import { describe, expect, it } from "vitest";
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

describe("planChunkRanges", () => {
  it("covers every sample with contiguous ranges and a short tail", () => {
    const perChunk = 1000;
    const ranges = planChunkRanges(2.5 * perChunk, perChunk);

    expect(ranges).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 2500],
    ]);
    expect(ranges[2][1] - ranges[2][0]).toBe(perChunk / 2);
  });

  it("returns a single range when everything fits in one chunk", () => {
    expect(planChunkRanges(10, 1000)).toEqual([[0, 10]]);
  });
});
