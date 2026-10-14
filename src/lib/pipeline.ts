// Drives the chunked transcription of one file.

import type { AudioChunk } from "@/app/audio-chunker";

/**
 * Upload chunks one at a time, in order, reporting progress before each.
 * Returns the raw transcript of every chunk; join them with joinTranscripts.
 */
export async function transcribeChunks(
  chunks: AudioChunk[],
  upload: (chunk: AudioChunk) => Promise<string>,
  onProgress: (message: string) => void
): Promise<string[]> {
  const parts: string[] = [];
  for (const chunk of chunks) {
    onProgress(`Transcribing chunk ${chunk.index + 1} of ${chunks.length}…`);
    parts.push(await upload(chunk));
  }
  return parts;
}
