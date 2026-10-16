// Size, length and audio limits shared by the page and the chunker.
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

/**
 * Files longer than this are split even when they are small enough to upload
 * whole. Whisper's time grows with the audio's length, not its size, so a long
 * low-bitrate file could outlast the transcribe route's 60 s maxDuration; a
 * 2-minute chunk stays well inside it.
 */
export const DIRECT_MAX_SECONDS = 600;

/**
 * Lengths above which splitting in the browser may run out of memory and crash
 * the tab, which no error handler can catch. The whole recording is decoded in
 * memory at once: in Chromium that peaked at about 1.7 GB for an hour of mono
 * MP3 and 8 GB for a 3 h stereo MP3. AAC (.m4a, the iPhone format) costs more
 * to decode: Chrome 155 measured about 2.1 GB per hour of mono AAC and 4.1 GB
 * per hour of stereo, so it gets a lower desktop limit. iOS gives a tab far
 * less; its figure is an estimate, not measured.
 */
export const LONG_FILE_SOFT_SECONDS = { desktop: 9000, desktopAac: 5400, ios: 3600 } as const;

export type UploadPlan = "direct" | "chunked";

/**
 * Upload a file whole, or decode and split it into chunks first: chunked when
 * it is over DIRECT_LIMIT bytes or longer than DIRECT_MAX_SECONDS. A null
 * duration (the browser could not read it) is decided by size alone.
 */
export function planUpload({
  size,
  durationSec,
}: {
  size: number;
  durationSec: number | null;
}): UploadPlan {
  if (size > DIRECT_LIMIT) return "chunked";
  return durationSec !== null && durationSec > DIRECT_MAX_SECONDS ? "chunked" : "direct";
}

/**
 * True on an iPhone, iPod or iPad. iPadOS asks for desktop sites by default and
 * then reports itself as a Mac, so a "Mac" with a touch screen counts too.
 */
export function isIOS(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export type LongFileCheck = { warn: false } | { warn: true; message: string };

/**
 * Whether to ask before splitting a recording this long, and what to ask.
 * Nothing is asked at or under the soft limit, or when the length is unknown.
 * `aac` selects the lower desktop limit for AAC files (see isAacFile).
 */
export function assessLongFile(
  durationSec: number | null,
  ios: boolean,
  aac = false
): LongFileCheck {
  const limit = ios
    ? LONG_FILE_SOFT_SECONDS.ios
    : aac
      ? LONG_FILE_SOFT_SECONDS.desktopAac
      : LONG_FILE_SOFT_SECONDS.desktop;
  if (durationSec === null || durationSec <= limit) return { warn: false };
  const where = ios ? "on an iPhone or iPad" : "in the browser";
  return {
    warn: true,
    message:
      `This recording is ${formatDuration(durationSec)} long. Splitting recordings over ` +
      `${formatDuration(limit)} ${where} can run out of memory and crash the tab, losing ` +
      `all progress. Splitting the file into shorter parts first is safer. Continue anyway?`,
  };
}

/** "45 min", "1 h" or "2 h 30 min", rounding up to the next minute. */
function formatDuration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
