// Size and audio limits shared by the page and the chunker.
//
// Every upload is a single request to a Vercel function, and Vercel rejects a
// request body over about 4.5 MB with a 413 before the route runs. Both ways
// of uploading are bounded by MAX_REQUEST_BYTES: a direct upload is at most
// DIRECT_LIMIT, and a chunk is at most wavBytes(MAX_CHUNK_SECONDS). Each must
// leave REQUEST_OVERHEAD_MARGIN for the multipart framing and the filename.
// limits.test.ts checks both, so raise neither without checking the cap.

/** Vercel's request-body cap, read as decimal megabytes (the stricter reading). */
export const MAX_REQUEST_BYTES = 4_500_000;
/** Room kept for multipart framing, the filename and other request overhead. */
export const REQUEST_OVERHEAD_MARGIN = 64 * 1024;

/** Files at or under this size are uploaded as-is; larger ones are chunked. */
export const DIRECT_LIMIT = 4_000_000;
/** Largest file the dropzone accepts. */
export const MAX_SIZE = 500 * 1024 * 1024;

export const TARGET_SAMPLE_RATE = 16000; // Whisper internally works at 16 kHz
/** Nominal chunk length: 2 minutes, which is 3,840,044 bytes as 16 kHz mono 16-bit WAV. */
export const CHUNK_SECONDS = 120;
/** A final remainder shorter than this is merged into the previous chunk. */
export const MIN_TAIL_SECONDS = 1;
/** How far back from each nominal cut the chunk planner looks for a quiet point. */
export const SILENCE_SEARCH_SECONDS = 8;
/** Longest chunk the planner can produce: a full chunk plus a merged tail. */
export const MAX_CHUNK_SECONDS = CHUNK_SECONDS + MIN_TAIL_SECONDS;
/** OpenAI rejects audio shorter than this. */
export const MIN_AUDIO_SECONDS = 0.1;

/** Size in bytes of a 16-bit mono WAV file holding `seconds` of audio. */
export function wavBytes(seconds: number, rate = TARGET_SAMPLE_RATE): number {
  return 44 + seconds * rate * 2;
}

/** True when a file is too big to upload directly and must be split first. */
export function shouldChunk(size: number): boolean {
  return size > DIRECT_LIMIT;
}
