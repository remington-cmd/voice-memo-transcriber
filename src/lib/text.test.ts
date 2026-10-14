import { describe, expect, it } from "vitest";
import { truncateWords } from "./text";

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

describe("truncateWords", () => {
  it("returns text under the cap unchanged", () => {
    const input = words(100);
    expect(truncateWords(input, 8000)).toEqual({
      text: input,
      truncated: false,
      wordsUsed: 100,
      totalWords: 100,
    });
  });

  it("keeps the first maxWords words and appends the marker when over the cap", () => {
    const result = truncateWords(words(9000), 8000);

    expect(result.truncated).toBe(true);
    expect(result.wordsUsed).toBe(8000);
    expect(result.totalWords).toBe(9000);
    expect(result.text).toBe(words(8000) + "\n\n[transcript truncated]");
  });

  it("does not truncate at exactly maxWords", () => {
    const input = words(8000);
    expect(truncateWords(input, 8000).text).toBe(input);
  });
});
