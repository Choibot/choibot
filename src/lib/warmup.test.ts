import { describe, expect, it } from "vitest";
import { FLEET_MASTER_ID } from "./queueRow";
import { QUIET_MS, WARM_AGENTS, WARM_CRON_JOBS, runWarmUp, warmSteps, type WarmEnv } from "./warmup";

// A fake browser: a clock that moves only by sleep, a hidden flag, and user actions on demand.
function fakeEnv() {
  let t = 0;
  let hidden = false;
  let showWaiters: Array<() => void> = [];
  let act: (() => void) | null = null;
  const log: string[] = [];
  const env: WarmEnv = {
    idle: () => Promise.resolve(),
    hidden: () => hidden,
    visible: () => new Promise((res) => { showWaiters.push(res); }),
    watchActs: (on) => { act = on; return () => { act = null; }; },
    sleep: (ms) => { log.push(`sleep ${ms}`); t += ms; return Promise.resolve(); },
    now: () => t,
  };
  return {
    env, log,
    hide: () => { hidden = true; },
    show: () => { hidden = false; const w = showWaiters; showWaiters = []; w.forEach((f) => f()); },
    act: () => act?.(),
    watching: () => act !== null,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("runWarmUp", () => {
  it("runs the tasks in order, one at a time", async () => {
    const f = fakeEnv();
    const seen: string[] = [];
    let release!: () => void;
    const first = () => new Promise<void>((res) => { seen.push("1 start"); release = () => { seen.push("1 end"); res(); }; });
    const second = async () => { seen.push("2 start"); };
    const { done } = runWarmUp([first, second], f.env);
    await flush();
    expect(seen).toEqual(["1 start"]); // the second waits for the first
    release();
    expect(await done).toBe(2);
    expect(seen).toEqual(["1 start", "1 end", "2 start"]);
    expect(f.watching()).toBe(false); // it lets go of the user's events at the end
  });

  it("waits while the tab is hidden", async () => {
    const f = fakeEnv();
    f.hide();
    let ran = false;
    const { done } = runWarmUp([async () => { ran = true; }], f.env);
    await flush();
    expect(ran).toBe(false);
    f.show();
    expect(await done).toBe(1);
    expect(ran).toBe(true);
  });

  it("waits until the user has been quiet for QUIET_MS after an action", async () => {
    const f = fakeEnv();
    let release!: () => void;
    const first = () => new Promise<void>((res) => { release = res; });
    const { done } = runWarmUp([first, async () => {}], f.env);
    await flush();
    f.act(); // the user presses while the first read is out
    release();
    expect(await done).toBe(2);
    expect(f.log).toContain(`sleep ${QUIET_MS}`);
  });

  it("stops before the next task", async () => {
    const f = fakeEnv();
    let release!: () => void;
    let second = false;
    const { done, stop } = runWarmUp([() => new Promise<void>((res) => { release = res; }), async () => { second = true; }], f.env);
    await flush();
    stop();
    release();
    expect(await done).toBe(1);
    expect(second).toBe(false);
  });

  it("skips a task that fails and goes on", async () => {
    const f = fakeEnv();
    let last = false;
    const { done } = runWarmUp([async () => { throw new Error("offline"); }, async () => { last = true; }], f.env);
    expect(await done).toBe(2);
    expect(last).toBe(true);
  });
});

describe("warmSteps", () => {
  const w = (id: string, status = "done") => ({ id, status, worker: true });
  const rowIds = (steps: ReturnType<typeof warmSteps>) => steps.flatMap((s) => (s.t === "row" ? [s.id] : []));

  it("goes in the sidebar's order: the master, GitHub, the leads, the first WARM_AGENTS agents", () => {
    const workers = Array.from({ length: WARM_AGENTS + 3 }, (_, i) => w(`a${i}`));
    const steps = warmSteps({ master: true, leads: [{ id: "lead-infra", status: "idle", worker: false }], workers, cronJobs: [] });
    expect(steps[0]).toMatchObject({ t: "row", id: FLEET_MASTER_ID });
    expect(steps[1]).toEqual({ t: "github" });
    expect(rowIds(steps)).toEqual([FLEET_MASTER_ID, "lead-infra", ...workers.slice(0, WARM_AGENTS).map((x) => x.id)]);
  });

  it("reads a prompt card only for a live agent, and widgets only for a worker", () => {
    const steps = warmSteps({ master: false, leads: [{ id: "lead-x", status: "done", worker: false }], workers: [w("run", "running"), w("old", "done")], cronJobs: [] });
    expect(steps).toEqual([
      { t: "github" },
      { t: "row", id: "lead-x", widgets: false, prompt: false },
      { t: "row", id: "run", widgets: true, prompt: true },
      { t: "row", id: "old", widgets: true, prompt: false },
    ]);
  });

  it("ends with the master view and the first cron jobs", () => {
    const jobs = Array.from({ length: WARM_CRON_JOBS + 2 }, (_, i) => `job${i}`);
    const steps = warmSteps({ master: true, leads: [], workers: [], cronJobs: jobs });
    expect(steps.slice(2)).toEqual([{ t: "master" }, ...jobs.slice(0, WARM_CRON_JOBS).map((job) => ({ t: "cron", job }))]);
  });
});
