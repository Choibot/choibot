// src/lib/useOutbox.ts — the rows of lib/outbox.ts for one agent's thread, kept
// current: the composer's queue and its sent messages (this browser), and the
// wait line of the agent's session file (every browser).
"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { composer, type Composer } from "./composer";
import { outbox, type OutRow } from "./outbox";
import type { ThreadState } from "./thread";

export type Outbox = {
  rows: OutRow[];
  // The newest message this browser sent and still shows: the view scrolls to it.
  lastLocal: string | null;
  retry: (localId: string) => void;
  remove: (localId: string) => void;
};

const NO_ROWS: OutRow[] = [];
// After a send the session file gets the message in a moment: read it then,
// not at the next poll.
const LOOKS_MS = [150, 600, 1500, 3000];
const TICK_MS = 5_000;

// `kick`: read the thread now (useThread).
export function useOutbox(agentId: string, state: ThreadState | null, status: string | null, skew: number, kick: () => void): Outbox {
  const [c, setC] = useState<Composer | null>(null);
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const kickRef = useRef(kick);
  kickRef.current = kick;

  useEffect(() => {
    const inst = composer();
    setC(inst);
    let sentSeen = inst.sent(agentId).length;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const unsub = inst.subscribe(agentId, () => {
      const n = inst.sent(agentId).length;
      if (n > sentSeen) {
        for (const ms of LOOKS_MS) {
          const t = setTimeout(() => { timers.delete(t); kickRef.current(); }, ms);
          timers.add(t);
        }
      }
      sentSeen = n;
      bump();
    });
    return () => { unsub(); for (const t of timers) clearTimeout(t); };
  }, [agentId]);

  const items = state?.items;
  const waiting = state?.waiting;
  const view = useMemo(() => {
    if (!c || !items) return null;
    return outbox({
      items, waiting: waiting ?? [], local: c.items(agentId), sent: c.sent(agentId), claimed: c.claimed(agentId),
      status, skew, now: Date.now(),
    });
  }, [c, agentId, items, waiting, status, skew, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // The file has the entry of a sent message: the composer forgets it.
  useEffect(() => {
    if (!c || !view) return;
    for (const s of view.settle) c.settle(agentId, s.id, s.by);
  }, [c, agentId, view]);

  // A state can change with time alone (a sent message the file never shows,
  // a wait line that is stale): look again while there are rows.
  const some = (view?.rows.length ?? 0) > 0;
  useEffect(() => {
    if (!some) return;
    const t = setInterval(bump, TICK_MS);
    return () => clearInterval(t);
  }, [some]);

  const retry = useCallback((id: string) => c?.retry(agentId, id), [c, agentId]);
  const remove = useCallback((id: string) => c?.remove(agentId, id), [c, agentId]);
  const rows = view?.rows ?? NO_ROWS;
  let lastLocal: string | null = null;
  for (const r of rows) if (r.localId) lastLocal = r.localId;
  return useMemo(() => ({ rows, lastLocal, retry, remove }), [rows, lastLocal, retry, remove]);
}
