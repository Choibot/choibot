import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Task 2c-8: `choibot cron list` in an agent must never read jobsDir. Every
// readdirSync of this module graph goes through this spy (it calls the real one).
const fsSpy = vi.hoisted(() => ({ readdirSync: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  fsSpy.readdirSync = vi.fn(real.readdirSync);
  return { ...real, readdirSync: fsSpy.readdirSync };
});

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { runCron, cronSync, type CronDeps } from "./cron.js";
import { parseCli } from "./cli.js";
import type { RunResult } from "./exec.js";

// runCron resolves repoDir from process.cwd(); cronSync takes it explicitly.
// Both must be the real repo root so deploy/cron-job.* can be rendered.
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

type Call = { cmd: string; args: string[]; stamps: string[] };

const OK: RunResult = { code: 0, stdout: "", stderr: "" };
const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

// A fake host: tmp home (unitDir/stampDir live under it), tmp CRON_DATA_DIR,
// and a run() that records every argv (plus the stamp files present at call
// time, to assert touch-before-enable ordering) without touching systemd.
function world(opts: { installed?: boolean; onRun?: (cmd: string, args: string[]) => RunResult | undefined } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cron-home-"));
  const data = mkdtempSync(join(tmpdir(), "cron-data-"));
  tmps.push(home, data);
  const unitDir = join(home, ".config", "systemd", "user");
  const stampDir = join(home, ".local", "share", "systemd", "timers");
  mkdirSync(unitDir, { recursive: true });
  if (opts.installed !== false) writeFileSync(join(unitDir, "choibot.service"), "[Unit]\n");
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps: CronDeps = {
    run: async (cmd, args) => {
      calls.push({ cmd, args, stamps: existsSync(stampDir) ? readdirSync(stampDir).sort() : [] });
      return opts.onRun?.(cmd, args) ?? OK;
    },
    readStdin: async () => { throw new Error("test gave no stdin"); },
    log: (s) => logs.push(s),
    now: () => 1_000,
    env: { CRON_DATA_DIR: data },
    homedir: () => home,
    fetch: (async () => { throw new Error("test gave no console"); }) as unknown as typeof fetch,
  };
  const argvs = () => calls.map((c) => [c.cmd, ...c.args].join(" "));
  return { home, data, unitDir, stampDir, calls, logs, deps, argvs };
}

const SPEC = { name: "daily", schedule: "*-*-* 08:00:00", prompt: "summarize the day" };
const stdin = (w: ReturnType<typeof world>, value: unknown | string) => {
  w.deps.readStdin = async () => (typeof value === "string" ? value : JSON.stringify(value));
};
// A full on-disk spec (as jobs/<name>.json would hold after `add`).
const fullSpec = (patch: Record<string, unknown> = {}) => ({
  ...SPEC, workdir: undefined, model: null, effort: null,
  timeoutMinutes: 30, notify: "always", enabled: true, createdAt: 1_000, ...patch,
});
const writeSpec = (w: ReturnType<typeof world>, patch: Record<string, unknown> = {}) => {
  const spec = fullSpec(patch);
  mkdirSync(join(w.data, "jobs"), { recursive: true });
  writeFileSync(join(w.data, "jobs", `${spec.name}.json`), JSON.stringify(spec));
  return spec;
};

describe("cron add", () => {
  it("validates the schedule, writes the spec + units, reloads, stamps, then enables", async () => {
    const w = world();
    stdin(w, SPEC);
    expect(await runCron("add", [], w.deps)).toBe(0);

    const spec = JSON.parse(readFileSync(join(w.data, "jobs", "daily.json"), "utf8"));
    expect(spec).toMatchObject({ name: "daily", enabled: true, createdAt: 1_000, timeoutMinutes: 30 });

    const service = readFileSync(join(w.unitDir, "choibot-cron-daily.service"), "utf8");
    expect(service).toContain(`${REPO}/bin/cron-runner.mjs daily`);
    expect(service).toContain(`Environment=CRON_DATA_DIR=${w.data}`);
    const timer = readFileSync(join(w.unitDir, "choibot-cron-daily.timer"), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 08:00:00");

    const argvs = w.argvs();
    expect(argvs[0]).toBe("systemd-analyze calendar *-*-* 08:00:00");
    const reload = argvs.indexOf("systemctl --user daemon-reload");
    const enable = argvs.indexOf("systemctl --user enable --now choibot-cron-daily.timer");
    expect(reload).toBeGreaterThan(0);
    expect(enable).toBeGreaterThan(reload);
    // The stamp must exist BEFORE `enable --now` (Persistent=true reads it).
    expect(w.calls[enable].stamps).toContain("stamp-choibot-cron-daily.timer");
  });

  it("aborts on a schedule systemd-analyze rejects, writing nothing", async () => {
    const w = world({
      onRun: (cmd) => (cmd === "systemd-analyze" ? { code: 1, stdout: "", stderr: "Failed to parse calendar specification" } : undefined),
    });
    stdin(w, { ...SPEC, schedule: "at teatime" });
    expect(await runCron("add", [], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/Failed to parse calendar/);
    expect(existsSync(join(w.data, "jobs", "daily.json"))).toBe(false);
    expect(existsSync(join(w.unitDir, "choibot-cron-daily.service"))).toBe(false);
    expect(w.calls).toHaveLength(1); // no systemctl at all
  });

  it("rejects a duplicate name", async () => {
    const w = world();
    stdin(w, SPEC);
    expect(await runCron("add", [], w.deps)).toBe(0);
    expect(await runCron("add", [], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/already exists/);
  });

  it("rejects invalid JSON on stdin without writing or calling anything", async () => {
    const w = world();
    stdin(w, "{ not json");
    expect(await runCron("add", [], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/invalid JSON/);
    expect(existsSync(join(w.data, "jobs"))).toBe(false);
    expect(w.calls).toHaveLength(0);
  });

  it("disables (not enables) the timer when the spec says enabled: false", async () => {
    const w = world();
    stdin(w, { ...SPEC, enabled: false });
    expect(await runCron("add", [], w.deps)).toBe(0);
    expect(w.argvs()).toContain("systemctl --user disable --now choibot-cron-daily.timer");
    expect(w.argvs().join("\n")).not.toMatch(/enable --now/);
    expect(existsSync(join(w.stampDir, "stamp-choibot-cron-daily.timer"))).toBe(false);
  });
});

describe("cron edit", () => {
  it("fails when the job does not exist", async () => {
    const w = world();
    stdin(w, SPEC);
    expect(await runCron("edit", ["daily"], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/no such job/);
  });

  it("replaces the spec, forcing the name from the CLI argument", async () => {
    const w = world();
    writeSpec(w);
    stdin(w, { ...SPEC, name: "hijack", schedule: "*-*-* 09:30:00" });
    expect(await runCron("edit", ["daily"], w.deps)).toBe(0);
    const spec = JSON.parse(readFileSync(join(w.data, "jobs", "daily.json"), "utf8"));
    expect(spec).toMatchObject({ name: "daily", schedule: "*-*-* 09:30:00" });
    expect(existsSync(join(w.data, "jobs", "hijack.json"))).toBe(false);
  });
});

describe("cron rm", () => {
  it("disables the timer, deletes units + stamp + spec + runs, reloads", async () => {
    const w = world();
    writeSpec(w);
    writeFileSync(join(w.unitDir, "choibot-cron-daily.service"), "s");
    writeFileSync(join(w.unitDir, "choibot-cron-daily.timer"), "t");
    mkdirSync(w.stampDir, { recursive: true });
    writeFileSync(join(w.stampDir, "stamp-choibot-cron-daily.timer"), "");
    mkdirSync(join(w.data, "runs", "daily", "ring"), { recursive: true });
    writeFileSync(join(w.data, "runs", "daily", "last.json"), "{}");

    expect(await runCron("rm", ["daily"], w.deps)).toBe(0);
    const argvs = w.argvs();
    expect(argvs).toContain("systemctl --user disable --now choibot-cron-daily.timer");
    // Clears the lingering "not-found failed" row a failed last run leaves behind.
    expect(argvs).toContain("systemctl --user reset-failed choibot-cron-daily.service choibot-cron-daily.timer");
    expect(argvs).toContain("systemctl --user daemon-reload");
    for (const gone of [
      join(w.unitDir, "choibot-cron-daily.service"), join(w.unitDir, "choibot-cron-daily.timer"),
      join(w.stampDir, "stamp-choibot-cron-daily.timer"),
      join(w.data, "jobs", "daily.json"), join(w.data, "runs", "daily"),
    ]) expect(existsSync(gone)).toBe(false);
  });

  it("fails on an unknown job", async () => {
    const w = world();
    expect(await runCron("rm", ["ghost"], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/no such job/);
  });
});

describe("cron enable/disable", () => {
  it("disable flips the spec off and calls systemctl disable --now", async () => {
    const w = world();
    writeSpec(w);
    expect(await runCron("disable", ["daily"], w.deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(w.data, "jobs", "daily.json"), "utf8")).enabled).toBe(false);
    expect(w.argvs()).toContain("systemctl --user disable --now choibot-cron-daily.timer");
  });

  it("enable flips the spec on and calls systemctl enable --now", async () => {
    const w = world();
    writeSpec(w, { enabled: false });
    expect(await runCron("enable", ["daily"], w.deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(w.data, "jobs", "daily.json"), "utf8")).enabled).toBe(true);
    expect(w.argvs()).toContain("systemctl --user enable --now choibot-cron-daily.timer");
  });

  it("enable touches the stamp before enable --now (no Persistent catch-up run)", async () => {
    const w = world();
    writeSpec(w, { enabled: false });
    expect(await runCron("enable", ["daily"], w.deps)).toBe(0);
    const enable = w.calls.find((c) => c.args.includes("enable"))!;
    expect(enable.stamps).toContain("stamp-choibot-cron-daily.timer");
  });

  it("refuses to overwrite a spec file that exists but cannot be parsed", async () => {
    const w = world();
    mkdirSync(join(w.data, "jobs"), { recursive: true });
    writeFileSync(join(w.data, "jobs", "daily.json"), "{ corrupted");
    expect(await runCron("enable", ["daily"], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/cannot be read/);
    // The I/O fault must not destroy the file's contents.
    expect(readFileSync(join(w.data, "jobs", "daily.json"), "utf8")).toBe("{ corrupted");
    expect(w.calls).toHaveLength(0);
  });

  it("fails on a missing job", async () => {
    const w = world();
    expect(await runCron("enable", ["ghost"], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/no such job/);
  });
});

describe("cron run", () => {
  it("starts the job's service unit", async () => {
    const w = world();
    writeSpec(w);
    expect(await runCron("run", ["daily"], w.deps)).toBe(0);
    expect(w.argvs()).toContain("systemctl --user start choibot-cron-daily.service");
  });

  it("fails on an unknown job without calling systemctl", async () => {
    const w = world();
    expect(await runCron("run", ["ghost"], w.deps)).toBe(1);
    expect(w.calls).toHaveLength(0);
  });
});

describe("cron sync", () => {
  it("does nothing on a host where the console was never set up", async () => {
    const w = world({ installed: false });
    writeSpec(w);
    await cronSync(REPO, w.deps);
    expect(w.calls).toHaveLength(0);
    expect(existsSync(join(w.unitDir, "choibot-cron-daily.timer"))).toBe(false);
  });

  it("renders spec'd units, removes orphans, reloads once, reconciles enablement", async () => {
    const w = world();
    writeSpec(w);
    // Orphan: units + stamp left behind for a job whose spec is gone.
    writeFileSync(join(w.unitDir, "choibot-cron-old.service"), "s");
    writeFileSync(join(w.unitDir, "choibot-cron-old.timer"), "t");
    mkdirSync(w.stampDir, { recursive: true });
    writeFileSync(join(w.stampDir, "stamp-choibot-cron-old.timer"), "");

    await cronSync(REPO, w.deps);

    expect(readFileSync(join(w.unitDir, "choibot-cron-daily.service"), "utf8")).toContain("cron-runner.mjs daily");
    expect(existsSync(join(w.unitDir, "choibot-cron-daily.timer"))).toBe(true);
    expect(existsSync(join(w.unitDir, "choibot-cron-old.service"))).toBe(false);
    expect(existsSync(join(w.unitDir, "choibot-cron-old.timer"))).toBe(false);
    expect(existsSync(join(w.stampDir, "stamp-choibot-cron-old.timer"))).toBe(false);

    const argvs = w.argvs();
    expect(argvs).toContain("systemctl --user disable --now choibot-cron-old.timer");
    // Same as rm: clears the lingering "not-found failed" row a failed last run leaves.
    expect(argvs).toContain("systemctl --user reset-failed choibot-cron-old.service choibot-cron-old.timer");
    expect(argvs.filter((a) => a === "systemctl --user daemon-reload")).toHaveLength(1);
    // reload lands before the enablement reconcile so new units are known.
    expect(argvs.indexOf("systemctl --user daemon-reload"))
      .toBeLessThan(argvs.indexOf("systemctl --user enable --now choibot-cron-daily.timer"));
  });

  it("touches an enabled job's stamp before its enable --now reconcile", async () => {
    const w = world();
    writeSpec(w);
    await cronSync(REPO, w.deps);
    const enable = w.calls.find((c) => c.args.includes("enable"))!;
    expect(enable.stamps).toContain("stamp-choibot-cron-daily.timer");
  });

  it("disables a timer whose spec is disabled", async () => {
    const w = world();
    writeSpec(w, { enabled: false });
    await cronSync(REPO, w.deps);
    expect(w.argvs()).toContain("systemctl --user disable --now choibot-cron-daily.timer");
  });
});

describe("cron list", () => {
  it("prints name, enablement, schedule, next run and last result per job", async () => {
    const w = world({
      onRun: (cmd, args) => (cmd === "systemctl" && args.includes("list-timers")
        ? { code: 0, stdout: JSON.stringify([{ unit: "choibot-cron-daily.timer", next_elapse: "Thu 2026-08-06 08:00:00 UTC" }]), stderr: "" }
        : undefined),
    });
    writeSpec(w);
    writeSpec(w, { name: "weekly", schedule: "Mon *-*-* 09:00:00", enabled: false });
    mkdirSync(join(w.data, "runs", "daily"), { recursive: true });
    writeFileSync(join(w.data, "runs", "daily", "last.json"),
      JSON.stringify({ startedAt: 0, finishedAt: 1754000000000, exitCode: 0, ok: true, outputTail: "" }));

    expect(await runCron("list", [], w.deps)).toBe(0);
    expect(w.argvs()).toContain("systemctl --user list-timers --all --output=json");
    const out = w.logs.join("\n");
    const daily = w.logs.find((l) => l.includes("daily") && !l.includes("weekly"))!;
    expect(daily).toContain("enabled");
    expect(daily).toContain("*-*-* 08:00:00");
    expect(daily).toContain("Thu 2026-08-06 08:00:00 UTC");
    expect(daily).toMatch(/ok/);
    expect(out).toMatch(/weekly\s+disabled/);
  });

  it("survives a shape-invalid last.json (no finishedAt): job still listed, last column '-'", async () => {
    // readJsonSafe only guards torn JSON; a hand-edited last.json with a
    // missing/garbage finishedAt would make toISOString() throw RangeError and
    // lose the entire listing.
    const w = world();
    writeSpec(w);
    mkdirSync(join(w.data, "runs", "daily"), { recursive: true });
    writeFileSync(join(w.data, "runs", "daily", "last.json"),
      JSON.stringify({ ok: true, summary: "hand-edited" }));

    expect(await runCron("list", [], w.deps)).toBe(0);
    const daily = w.logs.find((l) => l.includes("daily"))!;
    expect(daily).toContain("last: -");
  });

  it("reads `next` (µs) when a systemd build omits next_elapse, and ignores sentinels", async () => {
    const w = world({
      onRun: (cmd, args) => (cmd === "systemctl" && args.includes("list-timers")
        ? {
            code: 0,
            stdout: JSON.stringify([
              { unit: "choibot-cron-daily.timer", next: Date.UTC(2026, 7, 7, 8, 0, 0) * 1000 },
              // USEC_INFINITY: out of Date's range — must not throw, must show "-".
              { unit: "choibot-cron-weekly.timer", next: 18446744073709551615 },
            ]),
            stderr: "",
          }
        : undefined),
    });
    writeSpec(w);
    writeSpec(w, { name: "weekly", schedule: "Mon *-*-* 09:00:00" });

    expect(await runCron("list", [], w.deps)).toBe(0);
    const daily = w.logs.find((l) => l.includes("daily"))!;
    expect(daily).toContain("next: 2026-08-07T08:00:00.000Z");
    const weekly = w.logs.find((l) => l.includes("weekly"))!;
    expect(weekly).toContain("next: -");
  });

  it("treats unparseable list-timers output as no next-run info", async () => {
    const w = world({
      onRun: (cmd, args) => (cmd === "systemctl" && args.includes("list-timers")
        ? { code: 0, stdout: "not json", stderr: "" } : undefined),
    });
    writeSpec(w);
    expect(await runCron("list", [], w.deps)).toBe(0);
    expect(w.logs.join("\n")).toContain("daily");
  });
});

// The reader of the runs (the Coordinator, or the fleet master) reads a run after a
// `cron <name> <state>` digest line.
describe("cron show", () => {
  const writeRun = (w: ReturnType<typeof world>, run: Record<string, unknown>, ring = false) => {
    mkdirSync(join(w.data, "runs", "daily", "ring"), { recursive: true });
    writeFileSync(join(w.data, "runs", "daily", "last.json"), JSON.stringify(run));
    if (ring) writeFileSync(join(w.data, "runs", "daily", "ring", `${run.startedAt}.json`), JSON.stringify(run));
  };
  it("a run with no result line (a task from before): `ok`, time and output, as before; never calls systemctl", async () => {
    const w = world();
    writeRun(w, { name: "daily", startedAt: 1754000000000, finishedAt: 1754000060000, exitCode: 0, ok: true, outputTail: "3 new errors in app-shop\n- TypeError in Swap" });
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.logs).toEqual([`daily  ok  ${new Date(1754000060000).toISOString()}`, "3 new errors in app-shop\n- TypeError in Swap"]);
    expect(w.calls).toHaveLength(0);
  });
  it("a run with a result line: its state and its sentence as one plain line", async () => {
    const w = world();
    writeRun(w, { startedAt: 1, finishedAt: 2, exitCode: 0, ok: true, outputTail: "text\nRESULT: needs-you | x", result: { state: "needs-you", sentence: "## 3 new **errors**\n in app", refs: [] } });
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.logs).toEqual([`daily  needs-you  ${new Date(2).toISOString()}`, "3 new errors in app", "text\nRESULT: needs-you | x"]);
  });
  it("a run that did not finish names its exit code and its reason", async () => {
    const w = world();
    writeRun(w, { name: "daily", startedAt: 1, finishedAt: 2, exitCode: 1, ok: false, outputTail: "", why: "exit" });
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.logs).toEqual([`daily  did-not-finish  ${new Date(2).toISOString()}  exit 1`, "It stopped with an error.", "(no output recorded)"]);
  });
  it("names the ticket linked to the run, or else the newest ticket linked to an earlier run", async () => {
    const w = world();
    const older = { startedAt: 100, finishedAt: 160, exitCode: 1, ok: false, outputTail: "", why: "timeout" };
    writeRun(w, older, true);
    writeRun(w, { startedAt: 200, finishedAt: 260, exitCode: 1, ok: false, outputTail: "", why: "timeout" }, true);
    const notes = join(w.data, "runs", "daily", "tickets.json");
    writeFileSync(notes, JSON.stringify({ "50": "qold00000", "100": "qaaaa1111", "999": "not-an-id" }));
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.logs[2]).toBe(`earlier ticket: qaaaa1111 (linked to the run of ${new Date(160).toISOString()})`);
    w.logs.length = 0;
    writeFileSync(notes, JSON.stringify({ "100": "qaaaa1111", "200": "qbbbb2222" }));
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.logs[2]).toBe("ticket: qbbbb2222");
    expect(w.logs).not.toContain(expect.stringContaining("earlier"));
  });
  it("no run, a bad name or no name: exit 1", async () => {
    const w = world();
    expect(await runCron("show", ["daily"], w.deps)).toBe(1);
    expect(await runCron("show", ["../x"], w.deps)).toBe(1);
    expect(await runCron("show", [], w.deps)).toBe(1);
    expect(w.logs).toEqual(["daily: no run recorded", "usage: choibot cron show <name>", "usage: choibot cron show <name>"]);
  });
});

describe("cron as the Coordinator", () => {
  it("reads jobs; every change is refused before a file or a unit is touched", async () => {
    for (const key of ["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_ID"]) {
      const w = world();
      writeSpec(w);
      w.deps.env = { ...w.deps.env, [key]: "coordinator" };
      stdin(w, SPEC);
      for (const [sub, ...rest] of [["add"], ["edit", "daily"], ["rm", "daily"], ["enable", "daily"], ["disable", "daily"], ["run", "daily"], ["sync"]]) {
        expect(await runCron(sub, rest, w.deps)).toBe(1);
      }
      expect(w.calls).toEqual([]);
      expect(w.logs.every((l) => l.startsWith("refused: the Coordinator only reads cron jobs"))).toBe(true);
      expect(existsSync(join(w.data, "jobs", "daily.json"))).toBe(true);
      expect(await runCron("list", [], w.deps)).toBe(0);
    }
  });
  it("may link a ticket to a run: `note` goes to the console, which checks the caller", async () => {
    const w = world();
    writeSpec(w);
    const fetched: string[] = [];
    w.deps.env = { ...w.deps.env, CHOIBOT_AGENT_ID: "coordinator", CHOIBOT_AGENT_PASS: "t", PORT: "4555" };
    w.deps.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetched.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return new Response(JSON.stringify({ ok: true, run: 5, ticket: "qaaaa1111" }), { status: 200 });
    }) as typeof fetch;
    expect(await runCron("note", ["daily"], w.deps, { ticket: "qaaaa1111" })).toBe(0);
    expect(fetched).toEqual(["POST /api/cron/jobs/daily/note"]);
    expect(w.calls).toEqual([]);
  });
  it("another agent and a person are not refused", async () => {
    const w = world();
    writeSpec(w);
    w.deps.env = { ...w.deps.env, CHOIBOT_AGENT_ID: "fleet-master" };
    expect(await runCron("disable", ["daily"], w.deps)).toBe(0);
  });
});

describe("cron help", () => {
  it("prints usage and exits 2 on an unknown or missing subcommand", async () => {
    const w = world();
    expect(await runCron(undefined, [], w.deps)).toBe(2);
    expect(await runCron("bogus", [], w.deps)).toBe(2);
    expect(w.logs.join("\n")).toContain("choibot cron");
    expect(w.calls).toHaveLength(0);
  });
});

// ---- Task 2c-8: hardened deployment, cron changes through the spool --------

const QUEUED = "queued for the user's approval in the console (Recurring, Changes that wait for you)";
const SPOOL_FILE = /^\d{1,16}-[0-9a-f]{12}\.json$/;

// Exactly the env that reaches an agent through the helper (plan Global
// Constraints), nothing else.
function agentWorld(routes: Record<string, (headers: Record<string, string>) => { status?: number; body?: unknown }> = {}) {
  const w = world();
  const spool = mkdtempSync(join(tmpdir(), "cron-spool-"));
  tmps.push(spool);
  const fetched: { method: string; path: string; headers: Record<string, string> }[] = [];
  w.deps.env = {
    CHOIBOT_AGENT_ID: "cron-master", CHOIBOT_AGENT_PASS: "hook-secret", PORT: "4555",
    PATH: process.env.PATH, HOME: w.home, TERM: "xterm-256color", LANG: "C.UTF-8",
    CHOIBOT_CRON_SPOOL: spool, CRON_DATA_DIR: w.data,
  };
  w.deps.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetched.push({ method, path: u.pathname, headers });
    const h = routes[`${method} ${u.pathname}`];
    const r = h ? h(headers) : { status: 404, body: { error: "not found" } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const requests = () => readdirSync(spool).filter((f) => SPOOL_FILE.test(f))
    .map((f) => ({ file: f, mode: statSync(join(spool, f)).mode & 0o777, body: JSON.parse(readFileSync(join(spool, f), "utf8")) }));
  return { ...w, spool, fetched, requests };
}

describe("cron with CHOIBOT_CRON_SPOOL (an agent in a hardened deployment)", () => {
  it("add writes one spool request (0660, by the agent id) and prints the queued line; nothing in CRON_DATA_DIR, no systemd", async () => {
    const w = agentWorld();
    stdin(w, SPEC);
    expect(await runCron("add", [], w.deps)).toBe(0);
    expect(w.logs).toEqual([QUEUED]);
    const reqs = w.requests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].mode).toBe(0o660);
    expect(reqs[0].body).toMatchObject({ op: "add", name: "daily", spec: SPEC, by: "cron-master", at: 1_000 });
    expect(reqs[0].file).toBe(`${reqs[0].body.id}.json`);
    // No tmp file left behind, nothing written into the console's cron data dir.
    expect(readdirSync(w.spool)).toEqual([reqs[0].file]);
    expect(readdirSync(w.data)).toEqual([]);
    expect(w.calls).toHaveLength(0);
    expect(w.fetched).toHaveLength(0);
  });

  it("edit forces the name from the argument into the queued spec", async () => {
    const w = agentWorld();
    stdin(w, { ...SPEC, name: "hijack" });
    expect(await runCron("edit", ["daily"], w.deps)).toBe(0);
    const [r] = w.requests();
    expect(r.body).toMatchObject({ op: "edit", name: "daily", spec: { ...SPEC, name: "daily" } });
    expect(readdirSync(w.data)).toEqual([]);
  });

  it("the queued spec carries the request's name as a string (the console refuses a mismatch)", async () => {
    const w = agentWorld();
    stdin(w, { ...SPEC, name: 123 });
    expect(await runCron("add", [], w.deps)).toBe(0);
    const [r] = w.requests();
    expect(r.body.name).toBe("123");
    expect(r.body.spec.name).toBe("123");
  });

  it("rm, enable, disable and run are spooled too, with no spec and no systemd call", async () => {
    for (const op of ["rm", "enable", "disable", "run"]) {
      const w = agentWorld();
      writeSpec(w);
      expect(await runCron(op, ["daily"], w.deps)).toBe(0);
      expect(w.logs).toEqual([QUEUED]);
      const [r] = w.requests();
      expect(r.body).toEqual({ id: r.body.id, at: 1_000, op, name: "daily", by: "cron-master" });
      expect(w.calls).toHaveLength(0);
      // The spec the agent asked to change is untouched.
      expect(JSON.parse(readFileSync(join(w.data, "jobs", "daily.json"), "utf8"))).toEqual(fullSpec());
    }
  });

  it("refuses a bad name, a missing name, invalid JSON and an invalid spec without queueing anything", async () => {
    const w = agentWorld();
    expect(await runCron("rm", ["../x"], w.deps)).toBe(1);
    expect(await runCron("run", [], w.deps)).toBe(1);
    stdin(w, "{ not json");
    expect(await runCron("add", [], w.deps)).toBe(1);
    stdin(w, { ...SPEC, prompt: "" });
    expect(await runCron("add", [], w.deps)).toBe(1);
    stdin(w, { ...SPEC, name: "Bad Name" });
    expect(await runCron("add", [], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/invalid name/);
    expect(w.logs.join("\n")).toMatch(/invalid JSON/);
    expect(w.logs.join("\n")).toMatch(/prompt is required/);
    expect(w.logs).not.toContain(QUEUED);
    expect(readdirSync(w.spool)).toEqual([]);
  });

  it("refuses a request over 64 KiB", async () => {
    const w = agentWorld();
    stdin(w, { ...SPEC, prompt: "x".repeat(70_000) });
    expect(await runCron("add", [], w.deps)).toBe(1);
    expect(w.logs.join("\n")).toMatch(/64 KiB/);
    expect(readdirSync(w.spool)).toEqual([]);
  });

  it("list asks the console (agent headers) and never reads jobsDir or calls systemctl", async () => {
    const w = agentWorld({
      "GET /api/cron/jobs": () => ({ body: { jobs: [
        { name: "daily", schedule: "*-*-* 08:00:00", enabled: true, notify: "always", nextRun: "Thu 2026-08-06 08:00:00 UTC",
          lastRun: { finishedAt: 1754000000000, ok: true, summary: "fine" } },
        { name: "weekly", schedule: "Mon *-*-* 09:00:00", enabled: false, notify: "always", nextRun: null, lastRun: null },
      ] } }),
    });
    // A spec on disk the list must NOT read.
    writeSpec(w, { name: "secret-local" });
    fsSpy.readdirSync.mockClear();
    expect(await runCron("list", [], w.deps)).toBe(0);
    expect(fsSpy.readdirSync).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
    expect(w.fetched).toHaveLength(1);
    expect(w.fetched[0]).toMatchObject({ method: "GET", path: "/api/cron/jobs" });
    expect(w.fetched[0].headers).toMatchObject({ "x-choibot-agent": "cron-master", "x-choibot-agent-token": "hook-secret" });
    expect(w.fetched[0].headers["x-choibot-user"]).toBeUndefined();
    expect(w.logs).toEqual([
      `daily  enabled  *-*-* 08:00:00  next: Thu 2026-08-06 08:00:00 UTC  last: ok ${new Date(1754000000000).toISOString()}`,
      "weekly  disabled  Mon *-*-* 09:00:00  next: -  last: -",
    ]);
  });

  it("show asks the console for the job's runs (agent headers) and prints the newest", async () => {
    const w = agentWorld({
      "GET /api/cron/jobs/daily/runs": () => ({ body: { runs: [
        { startedAt: 3, finishedAt: 4, exitCode: 0, ok: true, outputTail: "newest" },
        { startedAt: 1, finishedAt: 2, exitCode: 1, ok: false, outputTail: "older" },
      ] } }),
    });
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.fetched).toHaveLength(1);
    expect(w.fetched[0]).toMatchObject({ method: "GET", path: "/api/cron/jobs/daily/runs" });
    expect(w.fetched[0].headers).toMatchObject({ "x-choibot-agent": "cron-master", "x-choibot-agent-token": "hook-secret" });
    expect(w.logs).toEqual([`daily  ok  ${new Date(4).toISOString()}`, "newest"]);
    expect(w.calls).toHaveLength(0);
    const none = agentWorld({ "GET /api/cron/jobs/daily/runs": () => ({ body: { runs: [] } }) });
    expect(await runCron("show", ["daily"], none.deps)).toBe(1);
    expect(none.logs).toEqual(["daily: no run recorded"]);
  });

  it("show prints the state and the sentence that the console gives, and the ticket of an earlier run", async () => {
    const ticket = { kind: "ticket", id: "qaaaa1111", title: "daily did not finish", open: true };
    const w = agentWorld({
      "GET /api/cron/jobs/daily/runs": () => ({ body: { runs: [
        { startedAt: 5, finishedAt: 6, exitCode: null, ok: false, outputTail: "", state: "failed", sentence: "It ran longer than its time limit.", links: [] },
        { startedAt: 3, finishedAt: 4, exitCode: 1, ok: false, outputTail: "", state: "failed", sentence: "It stopped with an error.", links: [{ kind: "pr", url: "u", label: "l" }, ticket] },
      ] } }),
    });
    expect(await runCron("show", ["daily"], w.deps)).toBe(0);
    expect(w.logs).toEqual([
      `daily  did-not-finish  ${new Date(6).toISOString()}  no exit code`, "It ran longer than its time limit.",
      `earlier ticket: qaaaa1111 (linked to the run of ${new Date(4).toISOString()})`, "(no output recorded)",
    ]);
  });

  it("note asks the console (agent headers) and says what it linked; a refusal of the console exits 1", async () => {
    const w = agentWorld({ "POST /api/cron/jobs/daily/note": () => ({ body: { ok: true, run: 1754000000000, ticket: "qaaaa1111" } }) });
    // As `choibot cron note daily --ticket qaaaa1111` gives it: the parser takes the flag out of the words.
    const cli = parseCli(["cron", "note", "daily", "--ticket", "qaaaa1111"]);
    expect(await runCron(cli.target, cli.rest, w.deps, cli.flags)).toBe(0);
    expect(w.fetched[0]).toMatchObject({ method: "POST", path: "/api/cron/jobs/daily/note" });
    expect(w.fetched[0].headers).toMatchObject({ "x-choibot-agent": "cron-master", "x-choibot-agent-token": "hook-secret" });
    expect(w.logs).toEqual([`linked ticket qaaaa1111 to the last run of daily (started ${new Date(1754000000000).toISOString()})`]);
    expect(w.requests()).toEqual([]);
    const refused = agentWorld({ "POST /api/cron/jobs/daily/note": () => ({ status: 403, body: { error: "only the Coordinator, the fleet master and the user link a ticket to a run" } }) });
    expect(await runCron("note", ["daily"], refused.deps, { ticket: "qaaaa1111" })).toBe(1);
    expect(refused.logs).toEqual(["cron note: only the Coordinator, the fleet master and the user link a ticket to a run"]);
    for (const [rest, flags] of [[[], {}], [["daily"], {}], [["daily"], { ticket: true }], [["../x"], { ticket: "qaaaa1111" }]] as const) {
      const u = agentWorld();
      expect(await runCron("note", [...rest], u.deps, flags)).toBe(1);
      expect(u.logs).toEqual(["usage: choibot cron note <name> --ticket <id>"]);
      expect(u.fetched).toEqual([]);
    }
  });

  it("list with no jobs, and with the console unreachable", async () => {
    const w = agentWorld({ "GET /api/cron/jobs": () => ({ body: { jobs: [] } }) });
    expect(await runCron("list", [], w.deps)).toBe(0);
    expect(w.logs).toEqual(["no cron jobs — `choibot cron add` to create one"]);
    const down = agentWorld();
    down.deps.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await runCron("list", [], down.deps)).toBe(1);
    expect(down.logs.join("\n")).toMatch(/console unreachable/);
  });

  it("not hardened (no CHOIBOT_CRON_SPOOL, or an empty one): an agent id alone still writes the spec as today", async () => {
    for (const extra of [{}, { CHOIBOT_CRON_SPOOL: "" }]) {
      const w = world();
      w.deps.env = { CRON_DATA_DIR: w.data, CHOIBOT_AGENT_ID: "cron-master", ...extra };
      stdin(w, SPEC);
      expect(await runCron("add", [], w.deps)).toBe(0);
      expect(JSON.parse(readFileSync(join(w.data, "jobs", "daily.json"), "utf8"))).toMatchObject({ name: "daily" });
      expect(w.logs.join("\n")).not.toContain(QUEUED);
    }
  });
});
