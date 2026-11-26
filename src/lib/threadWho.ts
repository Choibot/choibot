// src/lib/threadWho.ts — who speaks in the thread. The name shows once at the
// start of each group of rows from the same speaker: the agent's steps, its
// subagents and its tickets belong to the agent's group; a day line starts a
// new group; a note (an interrupt, a compaction) belongs to no group.
import type { Message } from "./thread";
import type { Row } from "./threadTickets";

export type Speaker = { name: string; mine: boolean; agent?: true };
export type SpeakerHead = Speaker & { ts: number };

const AGENT: Speaker = { name: "Claude", mine: false, agent: true };

// `mine`: what the user wrote (on the right), not a console event line or a reminder.
export function speakerOf(m: Message): Speaker {
  if (m.kind === "assistant") return AGENT;
  if (m.kind === "peer") return { name: m.from ?? "Peer", mine: false };
  if (m.via === "events") return { name: "Console", mine: false };
  if (m.via === "reminder") return { name: "Reminder", mine: false };
  return { name: "You", mine: true };
}

function rowStart(r: Row): number {
  if (r.type === "steps") return r.from;
  if (r.type === "day") return r.ts;
  if (r.type === "ticket") return r.item.createdAt;
  return r.item.ts;
}

// The rows that start a group, by row key, with the speaker and the group's first time.
// A folded quiet row (the master's quiet checks) ends the group before it.
export function speakerHeads(rows: readonly Row[]): Map<string, SpeakerHead> {
  const heads = new Map<string, SpeakerHead>();
  let last: string | null = null;
  for (const r of rows) {
    if (r.type === "day") { last = null; continue; }
    if (r.type === "note") continue;
    const who = r.type === "msg" ? speakerOf(r.item) : AGENT;
    const id = `${who.mine ? "1" : "0"}:${who.name}`;
    if (id !== last) heads.set(r.key, { ...who, ts: rowStart(r) });
    last = id;
  }
  return heads;
}
