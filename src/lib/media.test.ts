import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDuration } from "./media";

// Just enough of an <audio> element for readDuration.
class FakeAudio {
  preload = "";
  duration = NaN;
  src = "";
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  load = vi.fn();

  /** What the browser does once it has read the file's header. */
  metadata(duration: number) {
    this.duration = duration;
    this.onloadedmetadata?.();
  }
}

let audio: FakeAudio;
let revoke: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  audio = new FakeAudio();
  vi.stubGlobal("document", { createElement: vi.fn(() => audio) });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:memo");
  revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

const file = new Blob([new Uint8Array(16)], { type: "audio/mpeg" });

describe("readDuration", () => {
  it("reads only the metadata of the file", async () => {
    const pending = readDuration(file);
    expect(audio.preload).toBe("metadata");
    expect(audio.src).toBe("blob:memo");
    expect(audio.load).toHaveBeenCalledOnce();
    audio.metadata(754.25);
    await expect(pending).resolves.toBe(754.25);
  });

  it("revokes the URL and stops loading once done", async () => {
    const pending = readDuration(file);
    audio.metadata(60);
    await pending;
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:memo");
    expect(audio.src).toBe("");
    expect(audio.load).toHaveBeenCalled();
  });

  it("returns null for a file that reports no length", async () => {
    const pending = readDuration(file);
    audio.metadata(Infinity);
    await expect(pending).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("returns null when the browser can't open the file", async () => {
    const pending = readDuration(file);
    audio.onerror?.();
    await expect(pending).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("gives up after the timeout and ignores a late answer", async () => {
    vi.useFakeTimers();
    const pending = readDuration(file, 5000);
    vi.advanceTimersByTime(4999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledOnce();
    audio.metadata(60);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("returns null when no object URL can be made", async () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(readDuration(file)).resolves.toBeNull();
    expect(revoke).not.toHaveBeenCalled();
  });
});
