// src/lib/useThread.ts — one agent's thread, kept current at low cost.
// The first request takes the newest page. After that the hook asks only for
// what was appended since its cursor (a no-change answer costs the server one
// stat): every 1.5 s while the agent runs, every 10 s otherwise, and at once
// when a hook event for the agent arrives on the SSE hub (a turn started or
// ended). A hidden tab does not poll.
// The last thread seen of each agent is remembered (lib/viewCache): a pane that opens again shows
// it on its first frame, and its first request asks only for what came after it.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyPage, fetchThread, quietSince, runningSubIds, type ThreadState } from "./thread";
import { useEvents, type ConsoleEvent } from "./useEvents";
import { agentMemory } from "./viewCache";

// What a pane showed of an agent's thread the last time.
type Remembered = { state: ThreadState | null; available: boolean | null; status: string | null; skew: number; lastEntryAt: number | null };
const threads = agentMemory<Remembered>();
const prefetching = new Map<string, Promise<void>>();

// The user points at an agent's row (a hover, a finger down): read its newest page now, so its
// pane opens with the thread. Nothing for an agent already remembered or on its way. Only a
// readable thread is kept: "no session file" is for the pane to find (a master that is still
// being created has none yet).
export function prefetchThread(agentId: string): Promise<void> {
  if (threads.has(agentId)) return Promise.resolve();
  const busy = prefetching.get(agentId);
  if (busy) return busy;
  const p = fetchThread(agentId, {}).then((res) => {
    if (threads.has(agentId) || !res.ok) return; // a pane read it meanwhile, or nothing to keep
    threads.set(agentId, {
      state: applyPage(null, res, "tail"), available: true, status: res.status, skew: res.now - Date.now(), lastEntryAt: res.lastEntryAt ?? null,
    });
  }, () => { /* the pane reads it itself */ }).finally(() => { prefetching.delete(agentId); });
  prefetching.set(agentId, p);
  return p;
}

// The agent's thread is remembered: its pane opens with it.
export function threadKnown(agentId: string): boolean {
  return threads.get(agentId)?.available === true;
}

export const THREAD_FAST_MS = 1500;
export const THREAD_SLOW_MS = 10_000;
// The agent is between turns and a subagent of it still runs: the subagent's
// line and the live line follow it at this pace.
export const THREAD_SUBS_MS = 3000;
// A turn ended (the status event): the status waits this long at most for the
// read that brings the turn's last message, so both change in one frame. With
// the status first, the "Working" line went away and the answer came a moment
// later: the thread moved down, then up.
export const STATUS_WITH_READ_MS = 1200;

export type ThreadHandle = {
  state: ThreadState | null;
  // null until the first answer; false when there is no session file to read.
  available: boolean | null;
  status: string | null;
  // Server clock minus this browser's clock, for elapsed times.
  skew: number;
  // From when a running agent's silence counts (server clock): the session
  // file's last line, or the start of this run when that is later. Null with
  // no session time. See quietMs in thread.ts.
  quietSince: number | null;
  loadingOlder: boolean;
  loadOlder: () => void;
  // Read the thread now (the user sent a message: the file has it in a moment).
  kick: () => void;
};

// The pane's other hooks get the console events from this hook's stream, so
// one pane holds one EventSource. `onOpen` fires on each (re)connect.
export type EventTap = { onEvent?: (e: ConsoleEvent) => void; onOpen?: () => void };

// `live` false (the terminal is on screen) keeps only the slow check, which
// tells when a session becomes readable.
export function useThread(agentId: string, live: boolean, tap?: EventTap): ThreadHandle {
  const [seen] = useState(() => threads.get(agentId));
  const [state, setState] = useState<ThreadState | null>(seen?.state ?? null);
  const [available, setAvailable] = useState<boolean | null>(seen?.available ?? null);
  const [status, setStatus] = useState<string | null>(seen?.status ?? null);
  const [skew, setSkew] = useState(seen?.skew ?? 0);
  const [lastEntryAt, setLastEntryAt] = useState<number | null>(seen?.lastEntryAt ?? null);
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const skewRef = useRef(seen?.skew ?? 0);
  const tapRef = useRef(tap);
  tapRef.current = tap;
  const stateRef = useRef<ThreadState | null>(seen?.state ?? null);
  const statusRef = useRef<string | null>(seen?.status ?? null);
  const kickRef = useRef<() => void>(() => {});
  const olderBusy = useRef(false);
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const liveRef = useRef(live);
  liveRef.current = live;
  // The status of a turn end that waits for its read (STATUS_WITH_READ_MS).
  const heldStatus = useRef<{ status: string; at: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const dropHeld = useCallback((): void => {
    if (heldStatus.current) clearTimeout(heldStatus.current.timer);
    heldStatus.current = null;
  }, []);

  // A status this hook saw change to "running" starts the run at `at` (server
  // clock). A status that was running when the pane opened has no known start.
  const seeStatus = useCallback((next: string, at: number): void => {
    const prev = statusRef.current;
    statusRef.current = next;
    setStatus(next);
    if (next !== "running") setRunningSince(null);
    else if (prev !== null && prev !== "running") setRunningSince(at);
  }, []);

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let again = false;
    // The agent's remembered thread (nothing for an agent not seen yet) until the first answer.
    const m = threads.get(agentId);
    stateRef.current = m?.state ?? null;
    statusRef.current = m?.status ?? null;
    setState(m?.state ?? null); setAvailable(m?.available ?? null); setStatus(m?.status ?? null); setLoadingOlder(false);
    setLastEntryAt(m?.lastEntryAt ?? null); setRunningSince(null);
    olderBusy.current = false;
    dropHeld();

    const schedule = (): void => {
      clearTimeout(timer);
      if (dead || document.hidden) return;
      const pace = !liveRef.current ? THREAD_SLOW_MS
        : statusRef.current === "running" ? THREAD_FAST_MS
        : runningSubIds(stateRef.current?.subs).length ? THREAD_SUBS_MS : THREAD_SLOW_MS;
      timer = setTimeout(() => void tick(), pace);
    };
    const tick = async (): Promise<void> => {
      if (dead) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        // A prefetch of this thread is on its way: take it rather than ask twice.
        const coming = stateRef.current ? undefined : prefetching.get(agentId);
        if (coming) {
          await coming;
          if (dead) return;
          const m = threads.get(agentId);
          if (m && !stateRef.current) {
            stateRef.current = m.state;
            statusRef.current = m.status;
            skewRef.current = m.skew;
            setState(m.state); setAvailable(m.available); setStatus(m.status); setSkew(m.skew); setLastEntryAt(m.lastEntryAt);
          }
        }
        const cur = stateRef.current;
        // The subagents held as running go with the poll: their state comes back.
        const polled = runningSubIds(cur?.subs);
        const res = await fetchThread(agentId, cur ? { after: cur.end, session: cur.sessionId, subs: polled } : {});
        if (dead) return;
        skewRef.current = res.now - Date.now();
        setSkew(skewRef.current);
        // A read that began before the turn ended can still say "running": the held status stays.
        const held0 = heldStatus.current;
        if (held0 && res.status === "running") { /* the next read brings both */ }
        else { dropHeld(); seeStatus(res.status, res.now); }
        if (!res.ok) {
          stateRef.current = null;
          setState(null);
          setAvailable(false);
          setLastEntryAt(null);
          threads.set(agentId, { state: null, available: false, status: res.status, skew: skewRef.current, lastEntryAt: null });
        } else {
          // The same number again (a poll with no change) does not re-render.
          setLastEntryAt(res.lastEntryAt ?? null);
          const held = stateRef.current;
          const next = applyPage(held, res, held ? "newer" : "tail", polled);
          stateRef.current = next;
          // A poll that brought nothing moves only the cursor: no re-render.
          if (!held || res.reset || res.items.length > 0 || held.sessionId !== next.sessionId || held.subs !== next.subs) setState(next);
          setAvailable(true);
          threads.set(agentId, { state: next, available: true, status: res.status, skew: skewRef.current, lastEntryAt: res.lastEntryAt ?? null });
        }
      } catch {
        /* a failed poll keeps what is shown; the next one tries again */
      } finally {
        busy = false;
        if (again) { again = false; void tick(); } else schedule();
      }
    };
    kickRef.current = () => { clearTimeout(timer); void tick(); };
    const onVisible = (): void => { if (!document.hidden) kickRef.current(); };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      dead = true;
      clearTimeout(timer);
      dropHeld();
      kickRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [agentId, seeStatus, dropHeld]);

  // Back on the thread: catch up at once, then poll at the live pace.
  useEffect(() => { if (live) kickRef.current(); }, [live]);

  // A hook of this agent fired: its status is news now, and the session file
  // has new lines (or will in a moment: the second look catches a late write).
  useEvents((e) => {
    tapRef.current?.onEvent?.(e);
    if (!("agentId" in e) || e.agentId !== agentId) return;
    if (e.type === "agent-status") {
      const at = Date.now() + skewRef.current;
      dropHeld();
      if (statusRef.current === "running" && e.status !== "running" && liveRef.current && !document.hidden) {
        // The turn ended: the read below brings its last message and this status together.
        const timer = setTimeout(() => {
          const h = heldStatus.current;
          heldStatus.current = null;
          if (h && agentRef.current === agentId) seeStatus(h.status, h.at);
        }, STATUS_WITH_READ_MS);
        heldStatus.current = { status: e.status, at, timer };
      } else seeStatus(e.status, at);
    }
    if (e.type === "agent-status" || e.type === "agent-hook" || e.type === "agent-turn-end") {
      kickRef.current();
      setTimeout(() => { if (agentRef.current === agentId) kickRef.current(); }, 800);
    }
  }, true, () => tapRef.current?.onOpen?.());

  const loadOlder = useCallback(() => {
    const cur = stateRef.current;
    if (!cur || cur.start === null || olderBusy.current) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    // A page can come back empty when the scan budget ended inside a run of
    // request blobs: go on from its cursor, a few times at most.
    const run = async (): Promise<void> => {
      for (let n = 0; n < 4; n++) {
        const at = stateRef.current;
        if (!at || at.start === null) return;
        const res = await fetchThread(agentId, { before: at.start, session: at.sessionId });
        if (agentRef.current !== agentId || !res.ok) return;
        const next = applyPage(stateRef.current, res, "older");
        stateRef.current = next;
        setState(next);
        const m = threads.get(agentId);
        if (m) threads.set(agentId, { ...m, state: next });
        if (res.reset || res.items.some((it) => it.kind !== "end")) return;
      }
    };
    void run()
      .catch(() => { /* the button stays; the user can try again */ })
      .finally(() => {
        if (agentRef.current !== agentId) return;
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  }, [agentId]);

  const kick = useCallback(() => kickRef.current(), []);
  return { state, available, status, skew, quietSince: quietSince(lastEntryAt, runningSince), loadingOlder, loadOlder, kick };
}
