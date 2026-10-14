// Retrying API calls that failed for a reason that may pass: a dropped
// connection, a timeout, a rate limit or a server or gateway error.

import { ApiError } from "./api-client";

export interface RetryInfo {
  /** The attempt about to be made, counting the first call as 1. */
  attempt: number;
  attempts: number;
  /** How long to wait before that attempt. */
  delayMs: number;
  error: ApiError;
}

export interface RetryOptions {
  /** Total calls, including the first. */
  attempts?: number;
  /** Base wait before the 2nd, 3rd, ... call. The last one repeats if there are more calls. */
  delaysMs?: readonly number[];
  /** Longest Retry-After to honour. A longer one is cut to this. */
  maxRetryAfterMs?: number;
  /** Fraction each wait is randomly moved up or down by. */
  jitter?: number;
  /** Aborting stops at once, even mid-wait, and is never retried. */
  signal?: AbortSignal;
  /** Called before each wait, so the page can say it is retrying. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. Returns a number in [0, 1). */
  random?: () => number;
}

function abortReason(signal: AbortSignal): unknown {
  // signal.reason needs Safari 15.4.
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal!));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The promise, or a rejection with the abort reason as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Call fn until it succeeds, up to `attempts` times. Only an ApiError marked
 * retryable is retried; anything else is thrown at once, and so is the last
 * error once the attempts run out.
 *
 * Each wait is the base delay for that attempt or the server's Retry-After
 * (capped at maxRetryAfterMs), whichever is longer, moved up or down by up to
 * `jitter`. Jitter never makes it shorter than the Retry-After.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 4,
    delaysMs = [2000, 5000, 15000],
    maxRetryAfterMs = 30_000,
    jitter = 0.2,
    signal,
    onRetry,
    sleep: wait = sleep,
    random = Math.random,
  }: RetryOptions = {}
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await fn(attempt);
    } catch (err) {
      // Never retry after an abort, whatever the error says.
      if (signal?.aborted) throw err;
      if (!(err instanceof ApiError) || !err.retryable || attempt >= attempts) throw err;

      const base = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
      const retryAfter = Math.min(err.retryAfterMs ?? 0, maxRetryAfterMs);
      const target = Math.max(retryAfter, base);
      const delayMs = Math.max(
        retryAfter,
        Math.round(target * (1 + jitter * (2 * random() - 1)))
      );

      onRetry?.({ attempt: attempt + 1, attempts, delayMs, error: err });
      await untilAborted(wait(delayMs, signal), signal);
    }
  }
}
