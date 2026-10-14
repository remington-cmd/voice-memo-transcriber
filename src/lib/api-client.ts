// Browser-side calls to the app's own API routes.

export interface SummaryResponse {
  summary: string;
  /** True when only the first `wordsUsed` of `totalWords` words were summarized. */
  truncated?: boolean;
  wordsUsed?: number;
  totalWords?: number;
  /** True when the model hit its output cap, so the summary is cut off. */
  incomplete?: boolean;
}

/** A failed API call, with a message that can be shown to the user as is. */
export class ApiError extends Error {
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /** The route's machine-readable error code, when it sent one. */
  readonly code?: string;
  /** True when sending the same request again may succeed. */
  readonly retryable: boolean;
  /** How long the server asked the client to wait, from Retry-After. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    init: { status: number; code?: string; retryable: boolean; retryAfterMs?: number }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs;
  }
}

// Timeouts, rate limits and server or gateway failures, plus status 0 (no response).
const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);

// Header values must be Latin-1, so the password is percent-encoded and the
// server decodes it. This keeps passwords like "café€" from making fetch throw.
export function authHeaders(password: string): Record<string, string> {
  return password ? { "x-access-password": encodeURIComponent(password) } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function networkError(): ApiError {
  return new ApiError("Network error. Check your connection.", { status: 0, retryable: true });
}

/**
 * fetch() for the API routes. A request that gets no response at all (offline,
 * DNS failure, dropped connection) rejects with a TypeError, which becomes a
 * retryable ApiError with status 0. Anything else, such as an AbortError, is
 * rethrown unchanged.
 */
export async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof TypeError) throw networkError();
    throw err;
  }
}

/** Milliseconds to wait from a Retry-After header in seconds or HTTP-date form. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  // An HTTP-date always names the month. Date.parse alone would read "-5" as a year.
  const date = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function errorMessage(status: number, code: string | undefined, serverError: unknown): string {
  if (status === 401) {
    return code === "bad_password"
      ? "Access denied. Check your password (HTTP 401)."
      : "Access denied (HTTP 401).";
  }
  // The routes send fixed, specific messages, so prefer them to a generic one.
  if (typeof serverError === "string" && serverError.trim()) {
    return `${serverError.trim().replace(/\.$/, "")} (HTTP ${status}).`;
  }
  // Anything else is most likely the platform's own text or HTML error page.
  switch (status) {
    case 413:
      return "File too large for the server's upload limit (HTTP 413).";
    case 504:
      return "Server timed out. Try again (HTTP 504).";
    case 429:
      return "Rate limited. Try again shortly (HTTP 429).";
    default:
      return `Server error (HTTP ${status}).`;
  }
}

function errorFromResponse(res: Response, data: unknown): ApiError {
  const body = isRecord(data) ? data : {};
  const code = typeof body.code === "string" ? body.code : undefined;
  // The routes say whether an error is worth retrying; otherwise go by status.
  const retryable =
    code !== "insufficient_quota" &&
    (typeof body.retryable === "boolean" ? body.retryable : RETRYABLE_STATUSES.has(res.status));
  return new ApiError(errorMessage(res.status, code, body.error), {
    status: res.status,
    code,
    retryable,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
  });
}

/**
 * Read a response from one of the API routes. The body is read as text first,
 * so a platform error that is not JSON (a Vercel 413 or 504, an empty 500, an
 * HTML page) still becomes a readable ApiError instead of a JSON parse error.
 * Every error message names the HTTP status. A successful response whose body
 * fails `validate` is an error too.
 */
export async function readApiResponse<T>(
  res: Response,
  validate: (data: unknown) => data is T
): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (err instanceof TypeError) throw networkError();
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }

  if (!res.ok) throw errorFromResponse(res, data);
  if (!validate(data)) {
    throw new ApiError(`Unexpected response (HTTP ${res.status}).`, {
      status: res.status,
      retryable: false,
    });
  }
  return data;
}

function hasTranscript(data: unknown): data is { transcript: string } {
  return isRecord(data) && typeof data.transcript === "string";
}

function hasSummary(data: unknown): data is Record<string, unknown> & { summary: string } {
  return isRecord(data) && typeof data.summary === "string";
}

/**
 * One signal that aborts when any of `signals` does. AbortSignal.any needs
 * Safari 17.4, so this links them by hand. Call dispose() when done, so a
 * long-lived signal does not keep a listener for every request.
 */
export function linkSignals(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  const dispose = () => cleanups.splice(0).forEach((cleanup) => cleanup());
  const abort = () => {
    controller.abort();
    dispose();
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", abort));
  }
  return { signal: controller.signal, dispose };
}

// Time left for the answer once the upload is done: longer than the route's
// maxDuration (60 s), so a slow server answers with its own error first.
const RESPONSE_WAIT_MS = 90_000;
// The slowest uplink a request is given time for, about 130 kbps.
const MIN_UPLOAD_BYTES_PER_SECOND = 16 * 1024;

/**
 * How long to wait for an upload of this many bytes before giving up. The
 * timer runs while the body is still being sent, so it allows for sending it
 * on a slow uplink as well as for the server's answer. A fixed 90 s cut off
 * every 3.9 MB chunk on a link under about 350 kbps, and each retry failed
 * the same way.
 */
export function uploadTimeoutMs(bytes: number): number {
  return RESPONSE_WAIT_MS + Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
}

export interface TranscribeOptions {
  /** Aborting rejects with an AbortError, which is never retried. */
  signal?: AbortSignal;
  /** Gives up on a request with no answer after this long. Defaults to uploadTimeoutMs. */
  timeoutMs?: number;
}

export async function transcribeBlob(
  blob: Blob,
  filename: string,
  password: string,
  { signal, timeoutMs = uploadTimeoutMs(blob.size) }: TranscribeOptions = {}
): Promise<string> {
  const fd = new FormData();
  fd.append("file", blob, filename);

  // AbortSignal.timeout needs Safari 16, so the timeout is a plain timer.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const linked = linkSignals(signal, timeout.signal);
  try {
    const res = await apiFetch("/api/transcribe", {
      method: "POST",
      headers: authHeaders(password),
      body: fd,
      signal: linked.signal,
    });
    const { transcript } = await readApiResponse(res, hasTranscript);
    return transcript;
  } catch (err) {
    // A caller's abort stays an AbortError; only our own timer becomes a timeout.
    if (!signal?.aborted && timeout.signal.aborted) {
      throw new ApiError("Request timed out.", { status: 0, code: "timeout", retryable: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }
}

export async function requestSummary(
  transcript: string,
  password: string
): Promise<SummaryResponse> {
  const res = await apiFetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(password) },
    body: JSON.stringify({ transcript }),
  });
  const data = await readApiResponse(res, hasSummary);

  // The coverage fields only annotate the summary, so a malformed one is dropped
  // rather than throwing away a summary that was already paid for.
  const result: SummaryResponse = { summary: data.summary };
  if (typeof data.truncated === "boolean") result.truncated = data.truncated;
  if (typeof data.wordsUsed === "number") result.wordsUsed = data.wordsUsed;
  if (typeof data.totalWords === "number") result.totalWords = data.totalWords;
  if (typeof data.incomplete === "boolean") result.incomplete = data.incomplete;
  return result;
}
