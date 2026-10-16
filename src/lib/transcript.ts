// Naming and joining helpers for transcripts.

/**
 * Join per-chunk transcripts into one. Each part is trimmed and empty parts are
 * dropped. Chunk cuts are not sentence breaks, so parts are joined with a single
 * space rather than a paragraph break.
 */
export function joinTranscripts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

/** "memo.m4a" -> "memo-transcript.txt" */
export function transcriptFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "") + "-transcript.txt";
}

/** Upload name for a chunk: "memo.m4a", 0 -> "memo.m4a.part1.wav" */
export function chunkFilename(name: string, index: number): string {
  return `${name}.part${index + 1}.wav`;
}
