export const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;
export const MAX_SUMMARY_CHARACTERS = 20_000;
export const TRANSCRIPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscriptDraft {
  id: string;
  filename: string;
  transcript: string;
  at: string;
  summary?: string;
}

export function validTranscriptId(id: unknown): id is string {
  return typeof id === "string" && TRANSCRIPT_ID_RE.test(id);
}

export function parseTranscriptDraft(value: unknown): TranscriptDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!validTranscriptId(v.id)) return null;
  if (typeof v.filename !== "string" || v.filename.trim().length < 1 ||
      v.filename.length > 240 || /[\u0000-\u001f]/.test(v.filename)) return null;
  if (typeof v.transcript !== "string" || v.transcript.trim().length === 0 ||
      v.transcript.length > MAX_TRANSCRIPT_CHARACTERS) return null;
  if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at)) ||
      !/^\d{4}-\d{2}-\d{2}T/.test(v.at)) return null;
  if (v.summary !== undefined &&
      (typeof v.summary !== "string" || v.summary.length > MAX_SUMMARY_CHARACTERS)) return null;
  return {
    id: v.id,
    filename: v.filename,
    transcript: v.transcript,
    at: new Date(v.at).toISOString(),
    ...(typeof v.summary === "string" ? { summary: v.summary } : {}),
  };
}
