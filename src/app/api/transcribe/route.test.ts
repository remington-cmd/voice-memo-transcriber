import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function request(headers: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append("file", new File(["audio"], "memo.m4a", { type: "audio/mp4" }));
  return new NextRequest("http://localhost/api/transcribe", {
    method: "POST",
    headers,
    body: form,
  });
}

function stubUpstream() {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ text: "hello world", duration: 1.5, language: "english" })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /api/transcribe", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ACCESS_PASSWORD", "");
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
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the right password", async () => {
    vi.stubEnv("ACCESS_PASSWORD", "right");
    stubUpstream();

    const res = await POST(request({ "x-access-password": "right" }));

    expect(res.status).toBe(200);
  });

  it("forwards the file to Whisper and returns the transcript", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transcript: "hello world",
      duration: 1.5,
      language: "english",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-test" });
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    const file = form.get("file") as File;
    expect(file.name).toBe("memo.m4a");
    expect(await file.text()).toBe("audio");
  });

  it("returns 400 when no file is sent", async () => {
    const fetchMock = stubUpstream();
    const req = new NextRequest("http://localhost/api/transcribe", {
      method: "POST",
      body: new FormData(),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
