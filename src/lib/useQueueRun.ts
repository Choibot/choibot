// src/lib/useQueueRun.ts — the one commit path for a queue item, shared by the Queue view and the
// ticket cards in an agent's thread: an optimistic update of the page's queue state, one POST, then
// confirmed or failed (a 409 carries the current item; the reducer rolls back). No second path.
"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { sortOpen } from "../../server/chief/queue/priority";
import { answer, type QueueResult } from "./queue";
import { bindPrAutoCheck, prAutoCheck, type CheckSource } from "./prAutoCheck";
import type { UseQueue } from "./useQueue";

export type QueueRun = {
  // One POST for one item. Resolves true when the server took it.
  run(item: QueueItem, next: QueueItem, call: () => Promise<QueueResult>): Promise<boolean>;
  // The user's answer from this tab (`runAnswer` in lib/queueActions calls it).
  respond(item: QueueItem, value: string, text?: string, images?: string[]): Promise<boolean>;
  // `approve` on a pr item (overview decision 60; the `checkPr` plan of lib/queueActions: the
  // "I merged it" button and the `a` key). It is not an answer: the server reads the PR's state
  // now. Merged: the item closes, as it does on its own. Not merged, or not readable: the
  // server's reason becomes the item's error line, so the press never fails in silence. No
  // optimistic change (the usual result is a refusal); one check per item at a time. Resolves
  // true when the item closed.
  // `quiet` (decision 64): a check that nobody pressed (lib/prAutoCheck). A refusal shows
  // nothing. A close is not applied here: it arrives as a server change (the stream; the refetch
  // covers a stream that is down), so the Queue view pauses its keys as for every change the
  // user did not make.
  checkPr(item: QueueItem, o?: { quiet?: boolean }): Promise<boolean>;
};

// The pr tickets with a check in flight that the user started: their button says so.
const pressed = new Set<string>();
const inFlight = new Map<string, { quiet: boolean; done: Promise<boolean> }>();
const watchers = new Set<() => void>();
const setPressed = (id: string, on: boolean): void => {
  if (on) pressed.add(id); else pressed.delete(id);
  for (const f of watchers) f();
};
const watch = (f: () => void) => { watchers.add(f); return () => { watchers.delete(f); }; };
// True while a check that the user started runs for this ticket.
export function usePrChecking(id: string): boolean {
  return useSyncExternalStore(watch, () => pressed.has(id), () => false);
}

type Live = { current: Pick<UseQueue, "dispatch" | "now" | "refresh"> };
type RunDeps = { answer: typeof answer; stamp(id: string): void };

// The path itself, with no React (the hook below keeps one per view).
export function makeQueueRun(live: Live, d: RunDeps = { answer, stamp: (id) => prAutoCheck.stamp(id) }): QueueRun {
  const settle = (id: string, r: QueueResult): boolean => {
    const { dispatch, now: clock } = live.current;
    if (r.ok) dispatch({ t: "confirmed", item: r.item, now: clock() });
    else dispatch({ t: "failed", id, ...(r.item ? { current: r.item } : {}), error: r.error ?? `HTTP ${r.status}`, now: clock() });
    return r.ok;
  };
  const run: QueueRun["run"] = async (item, next, call) => {
    const { dispatch, now: clock } = live.current;
    dispatch({ t: "optimistic", id: item.id, next, now: clock() });
    return settle(item.id, await call());
  };
  const respond: QueueRun["respond"] = (item, value, text, images) => {
    const a = { value, ...(text !== undefined ? { text } : {}), by: "user" as const, via: "tab" as const, at: live.current.now() };
    const body = { value, ...(text !== undefined ? { text } : {}), ...(images?.length ? { images } : {}) };
    return run(item, { ...item, status: "answered", answer: a }, () => d.answer(item.id, body));
  };
  const checkPr: QueueRun["checkPr"] = async (item, o) => {
    const quiet = o?.quiet === true;
    const id = item.id;
    const cur = inFlight.get(id);
    if (cur && (quiet || !cur.quiet || pressed.has(id))) return false;
    if (!quiet) { d.stamp(id); setPressed(id, true); }
    try {
      // A press while a quiet check runs: the press still gets its answer (the close, or the reason).
      if (cur && await cur.done) return true;
      const done = (async () => {
        const r = await d.answer(id, { value: "approve" });
        if (!quiet) return settle(id, r);
        if (r.ok) live.current.refresh();
        return r.ok;
      })();
      inFlight.set(id, { quiet, done });
      try {
        return await done;
      } finally {
        if (inFlight.get(id)?.done === done) inFlight.delete(id);
      }
    } finally {
      if (!quiet) setPressed(id, false);
    }
  };
  return { run, respond, checkPr };
}

// What lib/prAutoCheck asks of a view: its selected pr ticket, and a quiet check of a ticket.
// Only an Open pr row of a paired device counts (the rule of planAction).
export function prCheckSource(live: { current: UseQueue }, api: Pick<QueueRun, "checkPr">, selected?: () => string | null): CheckSource {
  const openPr = (id: string): QueueItem | undefined => {
    const c = live.current;
    if (c.view !== "on" || c.state.readOnly) return undefined;
    const i = c.state.items.find((x) => x.id === id);
    return i && i.kind === "pr" && sortOpen([i], c.now()).length === 1 ? i : undefined;
  };
  return {
    selected: () => { const id = selected?.() ?? null; return id !== null && openPr(id) ? id : null; },
    check: (id) => {
      const i = openPr(id);
      if (!i) return false;
      void api.checkPr(i, { quiet: true });
      return true;
    },
  };
}

// `selected`: the id of the ticket this view shows as selected (the Queue view), if it has one.
export function useQueueRun(q: UseQueue, selected?: () => string | null): QueueRun {
  const live = useRef(q);
  live.current = q;
  const sel = useRef(selected);
  sel.current = selected;
  const api = useRef<QueueRun | null>(null);
  if (!api.current) api.current = makeQueueRun(live);
  const run = api.current;
  // While this view is mounted, a return to the tab checks its pr tickets (lib/prAutoCheck).
  useEffect(() => {
    bindPrAutoCheck();
    return prAutoCheck.add(prCheckSource(live, run, () => sel.current?.() ?? null));
  }, [run]);
  return run;
}
