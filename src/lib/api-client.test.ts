import { describe, expect, it, vi } from "vitest";
import { authHeaders, requestSummary, transcribeBlob } from "./api-client";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json(body, { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function headersOf(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

describe("authHeaders", () => {
  it("sends the password header only when a password is set", () => {
    expect(authHeaders("secret")).toEqual({ "x-access-password": "secret" });
    expect(authHeaders("")).toEqual({});
  });

  it("encodes any Unicode password into a legal ASCII header value", () => {
    const password = "caf\u00e9\u20ac\u2019\u2014\u{1F600}";
    const value = authHeaders(password)["x-access-password"];

    expect(value).toMatch(/^[\x21-\x7e]*$/);
    expect(decodeURIComponent(value)).toBe(password);
    expect(() => new Headers(authHeaders(password))).not.toThrow();
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

  it("throws the access-denied message on 401", async () => {
    stubFetch(401, { error: "Unauthorized" });
    await expect(transcribeBlob(new Blob(["x"]), "memo.m4a", "wrong")).rejects.toThrow(
      "Access denied — check your password."
    );
  });

  it("throws the server's error message on other failures", async () => {
    stubFetch(500, { error: "Transcription failed. Check your API key." });
    await expect(transcribeBlob(new Blob(["x"]), "memo.m4a", "")).rejects.toThrow(
      "Transcription failed. Check your API key."
    );
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

  it("throws the access-denied message on 401", async () => {
    stubFetch(401, { error: "Unauthorized" });
    await expect(requestSummary("t", "wrong")).rejects.toThrow(
      "Access denied — check your password."
    );
  });
});
