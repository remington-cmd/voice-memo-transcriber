import { describe, expect, it, vi } from "vitest";
import type { AudioChunk } from "@/app/audio-chunker";
import { transcribeChunks } from "./pipeline";
import { chunkFilename } from "./transcript";

function makeChunks(n: number): AudioChunk[] {
  return Array.from({ length: n }, (_, index) => ({ blob: new Blob([`c${index}`]), index }));
}

describe("transcribeChunks", () => {
  it("uploads chunks in order and reports progress before each", async () => {
    const chunks = makeChunks(3);
    const events: string[] = [];
    const sent: string[] = [];
    // Mirrors the page: each chunk is uploaded under its chunkFilename.
    const upload = vi.fn(async (chunk: AudioChunk) => {
      const filename = chunkFilename("memo.m4a", chunk.index);
      events.push(`upload ${filename}`);
      sent.push(filename);
      return ` text ${chunk.index} `;
    });
    const onProgress = vi.fn((message: string) => events.push(message));

    const parts = await transcribeChunks(chunks, upload, onProgress);

    expect(sent).toEqual(["memo.m4a.part1.wav", "memo.m4a.part2.wav", "memo.m4a.part3.wav"]);
    expect(upload.mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
    expect(events).toEqual([
      "Transcribing chunk 1 of 3…",
      "upload memo.m4a.part1.wav",
      "Transcribing chunk 2 of 3…",
      "upload memo.m4a.part2.wav",
      "Transcribing chunk 3 of 3…",
      "upload memo.m4a.part3.wav",
    ]);
    expect(parts).toEqual([" text 0 ", " text 1 ", " text 2 "]);
  });

  it("uploads one chunk at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const upload = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return "ok";
    };

    await transcribeChunks(makeChunks(4), upload, () => {});
    expect(maxInFlight).toBe(1);
  });

  it("stops at the first failed chunk", async () => {
    const upload = vi.fn(async (chunk: AudioChunk) => {
      if (chunk.index === 1) throw new Error("boom");
      return "ok";
    });

    await expect(transcribeChunks(makeChunks(3), upload, () => {})).rejects.toThrow("boom");
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
