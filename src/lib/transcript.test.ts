import { describe, expect, it } from "vitest";
import { chunkFilename, joinTranscripts, transcriptFilename } from "./transcript";

describe("joinTranscripts", () => {
  it("trims each part and joins them with single spaces", () => {
    expect(joinTranscripts([" first part ", "second\n", "third"])).toBe(
      "first part second third"
    );
  });

  it("does not break a sentence that spans a chunk cut", () => {
    expect(joinTranscripts(["We should ship", "on Friday."])).toBe("We should ship on Friday.");
  });

  it("drops empty and whitespace-only parts", () => {
    expect(joinTranscripts(["one", "", "  \n ", "two"])).toBe("one two");
    expect(joinTranscripts(["", " "])).toBe("");
    expect(joinTranscripts([])).toBe("");
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
