import { describe, expect, it } from "vitest";
import {
  CHUNK_SECONDS,
  DIRECT_LIMIT,
  MAX_CHUNK_SECONDS,
  MAX_REQUEST_BYTES,
  MIN_TAIL_SECONDS,
  REQUEST_OVERHEAD_MARGIN,
  SILENCE_SEARCH_SECONDS,
  assessLongFile,
  DIRECT_MAX_SECONDS,
  isIOS,
  LONG_FILE_SOFT_SECONDS,
  planUpload,
  wavBytes,
} from "./limits";
import { chunkFilename } from "./transcript";

describe("request size limits", () => {
  it("reads Vercel's cap the strict (decimal) way", () => {
    expect(MAX_REQUEST_BYTES).toBeLessThanOrEqual(4_500_000);
  });

  it("keeps a direct upload under the cap", () => {
    expect(DIRECT_LIMIT + REQUEST_OVERHEAD_MARGIN).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  });

  it("keeps the longest possible chunk under the cap", () => {
    expect(MAX_CHUNK_SECONDS).toBe(CHUNK_SECONDS + MIN_TAIL_SECONDS);
    expect(wavBytes(MAX_CHUNK_SECONDS) + REQUEST_OVERHEAD_MARGIN).toBeLessThanOrEqual(
      MAX_REQUEST_BYTES
    );
  });

  it("only searches for a quiet cut inside the chunk", () => {
    expect(SILENCE_SEARCH_SECONDS).toBeGreaterThan(0);
    expect(SILENCE_SEARCH_SECONDS).toBeLessThan(CHUNK_SECONDS);
  });

  it("leaves enough margin for the multipart framing of a long filename", async () => {
    const payload = new Blob([new Uint8Array(1000)]);
    const fd = new FormData();
    fd.append("file", payload, chunkFilename("x".repeat(255) + ".m4a", 999));
    const body = await new Request("http://localhost/api/transcribe", {
      method: "POST",
      body: fd,
    }).arrayBuffer();

    expect(body.byteLength - payload.size).toBeLessThan(REQUEST_OVERHEAD_MARGIN);
  });
});

describe("wavBytes", () => {
  it("adds the 44-byte header to 2 bytes per sample", () => {
    expect(wavBytes(CHUNK_SECONDS)).toBe(3_840_044);
    expect(wavBytes(1, 8000)).toBe(44 + 16_000);
  });
});

const MB = 1_000_000;

describe("planUpload", () => {
  it("uploads files up to DIRECT_LIMIT directly", () => {
    expect(planUpload({ size: DIRECT_LIMIT, durationSec: null })).toBe("direct");
  });

  it("chunks anything larger than DIRECT_LIMIT", () => {
    expect(planUpload({ size: DIRECT_LIMIT + 1, durationSec: null })).toBe("chunked");
  });

  it("chunks a 15 MB memo instead of sending it whole into a 413", () => {
    expect(planUpload({ size: 15 * MB, durationSec: 900 })).toBe("chunked");
  });

  it("uploads a short small file directly", () => {
    expect(planUpload({ size: 3 * MB, durationSec: 300 })).toBe("direct");
  });

  it("chunks a small file that is too long for one Whisper call", () => {
    expect(planUpload({ size: 3 * MB, durationSec: 1200 })).toBe("chunked");
    expect(planUpload({ size: 3 * MB, durationSec: DIRECT_MAX_SECONDS })).toBe("direct");
    expect(planUpload({ size: 3 * MB, durationSec: DIRECT_MAX_SECONDS + 1 })).toBe("chunked");
  });

  it("decides by size alone when the length is unknown", () => {
    expect(planUpload({ size: 5 * MB, durationSec: null })).toBe("chunked");
    expect(planUpload({ size: 3 * MB, durationSec: null })).toBe("direct");
  });
});

describe("assessLongFile", () => {
  it("does not ask at or under the desktop limit", () => {
    expect(assessLongFile(LONG_FILE_SOFT_SECONDS.desktop, false)).toEqual({ warn: false });
    expect(assessLongFile(60, false)).toEqual({ warn: false });
  });

  it("asks just over the desktop limit", () => {
    const check = assessLongFile(LONG_FILE_SOFT_SECONDS.desktop + 1, false);
    expect(check.warn).toBe(true);
    if (!check.warn) return;
    expect(check.message).toContain("2 h 31 min long");
    expect(check.message).toContain("over 2 h 30 min in the browser");
    expect(check.message).toMatch(/Continue anyway\?$/);
  });

  it("does not ask at or under the iOS limit", () => {
    expect(assessLongFile(LONG_FILE_SOFT_SECONDS.ios, true)).toEqual({ warn: false });
  });

  it("asks just over the iOS limit, well under the desktop one", () => {
    const check = assessLongFile(LONG_FILE_SOFT_SECONDS.ios + 1, true);
    expect(check.warn).toBe(true);
    if (!check.warn) return;
    expect(check.message).toContain("1 h 1 min long");
    expect(check.message).toContain("over 1 h on an iPhone or iPad");
    expect(assessLongFile(LONG_FILE_SOFT_SECONDS.ios + 1, false)).toEqual({ warn: false });
  });

  it("does not ask when the length is unknown", () => {
    expect(assessLongFile(null, false)).toEqual({ warn: false });
    expect(assessLongFile(null, true)).toEqual({ warn: false });
  });

  it("uses no em-dashes in the message", () => {
    const check = assessLongFile(5 * 3600, false);
    expect(check.warn && check.message).not.toContain("\u2014");
  });
});

describe("isIOS", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  // What iPadOS sends when it asks for the desktop site, which is the default.
  const IPAD_DESKTOP =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  it("detects an iPhone", () => {
    expect(isIOS(IPHONE, 5)).toBe(true);
  });

  it("detects an iPad that reports itself as a Mac", () => {
    expect(isIOS(IPAD_DESKTOP, 5)).toBe(true);
  });

  it("does not flag a Mac without a touch screen", () => {
    expect(isIOS(IPAD_DESKTOP, 0)).toBe(false);
    expect(isIOS(MAC_CHROME, 0)).toBe(false);
  });

  it("does not flag a Windows touch screen", () => {
    expect(isIOS(WINDOWS, 10)).toBe(false);
  });
});
