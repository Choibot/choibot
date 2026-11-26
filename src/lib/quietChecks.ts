// src/lib/quietChecks.ts — the activity of the fleet master that its chat hides (pure).
// The chat is the user's: what the console typed into the fleet master and what it answered
// with nothing for the user is activity, not chat. Hidden unless "Show activity" is on:
// - an event digest (a line that the console typed: "[events] …"). Since the Coordinator reads
//   the events the fleet master gets none; its older session still holds them;
// - a "(quiet)" reply: the one word the fleet master wrote when a digest had nothing for the user;
// - the steps of a digest turn in which it wrote nothing else.
// Never hidden: a turn the user started (a typed line, a queue answer, a reminder), a text the
// fleet master wrote in a digest turn (it can be an alert), and every queue ticket.
import type { Row } from "./threadTickets";

export const QUIET_MARK = "(quiet)";

// The reply that marks a quiet turn. An older "(quiet) <what I checked>" line counts too.
export function isQuietReply(text: string): boolean {
  return text.trimStart().startsWith(QUIET_MARK);
}

const startsTurn = (r: Row): boolean => r.type === "msg" && (r.item.kind === "user" || r.item.kind === "peer");
const isDigest = (r: Row): boolean => r.type === "msg" && r.item.kind === "user" && r.item.via === "events";
const isQuietRow = (r: Row): boolean => r.type === "msg" && r.item.kind === "assistant" && isQuietReply(r.item.text);

// The rows the chat shows, and how many digest turns it hides.
export function hideActivity(rows: Row[]): { rows: Row[]; hidden: number } {
  const out: Row[] = [];
  let hidden = 0;
  for (let i = 0; i < rows.length;) {
    if (!isDigest(rows[i])) { out.push(rows[i++]); continue; }
    let end = i + 1;
    while (end < rows.length && !startsTurn(rows[end])) end++;
    const turn = rows.slice(i + 1, end);
    hidden++;
    // The fleet master wrote something else than "(quiet)" in this turn: its steps and that text stay.
    const spoke = turn.some((r) => r.type === "msg" && !isQuietRow(r));
    for (const r of turn) {
      if (r.type === "ticket" || r.type === "day") out.push(r);
      else if (spoke && !isQuietRow(r)) out.push(r);
    }
    i = end;
  }
  // A day line with nothing under it any more.
  const kept = out.filter((r, k) => r.type !== "day" || (k + 1 < out.length && out[k + 1].type !== "day"));
  return { rows: kept, hidden };
}
