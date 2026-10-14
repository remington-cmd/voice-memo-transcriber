import { describe, expect, it, vi } from "vitest";
import { wavBytes } from "@/lib/limits";
import { chunkAudioFile } from "./audio-chunker";

/** A decoded mono buffer of silence, with getChannelData spied on. */
function decodedAudio(seconds: number) {
  const data = new Float32Array(seconds * 16000);
  const getChannelData = vi.fn(() => data);
  const buffer = { numberOfChannels: 1, getChannelData } as unknown as AudioBuffer;
  return { buffer, getChannelData };
}

/** Stands in for the browser's OfflineAudioContext, which Node does not have. */
function stubDecoder(decode: () => Promise<AudioBuffer>) {
  const decodeAudioData = vi.fn(decode);
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData = decodeAudioData;
    }
  );
  return decodeAudioData;
}

const file = () => new File([new Uint8Array(16)], "memo.m4a", { type: "audio/mp4" });

describe("chunkAudioFile", () => {
  it("encodes the decoded audio as WAV chunks", async () => {
    const audio = decodedAudio(3);
    stubDecoder(async () => audio.buffer);

    const chunks = await chunkAudioFile(file());

    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].blob.size).toBe(wavBytes(3));
  });

  it("stops without encoding when cancelled during the decode", async () => {
    const controller = new AbortController();
    const audio = decodedAudio(3);
    stubDecoder(async () => {
      controller.abort();
      return audio.buffer;
    });

    const err = await chunkAudioFile(file(), controller.signal).catch((e: unknown) => e);

    expect((err as DOMException).name).toBe("AbortError");
    // The samples are never read, so nothing is mixed down or encoded.
    expect(audio.getChannelData).not.toHaveBeenCalled();
  });

  it("does not start a decode when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const decode = stubDecoder(async () => decodedAudio(3).buffer);

    const err = await chunkAudioFile(file(), controller.signal).catch((e: unknown) => e);

    expect((err as DOMException).name).toBe("AbortError");
    expect(decode).not.toHaveBeenCalled();
  });
});
