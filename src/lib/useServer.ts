// src/lib/useServer.ts — the Server page's reads: the last answer at once (lib/viewCache), a new
// one when the page opens, when the tab comes back, and on a tick while the page is on screen.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHealth, fetchLevel, type HealthAnswer, type HealthView, type Level } from "./server";
import { useRemembered, viewMemory } from "./viewCache";

const seenHealth = viewMemory<HealthView | null>(1);
const seenLevel = viewMemory<Level | null>(1);

// The server samples each 15 seconds: the page asks at the same pace.
export const HEALTH_POLL_MS = 15_000;
// The dot of the sidebar row changes slowly (a warning needs minutes to come).
export const LEVEL_POLL_MS = 60_000;

function usePoll(on: boolean, ms: number, read: () => Promise<void>): void {
  useEffect(() => {
    if (!on) return;
    void read();
    const shown = () => document.visibilityState === "visible";
    const onShow = () => { if (shown()) void read(); };
    document.addEventListener("visibilitychange", onShow);
    const tick = setInterval(() => { if (shown()) void read(); }, ms);
    return () => { document.removeEventListener("visibilitychange", onShow); clearInterval(tick); };
  }, [on, ms, read]);
}

export type HealthState = {
  view: HealthView | null;
  // Why the last read gave no answer (the page keeps what it had).
  why: Exclude<HealthAnswer, { ok: true }>["why"] | null;
  refresh: () => Promise<void>;
};

export function useHealth(on = true): HealthState {
  const [view, setView] = useRemembered<HealthView | null>(seenHealth, "health", null);
  const [why, setWhy] = useState<HealthState["why"]>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const a = await fetchHealth();
    if (a.ok) {
      setView(a.view);
      seenLevel.set("level", a.view.level);
    }
    if (live.current) setWhy(a.ok ? null : a.why);
  }, [setView]);
  usePoll(on, HEALTH_POLL_MS, refresh);
  return { view, why, refresh };
}

// The worst warning level, for the dot of the sidebar row. Null until the server answers.
export function useServerLevel(): Level | null {
  const [level, setLevel] = useRemembered<Level | null>(seenLevel, "level", null);
  const refresh = useCallback(async () => {
    const next = await fetchLevel();
    if (next !== null) setLevel(next);
  }, [setLevel]);
  usePoll(true, LEVEL_POLL_MS, refresh);
  return level;
}
