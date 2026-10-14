import { describe, expect, it } from "vitest";
import { chunkFilename, joinTranscripts, transcriptFilename } from "./transcript";

describe("joinTranscripts", () => {
  it("trims each part and separates them with a blank line", () => {
    expect(joinTranscripts([" first part ", "second\n", "third"])).toBe(
      "first part\n\nsecond\n\nthird"
    );
  });

  it("returns a single trimmed part unchanged otherwise", () => {
    expect(joinTranscripts(["  only  "])).toBe("only");
  });
});

describe("transcriptFilename", () => {
  it("replaces the extension", () => {
    expect(transcriptFilename("memo.m4a")).toBe("memo-transcript.txt");
  });

  it("only strips the last extension", () => {
    expect(transcriptFilename("team.sync.mp3")).toBe("team.sync-transcript.txt");
  });

  it("appends the suffix when there is no extension", () => {
    expect(transcriptFilename("memo")).toBe("memo-transcript.txt");
  });
});

describe("chunkFilename", () => {
  it("numbers chunks from 1", () => {
    expect(chunkFilename("memo.m4a", 0)).toBe("memo.m4a.part1.wav");
    expect(chunkFilename("memo.m4a", 9)).toBe("memo.m4a.part10.wav");
  });
});
