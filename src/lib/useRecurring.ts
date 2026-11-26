// src/lib/useRecurring.ts — the one read of the recurring tasks for the page: the sidebar row's
// dot and the Recurring page use the same answer. The last answer shows at once (lib/viewCache);
// a new one comes on a tick while the browser tab is on screen, faster while the page is open.
"use client";
import { useCallback, useEffect } from "react";
import { fetchCronJobs, sortTasks, type CronJob, type CronJobs } from "./cron";
import { useRemembered, viewMemory } from "./viewCache";

// The page open: the pace of the old Cron group. Else: only the row's dot needs it.
export const RECURRING_OPEN_MS = 5_000;
export const RECURRING_IDLE_MS = 30_000;

const seen = viewMemory<CronJobs | null>(1);
const KEY = "tasks";

// The task names in the order of the list, once read (the warm-up reads their runs).
export function recurringNames(): string[] {
  return sortTasks(seen.get(KEY)?.jobs ?? []).map((j) => j.name);
}

// jobs null: not read yet. timeZone: the server's zone (null: not known).
export type Recurring = { jobs: CronJob[] | null; timeZone: string | null; refresh: () => Promise<void> };

export function useRecurring(open: boolean): Recurring {
  const [data, setData] = useRemembered<CronJobs | null>(seen, KEY, null);
  const refresh = useCallback(async () => {
    // A failed read keeps the last good list.
    try { setData(await fetchCronJobs()); } catch { /* the next tick tries again */ }
  }, [setData]);
  useEffect(() => {
    void refresh();
    const shown = () => document.visibilityState === "visible";
    const onShow = () => { if (shown()) void refresh(); };
    document.addEventListener("visibilitychange", onShow);
    const tick = setInterval(() => { if (shown()) void refresh(); }, open ? RECURRING_OPEN_MS : RECURRING_IDLE_MS);
    return () => { document.removeEventListener("visibilitychange", onShow); clearInterval(tick); };
  }, [open, refresh]);
  return { jobs: data?.jobs ?? null, timeZone: data?.timeZone ?? null, refresh };
}
