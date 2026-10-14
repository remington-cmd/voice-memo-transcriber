import { describe, expect, it, vi } from "vitest";
import type { AudioChunk } from "@/app/audio-chunker";
import { ApiError } from "./api-client";
import { ChunkError, partialTranscript, transcribeChunks } from "./pipeline";

function makeChunks(n: number): AudioChunk[] {
  return Array.from({ length: n }, (_, index) => ({ blob: new Blob([`c${index}`]), index }));
}

async function caught(promise: Promise<unknown>): Promise<ChunkError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ChunkError);
  return err as ChunkError;
}

describe("transcribeChunks", () => {
  it("uploads chunks in order, each under its chunk name, with progress before each", async () => {
    const chunks = makeChunks(3);
    const events: string[] = [];
    const upload = vi.fn(async (chunk: AudioChunk, filename: string) => {
      events.push(`upload ${filename}`);
      return ` text ${chunk.index} `;
    });
    const onProgress = vi.fn((message: string) => events.push(message));
    const parts: (string | undefined)[] = [];

    const result = await transcribeChunks({ name: "memo.m4a", chunks, parts, upload, onProgress });

    expect(upload.mock.calls).toEqual([
      [chunks[0], "memo.m4a.part1.wav"],
      [chunks[1], "memo.m4a.part2.wav"],
      [chunks[2], "memo.m4a.part3.wav"],
    ]);
    expect(events).toEqual([
      "Transcribing chunk 1 of 3…",
      "upload memo.m4a.part1.wav",
      "Transcribing chunk 2 of 3…",
      "upload memo.m4a.part2.wav",
      "Transcribing chunk 3 of 3…",
      "upload memo.m4a.part3.wav",
    ]);
    expect(result).toEqual([" text 0 ", " text 1 ", " text 2 "]);
    // The caller's array is the one that was filled.
    expect(result).toBe(parts);
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

    await transcribeChunks({
      name: "memo.m4a",
      chunks: makeChunks(4),
      parts: [],
      upload,
      onProgress: () => {},
    });
    expect(maxInFlight).toBe(1);
  });

  it("stops at a permanent failure on chunk 3 of 5 and keeps the 2 done", async () => {
    const cause = new ApiError("The audio is too short to transcribe (HTTP 422).", {
      status: 422,
      retryable: false,
    });
    const upload = vi.fn(async (chunk: AudioChunk) => {
      if (chunk.index === 2) throw cause;
      return `text ${chunk.index}`;
    });
    const parts: (string | undefined)[] = [];

    const err = await caught(
      transcribeChunks({
        name: "memo.m4a",
        chunks: makeChunks(5),
        parts,
        upload,
        onProgress: () => {},
      })
    );

    expect(err).toMatchObject({ index: 2, total: 5, completed: 2, cancelled: false, cause });
    expect(err.message).toBe(
      "Chunk 3 of 5 failed (2 completed): The audio is too short to transcribe (HTTP 422)."
    );
    expect(err.name).toBe("ChunkError");
    expect(upload).toHaveBeenCalledTimes(3);
    expect(parts).toEqual(["text 0", "text 1"]);
  });

  it("resumes at the failed chunk when called again with the same parts", async () => {
    const chunks = makeChunks(5);
    const parts: (string | undefined)[] = [];
    let failChunk3 = true;
    const upload = vi.fn(async (chunk: AudioChunk) => {
      if (chunk.index === 2 && failChunk3) throw new Error("Network error. Check your connection.");
      return `text ${chunk.index}`;
    });
    const progress: string[] = [];
    const onProgress = (message: string) => progress.push(message);

    await caught(transcribeChunks({ name: "memo.m4a", chunks, parts, upload, onProgress }));
    expect(upload).toHaveBeenCalledTimes(3);

    upload.mockClear();
    progress.length = 0;
    failChunk3 = false;
    const result = await transcribeChunks({ name: "memo.m4a", chunks, parts, upload, onProgress });

    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls.map(([chunk]) => chunk.index)).toEqual([2, 3, 4]);
    expect(progress).toEqual([
      "Transcribing chunk 3 of 5…",
      "Transcribing chunk 4 of 5…",
      "Transcribing chunk 5 of 5…",
    ]);
    expect(result).toEqual(["text 0", "text 1", "text 2", "text 3", "text 4"]);
  });

  it("counts chunks done by an earlier run as completed", async () => {
    const parts: (string | undefined)[] = ["a", "b", "c"];
    const upload = vi.fn(async () => {
      throw new Error("boom");
    });
    const err = await caught(
      transcribeChunks({
        name: "memo.m4a",
        chunks: makeChunks(5),
        parts,
        upload,
        onProgress: () => {},
      })
    );
    expect(err).toMatchObject({ index: 3, completed: 3 });
    expect(err.message).toBe("Chunk 4 of 5 failed (3 completed): boom");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("reports an abort during an upload as cancelled", async () => {
    const controller = new AbortController();
    const upload = vi.fn(async (chunk: AudioChunk) => {
      if (chunk.index === 1) {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return `text ${chunk.index}`;
    });
    const parts: (string | undefined)[] = [];

    const err = await caught(
      transcribeChunks({
        name: "memo.m4a",
        chunks: makeChunks(4),
        parts,
        upload,
        onProgress: () => {},
        signal: controller.signal,
      })
    );

    expect(err).toMatchObject({ index: 1, total: 4, completed: 1, cancelled: true });
    expect(err.message).toBe("Cancelled at chunk 2 of 4 (1 completed).");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(parts).toEqual(["text 0"]);
  });

  it("starts no further chunk after an abort between uploads", async () => {
    const controller = new AbortController();
    const upload = vi.fn(async (chunk: AudioChunk) => {
      if (chunk.index === 1) controller.abort();
      return `text ${chunk.index}`;
    });
    const parts: (string | undefined)[] = [];

    const err = await caught(
      transcribeChunks({
        name: "memo.m4a",
        chunks: makeChunks(4),
        parts,
        upload,
        onProgress: () => {},
        signal: controller.signal,
      })
    );

    expect(err).toMatchObject({ index: 2, completed: 2, cancelled: true });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(parts).toEqual(["text 0", "text 1"]);
  });
});

describe("partialTranscript", () => {
  const failure = (cancelled: boolean, cause: unknown = new Error("Server error (HTTP 500).")) =>
    new ChunkError({ index: 2, total: 5, completed: 2, cancelled, cause });

  it("joins the parts done and notes where and why it stopped", () => {
    expect(partialTranscript([" one ", "two"], failure(false))).toBe(
      "one two\n\n[Transcription stopped at chunk 3 of 5: Server error (HTTP 500)]"
    );
  });

  it("says when the job was cancelled", () => {
    expect(partialTranscript(["one", "two"], failure(true))).toBe(
      "one two\n\n[Transcription stopped at chunk 3 of 5: cancelled]"
    );
  });

  it("returns null when no chunk produced any text", () => {
    expect(partialTranscript([], failure(false))).toBeNull();
    expect(partialTranscript([" ", ""], failure(false))).toBeNull();
  });
});
