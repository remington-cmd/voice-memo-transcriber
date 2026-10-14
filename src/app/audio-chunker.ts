// Browser-side audio chunking using the Web Audio API.
// Decodes any audio file, downmixes to 16 kHz mono (what Whisper wants), and
// splits it into WAV chunks of at most about 2 minutes (3.84 MB). Each chunk is
// uploaded as its own request, which must stay under Vercel's 4.5 MB request
// body cap (see src/lib/limits.ts).

import { TARGET_SAMPLE_RATE } from "@/lib/limits";
import { encodeWav, planChunkRanges } from "@/lib/wav";

export interface AudioChunk {
  blob: Blob;
  index: number;
}

/**
 * Decode + downsample an audio file to 16 kHz mono and slice it into WAV
 * chunks of up to CHUNK_SECONDS (120 s), each cut at a quiet point where one
 * is found (see planChunkRanges). Returns one chunk for short files.
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

  return planChunkRanges(samples, TARGET_SAMPLE_RATE).map(([start, end], index) => ({
    blob: encodeWav(samples.subarray(start, end), TARGET_SAMPLE_RATE),
    index,
  }));
}
