// src/components/warmPlan.ts — what the warm-up (lib/warmup) reads after a page load, so a first
// open of a sidebar row shows its content at once, in the sidebar's order: the fleet master, the
// GitHub list, the leads and the first WARM_AGENTS agents (each: the newest page of its thread,
// its widget list, and its prompt card while it is live), then the master's status line and
// leads, and the run history of the first cron jobs. One row at a time (lib/warmup). The queue's
// tickets need nothing here: the page reads the queue at load.
//
// Server cost: a thread page reads the tail of the agent's session file (13-70 ms on real files
// of 20-130 MB), the GitHub list is cached 30 s by the server, the others read small files.
import { GITHUB_WAIT_MS, browserWarmEnv, runWarmUp, warmSteps, type WarmStep, type WarmTask } from "../lib/warmup";
import { prefetchThread } from "../lib/useThread";
import { prefetchPrompt } from "../lib/usePrompt";
import { prefetchWidgets } from "./WidgetStrip";
import { prefetchCockpit } from "./CockpitPanel";
import { prefetchMasterView } from "./MasterView";
import { prefetchCronRuns } from "./recurring/RecurringTask";

function task(s: WarmStep): WarmTask {
  switch (s.t) {
    case "row": return () => Promise.all([
      prefetchThread(s.id),
      s.widgets ? prefetchWidgets(s.id).catch(() => {}) : null,
      s.prompt ? prefetchPrompt(s.id).catch(() => {}) : null,
    ]);
    case "github": return () => Promise.race([prefetchCockpit().catch(() => {}), new Promise((res) => setTimeout(res, GITHUB_WAIT_MS))]);
    case "master": return () => prefetchMasterView();
    case "cron": return () => prefetchCronRuns(s.job);
  }
}

let started = false;

// Once per page load (the phone's home list mounts again on each way back).
export function startWarmUp(plan: Parameters<typeof warmSteps>[0]): void {
  if (started || typeof window === "undefined") return;
  started = true;
  runWarmUp(warmSteps(plan).map(task), browserWarmEnv());
}
