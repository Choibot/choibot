// src/lib/useSubThread.ts — one subagent's own thread (its steps and its final
// message), loaded when the user opens its line. It is the thread route with
// `sub=<id>`: the newest page first, then only what was appended, every 3 s
// while the subagent runs, and one last time when it ends. A finished
// subagent's page is read once. A hidden tab does not poll.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyPage, fetchThread, runningSubIds, type ThreadState } from "./thread";
import { THREAD_SUBS_MS } from "./useThread";

export type SubThreadHandle = {
  state: ThreadState | null;
  // False when the subagent's file cannot be read.
  available: boolean | null;
  loadingOlder: boolean;
  loadOlder: () => void;
};

// `running`: the subagent's state as its parent's thread knows it.
export function useSubThread(agentId: string, subId: string, running: boolean): SubThreadHandle {
  const [state, setState] = useState<ThreadState | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stateRef = useRef<ThreadState | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const kickRef = useRef<() => void>(() => {});
  const olderBusy = useRef(false);
  const keyRef = useRef("");
  keyRef.current = `${agentId}\0${subId}`;

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let again = false;
    let unreadable = false;
    stateRef.current = null;
    setState(null); setAvailable(null); setLoadingOlder(false);
    olderBusy.current = false;

    const tick = async (): Promise<void> => {
      if (dead) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const cur = stateRef.current;
        // The subagents that this one started, and that still run.
        const polled = runningSubIds(cur?.subs).filter((id) => id !== subId);
        const res = await fetchThread(agentId, cur ? { sub: subId, after: cur.end, session: cur.sessionId, subs: polled } : { sub: subId });
        if (dead) return;
        if (!res.ok) {
          unreadable = true;
          if (!stateRef.current) setAvailable(false);
        } else {
          unreadable = false;
          const held = stateRef.current;
          const next = applyPage(held, res, held ? "newer" : "tail", polled);
          stateRef.current = next;
          if (!held || res.reset || res.items.length > 0 || held.sessionId !== next.sessionId || held.subs !== next.subs) setState(next);
          setAvailable(true);
        }
      } catch {
        /* a failed poll keeps what is shown; the next one tries again */
      } finally {
        busy = false;
        if (again) { again = false; void tick(); }
        else {
          clearTimeout(timer);
          // Go on while it runs, while a subagent of it runs, and until the first page is in.
          const more = runningRef.current || runningSubIds(stateRef.current?.subs).length > 0 || (!stateRef.current && !unreadable);
          if (!dead && !document.hidden && more) timer = setTimeout(() => void tick(), THREAD_SUBS_MS);
        }
      }
    };
    kickRef.current = () => { clearTimeout(timer); void tick(); };
    const onVisible = (): void => { if (!document.hidden) kickRef.current(); };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      dead = true;
      clearTimeout(timer);
      kickRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [agentId, subId]);

  // It started again, or it ended: read what it wrote last (its final message),
  // and look a second time for a line that lands a moment late.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    kickRef.current();
    const t = setTimeout(() => kickRef.current(), 1500);
    return () => clearTimeout(t);
  }, [running]);

  const loadOlder = useCallback(() => {
    const cur = stateRef.current;
    if (!cur || cur.start === null || olderBusy.current) return;
    const key = `${agentId}\0${subId}`;
    olderBusy.current = true;
    setLoadingOlder(true);
    const run = async (): Promise<void> => {
      // A page can come back empty (see useThread): go on from its cursor.
      for (let n = 0; n < 4; n++) {
        const at = stateRef.current;
        if (!at || at.start === null) return;
        const res = await fetchThread(agentId, { sub: subId, before: at.start, session: at.sessionId });
        if (keyRef.current !== key || !res.ok) return;
        const next = applyPage(stateRef.current, res, "older");
        stateRef.current = next;
        setState(next);
        if (res.reset || res.items.some((it) => it.kind !== "end")) return;
      }
    };
    void run()
      .catch(() => { /* the button stays; the user can try again */ })
      .finally(() => {
        if (keyRef.current !== key) return;
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  }, [agentId, subId]);

  return { state, available, loadingOlder, loadOlder };
}
