// Naming and joining helpers for transcripts.

/** Join per-chunk transcripts into one, trimming each and separating with a blank line. */
export function joinTranscripts(parts: string[]): string {
  return parts.map((part) => part.trim()).join("\n\n");
}

/** "memo.m4a" -> "memo-transcript.txt" */
export function transcriptFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "") + "-transcript.txt";
}

/** Upload name for a chunk: "memo.m4a", 0 -> "memo.m4a.part1.wav" */
export function chunkFilename(name: string, index: number): string {
  return `${name}.part${index + 1}.wav`;
}
