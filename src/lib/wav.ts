// WAV encoding and chunk slicing for 16-bit mono PCM.

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

/**
 * Split `totalSamples` into consecutive [start, end) ranges of
 * `samplesPerChunk`. The last range holds whatever is left, however short.
 */
export function planChunkRanges(
  totalSamples: number,
  samplesPerChunk: number
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < totalSamples; start += samplesPerChunk) {
    ranges.push([start, Math.min(start + samplesPerChunk, totalSamples)]);
  }
  return ranges;
}
