// Drives the chunked transcription of one file.

import type { AudioChunk } from "@/app/audio-chunker";
import { chunkFilename, joinTranscripts } from "./transcript";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Why a chunked transcription stopped, and how far it got. */
export class ChunkError extends Error {
  /** Zero-based index of the chunk that failed or was not started. */
  readonly index: number;
  readonly total: number;
  /** How many chunks have a transcript, counting ones done by earlier runs. */
  readonly completed: number;
  /** True when the run was aborted rather than failed. */
  readonly cancelled: boolean;

  constructor(init: {
    index: number;
    total: number;
    completed: number;
    cancelled: boolean;
    cause: unknown;
  }) {
    const { index, total, completed, cancelled, cause } = init;
    super(
      cancelled
        ? `Cancelled at chunk ${index + 1} of ${total} (${completed} completed).`
        : `Chunk ${index + 1} of ${total} failed (${completed} completed): ${messageOf(cause)}`
    );
    this.name = "ChunkError";
    this.index = index;
    this.total = total;
    this.completed = completed;
    this.cancelled = cancelled;
    this.cause = cause;
  }
}

/**
 * Upload chunks one at a time, in order, reporting progress before each. Each
 * is uploaded under its chunkFilename, built from `name`, the source file's name.
 *
 * `parts` is owned by the caller and filled in place: parts[i] is chunk i's raw
 * transcript. Chunks that already have one are skipped, so calling again with
 * the same parts after a failure resumes at the failed chunk without paying
 * for the earlier ones twice. On success every chunk has a transcript and the
 * same array is returned; join it with joinTranscripts.
 *
 * Any failure, or an abort, throws a ChunkError.
 */
export async function transcribeChunks({
  name,
  chunks,
  parts,
  upload,
  onProgress,
  signal,
}: {
  name: string;
  chunks: AudioChunk[];
  parts: (string | undefined)[];
  upload: (chunk: AudioChunk, filename: string) => Promise<string>;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}): Promise<string[]> {
  const completed = () => parts.filter((part) => part !== undefined).length;

  for (const chunk of chunks) {
    if (parts[chunk.index] !== undefined) continue;
    const stop = (cancelled: boolean, cause: unknown) =>
      new ChunkError({
        index: chunk.index,
        total: chunks.length,
        completed: completed(),
        cancelled,
        cause,
      });

    if (signal?.aborted) throw stop(true, signal.reason);
    onProgress(`Transcribing chunk ${chunk.index + 1} of ${chunks.length}…`);
    try {
      parts[chunk.index] = await upload(chunk, chunkFilename(name, chunk.index));
    } catch (err) {
      throw stop(signal?.aborted ?? false, err);
    }
  }
  return parts as string[];
}

/**
 * The text of the chunks done so far, followed by a note saying where and why
 * the transcription stopped. Null when no chunk produced any text, since a
 * card with only the note would not be worth saving.
 */
export function partialTranscript(
  parts: readonly (string | undefined)[],
  error: ChunkError
): string | null {
  const text = joinTranscripts(parts.filter((part): part is string => part !== undefined));
  if (!text) return null;
  const reason = error.cancelled ? "cancelled" : messageOf(error.cause).replace(/\.$/, "");
  return `${text}\n\n[Transcription stopped at chunk ${error.index + 1} of ${error.total}: ${reason}]`;
}
