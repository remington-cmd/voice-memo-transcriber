// Text helpers shared by the API routes.

export interface TruncateResult {
  text: string;
  truncated: boolean;
  wordsUsed: number;
  totalWords: number;
}

/** Cut `text` to its first `maxWords` words, appending a marker when anything was dropped. */
export function truncateWords(text: string, maxWords: number): TruncateResult {
  const words = text.split(/\s+/);
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
