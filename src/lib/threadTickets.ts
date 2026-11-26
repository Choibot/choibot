// src/lib/threadTickets.ts — the queue tickets of one agent, placed in its thread (pure).
// A ticket shows where the agent asked: after the last thread block that began before the ticket
// was created. An open ticket whose place is before the loaded range shows at the bottom, so it is
// never hidden; when the user answers it there, its line stays there while the answer can still be
// undone. An answered ticket is one line that holds the answer; the session line that delivered
// the same answer ("[queue <id>] …") is then left out, so the answer shows one time.
// All item text is untrusted: callers render it as plain text.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { sortOpen } from "../../server/chief/queue/priority";
import { CONSOLE_AGENT_ID, DEPLOY_CLOSED, runLine } from "../../server/chief/deploy/ticket";
import { toBlocks, type Block, type Shown } from "./thread";

export type TicketPhase = "open" | "snoozed" | "answered" | "withdrawn";

// Open by the Queue view's own rule (sortOpen: open, or a snooze that ended).
export function ticketPhase(i: QueueItem, now: number): TicketPhase {
  if (sortOpen([i], now).length === 1) return "open";
  if (i.status === "snoozed") return "snoozed";
  return i.status === "withdrawn" ? "withdrawn" : "answered";
}

const FLEET_MASTER_ID = "fleet-master"; // = server/master/paths.ts (a node module)

// The tickets whose answer goes to this agent (the rule of the agent row's count), oldest first.
// The console's own deploy ticket has no agent: it shows in the fleet master's thread.
export function agentTickets(items: QueueItem[], agentId: string): QueueItem[] {
  const mine = (i: QueueItem): boolean => i.agentId === agentId || (agentId === FLEET_MASTER_ID && i.agentId === CONSOLE_AGENT_ID && i.kind === "deploy");
  return items.filter(mine).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

// `moved`: the ticket is at the bottom because its own place is not in the loaded range.
export type TicketRow = { type: "ticket"; key: string; item: QueueItem; phase: TicketPhase; moved: boolean };
export type Row = Block | TicketRow;

// The session line of an answer is written after the answer commit. The two clocks are one
// machine's; the slack covers a line stamped a moment early.
const ANSWER_SLACK_MS = 5_000;

const blockStart = (b: Block): number => (b.type === "steps" ? b.from : b.type === "day" ? b.ts : b.item.ts);

// True while an answer can still be taken back (the server's undo window).
const undoable = (i: QueueItem, now: number, undoMs: number): boolean =>
  (i.status === "answered" || i.status === "auto") && !!i.answer && now - i.answer.at <= undoMs;

// Items and tickets → the rows the thread draws. `undoMs`: the undo window of the queue.
export function threadRows(items: Shown[], tickets: QueueItem[], now: number, undoMs = 0, dayOf?: (ts: number) => string): Row[] {
  if (tickets.length === 0) return toBlocks(items, dayOf);
  const first = items.find((it) => it.ts > 0)?.ts;
  const inPlace: QueueItem[] = [];
  const atBottom: QueueItem[] = [];
  for (const t of tickets) {
    if (first !== undefined && t.createdAt >= first) inPlace.push(t);
    // Before the loaded range: an open ticket, and one just answered (its Undo must stay in reach).
    else if (ticketPhase(t, now) === "open" || undoable(t, now, undoMs)) atBottom.push(t);
    // Any other closed ticket from before the loaded range shows when its page loads.
  }

  // One time, not two: the line of a shown, answered ticket holds the answer.
  const told = new Map<string, number>();
  for (const t of [...inPlace, ...atBottom]) if (t.answer && ticketPhase(t, now) === "answered") told.set(t.id, t.answer.at);
  const kept = told.size === 0 ? items : items.filter((it) => {
    if (it.kind !== "user" || it.via !== "queue" || !it.ref || !it.ts) return true;
    const at = told.get(it.ref);
    return at === undefined || it.ts < at - ANSWER_SLACK_MS;
  });

  const row = (item: QueueItem, moved: boolean): TicketRow => ({ type: "ticket", key: `t:${item.id}`, item, phase: ticketPhase(item, now), moved });
  const out: Row[] = [];
  let n = 0;
  for (const b of toBlocks(kept, dayOf)) {
    const start = blockStart(b);
    while (n < inPlace.length && start > 0 && inPlace[n].createdAt < start) out.push(row(inPlace[n++], false));
    out.push(b);
  }
  while (n < inPlace.length) out.push(row(inPlace[n++], false));
  for (const t of atBottom) out.push(row(t, true));
  return out;
}

const KIND_WORD: Record<QueueItem["kind"], string> = { pr: "PR", preview: "Preview", choice: "Choice", question: "Question", deploy: "Deploy" };
export const kindWord = (i: QueueItem): string => KIND_WORD[i.kind] ?? i.kind;

// The words of a closed ticket's line. An item closed with no answer says why.
export function closedText(i: QueueItem): string {
  if (i.status === "withdrawn") {
    if (i.kind === "deploy") {
      if (i.lastError === DEPLOY_CLOSED.deployed) return runLine(i.deploy?.run) || "Deployed";
      if (i.lastError === DEPLOY_CLOSED.live) return "Closed: the running build has all of main";
      return "Dismissed";
    }
    if (i.lastError === "merged") return "PR merged";
    if (i.lastError === "closed") return "PR closed";
    if (i.lastError === "agent-gone") return "Agent gone";
    return "Withdrawn";
  }
  const a = i.answer;
  if (!a) return "Closed";
  // An answer of images and no text says how many (lib/answerImages), as the agent's line does.
  const n = a.images?.length ?? 0;
  const text = a.text?.trim() || (n > 0 ? `${n} ${n === 1 ? "image" : "images"}` : "");
  let said: string;
  if (i.kind === "pr" || i.kind === "preview") {
    said = a.value === "approve" ? (i.kind === "pr" ? "Approved" : "Looks good") : `Changes requested${text ? `: ${text}` : ""}`;
  } else if (i.kind === "choice" && a.value !== "reply") {
    const label = i.choice?.options.find((o) => o.key === a.value)?.label;
    said = `${a.value}${label ? ` · ${label}` : ""}${text ? ` — ${text}` : ""}`;
  } else {
    said = text || a.value;
  }
  if (a.by !== "master") return said;
  const rules = a.ruleIds?.length ? ` (rule ${a.ruleIds.join(", ")})` : "";
  return `Auto${rules}: ${said}`;
}

// The mark of a closed ticket: ✓ for an answer and for a deploy that was done, × for any other
// close with no answer (withdrawn, PR closed, agent gone).
export const closedMark = (i: QueueItem): "✓" | "×" =>
  (i.status !== "withdrawn" || (i.kind === "deploy" && i.lastError === DEPLOY_CLOSED.deployed) ? "✓" : "×");

// When the ticket closed: the answer's time, else the close time.
export const closedAt = (i: QueueItem): number => (i.status !== "withdrawn" && i.answer ? i.answer.at : i.closedAt ?? i.updatedAt);

// True while the user can still take the answer back (the Queue view's rule).
export const canUndo = (i: QueueItem, now: number, undoMs: number, readOnly: boolean): boolean => !readOnly && undoable(i, now, undoMs);
