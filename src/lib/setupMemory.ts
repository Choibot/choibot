// src/lib/setupMemory.ts — what the Set-up page read last about the first agent and its ticket,
// in memory for this page load. A part that opens later (the "Merge the first PR" step, after
// the "Start the first agent" step saw the pull request) draws its data on its first frame, and
// not first a "Reading…" line. Pure, apart from the read of a ticket (warmTicket).
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import type { FirstView } from "../../server/setup/firstagent"; // type-only
import { fetchTicket } from "./setupActions";
import { viewMemory } from "./viewCache";

export const firstMemory = viewMemory<FirstView>(1);
export const ticketMemory = viewMemory<QueueItem | null>(4);
const FIRST = "first";

/** A new read with the same data (a poll that changed nothing): the old object, so React draws nothing again. */
export function keepSame<T>(prev: T | null, next: T): T {
  return prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/** The last view of the first agent, if this part can show it (`accept`); else null (it reads first). */
export function firstStart(accept: (v: FirstView) => boolean = () => true): FirstView | null {
  const v = firstMemory.get(FIRST);
  return v && accept(v) ? v : null;
}

export function rememberFirst(v: FirstView): void {
  firstMemory.set(FIRST, v);
  for (const f of firstWatch) f();
}

// The scene over the step card (ChoiScene) follows the first agent from the view that the card
// read last: it reads nothing of its own.
const firstWatch = new Set<() => void>();
export function watchFirst(f: () => void): () => void {
  firstWatch.add(f);
  return () => { firstWatch.delete(f); };
}
export const lastFirst = (): FirstView | null => firstMemory.get(FIRST) ?? null;

// The merge step shows the ticket of the pull request (the first agent's, or another agent's that
// waits): a view with neither is older than the state that opened the step, and would draw the
// wrong branch for a moment.
export const hasTicket = (v: FirstView): boolean => v.ticket !== null || !!v.other;

const reading = new Set<string>();
/** Read a ticket before its part opens: once per id, while no copy is in memory. */
export async function warmTicket(id: string, read: (id: string) => Promise<QueueItem> = fetchTicket): Promise<void> {
  if (reading.has(id) || ticketMemory.has(id)) return;
  reading.add(id);
  try { ticketMemory.set(id, await read(id)); } catch { /* the step reads it again when it opens */ } finally { reading.delete(id); }
}
