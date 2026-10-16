import { describe, expect, it } from "vitest";
import {
  ACCEPT,
  ACCEPTED_EXTENSIONS,
  MAX_SIZE_LABEL,
  decodeFailedMessage,
  isAacFile,
  rejectionMessage,
} from "./files";

function rejected(...codes: string[]) {
  return { errors: codes.map((code) => ({ code, message: code })) };
}

describe("ACCEPTED_EXTENSIONS", () => {
  it("lists every extension in the accept map", () => {
    for (const exts of Object.values(ACCEPT)) {
      for (const ext of exts) expect(ACCEPTED_EXTENSIONS).toContain(ext);
    }
    expect(ACCEPTED_EXTENSIONS).toContain(".webm");
  });

  it("lists .m4a and .mp4 once each, though two MIME types name them", () => {
    expect(new Set(ACCEPTED_EXTENSIONS).size).toBe(ACCEPTED_EXTENSIONS.length);
    expect(ACCEPTED_EXTENSIONS.filter((e) => e === ".m4a")).toHaveLength(1);
    expect(ACCEPTED_EXTENSIONS.filter((e) => e === ".mp4")).toHaveLength(1);
  });
});

describe("rejectionMessage", () => {
  it("asks for one file at a time when several are dropped", () => {
    expect(rejectionMessage([rejected("too-many-files"), rejected("too-many-files")])).toBe(
      "Drop one file at a time."
    );
  });

  it("reports several files even when the first is also the wrong type", () => {
    expect(rejectionMessage([rejected("file-invalid-type"), rejected("too-many-files")])).toBe(
      "Drop one file at a time."
    );
  });

  it("reports a file over the size cap", () => {
    expect(MAX_SIZE_LABEL).toBe("500 MB");
    expect(rejectionMessage([rejected("file-too-large")])).toBe("File is larger than 500 MB.");
  });

  it("lists the accepted extensions for a wrong type", () => {
    expect(rejectionMessage([rejected("file-invalid-type", "file-too-large")])).toBe(
      "Unsupported file type. Use .m4a, .mp4, .mp3, .wav, .webm, .ogg."
    );
  });

  it("falls back to a general message for any other code", () => {
    const message = rejectionMessage([rejected("file-too-small")]);
    expect(message).toContain(".webm");
    expect(message).toContain("500 MB");
  });

  it("uses no em-dashes", () => {
    for (const code of ["too-many-files", "file-too-large", "file-invalid-type", "other"]) {
      expect(rejectionMessage([rejected(code)])).not.toContain("\u2014");
    }
  });
});

describe("decodeFailedMessage", () => {
  it("names the file's extension, in lower case", () => {
    expect(decodeFailedMessage("Memo 12.OGG")).toBe(
      "This browser couldn't decode this .ogg file for splitting. Convert it to MP3 or AAC (.m4a), or try Chrome."
    );
  });

  it("says 'this file' when there is no usable extension", () => {
    expect(decodeFailedMessage("memo")).toContain("decode this file for splitting");
    expect(decodeFailedMessage(".hidden")).toContain("decode this file for splitting");
    expect(decodeFailedMessage("memo.")).toContain("decode this file for splitting");
  });

  it("calls a failed .mp3 damaged instead of saying to convert it to MP3", () => {
    expect(decodeFailedMessage("corrupt5mb.MP3")).toBe(
      "This browser couldn't decode this .mp3 file for splitting. It may be damaged. Try exporting it again."
    );
  });

  it("names Lossless for a failed .m4a, and does not say to convert it to .m4a", () => {
    const message = decodeFailedMessage("New Recording.m4a");
    expect(message).toBe(
      "This browser couldn't decode this .m4a file for splitting. It may be damaged or recorded as Lossless. Try exporting it again, or convert it to MP3."
    );
    expect(message).not.toContain("AAC (.m4a)");
  });

  it("keeps the advice to convert for formats every browser may not decode", () => {
    for (const name of ["memo.webm", "memo.wav", "clip.mp4", "memo"]) {
      expect(decodeFailedMessage(name)).toContain("Convert it to MP3 or AAC (.m4a), or try Chrome.");
    }
  });

  it("blames the browser, not the file, when it has no AAC decoder", () => {
    for (const name of ["New Recording.m4a", "clip.MP4", "memo.aac"]) {
      const message = decodeFailedMessage(name, false);
      expect(message).toContain("It can't play AAC audio.");
      expect(message).toContain("Use a current Chrome, Edge or Safari, or convert the file to MP3.");
      expect(message).not.toContain("damaged");
    }
    // With an AAC decoder present, a failed .m4a keeps the damaged/Lossless advice.
    expect(decodeFailedMessage("New Recording.m4a", true)).toContain("recorded as Lossless");
  });

  it("ignores missing AAC support for files that are not AAC", () => {
    expect(decodeFailedMessage("memo.mp3", false)).toBe(decodeFailedMessage("memo.mp3"));
    expect(decodeFailedMessage("memo.ogg", false)).toBe(decodeFailedMessage("memo.ogg"));
  });

  it("uses no em-dashes", () => {
    for (const name of ["a.mp3", "a.m4a", "a.ogg", "a"]) {
      expect(decodeFailedMessage(name)).not.toContain("—");
      expect(decodeFailedMessage(name, false)).not.toContain("—");
    }
  });
});

describe("isAacFile", () => {
  it("recognises AAC extensions in any case", () => {
    for (const name of ["New Recording.m4a", "MEMO.M4A", "clip.mp4", "memo.aac"]) {
      expect(isAacFile(name)).toBe(true);
    }
  });

  it("rejects other formats and names without an extension", () => {
    for (const name of ["memo.mp3", "memo.wav", "memo.ogg", "memo.webm", "memo", ".m4a", "m4a"]) {
      expect(isAacFile(name)).toBe(false);
    }
  });
});
