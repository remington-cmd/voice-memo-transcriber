// Size and audio limits shared by the page and the chunker.

/** Files at or under this size are uploaded as-is; larger ones are chunked. */
export const DIRECT_LIMIT = 24 * 1024 * 1024;
/** Largest file the dropzone accepts. */
export const MAX_SIZE = 500 * 1024 * 1024;

export const TARGET_SAMPLE_RATE = 16000; // Whisper internally works at 16 kHz
// 2 minutes per chunk. As 16 kHz mono 16-bit WAV this is ~3.8 MB, which stays
// safely under Vercel's ~4.5 MB serverless request body limit (and Whisper's
// 25 MB cap). Shorter chunks = more requests but reliable uploads.
export const CHUNK_SECONDS = 120;

/** True when a file is too big to upload directly and must be split first. */
export function shouldChunk(size: number): boolean {
  return size > DIRECT_LIMIT;
}
