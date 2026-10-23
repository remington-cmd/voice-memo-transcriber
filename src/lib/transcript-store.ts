import { del, get, list, put } from "@vercel/blob";
import {
  MAX_SUMMARY_CHARACTERS,
  parseTranscriptDraft,
  type TranscriptDraft,
  validTranscriptId,
} from "./transcript-validation";
import { storageCredentialsAvailable } from "./api-auth";

const PREFIX = "transcripts/v1/";

export type TranscriptRecord = TranscriptDraft;
export type TranscriptSummary = {
  id: string;
  filename: string;
  at: string;
  characters: number;
  hasSummary: boolean;
};

export class StoreNotConfiguredError extends Error {
  constructor() {
    super("Private transcript storage is not configured.");
  }
}

function requireStore() {
  if (!storageCredentialsAvailable()) throw new StoreNotConfiguredError();
}

function pathFor(id: string): string {
  if (!validTranscriptId(id)) throw new Error("Invalid transcript id.");
  return `${PREFIX}${id}.json`;
}

async function readWithEtag(id: string): Promise<{ record: TranscriptRecord; etag: string } | null> {
  requireStore();
  if (!validTranscriptId(id)) return null;
  const blob = await get(pathFor(id), { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
  const value: unknown = JSON.parse(await new Response(blob.stream).text());
  const record = parseTranscriptDraft(value);
  if (!record || record.id !== id) throw new Error("Stored transcript failed validation.");
  return { record, etag: blob.blob.etag };
}

export async function getTranscript(id: string): Promise<TranscriptRecord | null> {
  return (await readWithEtag(id))?.record ?? null;
}

export async function saveTranscript(draft: TranscriptDraft): Promise<TranscriptRecord> {
  requireStore();
  const record = parseTranscriptDraft(draft);
  if (!record) throw new Error("Invalid transcript record.");
  const existing = await getTranscript(record.id);
  if (existing) {
    // Idempotent retries must not overwrite a different recording.
    if (existing.filename !== record.filename || existing.transcript !== record.transcript ||
        existing.at !== record.at) throw new Error("Transcript id already exists.");
    return existing;
  }
  await put(pathFor(record.id), JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return record;
}

export async function listTranscripts(options: { limit: number; cursor?: string }): Promise<{
  items: TranscriptSummary[];
  nextCursor: string | null;
}> {
  requireStore();
  const { blobs, cursor, hasMore } = await list({
    prefix: PREFIX,
    limit: options.limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  const items: TranscriptSummary[] = [];
  for (const blob of blobs) {
    const id = blob.pathname.slice(PREFIX.length).replace(/\.json$/, "");
    if (!validTranscriptId(id) || blob.pathname !== pathFor(id)) continue;
    const record = await getTranscript(id);
    if (!record) continue; // Another request may have deleted it.
    items.push({
      id: record.id,
      filename: record.filename,
      at: record.at,
      characters: record.transcript.length,
      hasSummary: !!record.summary,
    });
  }
  return { items, nextCursor: hasMore ? cursor ?? null : null };
}

export async function setTranscriptSummary(id: string, summary: string): Promise<TranscriptRecord | null> {
  requireStore();
  if (summary.length > MAX_SUMMARY_CHARACTERS) throw new Error("Summary too long.");
  const existing = await readWithEtag(id);
  if (!existing) return null;
  const updated = { ...existing.record, summary };
  await put(pathFor(id), JSON.stringify(updated), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    ifMatch: existing.etag,
  });
  return updated;
}

export async function deleteTranscript(id: string): Promise<void> {
  requireStore();
  await del(pathFor(id));
}
