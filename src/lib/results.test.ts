import { describe, expect, it, vi } from "vitest";
import {
  applySummary,
  createResult,
  loadResults,
  newId,
  removeResult,
  type Result,
} from "./results";

const AT = "2026-01-01T00:00:00.000Z";

function result(id: string, extra: Partial<Result> = {}): Result {
  return { id, filename: `${id}.m4a`, transcript: `transcript ${id}`, at: AT, ...extra };
}

describe("loadResults", () => {
  it("treats a missing or empty value as an empty list, not corruption", () => {
    expect(loadResults(null)).toEqual({ results: [], corrupt: false });
    expect(loadResults("")).toEqual({ results: [], corrupt: false });
  });

  it("flags a value that is not JSON as corrupt", () => {
    expect(loadResults("{oops")).toEqual({ results: [], corrupt: true });
  });

  it("flags JSON that is not an array as corrupt", () => {
    expect(loadResults("null")).toEqual({ results: [], corrupt: true });
    expect(loadResults('{"filename":"x"}')).toEqual({ results: [], corrupt: true });
    expect(loadResults("42")).toEqual({ results: [], corrupt: true });
  });

  it("keeps only entries with a string filename, transcript and at", () => {
    const raw = JSON.stringify([
      { id: "a", filename: "a.m4a", transcript: "hello", at: AT },
      null,
      "text",
      { id: "b", filename: "b.m4a", at: AT },
      { id: "c", filename: 3, transcript: "x", at: AT },
      { id: "d", filename: "d.m4a", transcript: "x", at: null },
      { id: "e", filename: "e.m4a", transcript: "", at: AT, summary: "sum" },
    ]);
    const { results, corrupt } = loadResults(raw);
    expect(corrupt).toBe(false);
    expect(results).toEqual([
      { id: "a", filename: "a.m4a", transcript: "hello", at: AT },
      { id: "e", filename: "e.m4a", transcript: "", at: AT, summary: "sum" },
    ]);
  });

  it("keeps the transcript but drops a summary that is not a string", () => {
    const raw = JSON.stringify([{ id: "a", filename: "a.m4a", transcript: "t", at: AT, summary: null }]);
    expect(loadResults(raw).results).toEqual([{ id: "a", filename: "a.m4a", transcript: "t", at: AT }]);
  });

  it("drops unknown fields and malformed summary annotations", () => {
    const raw = JSON.stringify([
      {
        id: "a",
        filename: "a.m4a",
        transcript: "t",
        at: AT,
        extra: 1,
        summary: "s",
        summaryCoverage: { wordsUsed: "8000", totalWords: 9000 },
        summaryIncomplete: "yes",
      },
      {
        id: "b",
        filename: "b.m4a",
        transcript: "t",
        at: AT,
        summary: "s",
        summaryCoverage: { wordsUsed: 8000, totalWords: 9000 },
        summaryIncomplete: true,
      },
    ]);
    expect(loadResults(raw).results).toEqual([
      { id: "a", filename: "a.m4a", transcript: "t", at: AT, summary: "s" },
      {
        id: "b",
        filename: "b.m4a",
        transcript: "t",
        at: AT,
        summary: "s",
        summaryCoverage: { wordsUsed: 8000, totalWords: 9000 },
        summaryIncomplete: true,
      },
    ]);
  });

  it("keeps the partial flag only when it is a boolean", () => {
    const raw = JSON.stringify([
      { id: "a", filename: "a.m4a", transcript: "t", at: AT, partial: true },
      { id: "b", filename: "b.m4a", transcript: "t", at: AT, partial: false },
      { id: "c", filename: "c.m4a", transcript: "t", at: AT, partial: "yes" },
    ]);
    expect(loadResults(raw).results.map((r) => r.partial)).toEqual([true, false, undefined]);
    expect(loadResults(raw).results[2]).not.toHaveProperty("partial");
  });

  it("backfills missing ids uniquely and preserves existing ones", () => {
    // Saved before ids existed: no id at all.
    const legacy = { filename: "old.m4a", transcript: "t", at: AT };
    const raw = JSON.stringify([legacy, { ...legacy, id: "keep-me" }, legacy, { ...legacy, id: "" }]);
    const ids = loadResults(raw).results.map((r) => r.id);
    expect(ids).toHaveLength(4);
    expect(ids[1]).toBe("keep-me");
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("gives a duplicated id to the first entry only", () => {
    const raw = JSON.stringify([result("same"), result("same")]);
    const [first, second] = loadResults(raw).results;
    expect(first.id).toBe("same");
    expect(second.id).not.toBe("same");
  });

  it("round-trips the list the page saves", () => {
    const list = [
      result("a", { summary: "s", summaryCoverage: { wordsUsed: 8000, totalWords: 27000 } }),
      result("b", { summary: "s [summary cut off]", summaryIncomplete: true }),
      result("c"),
      result("d", { partial: true }),
    ];
    const raw = JSON.stringify(list);
    const loaded = loadResults(raw);
    expect(loaded).toEqual({ results: list, corrupt: false });
    // The same string written back fires no storage event in other tabs.
    expect(JSON.stringify(loaded.results)).toBe(raw);
  });
});

describe("createResult", () => {
  it("creates a result with an id and the current time", () => {
    const r = createResult("memo.m4a", "hello");
    expect(r).toMatchObject({ filename: "memo.m4a", transcript: "hello" });
    expect(r.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(r.at))).toBe(false);
    expect(createResult("memo.m4a", "hello").id).not.toBe(r.id);
  });
});

describe("applySummary", () => {
  it("lands on the right result after a new one is prepended meanwhile", () => {
    const list = [result("a"), result("b")];
    // Summarize b, and while that runs a transcription finishes and is prepended.
    const later = [result("new"), ...list];
    const updated = applySummary(later, "b", { summary: "summary of b" });
    expect(updated.map((r) => r.summary)).toEqual([undefined, undefined, "summary of b"]);
  });

  it("lands on the right result after another one is deleted meanwhile", () => {
    const list = [result("a"), result("b"), result("c")];
    const later = removeResult(list, "a");
    const updated = applySummary(later, "b", { summary: "summary of b" });
    expect(updated).toEqual([result("b", { summary: "summary of b" }), result("c")]);
  });

  it("drops the summary when its result was deleted meanwhile", () => {
    const list = removeResult([result("a"), result("b")], "b");
    const updated = applySummary(list, "b", { summary: "summary of b" });
    expect(updated).toBe(list);
    expect(updated).toEqual([result("a")]);
  });

  it("never replaces an existing summary with an empty or missing one", () => {
    const list = [result("a", { summary: "good summary" })];
    for (const summary of ["", "   \n", null, undefined]) {
      expect(applySummary(list, "a", { summary })).toBe(list);
    }
    expect(list[0].summary).toBe("good summary");
  });

  it("records coverage for a summary of a truncated transcript", () => {
    const [r] = applySummary([result("a")], "a", {
      summary: "s",
      truncated: true,
      wordsUsed: 8000,
      totalWords: 27000,
    });
    expect(r.summaryCoverage).toEqual({ wordsUsed: 8000, totalWords: 27000 });
    expect(r.summaryIncomplete).toBeUndefined();
  });

  it("records a summary that hit the output cap", () => {
    const [r] = applySummary([result("a")], "a", { summary: "s", incomplete: true });
    expect(r.summaryIncomplete).toBe(true);
  });

  it("clears the previous summary's annotations on a re-summarize", () => {
    const list = [
      result("a", {
        summary: "old",
        summaryCoverage: { wordsUsed: 8000, totalWords: 9000 },
        summaryIncomplete: true,
      }),
    ];
    const [r] = applySummary(list, "a", {
      summary: "new",
      truncated: false,
      wordsUsed: 500,
      totalWords: 500,
      incomplete: false,
    });
    expect(r).toEqual(result("a", { summary: "new" }));
  });

  it("does not modify the list it was given", () => {
    const list = [result("a")];
    applySummary(list, "a", { summary: "s" });
    expect(list).toEqual([result("a")]);
  });
});

describe("removeResult", () => {
  it("removes only the result with that id", () => {
    const list = [result("a"), result("b"), result("c")];
    expect(removeResult(list, "b")).toEqual([result("a"), result("c")]);
    expect(list).toHaveLength(3);
  });

  it("leaves the list as is for an unknown id", () => {
    expect(removeResult([result("a")], "zzz")).toEqual([result("a")]);
  });
});

describe("newId", () => {
  it("returns unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
  });

  it("still returns unique ids where crypto.randomUUID is missing (plain http)", () => {
    vi.stubGlobal("crypto", { randomUUID: undefined });
    const ids = Array.from({ length: 1000 }, newId);
    expect(new Set(ids).size).toBe(1000);
    expect(ids.every((id) => /^[0-9a-z]+-[0-9a-z]+$/.test(id))).toBe(true);
  });
});
