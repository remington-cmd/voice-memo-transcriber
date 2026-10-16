// Text helpers shared by the API routes.

export interface TruncateResult {
  text: string;
  truncated: boolean;
  wordsUsed: number;
  totalWords: number;
}

/**
 * Cut `text` to its first `maxWords` words, appending a marker when anything was dropped.
 * Leading and trailing whitespace is not counted as a word.
 */
export function truncateWords(text: string, maxWords: number): TruncateResult {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/) : [];
  if (words.length > maxWords) {
    return {
      text: words.slice(0, maxWords).join(" ") + "\n\n[transcript truncated]",
      truncated: true,
      wordsUsed: maxWords,
      totalWords: words.length,
    };
  }
  return { text, truncated: false, wordsUsed: words.length, totalWords: words.length };
}
