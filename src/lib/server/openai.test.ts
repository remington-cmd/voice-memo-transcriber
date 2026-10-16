import { beforeEach, describe, expect, it, vi } from "vitest";
import { callOpenAI, mapOpenAIError, type OpenAIKind } from "./openai";

// What OpenAI sends back for a bad key: the message echoes part of the key.
const LEAKY_MESSAGE = "Incorrect API key provided: sk-abc…wxyz. You can find your API key at ...";

function upstreamBody(
  code: string | null,
  message = LEAKY_MESSAGE,
  type = "invalid_request_error"
) {
  return { error: { message, type, param: null, code } };
}

// Same error code and type, different upstream message.
function withMessage(body: unknown, message: string): unknown {
  if (typeof body !== "object" || body === null) return "<html>Bad gateway</html>";
  const { error } = body as { error: Record<string, unknown> };
  return { error: { ...error, message } };
}

interface Case {
  name: string;
  status: number;
  body: unknown;
  kind?: OpenAIKind;
  retryAfter?: string;
  expected: { status: number; code: string; retryable: boolean; retryAfter?: string };
}

const cases: Case[] = [
  {
    name: "401 bad key",
    status: 401,
    body: upstreamBody("invalid_api_key"),
    expected: { status: 502, code: "upstream_auth", retryable: false },
  },
  {
    name: "403 forbidden",
    status: 403,
    body: upstreamBody("unsupported_country_region_territory"),
    expected: { status: 502, code: "upstream_auth", retryable: false },
  },
  {
    name: "404 unknown model",
    status: 404,
    body: upstreamBody("model_not_found"),
    expected: { status: 502, code: "upstream_model", retryable: false },
  },
  {
    name: "400 audio_too_short",
    status: 400,
    body: upstreamBody("audio_too_short"),
    expected: { status: 422, code: "audio_too_short", retryable: false },
  },
  {
    name: "other 400",
    status: 400,
    body: upstreamBody("invalid_value"),
    expected: { status: 400, code: "upstream_rejected", retryable: false },
  },
  {
    name: "413",
    status: 413,
    body: upstreamBody(null),
    expected: { status: 413, code: "too_large", retryable: false },
  },
  {
    name: "429 insufficient_quota",
    status: 429,
    body: upstreamBody("insufficient_quota", LEAKY_MESSAGE, "insufficient_quota"),
    expected: { status: 402, code: "insufficient_quota", retryable: false },
  },
  {
    name: "429 rate limit with Retry-After",
    status: 429,
    body: upstreamBody("rate_limit_exceeded", LEAKY_MESSAGE, "requests"),
    retryAfter: "7",
    expected: { status: 429, code: "rate_limited", retryable: true, retryAfter: "7" },
  },
  {
    name: "500",
    status: 500,
    body: upstreamBody(null, LEAKY_MESSAGE, "server_error"),
    expected: { status: 502, code: "upstream_unavailable", retryable: true },
  },
  {
    name: "503 with a non-JSON body",
    status: 503,
    body: undefined,
    expected: { status: 502, code: "upstream_unavailable", retryable: true },
  },
  {
    name: "418",
    status: 418,
    body: upstreamBody("teapot"),
    expected: { status: 502, code: "upstream_error", retryable: false },
  },
];

describe("mapOpenAIError", () => {
  it.each(cases)("maps $name", async ({ status, body, kind, retryAfter, expected }) => {
    const res = mapOpenAIError(status, body, kind ?? "transcribe", retryAfter ?? null);

    expect(res.status).toBe(expected.status);
    expect(res.headers.get("retry-after")).toBe(expected.retryAfter ?? null);
    const json = await res.json();
    expect(json).toEqual({
      code: expected.code,
      error: expect.any(String),
      retryable: expected.retryable,
    });
    expect(json.error.length).toBeGreaterThan(0);
  });

  it.each(cases)("uses a fixed message that never echoes upstream text for $name", async (c) => {
    for (const kind of ["transcribe", "summarize"] as const) {
      const leaky = await mapOpenAIError(c.status, c.body, kind).json();
      const other = await mapOpenAIError(
        c.status,
        withMessage(c.body, "something else"),
        kind
      ).json();

      expect(JSON.stringify(leaky)).not.toContain("sk-abc");
      expect(JSON.stringify(leaky)).not.toContain("Incorrect API key");
      expect(leaky.error).toBe(other.error);
    }
  });

  it("does not forward Retry-After on errors that are not retryable", () => {
    const res = mapOpenAIError(401, upstreamBody("invalid_api_key"), "transcribe", "7");
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("names the model variable for the route that failed", async () => {
    const transcribe = await mapOpenAIError(404, undefined, "transcribe").json();
    const summarize = await mapOpenAIError(404, undefined, "summarize").json();

    expect(transcribe.error).toContain("OPENAI_TRANSCRIBE_MODEL");
    expect(summarize.error).toContain("OPENAI_SUMMARY_MODEL");
  });

  it("words a 400 for the request kind", async () => {
    const transcribe = await mapOpenAIError(400, undefined, "transcribe").json();
    const summarize = await mapOpenAIError(400, undefined, "summarize").json();

    expect(transcribe.error).toBe(
      "OpenAI could not read this audio (unsupported or corrupt format)."
    );
    expect(summarize.error).toBe("OpenAI rejected the summary request.");
  });

  it("uses no em-dashes in user-facing messages", async () => {
    for (const c of cases) {
      for (const kind of ["transcribe", "summarize"] as const) {
        const { error } = await mapOpenAIError(c.status, c.body, kind).json();
        expect(error).not.toContain("—");
      }
    }
  });
});

describe("callOpenAI", () => {
  const URL = "https://api.openai.com/v1/test";
  const opts = { timeoutMs: 1000, kind: "transcribe" as const };

  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function expectFailure(
    result: Awaited<ReturnType<typeof callOpenAI>>,
    status: number,
    body: Record<string, unknown>
  ) {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(status);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.json()).toMatchObject(body);
  }

  it("returns the parsed JSON and passes a timeout signal", async () => {
    const fetchMock = stubFetch(async () => Response.json({ text: "hi" }));

    const result = await callOpenAI(URL, { method: "POST", body: "x" }, opts);

    expect(result).toEqual({ ok: true, data: { text: "hi" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("x");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a network error into a JSON 502", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expectFailure(await callOpenAI(URL, {}, opts), 502, {
      code: "upstream_unreachable",
      retryable: true,
    });
  });

  it("turns a TimeoutError into a JSON 504", async () => {
    stubFetch(async () => {
      throw new DOMException("", "TimeoutError");
    });

    await expectFailure(await callOpenAI(URL, {}, opts), 504, {
      code: "upstream_timeout",
      error: "OpenAI took too long to respond. Try again.",
      retryable: true,
    });
  });

  it("aborts a request that outlives timeoutMs", async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        })
    );

    await expectFailure(await callOpenAI(URL, {}, { timeoutMs: 20, kind: "summarize" }), 504, {
      code: "upstream_timeout",
    });
  });

  it("turns a 200 with a non-JSON body into a JSON 502", async () => {
    stubFetch(async () => new Response("not json", { status: 200 }));

    await expectFailure(await callOpenAI(URL, {}, opts), 502, { code: "upstream_bad_response" });
  });

  it("maps an upstream error and logs a truncated body to the server only", async () => {
    const huge = { error: { message: LEAKY_MESSAGE + "x".repeat(5000), code: "invalid_api_key" } };
    stubFetch(async () => Response.json(huge, { status: 401 }));

    const result = await callOpenAI(URL, {}, opts);

    await expectFailure(result, 502, { code: "upstream_auth" });
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("HTTP 401");
    expect(logged.length).toBeLessThan(700);
  });

  it("forwards Retry-After from a 429", async () => {
    stubFetch(async () =>
      Response.json(upstreamBody("rate_limit_exceeded"), {
        status: 429,
        headers: { "Retry-After": "7" },
      })
    );

    const result = await callOpenAI(URL, {}, opts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("7");
  });
});
