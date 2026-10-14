// WAV encoding and chunk slicing for 16-bit mono PCM.

import {
  CHUNK_SECONDS,
  MIN_AUDIO_SECONDS,
  MIN_TAIL_SECONDS,
  SILENCE_SEARCH_SECONDS,
} from "./limits";

/** Encode a Float32 PCM buffer into a 16-bit mono WAV Blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

export interface ChunkPlanOptions {
  chunkSeconds?: number;
  minTailSeconds?: number;
  searchSeconds?: number;
}

// Length of the frames compared when looking for a quiet place to cut.
const FRAME_SECONDS = 0.03;

/**
 * Split decoded audio into consecutive [start, end) sample ranges, one per upload.
 *
 * While more than `chunkSeconds` remain, each cut goes at the centre of the
 * quietest 30 ms frame (frames are 15 ms apart) in the `searchSeconds` before
 * the nominal cut, so it tends to land between words. The search only looks
 * backwards, so no chunk is longer than `chunkSeconds`, except that a remainder
 * shorter than `minTailSeconds` is merged into the last chunk rather than sent
 * alone (OpenAI rejects audio under 0.1 s). A recording shorter than 0.1 s
 * throws. The plan depends only on the samples, so the same decode always gives
 * the same chunks.
 */
export function planChunkRanges(
  samples: Float32Array,
  sampleRate: number,
  opts: ChunkPlanOptions = {}
): Array<[number, number]> {
  const {
    chunkSeconds = CHUNK_SECONDS,
    minTailSeconds = MIN_TAIL_SECONDS,
    searchSeconds = SILENCE_SEARCH_SECONDS,
  } = opts;
  const total = samples.length;
  if (total < Math.round(MIN_AUDIO_SECONDS * sampleRate)) {
    throw new Error("Recording is too short to transcribe.");
  }

  const perChunk = Math.round(chunkSeconds * sampleRate);
  const minTail = Math.round(minTailSeconds * sampleRate);
  const search = Math.round(searchSeconds * sampleRate);
  const frame = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));

  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (total - start > perChunk) {
    const nominal = start + perChunk;
    let end = quietestCut(samples, Math.max(start + 1, nominal - search), nominal, frame);
    if (total - end < minTail) end = total;
    ranges.push([start, end]);
    start = end;
  }
  if (start < total) ranges.push([start, total]);
  return ranges;
}

/**
 * Centre of the lowest-RMS frame among frames centred in [from, to], scanning
 * back from `to`. Only a strictly quieter frame replaces the best so far, so a
 * uniform signal is cut at `to` and ties go to the later frame.
 */
function quietestCut(samples: Float32Array, from: number, to: number, frame: number): number {
  const half = Math.floor(frame / 2);
  const hop = Math.max(1, half);
  let best = to;
  let bestPower = Infinity;
  for (let centre = to; centre >= from; centre -= hop) {
    const power = meanSquare(samples, centre - half, centre - half + frame);
    if (power < bestPower) {
      bestPower = power;
      best = centre;
    }
  }
  return best;
}

// Mean of the squared samples in [from, to), clamped to the buffer. Ordering
// frames by this is the same as ordering them by RMS, without the square root.
function meanSquare(samples: Float32Array, from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(samples.length, to);
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += samples[i] * samples[i];
  return sum / (hi - lo);
}
