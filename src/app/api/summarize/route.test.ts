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

function completion(content: unknown, finishReason = "stop") {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }] };
}

function stubUpstream(body: unknown = completion("the summary")) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubUpstream>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

describe("POST /api/summarize", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ACCESS_PASSWORD", "");
    vi.stubEnv("OPENAI_SUMMARY_MODEL", "");
  });

  it("returns 400 when the transcript is missing", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: "no_transcript",
      error: "No transcript provided",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a null body", null],
    ["a numeric transcript", { transcript: 42 }],
    ["a whitespace-only transcript", { transcript: " \n\t " }],
    ["an array body", ["transcript"]],
  ])("returns 400 for %s", async (_name, body) => {
    const fetchMock = stubUpstream();

    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_transcript" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong password without calling OpenAI", async () => {
    vi.stubEnv("ACCESS_PASSWORD", "right");
    const fetchMock = stubUpstream();

    const res = await POST(request({ transcript: "hi" }, { "x-access-password": "wrong" }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends at most 8000 words plus the truncation marker upstream and says so", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request({ transcript: words(9000) }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      summary: "the summary",
      truncated: true,
      wordsUsed: 8000,
      totalWords: 9000,
      incomplete: false,
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = sentBody(fetchMock);
    expect(sent.model).toBe("gpt-4o-mini");
    const userMessage = sent.messages[1];
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toBe(words(8000) + "\n\n[transcript truncated]");
  });

  it("sends a short transcript unchanged", async () => {
    const fetchMock = stubUpstream();

    const res = await POST(request({ transcript: "just a few words" }));

    expect(sentBody(fetchMock).messages[1].content).toBe("just a few words");
    expect(await res.json()).toMatchObject({ truncated: false, wordsUsed: 4, totalWords: 4 });
  });

  it("does not count leading whitespace as a word", async () => {
    stubUpstream();

    const res = await POST(request({ transcript: "  a b" }));

    expect(await res.json()).toMatchObject({ wordsUsed: 2, totalWords: 2 });
  });

  it("caps output with max_completion_tokens only", async () => {
    const fetchMock = stubUpstream();

    await POST(request({ transcript: "hello" }));

    const sent = sentBody(fetchMock);
    expect(Object.keys(sent).sort()).toEqual(["max_completion_tokens", "messages", "model"]);
    expect(sent.max_completion_tokens).toBe(1000);
  });

  it("uses OPENAI_SUMMARY_MODEL when set", async () => {
    vi.stubEnv("OPENAI_SUMMARY_MODEL", " gpt-6-luna ");
    const fetchMock = stubUpstream();

    await POST(request({ transcript: "hello" }));

    expect(sentBody(fetchMock).model).toBe("gpt-6-luna");
  });

  it("asks for plain-text headings, not Markdown", async () => {
    const fetchMock = stubUpstream();

    await POST(request({ transcript: "hello" }));

    const system = sentBody(fetchMock).messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("KEY TOPICS:");
    expect(system.content).toContain("DECISIONS / ACTION ITEMS:");
    expect(system.content).toContain("PEOPLE MENTIONED:");
    expect(system.content).not.toContain("**");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "  \n"],
  ])("returns 502 empty_summary when the content is %s", async (_name, content) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubUpstream(completion(content));

    const res = await POST(request({ transcript: "hello" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "empty_summary" });
  });

  it("returns 502 empty_summary when there are no choices", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubUpstream({ choices: [] });

    const res = await POST(request({ transcript: "hello" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "empty_summary" });
  });

  it("marks a summary cut off by the output cap", async () => {
    stubUpstream(completion("KEY TOPICS:\n- Follow up with Sar", "length"));

    const res = await POST(request({ transcript: "hello" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBe("KEY TOPICS:\n- Follow up with Sar\n\n[summary cut off]");
    expect(body.summary.endsWith("[summary cut off]")).toBe(true);
    expect(body.incomplete).toBe(true);
  });

  it("maps an OpenAI 429 quota error to 402", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        },
        { status: 429 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(request({ transcript: "hello" }));

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "insufficient_quota" });
  });
});
