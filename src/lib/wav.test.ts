import { describe, expect, it } from "vitest";
import { CHUNK_SECONDS, MAX_CHUNK_SECONDS, SILENCE_SEARCH_SECONDS } from "./limits";
import { encodeWav, planChunkRanges } from "./wav";

async function view(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(v: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(v.getUint8(offset + i));
  return s;
}

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM header", async () => {
    const n = 10;
    const blob = encodeWav(new Float32Array(n), 16000);
    const v = await view(blob);

    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 2 * n);
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 2 * n);
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(2 * n);
  });

  it("clamps samples outside [-1, 1]", async () => {
    const v = await view(encodeWav(new Float32Array([1.5, -1.5, 0]), 16000));
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
    expect(v.getInt16(48, true)).toBe(0);
  });
});

const RATE = 16000;
const SEC = RATE;

// A 1 kHz square wave: every sample has the same magnitude, so every frame has
// exactly the same RMS wherever it starts.
function tone(length: number): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = Math.floor(i / 8) % 2 ? 0.5 : -0.5;
  return samples;
}

function withGap(samples: Float32Array, fromSec: number, toSec: number): Float32Array {
  samples.fill(0, Math.round(fromSec * SEC), Math.round(toSec * SEC));
  return samples;
}

// Deterministic noise with a slowly varying loudness, like speech.
function noise(length: number, seed: number): Float32Array {
  const samples = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const envelope = 0.55 + 0.45 * Math.sin(i / 3001 + seed);
    samples[i] = (state / 2 ** 32 - 0.5) * envelope;
  }
  return samples;
}

function expectValidPlan(ranges: Array<[number, number]>, total: number) {
  expect(ranges[0][0]).toBe(0);
  expect(ranges[ranges.length - 1][1]).toBe(total);
  for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
  for (const [start, end] of ranges) {
    expect(end - start).toBeLessThanOrEqual(MAX_CHUNK_SECONDS * RATE);
    expect(end - start).toBeGreaterThanOrEqual(1600);
  }
}

function plan(samples: Float32Array): Array<[number, number]> {
  const ranges = planChunkRanges(samples, RATE);
  expectValidPlan(ranges, samples.length);
  return ranges;
}

describe("planChunkRanges", () => {
  it("cuts an exact multiple of the chunk length into full chunks", () => {
    expect(plan(tone(240 * SEC))).toEqual([
      [0, 120 * SEC],
      [120 * SEC, 240 * SEC],
    ]);
  });

  it.each([1, 1599])("merges a %i-sample remainder into the last chunk", (extra) => {
    const ranges = plan(tone(240 * SEC + extra));

    expect(ranges).toEqual([
      [0, 120 * SEC],
      [120 * SEC, 240 * SEC + extra],
    ]);
    expect(ranges[1][1] - ranges[1][0]).toBeLessThanOrEqual(121 * SEC);
  });

  it("keeps a 1 s remainder as its own chunk", () => {
    expect(plan(tone(240 * SEC + 16000))).toEqual([
      [0, 120 * SEC],
      [120 * SEC, 240 * SEC],
      [240 * SEC, 241 * SEC],
    ]);
  });

  it("refuses a recording shorter than 0.1 s", () => {
    expect(() => planChunkRanges(tone(1000), RATE)).toThrow("too short");
    expect(() => planChunkRanges(new Float32Array(0), RATE)).toThrow("too short");
  });

  it("returns a single range when everything fits in one chunk", () => {
    expect(plan(tone(1600))).toEqual([[0, 1600]]);
    expect(plan(tone(120 * SEC))).toEqual([[0, 120 * SEC]]);
  });

  it("cuts inside a short silence just before the nominal cut", () => {
    const [[, cut]] = plan(withGap(tone(200 * SEC), 115, 115.2));

    expect(cut).toBeGreaterThanOrEqual(115 * SEC);
    expect(cut).toBeLessThanOrEqual(115.2 * SEC);
  });

  it("cuts a uniform signal exactly at the nominal cut", () => {
    const [[, cut]] = plan(tone(200 * SEC));
    expect(cut).toBe(120 * SEC);
  });

  it("never looks past the nominal cut for a quiet point", () => {
    const [[, cut]] = plan(withGap(tone(200 * SEC), 120.5, 121));
    expect(cut).toBe(120 * SEC);
  });

  it("ignores silence further back than the search window", () => {
    const [[, cut]] = plan(withGap(tone(200 * SEC), 100, 101));
    expect(cut).toBe(120 * SEC);
  });

  it("gives the same plan for the same samples", () => {
    const samples = noise(250 * SEC, 7);
    expect(planChunkRanges(samples, RATE)).toEqual(planChunkRanges(samples, RATE));
  });

  it.each([
    [121 * SEC, 1],
    [240 * SEC - 1, 2],
    [360 * SEC + 800, 3],
    [480 * SEC + 3 * SEC, 4],
  ])("plans valid chunks for %i samples of noise", (length, seed) => {
    const ranges = plan(noise(length, seed));
    for (const [start, end] of ranges.slice(0, -1)) {
      expect(end - start).toBeGreaterThanOrEqual((CHUNK_SECONDS - SILENCE_SEARCH_SECONDS) * RATE);
      expect(end - start).toBeLessThanOrEqual(CHUNK_SECONDS * RATE);
    }
  });
});
