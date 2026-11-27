// server/chief/leads/close.ts — who may close an agent through
// POST /api/agents/:id/close while the chief is on (spec §7 "Close", §13).
// A lead closes a worker it spawned itself, and nothing else. "Spawned by this
// lead" is the worker record's `spawnedBy`, which the server wrote at spawn
// time from the caller's authenticated identity (POST /api/agents); the lead's
// own identity is the record its agent token matched (auth.ts callerOf). No
// request field takes part.
// Every other caller keeps what it had before this gate: a request without
// agent headers (the user's ✕, a paired browser) and the two masters pass
// untouched. Any other agent (a worker, an issue agent, headers that do not
// authenticate) is refused. A rename (POST /api/agents/:id/rename) takes the same
// owner rule (ownerRefusal), without the close's running and open-item checks.
import { isMasterKind, type AgentRecord } from "../../agents/store.js";
import type { Caller } from "../auth.js";
import type { QueueItem } from "../queue/types.js";

export type CloseRefusal = { code: 403 | 404 | 409; error: string };

export const LEAD_CLOSE_RULE = "a lead closes only the workers it spawned";
// POST /api/agents/:id/delete from a lead, whatever the target.
export const LEAD_DELETE_REFUSAL = "refused: a lead does not delete agents; close a finished worker with `agents close <id>`";

// An item that still waits for the user (the store's dedup rule: open or snoozed).
export const waitsForUser = (i: Pick<QueueItem, "status">): boolean => i.status === "open" || i.status === "snoozed";

// The id of one item of `agentId` that still waits for the user, or null.
export async function openItemOf(queue: { list(): Promise<QueueItem[]> }, agentId: string): Promise<string | null> {
  return (await queue.list()).find((i) => i.agentId === agentId && waitsForUser(i))?.id ?? null;
}

const what = (rec: AgentRecord): string | null => {
  if (rec.kind === "lead") return "a lead";
  if (rec.kind === "fleet-master") return "the fleet master";
  return null;
};

// A rename (POST /api/agents/:id/rename) takes the same owner rule as a close.
export const LEAD_RENAME_RULE = "a lead renames only the workers it spawned";

// The owner rule of a close and of a rename: the user (no agent headers) and the masters act on
// every agent; a lead only on a worker it spawned; any other agent on none. `verb`/`rule` word
// the refusal. Null: the caller may act on `target` (a lead: `target` is its own worker).
export function ownerRefusal(
  caller: Caller, id: string, target: AgentRecord | null, verb: string, rule: string,
): CloseRefusal | null {
  if (!caller.agentHeaders) return null;
  if (caller.agentId && isMasterKind(caller.kind)) return null;
  if (caller.level !== "lead" || !caller.agentId) {
    return { code: 403, error: `refused: only the user or the lead that spawned an agent ${verb} it; ${rule}` };
  }
  if (!target) return { code: 404, error: "not found" };
  const persistent = what(target);
  if (persistent) return { code: 403, error: `refused: ${id} is ${persistent}; ${rule}` };
  if (target.spawnedBy !== caller.agentId) {
    return { code: 403, error: `refused: ${id} was not spawned by ${caller.agentId}; ${rule}` };
  }
  return null;
}

// Why this caller may not close `target` (the loaded record of `id`, or null),
// or null when the close goes on as before the gate. `openItem` is asked last
// and only for a lead's own, stopped or idle worker.
export async function closeRefusal(
  caller: Caller, id: string, target: AgentRecord | null,
  openItem: (agentId: string) => Promise<string | null>,
): Promise<CloseRefusal | null> {
  const owner = ownerRefusal(caller, id, target, "closes", LEAD_CLOSE_RULE);
  // Refused, or the user or a master (they pass as before the gate): no more checks.
  if (owner || !caller.agentHeaders || (caller.agentId && isMasterKind(caller.kind)) || !target) return owner;
  if (target.status === "running") {
    return { code: 409, error: `refused: ${id} is running; close it when its task is done` };
  }
  const item = await openItem(id);
  if (item) {
    return { code: 409, error: `refused: ${id} has an open queue item (${item}); close it after the user answers the item` };
  }
  return null;
}
