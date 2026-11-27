// server/chief/leads/quiet.ts — a lead's quiet policy (owner's order of 2026-11-26, "cut the
// token use"): a lead is woken only by an event it must act on. Each digest turn of a lead
// reads its whole context again, so a line it does not act on is the most costly line.
// The fleet master's policy (master/quiet.ts) stays as it is.
//
// What a lead's digest gets (EventQueue with `quiet.lead`, MasterInbox with digestGapMs):
//   waiting (status idle, issue needs-input)  held: a line only when the worker waited
//   finished (status done)                    BLOCKED_ALERT_MS with no status change, the user
//                                             did not type to it within USER_PRESENT_MS, it has
//                                             no open or snoozed queue item of its own, and its
//                                             last turn sent no message (SendMessage)
//   pr-opened                                 no line: its message or its pr item carries it
//   errored, at-limit, model-error, login-out a line, at once: it skips the digest gap
//   queue pr | preview | choice | question    a line (the lead reads them and may recommend)
//   service crashed, cron, lead-*             never in a lead's queue
// Plain lines come at most once per LEAD_DIGEST_GAP_MS; a failure line sends the batch at once.
import { readThreadBefore, sessionFileFor } from "../../agents/threadfile.js";
import type { ThreadItem } from "../../agents/thread.js";
import type { AgentRecord, SessionStore } from "../../agents/store.js";
import type { EventQueue } from "../../master/events.js";
import type { QuietPolicy } from "../../master/quiet.js";
import type { QueueItem } from "../queue/types.js";

// Of the lead's 192 event turns on 2026-11-26, 135 came within 5 min of the one before.
export const LEAD_DIGEST_GAP_MS = 5 * 60_000;

// The inbox's gap: none while a failure line waits.
export function leadDigestGap(events: Pick<EventQueue, "hasAlert">): () => number {
  return () => (events.hasAlert() ? 0 : LEAD_DIGEST_GAP_MS);
}

// The last turn: the items after the last line the agent was given (the user's, the console's
// or another session's). With no such line in the page, the whole page. A send that failed
// (its result says so: `error`, thread.ts) does not count: the lead never got it. A send whose
// result is not in the page has no `end` and no `error`: it counts.
export function messagedInLastTurn(items: ThreadItem[]): boolean {
  let i = items.length - 1;
  while (i >= 0 && items[i].kind !== "user" && items[i].kind !== "peer") i--;
  return items.slice(i + 1).some((it) => it.kind === "step" && it.tool === "SendMessage" && !it.error);
}

// One tail read of the agent's Claude session file (through the helper with strong protection).
// No file: false.
export async function lastTurnMessaged(rec: AgentRecord, ctx: { workspaceDir: string }): Promise<boolean> {
  const file = await sessionFileFor(rec, ctx);
  if (!file.ok) return false;
  const page = await readThreadBefore(file.path, null);
  return page !== null && messagedInLastTurn(page.items);
}

export type LeadQuietDeps = {
  userPresent(agentId: string): boolean;
  blockedMs?: number;
  queue: { list(): Promise<QueueItem[]> };
  workspaceDir: string;
};

// A held line is explained when the worker waits on someone who knows: it holds an open or
// snoozed queue item (the user has it), or its last turn sent a message (its lead has it).
export function leadExplained(d: {
  agents: Pick<SessionStore, "load">;
  queue: { list(): Promise<QueueItem[]> };
  messaged: (rec: AgentRecord) => Promise<boolean>;
}): (agentId: string) => Promise<boolean> {
  return async (agentId) => {
    const items = await d.queue.list();
    if (items.some((i) => i.agentId === agentId && (i.status === "open" || i.status === "snoozed"))) return true;
    const rec = await d.agents.load(agentId);
    return rec !== null && (await d.messaged(rec));
  };
}

export function leadQuiet(d: LeadQuietDeps & { agents: Pick<SessionStore, "load"> }): QuietPolicy {
  return {
    ...(d.blockedMs !== undefined ? { blockedMs: d.blockedMs } : {}),
    userPresent: d.userPresent,
    // Never asked: a lead's queue gets its workers' item lines by addQueueLine, not addQueue.
    queueEcho: async () => true,
    lead: {
      explained: leadExplained({
        agents: d.agents, queue: d.queue,
        messaged: (rec) => lastTurnMessaged(rec, { workspaceDir: d.workspaceDir }),
      }),
    },
  };
}
