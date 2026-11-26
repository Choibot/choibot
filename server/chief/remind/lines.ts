// server/chief/remind/lines.ts — the line a due reminder types into an agent.
// It always says who set it and when, so the agent reads it as its own (or
// its lead's or master's) earlier note, never as the user's order.
import type { Reminder } from "./store.js";

const pad = (n: number) => String(n).padStart(2, "0");

// 2026-11-10 15:40 UTC
export function reminderDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// The queue's line breaks (queue/lines.ts userText): CRLF, CR, LF, U+2028,
// U+2029 and NEL. A TUI may break a line at any of them.
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029\u0085]/;

// `recipient` is the agent the line goes to: the target, or the fleet master
// when the target's record is gone. Every line of the text after the first is
// indented, so none of them starts like a [queue …] or [events] line, and no
// line break the split missed can put one on the header line.
export function formatReminderLine(r: Reminder, recipient: string): string {
  const who = r.setBy === recipient ? "you" : r.setBy;
  const label = r.agentLabel.replace(/"/g, "'").replace(/[\s\u0085]+/g, " ").trim();
  const head = recipient === r.agentId
    ? `(set by ${who} on ${reminderDate(r.createdAt)})`
    : `(for deleted agent ${r.agentId} "${label}"; set by ${who} on ${reminderDate(r.createdAt)})`;
  // Blank lines dropped (the master inbox joins a batch with a blank line),
  // trailing whitespace trimmed, as the queue does for a user answer.
  const text = r.text.split(LINE_BREAK).map((l) => l.trimEnd()).filter((l) => l !== "").join("\n  ");
  return `[reminder ${r.id}] ${head} ${text}`;
}
