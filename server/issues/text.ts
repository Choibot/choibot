// server/issues/text.ts — length limits counted in code points, so a cut never
// leaves a lone surrogate (Telegram rejects such text as invalid UTF-8).

// The first `n` code points of `text`. Same as slice(0, n) for BMP-only text.
export function truncateChars(text: string, n: number): string {
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join("") : text;
}

// `text` cut to at most `max` code points, ending in "…" when cut.
export function ellipsize(text: string, max: number): string {
  return Array.from(text).length > max ? `${truncateChars(text, max - 1)}…` : text;
}
