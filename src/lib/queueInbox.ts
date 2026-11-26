// src/lib/queueInbox.ts — pure helpers for the Queue view's "Inbox" layout: the order of the
// list, its groups (Blocks an agent, For review, Snoozed, Done today), the words of a row and of
// the reading pane's head. No React, no fetch. All item text is untrusted: callers render it as
// plain text.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { sortOpen } from "../../server/chief/queue/priority";
import { isGone, isUndelivered } from "../../server/chief/queue/sections";
import { fmtClock, fmtDay } from "./thread";
import { closedAt } from "./threadTickets";
import { pressLimit, stepWords } from "../../server/chief/deploy/ticket";

// The row word of a press that ended with no update (server/update).
const UPDATE_ROW_WORD = { "not-started": "not started", unreachable: "release not reachable", "not-finished": "not finished" } as const;

// The Open rows in the order the list shows them: the tickets that block an agent first, then
// the rest. Inside each part the order is the queue's priority rule (sortOpen: score, then the
// oldest first). The reducer moves focus in this order too (lib/queueState), so j / k and the
// focus after an answer follow the list.
export function openOrder(items: QueueItem[], now: number): QueueItem[] {
  const open = sortOpen(items, now);
  return [...open.filter((i) => i.blocking), ...open.filter((i) => !i.blocking)];
}

export type InboxGroups = { blocks: QueueItem[]; review: QueueItem[] };

// The two groups of the Open rows. `open` keeps its order inside each group.
export function inboxGroups(open: QueueItem[]): InboxGroups {
  return { blocks: open.filter((i) => i.blocking), review: open.filter((i) => !i.blocking) };
}

// "4 open · 2 block an agent".
export function countsLine(open: QueueItem[]): string {
  const b = open.filter((i) => i.blocking).length;
  const head = `${open.length} open`;
  if (b === 0) return head;
  return `${head} · ${b} ${b === 1 ? "blocks" : "block"} an agent`;
}

// Snoozed tickets whose snooze has not ended (an ended snooze is an Open row), the next to wake first.
export function snoozedRows(items: QueueItem[], now: number): QueueItem[] {
  return items
    .filter((i) => i.status === "snoozed" && (i.snoozedUntil ?? 0) > now)
    .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || a.createdAt - b.createdAt);
}

const startOfLocalDay = (ts: number): number => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

const undoable = (i: QueueItem, now: number, undoMs: number): boolean =>
  (i.status === "answered" || i.status === "auto") && !!i.answer && now - i.answer.at <= undoMs;

// "Done today": the tickets that closed on this day (answered by the user or the master,
// withdrawn, PR merged or closed, agent gone), the newest first. Two kinds of older ticket stay:
// an answer that can still be undone, and an agent-gone ticket in its 24 h window. A ticket with
// a stuck delivery is not here: it has its own group, with its actions.
export function doneToday(items: QueueItem[], now: number, undoMs: number, dayStart: (ts: number) => number = startOfLocalDay): QueueItem[] {
  const start = dayStart(now);
  return items
    .filter((i) => (i.status === "answered" || i.status === "auto" || i.status === "withdrawn") && !isUndelivered(i))
    .filter((i) => closedAt(i) >= start || undoable(i, now, undoMs) || isGone(i, now))
    .sort((a, b) => closedAt(b) - closedAt(a) || (a.id < b.id ? -1 : 1));
}

// "6 min", "3 h", "1 h 40 min", "2 d".
export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d`;
}

// "17:38" on this day, "9 Nov 17:38" on another day.
export function clockText(ts: number, now: number): string {
  if (!ts) return "";
  const a = new Date(ts), b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? fmtClock(ts) : `${fmtDay(ts)} ${fmtClock(ts)}`;
}

// True for a pr ticket that still waits (open, or snoozed): its PR is not merged. A pr ticket
// has no approve; the merge of its PR closes it (overview decision 60, PrWatch), so a ticket that
// is still here was not seen as merged. The words of the reading pane are `prWait` (lib/queueDetail).
export function notMerged(i: QueueItem): boolean {
  return i.kind === "pr" && !!i.pr && (i.status === "open" || i.status === "snoozed");
}

export type MetaPart = { text: string; warn?: true; lead?: true };

// Where a ticket is from. `hasLead`: its area has a lead; then the area name comes first, marked
// `lead` (the Queue draws the lead's avatar before it), and stands for a repo of the same name.
export function whereParts(i: Pick<QueueItem, "repo" | "area">, hasLead: boolean): MetaPart[] {
  if (!hasLead || !i.area) return [{ text: i.repo }];
  return i.area === i.repo ? [{ text: i.area, lead: true }] : [{ text: i.area, lead: true }, { text: i.repo }];
}

// The second line of a row: kind · (area) · repo · facts · age. `warn` parts show in amber.
export function rowMeta(i: QueueItem, now: number, hasLead = false): MetaPart[] {
  const out: MetaPart[] = [{ text: i.kind === "deploy" && i.deploy?.release ? "update" : i.kind }, ...whereParts(i, hasLead)];
  if (notMerged(i)) out.push({ text: "not merged", warn: true });
  // The console's own deploy ticket: where its run is.
  const run = i.kind === "deploy" ? i.deploy?.run : undefined;
  if (run?.phase === "running") out.push({ text: `runs: ${run.step}` });
  else if (run?.phase === "failed") out.push({ text: `failed at ${run.step}`, warn: true });
  // The release variant: where the update is.
  const up = i.kind === "deploy" ? i.deploy?.update : undefined;
  if (up?.state === "asked" || up?.state === "running") out.push({ text: "updating" });
  else if (up?.state === "refused") out.push({ text: pressLimit(up) ? "too many presses" : `refused at ${stepWords(up.step)}`, warn: true });
  else if (up?.state === "not-started" || up?.state === "unreachable" || up?.state === "not-finished") out.push({ text: UPDATE_ROW_WORD[up.state], warn: true });
  const n = i.kind === "preview" || i.kind === "pr" ? i.preview?.images.length ?? 0 : 0; // a pr ticket may carry screenshots (decision 65)
  if (n > 0) out.push({ text: n === 1 ? "1 image" : `${n} images` });
  if (i.status === "snoozed" && (i.snoozedUntil ?? 0) > now) out.push({ text: `snoozed until ${clockText(i.snoozedUntil ?? 0, now)}` });
  else out.push({ text: ageText(now - i.createdAt) });
  return out;
}

// The chip at the head of the reading pane: "choice · blocks the agent".
export function kindChip(i: QueueItem, now: number): { text: string; block: boolean } {
  const isOpen = sortOpen([i], now).length === 1;
  if (!isOpen) {
    const state = i.status === "snoozed" ? "snoozed" : i.status !== "withdrawn" ? "answered"
      : i.kind === "deploy" && (i.lastError === "deployed" || i.lastError === "updated") ? i.lastError
      : i.kind === "deploy" && i.lastError === "update-failed" ? "update failed" : "closed";
    return { text: `${i.kind} · ${state}`, block: false };
  }
  if (i.kind === "deploy") return { text: `${i.deploy?.release ? "update" : "deploy"} · from the console`, block: false };
  if (i.blocking) return { text: `${i.kind} · blocks the agent`, block: true };
  return { text: `${i.kind} · ${i.kind === "pr" || i.kind === "preview" ? "for review" : "not blocking"}`, block: false };
}

// "agent 945f47da", "lead console", "fleet master": a short name for the ticket's agent.
export function agentWord(agentId: string): string {
  if (agentId === "console") return "the console itself"; // the deploy ticket has no agent
  if (agentId === "fleet-master") return "fleet master";
  if (agentId === "coordinator") return "the Coordinator";
  if (agentId === "cron-master") return "cron master";
  if (agentId.startsWith("lead-")) return `lead ${agentId.slice(5)}`;
  const bare = agentId.startsWith("agent-") ? agentId.slice(6) : agentId;
  return `agent ${bare.slice(0, 8)}`;
}

// The PR facts the item holds, in the words of the reading pane. `tone` colours the word.
export type FactWord = { text: string; tone?: "good" | "bad" | "warn" };
export function mergeableWord(v: string | undefined): FactWord {
  if (v === "MERGEABLE") return { text: "mergeable", tone: "good" };
  if (v === "CONFLICTING") return { text: "conflicts", tone: "bad" };
  return { text: "mergeable: unknown" };
}
export function checksWord(v: string | undefined): FactWord {
  if (v === "success") return { text: "checks pass", tone: "good" };
  if (v === "failure") return { text: "checks fail", tone: "bad" };
  if (v === "pending") return { text: "checks run", tone: "warn" };
  if (v === "none") return { text: "no checks" };
  return { text: "checks: unknown" };
}

// "13 files", "+1,170", "−50" from the PR's file list.
export function sizeWords(files: { additions: number; deletions: number }[]): { files: string; plus: string; minus: string } {
  const add = files.reduce((n, f) => n + f.additions, 0), del = files.reduce((n, f) => n + f.deletions, 0);
  const num = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return { files: files.length === 1 ? "1 file" : `${num(files.length)} files`, plus: `+${num(add)}`, minus: `−${num(del)}` };
}
