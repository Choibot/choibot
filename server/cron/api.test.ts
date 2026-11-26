// server/cron/api.test.ts
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTE_REFUSAL, RECURRING_NO_PAIRING, registerCronApi, repoName } from "./api.js";
import { COORDINATOR_REFUSAL, registerCoordinatorGate } from "../coordinator/gate.js";
import type { GuideModel } from "../guide/model.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cronCtx } from "../../bin/lib/cron.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { CHIEF_ERR, makeGate } from "../chief/gate.js";
import type { TicketLookup } from "./result.js";
import { cronPaths, type CronJobSpec, type CronRunResult } from "../../bin/lib/cronspec.js";
import { EventHub, type ConsoleEvent } from "../events.js";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const SPEC: CronJobSpec = {
  name: "brief", schedule: "*-*-* 08:00:00", prompt: "write the morning brief",
  timeoutMinutes: 30, notify: "always", enabled: true, createdAt: 1000,
};

async function seedJob(dataDir: string, spec: CronJobSpec, last?: CronRunResult | string) {
  const paths = cronPaths(dataDir);
  await mkdir(paths.jobsDir, { recursive: true });
  await writeFile(join(paths.jobsDir, `${spec.name}.json`), JSON.stringify(spec));
  if (last !== undefined) {
    const runDir = join(paths.runsDir, spec.name);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "last.json"), typeof last === "string" ? last : JSON.stringify(last));
  }
}

type Deps = { listTimers?: () => Promise<Array<{ unit?: string; next_elapse?: string | null; next?: number }>>; timeZone?: () => string; workspaceDir?: string; ticket?: TicketLookup };

async function makeApp(dataDir: string, extra: Deps = {}): Promise<{
  app: FastifyInstance; hub: EventHub; events: ConsoleEvent[]; cleanup: () => Promise<void>;
}> {
  const hub = new EventHub();
  const events: ConsoleEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const app = Fastify();
  registerCronApi(app, { hub, cronDataDir: dataDir, listTimers: extra.listTimers ?? (async () => []), timeZone: extra.timeZone ?? (() => "Europe/Paris"), workspaceDir: extra.workspaceDir ?? "/srv/work", ticket: extra.ticket });
  return {
    app, hub, events,
    cleanup: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

describe("GET /api/cron/jobs", () => {
  it("returns the seeded job with lastRun summary (tail) and nextRun from the timers list", async () => {
    const dataDir = await tmp("cron-");
    const outputTail = "x".repeat(150) + "y".repeat(300); // 450 chars; tail = last 300
    await seedJob(dataDir, SPEC, { startedAt: 1, finishedAt: 2, exitCode: 0, ok: true, outputTail });
    const { app, cleanup } = await makeApp(dataDir, {
      listTimers: async () => [
        { unit: "choibot-cron-other.timer", next_elapse: "2026-08-07T00:00:00Z" },
        { unit: "choibot-cron-brief.timer", next_elapse: "2026-08-07T08:00:00Z" },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: "brief", schedule: "*-*-* 08:00:00", enabled: true, notify: "always",
      nextRun: "2026-08-07T08:00:00Z",
    });
    const lastRun = jobs[0].lastRun as { finishedAt: number; ok: boolean; summary: string };
    expect(lastRun.finishedAt).toBe(2);
    expect(lastRun.ok).toBe(true);
    expect(lastRun.summary).toBe("y".repeat(300)); // tail of outputTail

    await cleanup();
  });

  it("reads nextRun from `next` (µs since epoch) when systemd omits next_elapse", async () => {
    // Some systemd versions emit only `next` (microseconds since the epoch)
    // in list-timers --output=json; `choibot cron list` handles both, so must this.
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC);
    const nextMs = Date.UTC(2026, 7, 7, 8, 0, 0); // 2026-08-07T08:00:00.000Z
    const { app, cleanup } = await makeApp(dataDir, {
      listTimers: async () => [{ unit: "choibot-cron-brief.timer", next: nextMs * 1000 }],
    });

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs[0].nextRun).toBe("2026-08-07T08:00:00.000Z");

    await cleanup();
  });

  it("prefers next_elapse when a row carries both fields", async () => {
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC);
    const { app, cleanup } = await makeApp(dataDir, {
      listTimers: async () => [{
        unit: "choibot-cron-brief.timer",
        next_elapse: "2026-08-07T08:00:00Z",
        next: Date.UTC(2030, 0, 1) * 1000,
      }],
    });

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs[0].nextRun).toBe("2026-08-07T08:00:00Z");

    await cleanup();
  });

  it("falls through an empty next_elapse to `next` (the CLI's truthy test)", async () => {
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC);
    const { app, cleanup } = await makeApp(dataDir, {
      listTimers: async () => [{
        unit: "choibot-cron-brief.timer", next_elapse: "", next: Date.UTC(2026, 7, 7, 8, 0, 0) * 1000,
      }],
    });

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs[0].nextRun).toBe("2026-08-07T08:00:00.000Z");

    await cleanup();
  });

  it("treats sentinel `next` values as no next run instead of 500ing", async () => {
    // systemd's USEC_INFINITY (UINT64_MAX µs) would blow past the Date range and
    // make toISOString() throw — the rail polls every 5s, so an unguarded
    // conversion 500s forever on such a host.
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC);
    await seedJob(dataDir, { ...SPEC, name: "other" });
    const { app, cleanup } = await makeApp(dataDir, {
      listTimers: async () => [
        { unit: "choibot-cron-brief.timer", next: 0 },
        { unit: "choibot-cron-other.timer", next: 18446744073709551615 },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs.map((j) => j.nextRun)).toEqual([null, null]);

    await cleanup();
  });

  it("returns nextRun null when no timer matches, lastRun null when no last.json", async () => {
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC);
    const { app, cleanup } = await makeApp(dataDir);

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs[0].nextRun).toBeNull();
    expect(jobs[0].lastRun).toBeNull();

    await cleanup();
  });

  it("survives a shape-invalid last.json (valid JSON, no outputTail): lastRun null, still 200", async () => {
    // Uncovered by E2E: readJsonSafe only guards parse failures, so a
    // hand-edited last.json without outputTail made .slice() throw and 500
    // the polled route forever.
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC, JSON.stringify({ finishedAt: 2, ok: true, summary: "hand-edited" }));
    const { app, cleanup } = await makeApp(dataDir);

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastRun).toBeNull();

    await cleanup();
  });

  it("survives a torn last.json: lastRun null, still 200", async () => {
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, SPEC, "{ tor");
    const { app, cleanup } = await makeApp(dataDir);

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastRun).toBeNull();

    await cleanup();
  });

  it("gives the first line of an ok run as its sentence, plain text; none for a failed run", async () => {
    const dataDir = await tmp("cron-");
    const ok = { startedAt: 1, finishedAt: 2, exitCode: 0, ok: true, outputTail: "## **No new error**\u202e\n\nThe 3 known errors did not change." };
    await seedJob(dataDir, SPEC, ok);
    await seedJob(dataDir, { ...SPEC, name: "watch" }, { ...ok, exitCode: 1, ok: false });
    const { app, cleanup } = await makeApp(dataDir, { timeZone: () => "UTC" });
    try {
      const body = (await app.inject({ method: "GET", url: "/api/cron/jobs" })).json() as { jobs: Array<{ name: string; lastRun: { sentence: string | null } }>; timeZone: string };
      expect(body.timeZone).toBe("UTC");
      expect(body.jobs.map((j) => [j.name, j.lastRun.sentence])).toEqual([["brief", "No new error"], ["watch", null]]);
    } finally { await cleanup(); }
  });

  it("says of each task what its last run was: the checked state, the sentence and the links", async () => {
    const dataDir = await tmp("cron-");
    const base = { startedAt: 1, finishedAt: 2, exitCode: 0, ok: true, outputTail: "text\nRESULT: x" };
    const lie = { state: "all-clear", sentence: "Everything is fine.", refs: ["qab12cd34"] };
    await seedJob(dataDir, { ...SPEC, name: "a-clear" }, { ...base, result: { state: "all-clear", sentence: "No new error.", refs: [] } });
    await seedJob(dataDir, { ...SPEC, name: "b-needs" }, { ...base, result: { state: "needs-you", sentence: "2 new errors.", refs: ["qab12cd34", "https://github.com/acme/shop/pull/12", "https://evil.example/x"] } });
    await seedJob(dataDir, { ...SPEC, name: "c-failed" }, { ...base, ok: false, exitCode: 1, result: lie, why: "exit" });
    await seedJob(dataDir, { ...SPEC, name: "d-old" }, base);
    const ticket: TicketLookup = async (id) => (id === "qab12cd34" ? { title: "Checkout timeout", open: true } : null);
    const { app, cleanup } = await makeApp(dataDir, { ticket });
    try {
      const body = (await app.inject({ method: "GET", url: "/api/cron/jobs" })).json() as { jobs: Array<{ name: string; lastRun: { state: string; sentence: string | null; links: unknown[] } }> };
      expect(body.jobs.map((j) => [j.name, j.lastRun.state, j.lastRun.sentence, j.lastRun.links])).toEqual([
        ["a-clear", "clear", "No new error.", []],
        ["b-needs", "needs", "2 new errors.", [
          { kind: "ticket", id: "qab12cd34", title: "Checkout timeout", open: true },
          { kind: "pr", url: "https://github.com/acme/shop/pull/12", label: "PR #12 · acme/shop" },
        ]],
        // A run that did not finish is never all clear, whatever the task wrote.
        ["c-failed", "failed", "It stopped with an error.", []],
        ["d-old", "done", "text", []],
      ]);
    } finally { await cleanup(); }
  });

  it("gives the task's instructions, the name of its repo (never a path) and when it was made", async () => {
    const dataDir = await tmp("cron-");
    await seedJob(dataDir, { ...SPEC, name: "in-repo", workdir: "/srv/work/shop-api" });
    await seedJob(dataDir, { ...SPEC, name: "no-dir" });
    await seedJob(dataDir, { ...SPEC, name: "outside", workdir: "/etc/secret-place" });
    const { app, cleanup } = await makeApp(dataDir);
    try {
      const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
      const body = res.json() as { jobs: Array<{ name: string; prompt: string; repo: string | null; createdAt: number }> };
      expect(body.jobs.map((j) => [j.name, j.repo])).toEqual([["in-repo", "shop-api"], ["no-dir", null], ["outside", null]]);
      expect(body.jobs[0].prompt).toBe("write the morning brief");
      expect(body.jobs[0].createdAt).toBe(1000);
      expect(res.body).not.toContain("/srv/work");
      expect(res.body).not.toContain("secret-place");
    } finally { await cleanup(); }
  });

  it("returns an empty list when the jobs dir does not exist", async () => {
    const dataDir = await tmp("cron-");
    const { app, cleanup } = await makeApp(dataDir);

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobs: [], timeZone: "Europe/Paris" });

    await cleanup();
  });
});

describe("GET /api/cron/jobs/:name/runs", () => {
  const run = (startedAt: number, ok: boolean): CronRunResult => ({
    startedAt, finishedAt: startedAt + 5000, exitCode: ok ? 0 : 1, ok, outputTail: `run at ${startedAt}`,
  });
  async function seedRing(dataDir: string, name: string, entries: Array<CronRunResult | string>) {
    const ringDir = join(cronPaths(dataDir).runsDir, name, "ring");
    await mkdir(ringDir, { recursive: true });
    for (const [i, e] of entries.entries()) {
      await writeFile(join(ringDir, `${1000 + i}.json`), typeof e === "string" ? e : JSON.stringify(e));
    }
  }

  it("returns ring entries newest-first, skipping torn and shape-invalid files", async () => {
    const dataDir = await tmp("cron-api-");
    await seedJob(dataDir, SPEC);
    await seedRing(dataDir, "brief", [
      run(1000, true),
      "{ torn",
      JSON.stringify({ startedAt: 2000, ok: false }), // no outputTail/finishedAt
      run(3000, false),
    ]);
    const { app, cleanup } = await makeApp(dataDir);
    try {
      const res = await app.inject({ method: "GET", url: "/api/cron/jobs/brief/runs" });
      expect(res.statusCode).toBe(200);
      const { runs } = res.json() as { runs: CronRunResult[] };
      expect(runs.map((r) => r.startedAt)).toEqual([3000, 1000]);
      expect(runs[0].ok).toBe(false);
    } finally { await cleanup(); }
  });

  it("gives each run its checked state, sentence and links, and only the known fields of the record", async () => {
    const dataDir = await tmp("cron-api-");
    await seedJob(dataDir, SPEC);
    const lie = { state: "all-clear", sentence: "Fine.", refs: ["qab12cd34"] };
    await seedRing(dataDir, "brief", [
      { ...run(1000, true), result: { state: "needs-you", sentence: "Look at this.", refs: ["qab12cd34"] } },
      { ...run(2000, false), result: lie, why: "timeout" },
      { ...run(3000, true), result: { state: "all-clear", sentence: "No new error.", refs: [] }, extra: "<b>x</b>" } as CronRunResult,
    ]);
    let reads = 0;
    const ticket: TicketLookup = async () => { reads += 1; return { title: "A ticket", open: false }; };
    const { app, cleanup } = await makeApp(dataDir, { ticket });
    try {
      const { runs } = (await app.inject({ method: "GET", url: "/api/cron/jobs/brief/runs" })).json() as { runs: Array<Record<string, unknown>> };
      expect(runs.map((r) => [r.startedAt, r.state, r.sentence])).toEqual([
        [3000, "clear", "No new error."], [2000, "failed", "It ran longer than its time limit."], [1000, "needs", "Look at this."],
      ]);
      expect(runs[2].links).toEqual([{ kind: "ticket", id: "qab12cd34", title: "A ticket", open: false }]);
      expect(runs[1].links).toEqual([]);
      expect(reads).toBe(1);
      expect(Object.keys(runs[0]).sort()).toEqual(["exitCode", "finishedAt", "links", "ok", "outputTail", "sentence", "startedAt", "state"]);
    } finally { await cleanup(); }
  });

  it("rejects a non-slug name (path-traversal guard)", async () => {
    const dataDir = await tmp("cron-api-");
    const { app, cleanup } = await makeApp(dataDir);
    try {
      const res = await app.inject({ method: "GET", url: "/api/cron/jobs/Bad_Name/runs" });
      expect(res.statusCode).toBe(400);
    } finally { await cleanup(); }
  });

  it("unknown job → empty list, not an error", async () => {
    const dataDir = await tmp("cron-api-");
    const { app, cleanup } = await makeApp(dataDir);
    try {
      const res = await app.inject({ method: "GET", url: "/api/cron/jobs/ghost/runs" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ runs: [] });
    } finally { await cleanup(); }
  });
});

describe("POST /api/cron/notify", () => {
  it("401s without the token header and with a wrong token; emits nothing", async () => {
    const dataDir = await tmp("cron-");
    const { app, events, cleanup } = await makeApp(dataDir);

    const none = await app.inject({
      method: "POST", url: "/api/cron/notify",
      payload: { name: "brief", ok: true, summary: "hi" },
    });
    expect(none.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST", url: "/api/cron/notify",
      headers: { "x-cron-token": "not-the-token" },
      payload: { name: "brief", ok: true, summary: "hi" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(events).toHaveLength(0);

    await cleanup();
  });

  it("204s with the correct token and emits cron-run with the summary truncated to 3900", async () => {
    const dataDir = await tmp("cron-");
    const paths = cronPaths(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(paths.tokenFile, "seeded-token\n", { mode: 0o600 });
    const { app, events, cleanup } = await makeApp(dataDir);

    const res = await app.inject({
      method: "POST", url: "/api/cron/notify",
      headers: { "x-cron-token": "seeded-token" },
      payload: { name: "brief", ok: false, summary: "z".repeat(5000) },
    });
    expect(res.statusCode).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "cron-run", name: "brief", ok: false });
    expect((events[0] as { summary: string }).summary).toBe("z".repeat(3900));

    await cleanup();
  });

  it("passes telegram:false on (an OK run of an on-failure job); no field means Telegram as before", async () => {
    const dataDir = await tmp("cron-");
    const paths = cronPaths(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(paths.tokenFile, "seeded-token\n", { mode: 0o600 });
    const { app, events, cleanup } = await makeApp(dataDir);
    const post = (payload: Record<string, unknown>) => app.inject({
      method: "POST", url: "/api/cron/notify", headers: { "x-cron-token": "seeded-token" }, payload,
    });
    expect((await post({ name: "brief", ok: true, summary: "s", telegram: false })).statusCode).toBe(204);
    expect((await post({ name: "brief", ok: true, summary: "s" })).statusCode).toBe(204);
    expect((await post({ name: "brief", ok: true, summary: "s", telegram: true })).statusCode).toBe(204);
    expect(events.map((e) => (e as { telegram?: boolean }).telegram)).toEqual([false, undefined, undefined]);
    await cleanup();
  });

  it("passes what the run said: the state and one plain sentence; a run with no result line and no reason has none", async () => {
    const dataDir = await tmp("cron-");
    const paths = cronPaths(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(paths.tokenFile, "seeded-token\n", { mode: 0o600 });
    const { app, events, cleanup } = await makeApp(dataDir);
    const post = (payload: Record<string, unknown>) => app.inject({
      method: "POST", url: "/api/cron/notify", headers: { "x-cron-token": "seeded-token" }, payload,
    });
    await post({ name: "brief", ok: true, summary: "s", result: { state: "needs-you", sentence: "  ## 3 new **errors**\u202e in app  " } });
    await post({ name: "brief", ok: true, summary: "s", result: { state: "all-clear", sentence: "Fine." } });
    await post({ name: "brief", ok: false, summary: "exit 1: x", why: "timeout" });
    // A failed run is never all clear, whatever it sent.
    await post({ name: "brief", ok: false, summary: "x", why: "exit", result: { state: "all-clear", sentence: "Fine." } });
    // From before: no result, no reason, or values that are not fixed ones.
    await post({ name: "brief", ok: true, summary: "s" });
    await post({ name: "brief", ok: false, summary: "s" });
    await post({ name: "brief", ok: true, summary: "s", result: { state: "fine", sentence: "x" } });
    await post({ name: "brief", ok: false, summary: "s", why: "toString" });
    expect(events.map((e) => (e as { said?: unknown }).said)).toEqual([
      { state: "needs-you", sentence: "3 new errors in app" },
      { state: "all-clear", sentence: "Fine." },
      { state: "did-not-finish", sentence: "It ran longer than its time limit." },
      { state: "did-not-finish", sentence: "It stopped with an error." },
      undefined, undefined, undefined, undefined,
    ]);
    await cleanup();
  });

  it("400s when the body has no name", async () => {
    const dataDir = await tmp("cron-");
    const paths = cronPaths(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(paths.tokenFile, "seeded-token", { mode: 0o600 });
    const { app, events, cleanup } = await makeApp(dataDir);

    const res = await app.inject({
      method: "POST", url: "/api/cron/notify",
      headers: { "x-cron-token": "seeded-token" },
      payload: { ok: true, summary: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(events).toHaveLength(0);

    await cleanup();
  });
});

// `cron note <name> --ticket <id>`: the reader of a run links its ticket to it.
describe("POST /api/cron/jobs/:name/note", () => {
  const USER = "user-token";
  const HOOK = "hook-token";
  const TICKETS: Record<string, { title: string; open: boolean }> = { qaaaa1111: { title: "brief did not finish", open: true } };
  async function world(o: { gate?: boolean } = {}) {
    const dataDir = await tmp("cron-note-");
    const ids = ["w1", "lead-app", "fleet-master", "coordinator", "fake"];
    const kinds: Record<string, string> = { "lead-app": "lead", "fleet-master": "fleet-master", coordinator: "coordinator", fake: "coordinator" };
    const agents = { load: async (id: string) => (ids.includes(id) ? { id, hookToken: HOOK, kind: kinds[id] } as never : null) };
    const gate = makeGate({
      misconfigured: null, userAuth: "log",
      deps: { devices: { verify: async (tok: string) => (tok === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
    });
    const app = Fastify();
    // The Coordinator's allow-list in front, as in index.ts.
    registerCoordinatorGate(app);
    registerCronApi(app, {
      hub: new EventHub(), cronDataDir: dataDir, listTimers: async () => [], workspaceDir: "/srv/work",
      gate: o.gate === false ? undefined : gate, ticket: async (id) => TICKETS[id] ?? null,
      ctx: () => { throw new Error("a note runs no command"); },
    });
    const runDir = join(cronPaths(dataDir).runsDir, "brief");
    const older: CronRunResult = { startedAt: 100, finishedAt: 150, exitCode: 1, ok: false, outputTail: "boom", why: "exit" };
    const last: CronRunResult = { startedAt: 200, finishedAt: 250, exitCode: 1, ok: false, outputTail: "boom again", why: "timeout" };
    await seedJob(dataDir, SPEC, last);
    await mkdir(join(runDir, "ring"), { recursive: true });
    for (const r of [older, last]) await writeFile(join(runDir, "ring", `${r.startedAt}.json`), JSON.stringify(r));
    const note = (headers: Record<string, string>, payload: unknown = { ticket: "qaaaa1111" }) =>
      app.inject({ method: "POST", url: "/api/cron/jobs/brief/note", headers, payload: payload as object });
    const as = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK });
    const notes = async () => JSON.parse(await readFile(join(runDir, "tickets.json"), "utf8").catch(() => "{}"));
    return { app, dataDir, runDir, note, as, notes, cleanup: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
  }

  it("the Coordinator, the fleet master and the paired user may link a ticket to the last run; the run itself does not change", async () => {
    const w = await world();
    try {
      const before = await readFile(join(w.runDir, "last.json"), "utf8");
      for (const headers of [w.as("coordinator"), w.as("fleet-master"), { [USER_HEADER]: USER }]) {
        const res = await w.note(headers);
        expect([res.statusCode, res.json()]).toEqual([200, { ok: true, run: 200, ticket: "qaaaa1111" }]);
      }
      expect(await w.notes()).toEqual({ "200": "qaaaa1111" });
      expect(await readFile(join(w.runDir, "last.json"), "utf8")).toBe(before);
      expect(await readFile(join(w.runDir, "ring", "200.json"), "utf8")).toBe(before);
      // The page: the ticket shows on the run that did not finish, and only on that run.
      const runs = (await w.app.inject({ method: "GET", url: "/api/cron/jobs/brief/runs" })).json().runs as Array<{ startedAt: number; state: string; links: unknown[] }>;
      expect(runs.map((r) => [r.startedAt, r.state, r.links])).toEqual([
        [200, "failed", [{ kind: "ticket", id: "qaaaa1111", title: "brief did not finish", open: true }]],
        [100, "failed", []],
      ]);
      const jobs = (await w.app.inject({ method: "GET", url: "/api/cron/jobs" })).json().jobs;
      expect(jobs[0].lastRun.links).toEqual([{ kind: "ticket", id: "qaaaa1111", title: "brief did not finish", open: true }]);
    } finally { await w.cleanup(); }
  });

  it("refuses a worker, a lead, another record with the Coordinator's kind and an unpaired browser: nothing is written", async () => {
    const w = await world();
    try {
      for (const id of ["w1", "lead-app"]) expect([(await w.note(w.as(id))).statusCode, (await w.note(w.as(id))).json().error]).toEqual([403, NOTE_REFUSAL]);
      // The gate of the Coordinator lets this route pass by its header alone: the route checks the record.
      expect([(await w.note(w.as("fake"))).statusCode, (await w.note(w.as("fake"))).json().error]).toEqual([403, NOTE_REFUSAL]);
      // The Coordinator's id with a wrong token.
      expect((await w.note({ [AGENT_HEADER]: "coordinator", [AGENT_TOKEN_HEADER]: "wrong" })).statusCode).toBe(403);
      for (const headers of [{}, { [USER_HEADER]: "wrong" }] as Record<string, string>[]) expect([(await w.note(headers)).statusCode, (await w.note(headers)).json().error]).toEqual([403, CHIEF_ERR.pairRequired]);
      expect(await w.notes()).toEqual({});
    } finally { await w.cleanup(); }
  });

  it("the id must be a ticket of this console's queue, the task must have a run; no queue (no pairing): refused", async () => {
    const w = await world();
    try {
      const C = w.as("coordinator");
      for (const ticket of ["", "q1", "QAAAA1111", "qaaaa1111 x", 7, null]) expect((await w.note(C, { ticket })).statusCode).toBe(400);
      expect([(await w.note(C, { ticket: "qbbbb2222" })).statusCode, (await w.note(C, { ticket: "qbbbb2222" })).json().error]).toEqual([404, "no such ticket in this console's queue"]);
      expect((await w.app.inject({ method: "POST", url: "/api/cron/jobs/Bad/note", headers: C, payload: { ticket: "qaaaa1111" } })).statusCode).toBe(400);
      expect((await w.app.inject({ method: "POST", url: "/api/cron/jobs/other/note", headers: C, payload: { ticket: "qaaaa1111" } })).statusCode).toBe(404);
      expect(await w.notes()).toEqual({});
    } finally { await w.cleanup(); }
    const none = await world({ gate: false });
    try {
      expect([(await none.note({ [USER_HEADER]: USER })).statusCode, (await none.note({ [USER_HEADER]: USER })).json()]).toEqual([403, RECURRING_NO_PAIRING]);
    } finally { await none.cleanup(); }
  });

  it("keeps the notes of runs that are still in the history only", async () => {
    const w = await world();
    try {
      await writeFile(join(w.runDir, "tickets.json"), JSON.stringify({ "100": "qaaaa1111", "50": "qaaaa1111", "x": "y" }));
      expect((await w.note(w.as("coordinator"))).statusCode).toBe(200);
      expect(await w.notes()).toEqual({ "100": "qaaaa1111", "200": "qaaaa1111" });
    } finally { await w.cleanup(); }
  });

  it("the Coordinator still cannot run, pause, resume or delete a task: its allow-list refuses the route", async () => {
    const w = await world();
    try {
      for (const action of ["run", "pause", "resume", "delete"]) {
        const res = await w.app.inject({ method: "POST", url: `/api/cron/jobs/brief/${action}`, headers: w.as("coordinator") });
        expect([action, res.statusCode, res.json().error]).toEqual([action, 403, COORDINATOR_REFUSAL]);
      }
    } finally { await w.cleanup(); }
  });
});

describe("POST /api/cron/master", () => {
  it("is gone: the cron master is retired (the fleet master manages cron)", async () => {
    const dataDir = await tmp("cron-");
    const { app, cleanup } = await makeApp(dataDir);
    expect((await app.inject({ method: "POST", url: "/api/cron/master" })).statusCode).toBe(404);
    await cleanup();
  });
});

describe("registration side effects", () => {
  it("creates the notify-token file with mode 0600 when absent", async () => {
    const dataDir = await tmp("cron-");
    const paths = cronPaths(dataDir);
    const { app, cleanup } = await makeApp(dataDir);

    // The token setup is async; a notify request awaits it, so after this
    // response the file must exist.
    await app.inject({
      method: "POST", url: "/api/cron/notify",
      payload: { name: "x", ok: true, summary: "" },
    });

    const s = await stat(paths.tokenFile);
    expect(s.mode & 0o777).toBe(0o600);

    await cleanup();
  });

  it("survives an unwritable data dir: no unhandled rejection, notify 500s per-request", async () => {
    // dataDir nested under a regular FILE → the token setup's mkdir rejects at
    // registration time, before any request awaits it. Without a side-branch
    // handler that rejection is unhandled and would crash the server (vitest
    // flags it as an unhandled error in this test).
    const parent = await tmp("cron-bad-");
    const blocker = join(parent, "file");
    await writeFile(blocker, "not a dir");
    const dataDir = join(blocker, "sub");

    const app = Fastify();
    registerCronApi(app, { hub: new EventHub(), cronDataDir: dataDir, listTimers: async () => [] });

    // Give the rejected setup promise a macrotask tick to trip the unhandled-
    // rejection detector if the side-branch handler is missing.
    await new Promise((r) => setTimeout(r, 10));

    const res = await app.inject({
      method: "POST", url: "/api/cron/notify",
      headers: { "x-cron-token": "whatever" },
      payload: { name: "brief", ok: true, summary: "s" },
    });
    expect(res.statusCode).toBe(500);

    await app.close();
    await rm(parent, { recursive: true, force: true });
  });

  it("keeps an existing notify-token file untouched", async () => {
    const dataDir = await tmp("cron-");
    const paths = cronPaths(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(paths.tokenFile, "keep-me", { mode: 0o600 });
    const { app, cleanup } = await makeApp(dataDir);

    const ok = await app.inject({
      method: "POST", url: "/api/cron/notify",
      headers: { "x-cron-token": "keep-me" },
      payload: { name: "brief", ok: true, summary: "s" },
    });
    expect(ok.statusCode).toBe(204);

    await cleanup();
  });
});

describe("repoName", () => {
  it("is the name of a folder right under the work folder, else nothing", () => {
    expect(repoName("/srv/work/shop-api", "/srv/work")).toBe("shop-api");
    expect(repoName("/srv/work/shop-api/", "/srv/work/")).toBe("shop-api");
    expect(repoName("/srv/work", "/srv/work")).toBeNull();
    expect(repoName("/srv/work/a/b", "/srv/work")).toBeNull();
    expect(repoName("/srv/other", "/srv/work")).toBeNull();
    expect(repoName("/srv/work/../etc", "/srv/work")).toBeNull();
    expect(repoName(undefined, "/srv/work")).toBeNull();
  });
});

// Run now, Pause, Resume, Delete from the page: the paired user only. Every command of the
// service manager goes to a recorder: no real unit or timer is touched.
describe("POST /api/cron/jobs/:name/:action", () => {
  const USER = "user-token";
  const HOOK = "hook-token";
  const ACTIONS = ["run", "pause", "resume", "delete"] as const;

  async function world(o: { gate?: boolean; misconfigured?: string | null; fail?: boolean } = {}) {
    const dataDir = await tmp("cron-act-");
    const home = await tmp("cron-act-home-");
    const calls: string[] = [];
    const ctx = () => cronCtx("/repo", {
      env: { CRON_DATA_DIR: dataDir }, homedir: () => home, log: () => {}, now: () => 5000,
      run: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return o.fail ? { code: 1, stdout: "", stderr: "Unit choibot-cron-brief.service not found." } : { code: 0, stdout: "", stderr: "" }; },
    });
    const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
      ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
    const gate = makeGate({
      misconfigured: o.misconfigured ?? null, userAuth: "log",
      deps: { devices: { verify: async (tok: string) => (tok === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
    });
    const app = Fastify();
    registerCronApi(app, { hub: new EventHub(), cronDataDir: dataDir, listTimers: async () => [], workspaceDir: "/srv/work", gate: o.gate === false ? undefined : gate, ctx });
    await seedJob(dataDir, SPEC, { startedAt: 1, finishedAt: 2, exitCode: 0, ok: true, outputTail: "x" });
    const specFile = join(cronPaths(dataDir).jobsDir, "brief.json");
    const post = (name: string, action: string, headers: Record<string, string> = { [USER_HEADER]: USER }, payload?: unknown) =>
      app.inject({ method: "POST", url: `/api/cron/jobs/${name}/${action}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    const enabled = async () => (JSON.parse(await readFile(specFile, "utf8")) as CronJobSpec).enabled;
    return { app, dataDir, calls, post, specFile, enabled, cleanup: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); } };
  }

  it("refuses a browser that is not paired, an agent, a lead and the fleet master: nothing changes, no command runs", async () => {
    const w = await world();
    try {
      const callers: Record<string, string>[] = [{}, { [USER_HEADER]: "wrong" }, ...["w1", "lead-app", "fleet-master"].map((id) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK }))];
      for (const action of ACTIONS) {
        for (const headers of callers) {
          const res = await w.post("brief", action, headers);
          expect([action, res.statusCode, res.json().error]).toEqual([action, 403, CHIEF_ERR.pairRequired]);
        }
      }
      expect(w.calls).toEqual([]);
      expect(existsSync(w.specFile)).toBe(true);
      expect(await w.enabled()).toBe(true);
    } finally { await w.cleanup(); }
  });

  it("answers 503 while the pairing is set up wrong; a console with no pairing refuses every change", async () => {
    const bad = await world({ misconfigured: "no key" });
    try {
      expect((await bad.post("brief", "pause")).statusCode).toBe(503);
      expect(bad.calls).toEqual([]);
    } finally { await bad.cleanup(); }
    const open = await world({ gate: false });
    try {
      for (const action of ACTIONS) {
        const res = await open.post("brief", action, {});
        expect([action, res.statusCode, res.json()]).toEqual([action, 403, RECURRING_NO_PAIRING]);
      }
      expect(await open.enabled()).toBe(true);
      expect(open.calls).toEqual([]);
    } finally { await open.cleanup(); }
  });

  it("Run now starts the unit of the task and does not wait for the end of the run", async () => {
    const w = await world();
    try {
      const res = await w.post("brief", "run");
      expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
      expect(w.calls).toEqual(["systemctl --user start --no-block choibot-cron-brief.service"]);
    } finally { await w.cleanup(); }
  });

  it("Pause and Resume change the task and its timer; Run now on a paused task is refused with a sentence", async () => {
    const w = await world();
    try {
      expect((await w.post("brief", "pause")).statusCode).toBe(200);
      expect(await w.enabled()).toBe(false);
      const run = await w.post("brief", "run");
      expect([run.statusCode, run.json().error]).toEqual([409, "This task is paused. Resume it first."]);
      expect((await w.post("brief", "resume")).statusCode).toBe(200);
      expect(await w.enabled()).toBe(true);
      // The test world is not an installed console: the flip writes the task and runs no timer command.
      expect(w.calls.filter((c) => c.includes(" start "))).toEqual([]);
    } finally { await w.cleanup(); }
  });

  it("Delete removes the task and its runs, with the unit names that the server builds", async () => {
    const w = await world();
    try {
      expect((await w.post("brief", "delete")).statusCode).toBe(200);
      expect(existsSync(w.specFile)).toBe(false);
      expect(existsSync(join(cronPaths(w.dataDir).runsDir, "brief"))).toBe(false);
      expect(w.calls).toEqual([
        "systemctl --user disable --now choibot-cron-brief.timer",
        "systemctl --user reset-failed choibot-cron-brief.service choibot-cron-brief.timer",
        "systemctl --user daemon-reload",
      ]);
      const again = await w.post("brief", "delete");
      expect([again.statusCode, again.json().error]).toEqual([404, "This task is not in the list now."]);
    } finally { await w.cleanup(); }
  });

  it("takes only a task name of the pattern and one of the 4 actions; a body changes nothing", async () => {
    const w = await world();
    try {
      for (const name of ["Bad_Name", "..%2F..%2Fetc", "a.timer", "-x", "brief%20--now"]) {
        expect([name, (await w.post(name, "run")).statusCode]).toEqual([name, 400]);
      }
      for (const action of ["add", "edit", "rm", "enable", "disable", "start", "__proto__", "constructor"]) {
        expect([action, (await w.post("brief", action)).statusCode]).toEqual([action, 404]);
      }
      expect((await w.post("other", "run")).statusCode).toBe(404);
      expect(w.calls).toEqual([]);
      // A unit name, a path or a spec in the body is not read.
      await w.post("brief", "run", { [USER_HEADER]: USER }, { unit: "choibot.service", name: "other", spec: { prompt: "x" }, path: "/etc" });
      expect(w.calls).toEqual(["systemctl --user start --no-block choibot-cron-brief.service"]);
    } finally { await w.cleanup(); }
  });

  it("a command that fails gives one plain sentence, with no unit name and no word of the service manager", async () => {
    const w = await world({ fail: true });
    try {
      const res = await w.post("brief", "run");
      expect([res.statusCode, res.json()]).toEqual([422, { error: "Your server could not do this. Try again." }]);
      expect(res.body).not.toMatch(/systemctl|choibot-cron|Unit/);
    } finally { await w.cleanup(); }
  });
});

describe("a run in progress", () => {
  it("says running while the runner's mark is there and not older than the task's time limit", async () => {
    const dataDir = await tmp("cron-run-");
    const mark = (name: string, startedAt: unknown) => mkdir(join(cronPaths(dataDir).runsDir, name), { recursive: true })
      .then(() => writeFile(join(cronPaths(dataDir).runsDir, name, "running.json"), JSON.stringify({ startedAt })));
    await seedJob(dataDir, { ...SPEC, name: "a-now" });
    await seedJob(dataDir, { ...SPEC, name: "b-none" });
    await seedJob(dataDir, { ...SPEC, name: "c-dead", timeoutMinutes: 5 });
    await seedJob(dataDir, { ...SPEC, name: "d-bad" });
    await mark("a-now", Date.now() - 60_000);
    await mark("c-dead", Date.now() - 8 * 60_000);
    await mark("d-bad", "now");
    const { app, cleanup } = await makeApp(dataDir);
    try {
      const body = (await app.inject({ method: "GET", url: "/api/cron/jobs" })).json() as { jobs: Array<{ name: string; running: boolean }> };
      expect(body.jobs.map((j) => [j.name, j.running])).toEqual([["a-now", true], ["b-none", false], ["c-dead", false], ["d-bad", false]]);
    } finally { await cleanup(); }
  });
});

// The form: New task, Change, and "Fill in". The paired user only. Made-up tasks in temp folders;
// every command goes to a recorder.
describe("the form routes", () => {
  const USER = "user-token";
  const HOOK = "hook-token";
  const FORM = { name: "morning-digest", repo: "shop-api", what: "Read the errors of the last day.", when: { kind: "days", days: [0, 1, 2, 3, 4], times: ["08:00"] }, zone: "Europe/Paris", tell: "needs" };

  async function world(o: { gate?: boolean; badSchedule?: boolean; draft?: GuideModel | null } = {}) {
    const dataDir = await tmp("cron-form-");
    const home = await tmp("cron-form-home-");
    const calls: string[] = [];
    let modelCalls = 0;
    const ctx = () => cronCtx("/repo", {
      env: { CRON_DATA_DIR: dataDir }, homedir: () => home, log: () => {}, now: () => 5000,
      run: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return cmd === "systemd-analyze" && o.badSchedule ? { code: 1, stdout: "", stderr: "Failed to parse calendar specification" } : { code: 0, stdout: "", stderr: "" }; },
    });
    const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
      ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
    const gate = makeGate({
      misconfigured: null, userAuth: "log",
      deps: { devices: { verify: async (tok: string) => (tok === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
    });
    const model: GuideModel = async (q) => { modelCalls += 1; return (o.draft ?? (async () => ({ ok: true as const, text: "{}" })))(q); };
    const app = Fastify();
    registerCronApi(app, {
      hub: new EventHub(), cronDataDir: dataDir, listTimers: async () => [], workspaceDir: dataDir, gate: o.gate === false ? undefined : gate, ctx,
      // dataDir stands for the work folder: the "repos" are folders of it that exist.
      repos: async () => [{ name: "shop-api", path: join(dataDir, "shop-api") }, { name: "web", path: join(dataDir, "web") }],
      ...(o.draft === null ? {} : { draft: model }),
    });
    await mkdir(join(dataDir, "shop-api"), { recursive: true });
    await mkdir(join(dataDir, "web"), { recursive: true });
    const send = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = { [USER_HEADER]: USER }) =>
      app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    const spec = async (name: string) => { try { return JSON.parse(await readFile(join(cronPaths(dataDir).jobsDir, `${name}.json`), "utf8")) as CronJobSpec; } catch { return null; } };
    return { app, dataDir, calls, send, spec, modelCalls: () => modelCalls, cleanup: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); } };
  }
  const CHANGING: ["GET" | "POST", string, unknown][] = [
    ["POST", "/api/cron/tasks", FORM], ["POST", "/api/cron/tasks/brief", FORM], ["GET", "/api/cron/form", undefined], ["POST", "/api/cron/draft", { text: "check the backup every day" }],
  ];

  it("refuse a browser that is not paired, an agent, a lead and the fleet master: nothing is written, the model is not called", async () => {
    const w = await world();
    try {
      await seedJob(w.dataDir, SPEC);
      const callers: Record<string, string>[] = [{}, { [USER_HEADER]: "wrong" }, ...["w1", "lead-app", "fleet-master"].map((id) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK }))];
      for (const [method, url, body] of CHANGING) {
        for (const headers of callers) {
          const res = await w.send(method, url, body, headers);
          expect([url, res.statusCode, res.json().error]).toEqual([url, 403, CHIEF_ERR.pairRequired]);
        }
      }
      expect(await w.spec("morning-digest")).toBeNull();
      expect((await w.spec("brief"))!.prompt).toBe(SPEC.prompt);
      expect(w.calls).toEqual([]);
      expect(w.modelCalls()).toBe(0);
    } finally { await w.cleanup(); }
  });

  it("a console with no device pairing refuses every changing route with one plain line; the read routes answer", async () => {
    const w = await world({ gate: false });
    try {
      await seedJob(w.dataDir, SPEC);
      for (const [method, url, body] of CHANGING) {
        const res = await w.send(method, url, body, {});
        expect([url, res.statusCode, res.json()]).toEqual([url, 403, RECURRING_NO_PAIRING]);
      }
      expect(await w.spec("morning-digest")).toBeNull();
      expect(w.modelCalls()).toBe(0);
      expect((await w.send("GET", "/api/cron/jobs", undefined, {})).statusCode).toBe(200);
      expect((await w.send("GET", "/api/cron/jobs/brief/runs", undefined, {})).statusCode).toBe(200);
    } finally { await w.cleanup(); }
  });

  it("New task: the server makes the definition: the timer line from the model, the folder from its repo list", async () => {
    const w = await world();
    try {
      const res = await w.send("POST", "/api/cron/tasks", {
        ...FORM,
        // What a browser must not decide is not read.
        schedule: "*-*-* *:*:*", workdir: "/etc", prompt: "other", unit: "choibot.service", model: "opus", account: "boss", timeoutMinutes: 720, enabled: false, notify: "always",
      });
      expect([res.statusCode, res.json()]).toEqual([200, { ok: true, name: "morning-digest" }]);
      expect(await w.spec("morning-digest")).toEqual({
        name: "morning-digest", schedule: "Mon..Fri *-*-* 08:00 Europe/Paris", prompt: "Read the errors of the last day.",
        workdir: join(w.dataDir, "shop-api"), model: null, effort: null, timeoutMinutes: 30, notify: "on-failure", enabled: true, createdAt: 5000,
      });
      expect(w.calls).toEqual(["systemd-analyze calendar Mon..Fri *-*-* 08:00 Europe/Paris"]);
      // The form's own routes and the list show the repo by its name.
      expect((await w.send("GET", "/api/cron/form")).json()).toEqual({ repos: ["shop-api", "web"], fillIn: true });
      const again = await w.send("POST", "/api/cron/tasks", FORM);
      expect([again.statusCode, again.json()]).toEqual([409, { field: "name", error: "A task with this name exists. Choose another name." }]);
    } finally { await w.cleanup(); }
  });

  it("New task with no repo runs in the work folder; tell always; no zone", async () => {
    const w = await world();
    try {
      expect((await w.send("POST", "/api/cron/tasks", { ...FORM, repo: null, zone: null, tell: "always", when: { kind: "hours", every: 6, minute: 0 } })).statusCode).toBe(200);
      const s = (await w.spec("morning-digest"))!;
      expect([s.schedule, s.workdir, s.notify]).toEqual(["*-*-* 0/6:00", undefined, "always"]);
    } finally { await w.cleanup(); }
  });

  it.each([
    [{ name: "Bad Name" }, "name"], [{ name: "../x" }, "name"], [{ name: "console" }, "name"], [{ name: 7 }, "name"],
    [{ repo: "nope" }, "repo"], [{ repo: "/etc" }, "repo"], [{ repo: "../shop-api" }, "repo"], [{ repo: 7 }, "repo"],
    [{ what: "" }, "what"], [{ what: "--dangerously-skip-permissions" }, "what"], [{ what: "x".repeat(9000) }, "what"], [{ what: "a\u0000b" }, "what"],
    [{ when: null }, "when"], [{ when: "*-*-* *:*" }, "when"], [{ when: { kind: "minutes", every: 5 } }, "when"], [{ when: { kind: "days", days: [9], times: ["08:00"] } }, "when"],
    [{ zone: "Europe/Paris\nOnCalendar=*:*" }, "when"], [{ zone: "Mars/Base" }, "when"],
    [{ tell: "never" }, "tell"],
  ])("New task refuses %j (field %s) and writes nothing", async (over, field) => {
    const w = await world();
    try {
      const res = await w.send("POST", "/api/cron/tasks", { ...FORM, ...over });
      expect([res.statusCode, res.json().field]).toEqual([400, field]);
      expect(await readdirSafe(cronPaths(w.dataDir).jobsDir)).toEqual([]);
      expect(w.calls).toEqual([]);
    } finally { await w.cleanup(); }
  });

  it("Change: the name is the one of the address; what the form does not show stays", async () => {
    const w = await world();
    try {
      const old: CronJobSpec = { ...SPEC, schedule: "*-12-25 09:00", workdir: join(w.dataDir, "web"), model: "sonnet", effort: "high", account: "work", timeoutMinutes: 45, enabled: false, createdAt: 77 };
      await seedJob(w.dataDir, old);
      const res = await w.send("POST", "/api/cron/tasks/brief", { ...FORM, name: "other", repo: "web", when: null, what: "New text.", tell: "always", model: "opus", enabled: true });
      expect([res.statusCode, res.json()]).toEqual([200, { ok: true, name: "brief" }]);
      expect(await w.spec("other")).toBeNull();
      // when null: the custom schedule of the task stays as it is.
      expect(await w.spec("brief")).toEqual({ ...old, prompt: "New text.", notify: "always" });
      await w.send("POST", "/api/cron/tasks/brief", { ...FORM, repo: "shop-api" });
      const s = (await w.spec("brief"))!;
      expect([s.schedule, s.workdir, s.notify, s.enabled, s.model, s.account, s.timeoutMinutes, s.createdAt]).toEqual(["Mon..Fri *-*-* 08:00 Europe/Paris", join(w.dataDir, "shop-api"), "on-failure", false, "sonnet", "work", 45, 77]);
      expect((await w.send("POST", "/api/cron/tasks/gone", FORM)).statusCode).toBe(404);
      expect((await w.send("POST", "/api/cron/tasks/Bad_Name", FORM)).json().field).toBe("name");
    } finally { await w.cleanup(); }
  });

  it("Change keeps the folder of a task that is not a repo of the list (the form shows no repo for it)", async () => {
    const w = await world();
    try {
      const outside = await tmp("cron-form-out-");
      await seedJob(w.dataDir, { ...SPEC, workdir: outside });
      expect((await w.send("POST", "/api/cron/tasks/brief", { ...FORM, repo: null })).statusCode).toBe(200);
      expect((await w.spec("brief"))!.workdir).toBe(outside);
      await rm(outside, { recursive: true, force: true });
    } finally { await w.cleanup(); }
  });

  it("a schedule that the server's own check refuses: one plain sentence, nothing written", async () => {
    const w = await world({ badSchedule: true });
    try {
      const res = await w.send("POST", "/api/cron/tasks", FORM);
      expect([res.statusCode, res.json()]).toEqual([422, { field: "when", error: "Your server does not take this schedule." }]);
      expect(await w.spec("morning-digest")).toBeNull();
    } finally { await w.cleanup(); }
  });

  describe("Fill in", () => {
    const answer = (text: string): GuideModel => async () => ({ ok: true, text });
    it("gives the checked fields of the model's answer, and saves nothing", async () => {
      const w = await world({ draft: answer('Here it is:\n```json\n{"title":"**Backup** check","what":"Check that the backup of last night is complete.","when":{"kind":"days","days":[0,1,2,3,4,5,6],"times":["02:30"]},"repo":"web","tell":"needs","workdir":"/etc","schedule":"*:*","name":"../x"}\n```') });
      try {
        const res = await w.send("POST", "/api/cron/draft", { text: "check the backup every night at 2:30 in web" });
        expect(res.json()).toEqual({ ok: true, draft: {
          title: "Backup check", name: "backup-check", what: "Check that the backup of last night is complete.",
          when: { kind: "days", days: [0, 1, 2, 3, 4, 5, 6], times: ["02:30"] }, repo: "web", tell: "needs",
        } });
        expect(await readdirSafe(cronPaths(w.dataDir).jobsDir)).toEqual([]);
        expect(w.calls).toEqual([]);
      } finally { await w.cleanup(); }
    });
    it("drops what is not of the form: a repo that is not in the list, a schedule each few minutes, a wrong tell", async () => {
      const w = await world({ draft: answer('{"title":"X","what":"Do it.","when":{"kind":"minutes","every":5},"repo":"/etc/passwd","tell":"shout"}') });
      try {
        expect((await w.send("POST", "/api/cron/draft", { text: "x" })).json().draft).toEqual({ title: "X", name: "x", what: "Do it.", when: null, repo: null, tell: null });
      } finally { await w.cleanup(); }
    });
    it("an answer that is not the form, a plan at its limit, no login: a reason, never a field", async () => {
      for (const [model, want] of [
        [answer("I cannot help with that."), { ok: false, why: "unclear" }],
        [(async () => ({ ok: false, why: "limit", until: 99 })) as GuideModel, { ok: false, why: "limit", until: 99 }],
        [(async () => ({ ok: false, why: "login" })) as GuideModel, { ok: false, why: "login" }],
        [(async () => ({ ok: false, why: "down" })) as GuideModel, { ok: false, why: "down" }],
      ] as [GuideModel, unknown][]) {
        const w = await world({ draft: model });
        try { expect((await w.send("POST", "/api/cron/draft", { text: "x" })).json()).toEqual(want); } finally { await w.cleanup(); }
      }
    });
    it("needs a sentence, has a length limit, takes one press at a time, and is not there with no model", async () => {
      let release = () => {};
      const slow: GuideModel = () => new Promise((res) => { release = () => res({ ok: true, text: '{"title":"A"}' }); });
      const w = await world({ draft: slow });
      try {
        expect((await w.send("POST", "/api/cron/draft", { text: "  " })).statusCode).toBe(400);
        expect((await w.send("POST", "/api/cron/draft", { text: "x".repeat(2001) })).statusCode).toBe(400);
        expect(w.modelCalls()).toBe(0);
        const first = w.send("POST", "/api/cron/draft", { text: "one" });
        await new Promise((r) => setTimeout(r, 20));
        expect((await w.send("POST", "/api/cron/draft", { text: "two" })).statusCode).toBe(429);
        release();
        expect((await first).json().ok).toBe(true);
        expect(w.modelCalls()).toBe(1);
      } finally { await w.cleanup(); }
      const none = await world({ draft: null });
      try {
        expect((await none.send("POST", "/api/cron/draft", { text: "x" })).statusCode).toBe(404);
        expect((await none.send("GET", "/api/cron/form")).json().fillIn).toBe(false);
      } finally { await none.cleanup(); }
    });
  });
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try { return await readdir(dir); } catch { return []; }
}
