import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import { withRetry, type RetryInfo, type RetryOptions } from "./retry";

function apiError(status: number, extra: { retryAfterMs?: number; code?: string } = {}) {
  const retryable = [0, 408, 429, 500, 502, 503, 504].includes(status);
  return new ApiError(`failed (HTTP ${status})`, { status, retryable, ...extra });
}

/** Fails with each error in turn, then returns "ok". */
function failing(...errors: unknown[]) {
  return vi.fn(async (_attempt: number) => {
    const next = errors.shift();
    if (next !== undefined) throw next;
    return "ok";
  });
}

/** Options with instant, recorded sleeps and no jitter (random() of 0.5). */
function opts(extra: RetryOptions = {}) {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
  });
  return { waits, sleep, options: { sleep, random: () => 0.5, ...extra } };
}

describe("withRetry", () => {
  it("returns the first success without waiting", async () => {
    const { waits, options } = opts();
    const fn = failing();
    await expect(withRetry(fn, options)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("succeeds after one retry when a 503 is followed by a 200", async () => {
    const { waits, options } = opts();
    const fn = failing(apiError(503));
    await expect(withRetry(fn, options)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    expect(waits).toEqual([2000]);
  });

  it("retries a network error (status 0)", async () => {
    const { options } = opts();
    const network = new ApiError("Network error. Check your connection.", {
      status: 0,
      retryable: true,
    });
    const fn = failing(network);
    await expect(withRetry(fn, options)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 402, 413])("calls a %i exactly once", async (status) => {
    const { waits, options } = opts();
    const err = apiError(status);
    const fn = failing(err);
    await expect(withRetry(fn, options)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("does not retry an error that is not an ApiError", async () => {
    const { options } = opts();
    const err = new TypeError("bug");
    const fn = failing(err);
    await expect(withRetry(fn, options)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits for a 429's Retry-After when it is longer than the base delay", async () => {
    const { waits, options } = opts();
    await withRetry(failing(apiError(429, { retryAfterMs: 7000 })), options);
    expect(waits).toEqual([7000]);
  });

  it("caps a long Retry-After at 30 s", async () => {
    const { waits, options } = opts();
    await withRetry(failing(apiError(429, { retryAfterMs: 120_000 })), options);
    expect(waits).toEqual([30_000]);
  });

  it("uses the base delay when Retry-After is shorter", async () => {
    const { waits, options } = opts();
    await withRetry(failing(apiError(429, { retryAfterMs: 1000 })), options);
    expect(waits).toEqual([2000]);
  });

  it("throws the last error after 4 retryable failures", async () => {
    const { waits, options } = opts({ attempts: 4 });
    const errors = [apiError(503), apiError(502), apiError(504), apiError(500)];
    const fn = failing(...errors, apiError(503));
    await expect(withRetry(fn, options)).rejects.toBe(errors[3]);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([2000, 5000, 15000]);
  });

  it("repeats the last delay when there are more attempts than delays", async () => {
    const { waits, options } = opts({ attempts: 5 });
    await expect(
      withRetry(failing(...Array.from({ length: 5 }, () => apiError(503))), options)
    ).rejects.toBeInstanceOf(ApiError);
    expect(waits).toEqual([2000, 5000, 15000, 15000]);
  });

  it("moves each wait by up to the jitter, but never below a Retry-After", async () => {
    const low = opts({ random: () => 0 });
    await withRetry(failing(apiError(503)), low.options);
    expect(low.waits).toEqual([1600]);

    const high = opts({ random: () => 0.999999 });
    await withRetry(failing(apiError(503)), high.options);
    expect(high.waits).toEqual([2400]);

    const floor = opts({ random: () => 0 });
    await withRetry(failing(apiError(429, { retryAfterMs: 7000 })), floor.options);
    expect(floor.waits).toEqual([7000]);
  });

  it("reports each retry before waiting", async () => {
    const events: string[] = [];
    const { options } = opts({ attempts: 4 });
    const fn = vi.fn(async (attempt: number) => {
      events.push(`call ${attempt}`);
      if (attempt < 3) throw apiError(503);
      return "ok";
    });
    const onRetry = vi.fn((info: RetryInfo) => events.push(`retry ${info.attempt} of ${info.attempts}`));
    await withRetry(fn, { ...options, onRetry });
    expect(events).toEqual(["call 1", "retry 2 of 4", "call 2", "retry 3 of 4", "call 3"]);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ delayMs: 2000, error: { status: 503 } });
  });

  it("rejects promptly with the abort reason when aborted during a wait", async () => {
    const controller = new AbortController();
    const reason = new DOMException("The operation was aborted.", "AbortError");
    const fn = failing(apiError(503));
    // A wait that would never end on its own.
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const onRetry = () => queueMicrotask(() => controller.abort(reason));

    await expect(
      withRetry(fn, { sleep, onRetry, signal: controller.signal, random: () => 0.5 })
    ).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops the real timer on abort instead of waiting it out", async () => {
    const controller = new AbortController();
    const fn = failing(apiError(503));
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);

    const err = await withRetry(fn, { signal: controller.signal }).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a retryable error once the signal is aborted", async () => {
    const controller = new AbortController();
    const err = apiError(503);
    const { waits, options } = opts();
    const fn = vi.fn(async () => {
      controller.abort();
      throw err;
    });
    await expect(withRetry(fn, { ...options, signal: controller.signal })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("makes no call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = failing();
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
