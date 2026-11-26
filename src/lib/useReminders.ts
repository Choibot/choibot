// src/lib/useReminders.ts — the Agents list's reminder badges: one fetch of
// GET /api/reminders when enabled (the chief queue is on), a re-fetch on each
// `reminders` SSE event and stream (re)open, and a 60 s clock for the
// countdown (no request). Disabled (flag off, misconfigured, loading): no
// request, no stream, no badge. `paired` (cancelAllowed, read again on every
// pairing change) shows the badge's cancel ×.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeChiefState } from "./chief";
import { cancelAllowed, fetchReminders, nextByAgent, type NextReminder, type ReminderRow } from "./reminders";
import { useEvents } from "./useEvents";

export type RemindersProp = { byAgent: Record<string, NextReminder>; now: number; paired: boolean };

const CLOCK_MS = 60_000;

export function useReminders(enabled: boolean): RemindersProp | undefined {
  const [list, setList] = useState<ReminderRow[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Read after mount (the server render has no localStorage).
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    setPaired(cancelAllowed());
    return subscribeChiefState(() => setPaired(cancelAllowed()));
  }, []);
  // serverNow - Date.now() at the last fetch: the countdown follows the server clock.
  const skew = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // A failed fetch keeps the last list.
  const load = useCallback(async () => {
    try {
      const v = await fetchReminders();
      if (!alive.current) return;
      if (v.state === "on") {
        skew.current = v.serverNow - Date.now();
        setNow(v.serverNow);
        setList(v.reminders);
      } else setList(null);
    } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    if (!enabled) { setList(null); return; }
    void load();
    const t = setInterval(() => setNow(Date.now() + skew.current), CLOCK_MS);
    return () => clearInterval(t);
  }, [enabled, load]);
  useEvents((e) => { if (e.type === "reminders") void load(); }, enabled, () => { void load(); });
  return useMemo(() => (enabled && list ? { byAgent: nextByAgent(list), now, paired } : undefined), [enabled, list, now, paired]);
}
