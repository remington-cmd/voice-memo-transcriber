import { describe, expect, it } from "vitest";
import {
  CHUNK_SECONDS,
  DIRECT_LIMIT,
  MAX_CHUNK_SECONDS,
  MAX_REQUEST_BYTES,
  MIN_TAIL_SECONDS,
  REQUEST_OVERHEAD_MARGIN,
  SILENCE_SEARCH_SECONDS,
  shouldChunk,
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

describe("shouldChunk", () => {
  it("uploads files up to DIRECT_LIMIT directly", () => {
    expect(shouldChunk(DIRECT_LIMIT)).toBe(false);
  });

  it("chunks anything larger than DIRECT_LIMIT", () => {
    expect(shouldChunk(DIRECT_LIMIT + 1)).toBe(true);
  });

  it("chunks a 15 MB memo instead of sending it whole into a 413", () => {
    expect(shouldChunk(15_000_000)).toBe(true);
  });
});
