// src/lib/warmup.ts — after a page load, fill the view memory (lib/viewCache) for the rows on
// screen, so a first open of them shows its content at once (components/warmPlan.ts has the
// list). After a load every open is a first one, and the user mostly comes from a Telegram link.
//
// Low priority: one read at a time, each at an idle moment; nothing while the tab is hidden; and
// nothing while the user acts (a press, a key, a scroll): the warm-up waits until they have been
// quiet for QUIET_MS, so it never competes with what they asked for.
import { FLEET_MASTER_ID } from "./queueRow";

export const QUIET_MS = 1500;

export type WarmEnv = {
  idle(): Promise<void>; // the next idle moment
  hidden(): boolean;
  visible(): Promise<void>; // the tab is shown again
  // Calls `onAct` on each user action; returns the unsubscribe.
  watchActs(onAct: () => void): () => void;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type WarmTask = () => Promise<unknown>;

// Runs the tasks in order, one at a time. `done` resolves with how many ran. A failed task is
// skipped (its view reads the data itself). `stop` ends the run before the next task.
export function runWarmUp(tasks: WarmTask[], env: WarmEnv): { done: Promise<number>; stop: () => void } {
  let stopped = false;
  let lastAct = Number.NEGATIVE_INFINITY;
  const unwatch = env.watchActs(() => { lastAct = env.now(); });
  const run = async (): Promise<number> => {
    let ran = 0;
    try {
      for (const task of tasks) {
        for (;;) {
          if (stopped) return ran;
          if (env.hidden()) { await env.visible(); continue; }
          const wait = lastAct + QUIET_MS - env.now();
          if (wait > 0) { await env.sleep(wait); continue; }
          await env.idle();
          if (stopped) return ran;
          // The user may have acted or hidden the tab while this waited for idle.
          if (env.hidden() || lastAct + QUIET_MS > env.now()) continue;
          break;
        }
        await task().catch(() => {});
        ran++;
      }
      return ran;
    } finally {
      unwatch();
    }
  };
  return { done: run(), stop: () => { stopped = true; } };
}

// The browser's signals. iOS Safari has no requestIdleCallback: a short timer stands in.
export function browserWarmEnv(): WarmEnv {
  type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  const w = window as IdleWindow;
  return {
    idle: () => new Promise((res) => {
      if (w.requestIdleCallback) w.requestIdleCallback(() => res(), { timeout: 2000 });
      else setTimeout(res, 200);
    }),
    hidden: () => document.hidden,
    visible: () => new Promise((res) => {
      const on = (): void => { if (!document.hidden) { document.removeEventListener("visibilitychange", on); res(); } };
      document.addEventListener("visibilitychange", on);
    }),
    watchActs: (onAct) => {
      const kinds = ["pointerdown", "keydown", "wheel", "touchmove"] as const;
      for (const k of kinds) document.addEventListener(k, onAct, { capture: true, passive: true });
      return () => { for (const k of kinds) document.removeEventListener(k, onAct, { capture: true }); };
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
  };
}

// ---- the plan (components/warmPlan.ts runs it) ----

export const WARM_AGENTS = 8;
export const WARM_CRON_JOBS = 4;
// The GitHub read can be slow (the server asks GitHub when its 30 s cache is cold): the warm-up
// waits this long for it at most, then goes on while the read finishes on its own.
export const GITHUB_WAIT_MS = 400;

// A row of the sidebar: a worker has widgets; a live one (running, idle) can show a prompt card.
export type WarmRow = { id: string; status?: string; worker: boolean };
// One step is one row (its reads go together: the newest thread page, the widget list of a
// worker, the prompt card of a live agent) or one list.
export type WarmStep =
  | { t: "row"; id: string; widgets: boolean; prompt: boolean }
  | { t: "cron"; job: string }
  | { t: "github" | "master" };

const live = (status?: string): boolean => status === "running" || status === "idle";

// The steps in the sidebar's order (pure, for the tests): the fleet master, the GitHub list, the
// leads, the first WARM_AGENTS agents, then the master view's status line and leads and the first
// cron jobs. `leads` and `workers` are in their sidebar order.
export function warmSteps({ master, leads, workers, cronJobs }: {
  master: boolean; leads: WarmRow[]; workers: WarmRow[]; cronJobs: string[];
}): WarmStep[] {
  const row = (r: WarmRow): WarmStep => ({ t: "row", id: r.id, widgets: r.worker, prompt: live(r.status) });
  return [
    ...(master ? [row({ id: FLEET_MASTER_ID, status: "idle", worker: false })] : []),
    { t: "github" } as const,
    ...leads.map(row),
    ...workers.slice(0, WARM_AGENTS).map(row),
    ...(master ? [{ t: "master" } as const] : []),
    ...cronJobs.slice(0, WARM_CRON_JOBS).map((job) => ({ t: "cron", job }) as const),
  ];
}
