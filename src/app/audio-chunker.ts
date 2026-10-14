// Browser-side audio chunking using the Web Audio API.
// Decodes any audio file straight to 16 kHz (what Whisper wants), averages it
// to mono, and splits it into WAV chunks of at most about 2 minutes (3.84 MB).
// Each chunk is uploaded as its own request, which must stay under Vercel's
// 4.5 MB request body cap (see src/lib/limits.ts).
//
// The whole recording is held in memory while it is decoded, so a very long one
// can crash the tab. The page reads the length first and asks before splitting
// one that long (see assessLongFile).

import { decodeFailedMessage } from "@/lib/files";
import { TARGET_SAMPLE_RATE } from "@/lib/limits";
import { downmixToMono, encodeWav, planChunkRanges } from "@/lib/wav";

export interface AudioChunk {
  blob: Blob;
  index: number;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  // signal.throwIfAborted needs Safari 15.4.
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Decode an audio file to 16 kHz mono and slice it into WAV chunks of up to
 * CHUNK_SECONDS (120 s), each cut at a quiet point where one is found (see
 * planChunkRanges). Returns one chunk for short files.
 *
 * A decode cannot be interrupted, so aborting `signal` takes effect once it
 * ends: this then rejects with an AbortError instead of encoding the chunks.
 */
export async function chunkAudioFile(file: File, signal?: AbortSignal): Promise<AudioChunk[]> {
  // Safari before 14.1 only has the prefixed, callback-style API.
  if (typeof OfflineAudioContext !== "function") {
    throw new Error(
      "This browser is too old to split long recordings. Use a current Chrome or Safari."
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  throwIfAborted(signal);

  // decodeAudioData resamples to its context's rate with the decoder's
  // band-limited resampler, so a 16 kHz offline context yields 16 kHz audio
  // directly, whatever the output device runs at. It keeps every channel.
  let decoded: AudioBuffer;
  try {
    decoded = await new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE).decodeAudioData(arrayBuffer);
  } catch (e) {
    // Older WebKit rejects with null rather than an Error.
    throw new Error(decodeFailedMessage(file.name), { cause: e });
  }
  throwIfAborted(signal);

  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const samples = downmixToMono(channels);

  return planChunkRanges(samples, TARGET_SAMPLE_RATE).map(([start, end], index) => ({
    blob: encodeWav(samples.subarray(start, end), TARGET_SAMPLE_RATE),
    index,
  }));
}
