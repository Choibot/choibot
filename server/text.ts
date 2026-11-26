// server/text.ts — small text helpers shared by the widget fallback, queue
// input checks and Telegram lines. Pure; no imports.

// One line of plain text: controls are dropped and every whitespace run becomes
// one space, so no newline run can push text out of view or start a new line.
export function oneLine(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, "").replace(/\s+/g, " ").trim();
}
