// server/setup/api.ts — the step list for the browser.
//   GET /api/setup/steps   any session: every set-up step with its state, in order
//   GET /api/setup/home    any session: is the Set-up page the home of this console?
// The answer is the output of runSteps (steps.ts): plain words only, no secret, no file path,
// no settings key. Read only: nothing here can mark a step done. The answer is kept for a few
// seconds, and callers that come while a run is in progress share that run.
import type { FastifyInstance } from "fastify";
import { boxFactsOf, runChecks } from "../../bin/lib/doctor.js";
import { deployUnit, ownUnit } from "../chief/deploy/config.js";
import type { Env } from "../defaults.js";
import type { ClaudeAccount } from "../../bin/lib/login.js";
import type { AppTokenState } from "../gh/applogin.js";
import { boxProbes, consoleProbes, type ConsoleDeps } from "./probes.js";
import { runSteps, stepOf, type Probes, type StepId, type StepStatus } from "./steps.js";

export const STEPS_TTL_MS = 5_000;

// home: the Set-up page is the home of the console. True on a new install (server/names.mjs)
// until its first pull request is merged. Always false on an install with the old names: there
// the list is one row of Settings.
// protection: "strong" when the agents run under their own account (chief/hardened.ts).
// githubApp: the ChoiBot GitHub app switch is on (gh/appconfig.ts): the page draws "Connect
// GitHub" and "Pick a repo" as one step (src/lib/setup.ts). The two checks stay two.
export type StepsAnswer = { steps: StepStatus[]; checkedAt: number; home: boolean; protection: "strong" | "basic"; githubApp?: true };

const mergeOpen = (steps: StepStatus[]): boolean => steps.some((s) => s.id === "merge" && s.state !== "done");

// An event of the console that makes the kept answer old before its few seconds are over: a
// change of a pull request ticket (it came, its state changed, it was merged). The checks of
// "Start the first agent" and "Merge the first PR" read those tickets, and the page reads the
// list right after its own Merge: it must not get the answer from before the merge.
export const makesStale = (e: { type: string; item?: { kind?: string } }): boolean => e.type === "queue" && e.item?.kind === "pr";

export function registerSetupApi(app: FastifyInstance, d: {
  // A new set of probes for each run of the list.
  probes: () => Partial<Probes>;
  // This console is a new install (chief/firstrun.ts newInstall).
  newInstall?: boolean;
  // Strong protection is on now (the hardened monitor). None: basic.
  strong?: () => boolean;
  // The ChoiBot GitHub app switch is on.
  githubApp?: boolean;
  now?: () => number;
  log?: (s: string) => void;
}): { forget(): void; read(): Promise<StepsAnswer>; last(): StepsAnswer | null } {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((s: string) => console.warn(s));
  let cache: StepsAnswer | null = null;
  let inflight: Promise<StepsAnswer> | null = null;
  let runs = 0;

  // One read of the list. The route and the guide (guide/guide.ts) share it: one cache, one run.
  const read = (): Promise<StepsAnswer> => {
    if (cache && now() - cache.checkedAt < STEPS_TTL_MS) return Promise.resolve(cache);
    if (inflight) return inflight;
    const run = runs;
    const p: Promise<StepsAnswer> = runSteps(d.probes(), {
      // The cause goes to the console's log. The answer says only that the check did not run.
      onError: (id: StepId, e: unknown) => log(`[setup] the check of step ${id} did not run: ${e instanceof Error ? e.message : String(e)}`),
    })
      .then((steps) => {
        const answer: StepsAnswer = {
          steps, checkedAt: now(), home: d.newInstall === true && mergeOpen(steps), protection: d.strong?.() === true ? "strong" : "basic",
          ...(d.githubApp ? { githubApp: true as const } : {}),
        };
        // An action came in while this run read the box: its answer is not kept.
        if (run === runs) cache = answer;
        return answer;
      })
      .finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  };
  const forget = () => { cache = null; inflight = null; runs++; };

  app.get("/api/setup/steps", async () => read());

  // What the page asks when it opens. An install with the old names gets its answer with no
  // check at all. A new install runs the one check that decides (the last required step).
  app.get("/api/setup/home", async () => {
    if (d.newInstall !== true) return { home: false };
    if (cache && now() - cache.checkedAt < STEPS_TTL_MS) return { home: cache.home };
    return { home: mergeOpen(await runSteps(d.probes(), { steps: [stepOf("merge")] })) };
  });

  // forget: an action of the page changed what a check reads (actions.ts): the next read checks again.
  // last: the answer that is kept, of any age (null after forget). The guide's sync reads it, so
  // its ticks start no run of the checks: the page's own reads keep the answer new.
  return { forget, read, last: () => cache };
}

// The probes of the running console: the box under it, checked with the console's own
// settings (the env it runs with), and its own state.
export function consoleStepProbes(d: {
  env: Env; repoDir: string; agentStatus?: (() => Promise<ClaudeAccount>) | null;
  // The GitHub app switch is on: the state of the app's key (probes.ts BoxDeps).
  githubApp?: () => Promise<AppTokenState>;
  // The second sign-in (chief/chiefaccount.ts): its status and the agents that wait for it.
  // Absent: no second account here, and the step has no row.
  // problem: why the server cannot make that sign-in (null: it can).
  persistent?: { status: (() => Promise<ClaudeAccount>) | null; waits: () => string[]; problem: () => string | null };
} & Omit<ConsoleDeps, "env">): Partial<Probes> {
  const settings = new Map(Object.entries(d.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  return {
    ...boxProbes({
      env: d.env, agentStatus: d.agentStatus, ...(d.githubApp ? { githubApp: d.githubApp } : {}),
      box: async () => boxFactsOf(await runChecks(d.repoDir, { requiredOnly: true, env: settings }), {
        // This process is the console: it answers. It is the service when it runs in its unit.
        service: (await ownUnit(deployUnit(d.env))).ok ? "running" : "none",
        answers: true,
      }),
    }),
    ...consoleProbes(d),
    persistentLogin: async () => {
      const s = d.persistent;
      if (!s) return { wanted: false, ready: false, loggedIn: false, waits: [] };
      const ready = s.problem() === null && s.status !== null;
      return { wanted: true, ready, loggedIn: ready && s.status ? (await s.status()).loggedIn : false, waits: s.waits() };
    },
  };
}
