// Pure terminal-input helpers for the mobile key bar. No DOM — unit-testable in
// the node test env (matches the theme-resolve.ts pattern).
export type TermKey = "esc" | "tab" | "up" | "down" | "left" | "right" | "enter";

const SEQ: Record<TermKey, string> = {
  esc: "\x1b",
  tab: "\t",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

export function keySeq(key: TermKey): string {
  return SEQ[key];
}

// Control byte for a single character: Ctrl-A..Ctrl-_ map the ASCII range 64–95
// (@A-Z[\]^_) to 0–31. Returns null for anything outside that range.
export function ctrlCode(letter: string): string | null {
  if (letter.length !== 1) return null;
  const c = letter.toUpperCase().charCodeAt(0);
  if (c < 64 || c > 95) return null;
  return String.fromCharCode(c - 64);
}
