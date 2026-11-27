// src/lib/useGuide.ts — the guide for the Set-up page: its thread, kept up to date, and the
// send of a message. The guide is read when the page opens (with a sync, so the welcome is
// there), on each new answer of the step list, on a slow tick, and every second while the
// guide writes. A console with no guide answers 404: `on` then stays false and the page is the
// list alone.
"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BUSY_MAX_MS, fetchGuide, readGuideHint, sendToGuide, writeGuideHint, type GuideView, type SendResult } from "./guide";
import { useRemembered, viewMemory } from "./viewCache";

// The last thread of this page load, so the page that opens again draws it on its first frame.
// In memory only. It holds what the server gave: never a text of the box.
const seen = viewMemory<GuideView | null>(1);

const SYNC_MS = 10_000;
const BUSY_POLL_MS = 1_000;

export type GuideHook = {
  // False: no guide on this console (or no answer yet). The page shows the list alone.
  on: boolean;
  view: GuideView | null;
  // The guide writes an answer now (and the wait is not over its limit).
  busy: boolean;
  // The guide wrote for longer than the page waits: one plain line, and the box is free again.
  late: boolean;
  send: (text: string) => Promise<SendResult>;
  // The list changed (the action of a step ended): let the guide say what is new.
  sync: () => void;
};

export function useGuide(o: { on: boolean; mark: number }): GuideHook {
  const [view, setView] = useRemembered<GuideView | null>(seen, "guide", null);
  const [on, setOn] = useState(view !== null);
  // The answer of the last load ("this console has a guide") is read before the first paint, so
  // the page does not open as the list alone and then change.
  useLayoutEffect(() => { if (readGuideHint()) setOn(true); }, []);
  const [late, setLate] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // No guide here: no call after the first one says so.
  const none = useRef(false);

  const read = useCallback(async (sync: boolean) => {
    if (none.current) return;
    const r = await fetchGuide({ sync });
    if (!live.current || r === null) return;
    writeGuideHint(r.on);
    if (!r.on) { none.current = true; setOn(false); return; }
    setOn(true);
    setView(r.view);
  }, [setView]);
  const sync = useCallback(() => { void read(true); }, [read]);

  // The page opens, the step list has a new answer, or the slow tick: sync.
  const { on: wanted, mark } = o;
  useEffect(() => { if (wanted) void read(true); }, [wanted, mark, read]);
  useEffect(() => {
    if (!wanted) return;
    const tick = setInterval(() => { if (document.visibilityState === "visible") void read(true); }, SYNC_MS);
    return () => clearInterval(tick);
  }, [wanted, read]);

  // While the guide writes: read every second, for BUSY_MAX_MS at most.
  const writes = view?.busy === true;
  useEffect(() => {
    if (!writes) { setLate(false); return; }
    const tick = setInterval(() => void read(false), BUSY_POLL_MS);
    const end = setTimeout(() => setLate(true), BUSY_MAX_MS);
    return () => { clearInterval(tick); clearTimeout(end); };
  }, [writes, read]);

  // A plan limit with a known end: read again when it is over.
  const until = view?.off?.until;
  useEffect(() => {
    if (!until) return;
    const ms = until - Date.now();
    if (ms <= 0 || ms > 24 * 3600_000) return;
    const t = setTimeout(() => void read(false), ms + 1_000);
    return () => clearTimeout(t);
  }, [until, read]);

  const send = useCallback(async (text: string) => {
    const r = await sendToGuide(text);
    if (live.current && "view" in r && r.view) setView(r.view);
    return r;
  }, [setView]);

  return { on, view, busy: writes && !late, late: writes && late, send, sync };
}
