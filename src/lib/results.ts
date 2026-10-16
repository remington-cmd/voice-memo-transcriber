// The saved transcripts list: its shape, how it is read back from storage, and
// the updates the page applies to it. Updates match by id, never by position,
// because the list can change while a summary request is in flight.

import type { SummaryResponse } from "./api-client";

export interface SummaryCoverage {
  wordsUsed: number;
  totalWords: number;
}

export interface Result {
  /** Stable identity for React keys and updates. Older saved entries get one on load. */
  id: string;
  filename: string;
  transcript: string;
  at: string; // ISO string for serialization
  summary?: string;
  /** Set when the summary covers only the first `wordsUsed` of `totalWords` words. */
  summaryCoverage?: SummaryCoverage;
  /** Set when the model hit its output cap, so the summary is cut off. */
  summaryIncomplete?: boolean;
  /** Set on the text saved from a chunked job that stopped before the last chunk. */
  partial?: boolean;
}

export interface LoadedResults {
  results: Result[];
  /** True when a stored value exists but is not a JSON array, so none of it was loaded. */
  corrupt: boolean;
}

/**
 * A random id. crypto.randomUUID exists only in secure contexts, so a phone
 * testing the dev server over plain http on the LAN gets the fallback.
 */
export function newId(): string {
  return (
    crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export function createResult(filename: string, transcript: string): Result {
  return { id: newId(), filename, transcript, at: new Date().toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The entry as a Result with only the known fields, or null when a required one is missing. */
function toResult(entry: unknown): Result | null {
  if (!isRecord(entry)) return null;
  const { id, filename, transcript, at, summary, summaryCoverage, summaryIncomplete, partial } =
    entry;
  if (typeof filename !== "string" || typeof transcript !== "string" || typeof at !== "string") {
    return null;
  }

  const result: Result = { id: typeof id === "string" ? id : "", filename, transcript, at };
  // An older version could save summary: null. The transcript is still worth keeping.
  if (typeof summary === "string") result.summary = summary;
  if (
    isRecord(summaryCoverage) &&
    typeof summaryCoverage.wordsUsed === "number" &&
    typeof summaryCoverage.totalWords === "number"
  ) {
    result.summaryCoverage = {
      wordsUsed: summaryCoverage.wordsUsed,
      totalWords: summaryCoverage.totalWords,
    };
  }
  if (typeof summaryIncomplete === "boolean") result.summaryIncomplete = summaryIncomplete;
  if (typeof partial === "boolean") result.partial = partial;
  return result;
}

/**
 * Parse the saved list. Never throws. Entries without a string filename,
 * transcript and at are dropped, and entries without a usable id (saved before
 * ids existed, or a duplicate) get a new one.
 */
export function loadResults(raw: string | null): LoadedResults {
  if (!raw) return { results: [], corrupt: false };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { results: [], corrupt: true };
  }
  if (!Array.isArray(data)) return { results: [], corrupt: true };

  const seen = new Set<string>();
  const results: Result[] = [];
  for (const entry of data) {
    const result = toResult(entry);
    if (!result) continue;
    if (!result.id || seen.has(result.id)) result.id = newId();
    seen.add(result.id);
    results.push(result);
  }
  return { results, corrupt: false };
}

/**
 * Store a summary on the result with this id. The list is returned unchanged
 * when that result is gone (deleted while the request ran) or the summary is
 * empty, so an existing summary is never erased.
 */
export function applySummary(
  list: Result[],
  id: string,
  resp: Omit<SummaryResponse, "summary"> & { summary?: string | null }
): Result[] {
  const { summary } = resp;
  if (typeof summary !== "string" || !summary.trim()) return list;
  if (!list.some((r) => r.id === id)) return list;

  return list.map((r) => {
    if (r.id !== id) return r;
    // Drop the previous summary's annotations; they describe a different summary.
    const { summaryCoverage: _coverage, summaryIncomplete: _incomplete, ...rest } = r;
    const next: Result = { ...rest, summary };
    if (resp.truncated && typeof resp.wordsUsed === "number" && typeof resp.totalWords === "number") {
      next.summaryCoverage = { wordsUsed: resp.wordsUsed, totalWords: resp.totalWords };
    }
    if (resp.incomplete) next.summaryIncomplete = true;
    // In the key order loadResults gives, so another tab that reads this list
    // back serializes the same string and has no reason to write it again.
    return toResult(next) ?? next;
  });
}

export function removeResult(list: Result[], id: string): Result[] {
  return list.filter((r) => r.id !== id);
}
