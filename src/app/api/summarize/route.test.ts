import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function stubUpstream() {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ choices: [{ message: { content: "the summary" } }] })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

describe("POST /api/summarize", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ACCESS_PASSWORD", "");
  });

  it("returns 400 when the transcript is missing", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No transcript provided" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong password without calling OpenAI", async () => {
    vi.stubEnv("ACCESS_PASSWORD", "right");
    const fetchMock = stubUpstream();

    const res = await POST(request({ transcript: "hi" }, { "x-access-password": "wrong" }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends at most 8000 words plus the truncation marker upstream", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request({ transcript: words(9000) }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: "the summary" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("gpt-4o-mini");
    const userMessage = sent.messages[1];
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toBe(words(8000) + "\n\n[transcript truncated]");
  });

  it("sends a short transcript unchanged", async () => {
    const fetchMock = stubUpstream();

    await POST(request({ transcript: "just a few words" }));

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.messages[1].content).toBe("just a few words");
  });
});
