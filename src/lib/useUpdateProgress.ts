// src/lib/useUpdateProgress.ts — the progress of a press of Update (lib/updateProgress) for one
// place on the page: the update ticket's panel (the Queue, the thread card) or the Settings page.
"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { UpdateRun } from "../../server/chief/deploy/ticket"; // type-only
import { progressOf, updateTracker, type Press, type Progress, type Snapshot, type UpdateTracker } from "./updateProgress";

const NO_SNAPSHOT: Snapshot = { press: null, link: { t: "none" } };

export function useUpdateSnapshot(tracker: UpdateTracker = updateTracker()): Snapshot {
  return useSyncExternalStore(tracker.subscribe, tracker.get, () => NO_SNAPSHOT);
}

// Only the page's press (the Queue view): no render on each poll.
export function useUpdatePress(tracker: UpdateTracker = updateTracker()): Press | null {
  return useSyncExternalStore(tracker.subscribe, () => tracker.get().press, () => null);
}

export type UpdateProgressView = {
  p: Progress;
  // This place saw the run under way (or the page's press has not shown its end yet): its end
  // plays the one end motion, and Settings shows the progress in place of its line.
  live: boolean;
  press: Press | null;
  tracker: UpdateTracker;
};

type Opts = {
  // The ticket's id; null on the Settings page (the page's press of any ticket).
  item: string | null;
  run: UpdateRun | null | undefined;
  closed?: string | null;
  to?: number;
  // Settings: one read of GET /api/deploy on mount (a run that another device asked).
  pollOnMount?: boolean;
};

export function useUpdateProgress(o: Opts, tracker: UpdateTracker = updateTracker()): UpdateProgressView {
  const snap = useUpdateSnapshot(tracker);
  const press = snap.press && (o.item === null || snap.press.item === o.item) ? snap.press : null;
  const { p, furthest } = progressOf({ run: o.run, closed: o.closed ?? null, press, link: snap.link, now: Date.now(), ...(o.to !== undefined ? { to: o.to } : {}) });
  const saw = useRef(false);
  if (p.t === "going" || (press !== null && !press.ended)) saw.current = true;
  const going = p.t === "going";
  // The poll runs while a run is under way somewhere on the page (one poll for all places).
  useEffect(() => (going ? tracker.watch() : undefined), [going, tracker]);
  const pollOnMount = o.pollOnMount === true;
  useEffect(() => { if (pollOnMount) void tracker.pollOnce(); }, [pollOnMount, tracker]);
  const ended = p.t === "done" || p.t === "failed";
  useEffect(() => {
    if (press && furthest > press.furthest) tracker.note({ furthest });
  }, [press, furthest, tracker]);
  useEffect(() => {
    if (press && ended && !press.ended) tracker.note({ ended: true });
  }, [press, ended, tracker]);
  return { p, live: saw.current, press, tracker };
}
