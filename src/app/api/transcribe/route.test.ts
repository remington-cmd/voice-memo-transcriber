import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function formRequest(form: FormData, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/transcribe", {
    method: "POST",
    headers,
    body: form,
  });
}

function request(headers: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append("file", new File(["audio"], "memo.m4a", { type: "audio/mp4" }));
  return formRequest(form, headers);
}

function stubUpstream(respond: () => Response = () => Response.json({ text: "hello world" })) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /api/transcribe", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ACCESS_PASSWORD", "");
    vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "");
  });

  it("returns 500 when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = stubUpstream();

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong password without calling OpenAI", async () => {
    vi.stubEnv("ACCESS_PASSWORD", "right");
    const fetchMock = stubUpstream();

    const res = await POST(request({ "x-access-password": "wrong" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "bad_password", error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the password before reporting a missing OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ACCESS_PASSWORD", "right");
    const fetchMock = stubUpstream();

    const res = await POST(request({ "x-access-password": "wrong" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "bad_password" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the right password", async () => {
    vi.stubEnv("ACCESS_PASSWORD", "right");
    stubUpstream();

    const res = await POST(request({ "x-access-password": "right" }));

    expect(res.status).toBe(200);
  });

  it("forwards the file to OpenAI and returns the transcript", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: "hello world" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.has("response_format")).toBe(false);
    const file = form.get("file") as File;
    expect(file.name).toBe("memo.m4a");
    expect(await file.text()).toBe("audio");
  });

  it("uses OPENAI_TRANSCRIBE_MODEL and sends no response_format", async () => {
    vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", " gpt-transcribe ");
    const fetchMock = stubUpstream();

    await POST(request());

    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.has("response_format")).toBe(false);
    expect([...form.keys()].sort()).toEqual(["file", "model"]);
  });

  it("returns 400 when no file is sent", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(formRequest(new FormData()));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_file" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the file field is a string", async () => {
    const fetchMock = stubUpstream();
    const form = new FormData();
    form.append("file", "not a file");

    const res = await POST(formRequest(form));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_file" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a 0-byte file", async () => {
    const fetchMock = stubUpstream();
    const form = new FormData();
    form.append("file", new File([], "empty.m4a", { type: "audio/mp4" }));

    const res = await POST(formRequest(form));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_file" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 413 for a file over 25 MiB without calling OpenAI", async () => {
    const fetchMock = stubUpstream();
    const form = new FormData();
    form.append("file", new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.wav"));

    const res = await POST(formRequest(form));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      code: "too_large",
      error: "File exceeds the 25 MB transcription limit.",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an OpenAI 401 as a server key problem, not a wrong password", async () => {
    vi.stubEnv("ACCESS_PASSWORD", "right");
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubUpstream(() =>
      Response.json(
        { error: { message: "Incorrect API key provided: sk-abc…wxyz.", code: "invalid_api_key" } },
        { status: 401 }
      )
    );

    const res = await POST(request({ "x-access-password": "right" }));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ code: "upstream_auth" });
    expect(JSON.stringify(body)).not.toContain("sk-abc");
  });

  it("returns 502 when OpenAI's 200 has no text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubUpstream(() => Response.json({ transcript: "wrong field" }));

    const res = await POST(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "upstream_bad_response" });
  });

  it("returns JSON when OpenAI cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubUpstream(() => {
      throw new TypeError("fetch failed");
    });

    const res = await POST(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "upstream_unreachable", retryable: true });
  });
});
