// server/cron/running.test.ts — the Recurring runs in progress and their logins, from the
// runner's marks (bin/cron-runner.mjs): what the sign-out of a login waits for.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recurringRunsNow, runsNow } from "./running.js";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cron-running-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

async function mark(name: string, body: unknown, timeoutMinutes?: number) {
  await mkdir(join(dir, "runs", name), { recursive: true });
  await mkdir(join(dir, "jobs"), { recursive: true });
  await writeFile(join(dir, "runs", name, "running.json"), JSON.stringify(body));
  await writeFile(join(dir, "jobs", `${name}.json`), JSON.stringify({ name, ...(timeoutMinutes ? { timeoutMinutes } : {}) }));
}

describe("recurringRunsNow", () => {
  const NOW = 1_800_000_000_000;
  it("no runs folder: no run", async () => {
    expect(await recurringRunsNow(join(dir, "nope"), NOW)).toEqual([]);
  });

  it("each fresh mark with its login; a mark with no login (or a bad one) is any login; an old mark or a run that ended is no run", async () => {
    await mark("a-named", { startedAt: NOW - 60_000, login: "work" });
    await mark("b-starting", { startedAt: NOW - 1_000 });
    await mark("c-bad", { startedAt: NOW - 1_000, login: "../x" });
    await mark("d-old", { startedAt: NOW - 33 * 60_000, login: "default" }); // past 30 min + the margin
    await mark("e-long", { startedAt: NOW - 50 * 60_000, login: "default" }, 60);
    await mkdir(join(dir, "runs", "f-ended"), { recursive: true });
    expect(await recurringRunsNow(dir, NOW)).toEqual([
      { name: "a-named", login: "work" }, { name: "b-starting", login: null }, { name: "c-bad", login: null }, { name: "e-long", login: "default" },
    ]);
  });

  it("runsNow (the task list): the same freshness rule", async () => {
    await mark("x", { startedAt: NOW - 1_000 });
    expect(await runsNow(join(dir, "runs", "x", "running.json"), undefined, NOW)).toBe(true);
    expect(await runsNow(join(dir, "runs", "x", "running.json"), undefined, NOW + 40 * 60_000)).toBe(false);
    expect(await runsNow(join(dir, "runs", "nope", "running.json"), undefined, NOW)).toBe(false);
  });
});
