// server/cron/running.ts — the Recurring runs that are in progress now. bin/cron-runner.mjs
// writes runs/<task>/running.json when a run starts ({startedAt}), then again with the Claude
// login of the run ({startedAt, login}) when it knows it, and removes it when the run ends. The
// task list of the page ("Runs now") and "Sign out" of a Claude login (agents/api.ts) read it: a
// run's Claude holds its login while it runs and can write it back after a sign-out.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cronPaths, readJsonSafe, resolveCronDataDir, type CronJobSpec } from "../../bin/lib/cronspec.js";
import { isLoginId } from "../../bin/lib/cron-login.mjs";

// A mark older than the task's time limit (plus a margin) is from a runner that died: the task
// does not run.
const RUNNING_MARGIN_MS = 2 * 60_000;

type Mark = { startedAt?: unknown; login?: unknown };

const fresh = (mark: Mark | null, timeoutMinutes: unknown, now: number): boolean => {
  if (!mark || typeof mark.startedAt !== "number") return false;
  const limit = (typeof timeoutMinutes === "number" && timeoutMinutes > 0 ? timeoutMinutes : 30) * 60_000 + RUNNING_MARGIN_MS;
  const age = now - mark.startedAt;
  return age >= 0 && age < limit;
};

export async function runsNow(file: string, timeoutMinutes: unknown, now = Date.now()): Promise<boolean> {
  return fresh(await readJsonSafe<Mark>(file), timeoutMinutes, now);
}

// login: the id of the run's login ("default": the main login), or null while the runner does
// not know it yet (or an older runner, which writes no login): then it can be any login.
export type RunNow = { name: string; login: string | null };

export async function recurringRunsNow(dataDir: string = resolveCronDataDir(), now = Date.now()): Promise<RunNow[]> {
  const paths = cronPaths(dataDir);
  let names: string[] = [];
  try { names = await readdir(paths.runsDir); } catch { return []; } // no run yet
  const out: RunNow[] = [];
  for (const name of names.sort()) {
    const mark = await readJsonSafe<Mark>(join(paths.runsDir, name, "running.json"));
    if (!mark) continue;
    const spec = await readJsonSafe<CronJobSpec>(join(paths.jobsDir, `${name}.json`));
    if (!fresh(mark, spec?.timeoutMinutes, now)) continue;
    out.push({ name, login: typeof mark.login === "string" && isLoginId(mark.login) ? mark.login : null });
  }
  return out;
}
