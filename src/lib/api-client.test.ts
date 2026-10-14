import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  authHeaders,
  parseRetryAfter,
  readApiResponse,
  requestSummary,
  transcribeBlob,
} from "./api-client";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json(body, { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetchResponse(res: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => res));
}

function headersOf(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const anyBody = (data: unknown): data is unknown => true;
const hasOk = (data: unknown): data is { ok: true } =>
  typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function text(status: number, body: string | null, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

describe("authHeaders", () => {
  it("sends the password header only when a password is set", () => {
    expect(authHeaders("secret")).toEqual({ "x-access-password": "secret" });
    expect(authHeaders("")).toEqual({});
  });

  it("encodes any Unicode password into a legal ASCII header value", () => {
    const password = "café€’—\u{1F600}";
    const value = authHeaders(password)["x-access-password"];

    expect(value).toMatch(/^[\x21-\x7e]*$/);
    expect(decodeURIComponent(value)).toBe(password);
    expect(() => new Headers(authHeaders(password))).not.toThrow();
  });
});

describe("readApiResponse errors", () => {
  it.each([
    {
      name: "a Vercel text/plain 413",
      res: () => text(413, "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE"),
      message: "File too large for the server's upload limit (HTTP 413).",
      retryable: false,
    },
    {
      name: "an HTML 504 page",
      res: () => text(504, "<!DOCTYPE html><p>An error occurred</p>", "text/html"),
      message: "Server timed out. Try again (HTTP 504).",
      retryable: true,
    },
    {
      name: "an empty 500",
      res: () => text(500, null),
      message: "Server error (HTTP 500).",
      retryable: true,
    },
    {
      name: "a Vercel text/plain 502",
      res: () => text(502, "Bad Gateway"),
      message: "Server error (HTTP 502).",
      retryable: true,
    },
    {
      name: "a text/plain 429",
      res: () => text(429, "Too Many Requests"),
      message: "Rate limited. Try again shortly (HTTP 429).",
      retryable: true,
    },
    {
      name: "a 401 for a wrong password",
      res: () => json(401, { code: "bad_password", error: "Unauthorized" }),
      message: "Access denied. Check your password (HTTP 401).",
      retryable: false,
      code: "bad_password",
    },
    {
      name: "a 401 without the bad_password code",
      res: () => json(401, { error: "Unauthorized" }),
      message: "Access denied (HTTP 401).",
      retryable: false,
    },
    {
      name: "an HTML 401 from Deployment Protection",
      res: () => text(401, "<html>Authentication Required</html>", "text/html"),
      message: "Access denied (HTTP 401).",
      retryable: false,
    },
    {
      name: "a 502 for a rejected OpenAI key",
      res: () =>
        json(502, {
          code: "upstream_auth",
          error: "OpenAI rejected the server API key (OPENAI_API_KEY).",
          retryable: false,
        }),
      message: "OpenAI rejected the server API key (OPENAI_API_KEY) (HTTP 502).",
      retryable: false,
      code: "upstream_auth",
    },
    {
      name: "a 504 from the route's own upstream timeout",
      res: () =>
        json(504, {
          code: "upstream_timeout",
          error: "OpenAI took too long to respond. Try again.",
          retryable: true,
        }),
      message: "OpenAI took too long to respond. Try again (HTTP 504).",
      retryable: true,
      code: "upstream_timeout",
    },
    {
      name: "a 402 for an account out of credit",
      res: () =>
        json(402, {
          code: "insufficient_quota",
          error: "OpenAI account is out of credit.",
          retryable: false,
        }),
      message: "OpenAI account is out of credit (HTTP 402).",
      retryable: false,
      code: "insufficient_quota",
    },
    {
      name: "an insufficient_quota 429 that claims to be retryable",
      res: () => json(429, { code: "insufficient_quota", error: "Out of credit", retryable: true }),
      message: "Out of credit (HTTP 429).",
      retryable: false,
      code: "insufficient_quota",
    },
    {
      name: "a JSON 503 that does not say whether to retry",
      res: () => json(503, { error: "Busy" }),
      message: "Busy (HTTP 503).",
      retryable: true,
    },
    {
      name: "a 422 for audio that is too short",
      res: () =>
        json(422, {
          code: "audio_too_short",
          error: "The audio is too short to transcribe.",
          retryable: false,
        }),
      message: "The audio is too short to transcribe (HTTP 422).",
      retryable: false,
      code: "audio_too_short",
    },
  ])("turns $name into a readable ApiError", async ({ res, message, retryable, code }) => {
    const response = res();
    const err = await caught(readApiResponse(response, anyBody));

    expect(err.message).toBe(message);
    expect(err.message).toContain(`HTTP ${response.status}`);
    expect(err.status).toBe(response.status);
    expect(err.retryable).toBe(retryable);
    expect(err.code).toBe(code);
    expect(err.name).toBe("ApiError");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("reads Retry-After in seconds", async () => {
    const err = await caught(
      readApiResponse(
        json(
          429,
          {
            code: "rate_limited",
            error: "OpenAI rate limit reached. Try again shortly.",
            retryable: true,
          },
          { "Retry-After": "7" }
        ),
        anyBody
      )
    );

    expect(err.retryAfterMs).toBe(7000);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("OpenAI rate limit reached. Try again shortly (HTTP 429).");
  });
});

describe("readApiResponse success", () => {
  it("returns the parsed body of a valid 200", async () => {
    await expect(readApiResponse(json(200, { ok: true }), hasOk)).resolves.toEqual({ ok: true });
  });

  it("rejects a 200 that is not JSON", async () => {
    const err = await caught(
      readApiResponse(text(200, "<html>Sign in</html>", "text/html"), hasOk)
    );
    expect(err.message).toBe("Unexpected response (HTTP 200).");
    expect(err.retryable).toBe(false);
  });

  it("rejects a 200 JSON body with the wrong shape", async () => {
    const err = await caught(readApiResponse(json(200, { ok: "yes" }), hasOk));
    expect(err.message).toBe("Unexpected response (HTTP 200).");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");

  it("reads delay-seconds", () => {
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
  });

  it("reads an HTTP-date relative to now", () => {
    expect(parseRetryAfter("Wed, 14 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("treats a date in the past as no wait", () => {
    expect(parseRetryAfter("Wed, 14 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("ignores a missing or unreadable header", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});

describe("apiFetch", () => {
  it("turns a network failure into a retryable ApiError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const err = await caught(apiFetch("/api/transcribe", { method: "POST" }));
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe("Network error. Check your connection.");
  });

  it("passes an abort through unchanged", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      })
    );

    await expect(apiFetch("/api/transcribe", { method: "POST" })).rejects.toBe(abort);
  });

  it("returns the response for any HTTP status", async () => {
    const res = text(500, null);
    stubFetchResponse(res);
    await expect(apiFetch("/api/transcribe", { method: "POST" })).resolves.toBe(res);
  });
});

describe("transcribeBlob", () => {
  it("posts the blob and returns the transcript on 200", async () => {
    const fetchMock = stubFetch(200, { transcript: "hello world" });

    await expect(transcribeBlob(new Blob(["x"]), "memo.m4a", "secret")).resolves.toBe(
      "hello world"
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/transcribe");
    expect(init.method).toBe("POST");
    expect(headersOf(fetchMock)).toEqual({ "x-access-password": "secret" });
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("memo.m4a");
  });

  it("throws the password message for a wrong password", async () => {
    stubFetch(401, { code: "bad_password", error: "Unauthorized" });
    await expect(transcribeBlob(new Blob(["x"]), "memo.m4a", "wrong")).rejects.toThrow(
      "Access denied. Check your password (HTTP 401)."
    );
  });

  it("throws the server's error message with the status on other failures", async () => {
    stubFetch(502, {
      code: "upstream_unavailable",
      error: "OpenAI is unavailable right now. Try again.",
      retryable: true,
    });
    await expect(transcribeBlob(new Blob(["x"]), "memo.m4a", "")).rejects.toThrow(
      "OpenAI is unavailable right now. Try again (HTTP 502)."
    );
  });

  it("explains a platform 413 instead of failing to parse it", async () => {
    stubFetchResponse(text(413, "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE"));

    const err = await caught(transcribeBlob(new Blob(["x"]), "memo.m4a", ""));
    expect(err.message).toMatch(/too large.*HTTP 413/);
    expect(err.message).not.toMatch(/JSON|Unexpected token/);
  });

  it("rejects a 200 without a transcript", async () => {
    stubFetch(200, { text: "hello" });
    await expect(transcribeBlob(new Blob(["x"]), "memo.m4a", "")).rejects.toThrow(
      "Unexpected response (HTTP 200)."
    );
  });

  it("reports a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Load failed");
      })
    );
    const err = await caught(transcribeBlob(new Blob(["x"]), "memo.m4a", ""));
    expect(err.status).toBe(0);
    expect(err.message).toContain("Network error");
  });

  it("omits the password header when the password is empty", async () => {
    const fetchMock = stubFetch(200, { transcript: "ok" });
    await transcribeBlob(new Blob(["x"]), "memo.m4a", "");
    expect(headersOf(fetchMock)).not.toHaveProperty("x-access-password");
  });
});

describe("requestSummary", () => {
  it("posts the transcript as JSON and returns the summary", async () => {
    const fetchMock = stubFetch(200, { summary: "short" });

    await expect(requestSummary("long transcript", "secret")).resolves.toEqual({
      summary: "short",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/summarize");
    expect(headersOf(fetchMock)).toEqual({
      "Content-Type": "application/json",
      "x-access-password": "secret",
    });
    expect(JSON.parse(init.body as string)).toEqual({ transcript: "long transcript" });
  });

  it("returns the coverage fields", async () => {
    stubFetch(200, {
      summary: "short",
      truncated: true,
      wordsUsed: 8000,
      totalWords: 12000,
      incomplete: false,
    });

    await expect(requestSummary("t", "")).resolves.toEqual({
      summary: "short",
      truncated: true,
      wordsUsed: 8000,
      totalWords: 12000,
      incomplete: false,
    });
  });

  it("keeps the summary but drops malformed coverage fields", async () => {
    stubFetch(200, { summary: "short", truncated: "yes", wordsUsed: null, extra: 1 });

    const result = await requestSummary("t", "");
    expect(result).toStrictEqual({ summary: "short" });
  });

  it("rejects a 200 without a summary", async () => {
    stubFetch(200, { error: "nope" });
    await expect(requestSummary("t", "")).rejects.toThrow("Unexpected response (HTTP 200).");
  });

  it("throws the password message for a wrong password", async () => {
    stubFetch(401, { code: "bad_password", error: "Unauthorized" });
    await expect(requestSummary("t", "wrong")).rejects.toThrow(
      "Access denied. Check your password (HTTP 401)."
    );
  });

  it("explains an HTML 504 instead of failing to parse it", async () => {
    stubFetchResponse(text(504, "<!DOCTYPE html><p>An error occurred</p>", "text/html"));
    await expect(requestSummary("t", "")).rejects.toThrow(
      "Server timed out. Try again (HTTP 504)."
    );
  });
});
