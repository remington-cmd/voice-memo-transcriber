// Browser-side audio chunking using the Web Audio API.
// Decodes any audio file, downmixes to 16 kHz mono (what Whisper wants),
// and splits it into fixed-length WAV chunks small enough for the 25 MB API limit.

const TARGET_SAMPLE_RATE = 16000; // Whisper internally works at 16 kHz
// 2 minutes per chunk. As 16 kHz mono 16-bit WAV this is ~3.8 MB, which stays
// safely under Vercel's ~4.5 MB serverless request body limit (and Whisper's
// 25 MB cap). Shorter chunks = more requests but reliable uploads.
const CHUNK_SECONDS = 120;

export interface AudioChunk {
  blob: Blob;
  index: number;
}

/**
 * Decode + downsample an audio file to 16 kHz mono and slice it into
 * ~5 minute WAV chunks. Returns one chunk for short files.
 */
export async function chunkAudioFile(file: File): Promise<AudioChunk[]> {
  const arrayBuffer = await file.arrayBuffer();

  // Decode using a throwaway AudioContext
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const decodeCtx = new AudioCtx();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  await decodeCtx.close();

  // Resample to 16 kHz mono via an OfflineAudioContext
  const durationSeconds = decoded.duration;
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(durationSeconds * TARGET_SAMPLE_RATE),
    TARGET_SAMPLE_RATE
  );
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();

  const samples = rendered.getChannelData(0);
  const samplesPerChunk = CHUNK_SECONDS * TARGET_SAMPLE_RATE;
  const chunks: AudioChunk[] = [];

  for (let start = 0, index = 0; start < samples.length; start += samplesPerChunk, index++) {
    const slice = samples.subarray(start, Math.min(start + samplesPerChunk, samples.length));
    chunks.push({
      blob: encodeWav(slice, TARGET_SAMPLE_RATE),
      index,
    });
  }

  return chunks;
}

/** Encode a Float32 PCM buffer into a 16-bit mono WAV Blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
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
