// bin/lib/cron.ts — `pnpm choibot cron <sub>`: manage scheduled claude runs.
// Specs in CRON_DATA_DIR/jobs are the source of truth; this module renders
// them into choibot-cron-<name>.{service,timer} user units. Spec- and unit-file
// mutations hold the cron lock (withLock) so concurrent CLI calls and
// `choibot update`'s sync serialize — but slow systemctl calls (daemon-reload,
// enable/disable, start) run OUTSIDE the lock wherever ordering allows: the
// lock has a 60s stale-break, and a wedged systemd inside it could hand the
// lock to a second holder mid-mutation.
//
// Hardened deployment (Phase 2c, overview decision 42): an agent's env has
// CHOIBOT_CRON_SPOOL. Its uid can neither write CRON_DATA_DIR (0700, the
// console's) nor reach the console user's systemd, so add|edit|rm|enable|
// disable|run write a request into the spool, which the user applies or
// rejects in the console's Cron pane (server/cron/spool.ts runs the same code below as
// the console uid), and list asks the console. Without CHOIBOT_CRON_SPOOL (the
// console user's own shell, any non-hardened deployment) nothing changes.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";
import { run as runExec } from "./exec.js";
import { buildPath } from "./units.js";
import { renderCronUnits, type CronUnitVars } from "./cronunits.js";
import { createConsoleClient, msg } from "./client.js";
import {
  resolveCronDataDir, cronPaths, jobUnitNames, validateSpec, withLock, NAME_RE,
  atomicWriteJson, readJsonSafe, readRunTickets, runTicketsFile, type CronJobSpec, type CronRunResult,
} from "./cronspec.js";
import { WHY_WORDS, plainLine } from "./cron-result.mjs";
import { CLI_NAME } from "../../server/brand.js";
import { envRead, names } from "../../server/names.mjs";
import { COORDINATOR_ID } from "../../server/coordinator/paths.js";

// The cron subcommands the Coordinator may run: the reads, and the link of a ticket to a run
// (`note`: the console checks the caller and the ticket; it changes nothing of the task).
const COORDINATOR_CRON: readonly string[] = ["list", "show", "note"];

const HELP = `${CLI_NAME} cron — scheduled claude runs

  list                    jobs with schedule, next run, last result
  show <name>             the last run of a job: result, time, linked ticket, output
  note <name> --ticket <id>
                          link a ticket of the Queue to the last run of a job
                          (the task page shows it; the console checks the ticket)
  add                     create a job from a JSON spec on stdin
  edit <name>             replace a job's spec from stdin
  rm <name>               remove a job (units, stamp, run history)
  enable|disable <name>   flip a job on/off
  run <name>              fire a job now
  sync                    re-render all units from specs (used by \`${CLI_NAME} update\`)

Spec JSON: { "name", "schedule", "prompt", "workdir"?, "model"?, "effort"?,
             "timeoutMinutes"?, "notify"? ("always"|"on-failure"), "enabled"? }`;

export type CronDeps = {
  run: typeof runExec; // the only child-process seam, injectable for tests
  readStdin: () => Promise<string>;
  log: (s: string) => void;
  now: () => number;
  env: Record<string, string | undefined>;
  homedir: () => string;
  fetch: typeof fetch; // `list` with the cron spool key set asks the console
};

function defaultDeps(): CronDeps {
  return {
    run: runExec,
    // setEncoding so a multibyte character split across chunks survives.
    readStdin: async () => { process.stdin.setEncoding("utf8"); let s = ""; for await (const c of process.stdin) s += c; return s; },
    log: console.log,
    now: Date.now,
    env: process.env as Record<string, string | undefined>,
    homedir: osHomedir,
    fetch: (input, init) => fetch(input, init),
  };
}

// Everything a subcommand needs, resolved once: deps plus the derived dirs.
type Ctx = CronDeps & {
  repoDir: string; dataDir: string; jobsDir: string; runsDir: string;
  unitDir: string; stampDir: string;
};
// The console builds one to apply a spool request (server/cron/spool.ts).
export type CronCtx = Ctx;
export const cronCtx = (repoDir: string, overrides?: Partial<CronDeps>): CronCtx => makeCtx(repoDir, overrides);

function makeCtx(repoDir: string, overrides?: Partial<CronDeps>): Ctx {
  const deps = { ...defaultDeps(), ...overrides };
  const dataDir = resolveCronDataDir(deps.env);
  const { jobsDir, runsDir } = cronPaths(dataDir);
  return {
    ...deps, repoDir, dataDir, jobsDir, runsDir,
    unitDir: join(deps.homedir(), ".config", "systemd", "user"),
    stampDir: join(deps.homedir(), ".local", "share", "systemd", "timers"),
  };
}

const specPath = (ctx: Ctx, name: string) => join(ctx.jobsDir, `${name}.json`);
const stampPath = (ctx: Ctx, name: string) => join(ctx.stampDir, `stamp-${jobUnitNames(name).timer}`);
const sysctl = (ctx: Ctx, ...args: string[]) => ctx.run("systemctl", ["--user", ...args]);

// The sync/add guard: unit writes and systemctl calls only happen on a host
// where the console itself is installed — never turn a never-setup clone into
// a half-install.
const consoleInstalled = (ctx: Ctx) => existsSync(join(ctx.unitDir, names().unit));

function unitVars(ctx: Ctx): CronUnitVars {
  return {
    REPO_DIR: ctx.repoDir,
    NODE_BIN: process.execPath,
    // ~/.local/bin matters: claude and gh live there on typical hosts.
    PATH: buildPath([dirname(process.execPath), join(ctx.homedir(), ".local", "bin")]),
    CRON_DATA_DIR: ctx.dataDir,
  };
}

// Same contract as steps.ts writeUnits: only write files whose content
// actually changed, and report whether anything was written (the signal for a
// daemon-reload).
function writeIfChanged(dest: string, content: string): boolean {
  if (existsSync(dest) && readFileSync(dest, "utf8") === content) return false;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  return true;
}

function writeJobUnits(ctx: Ctx, spec: CronJobSpec): boolean {
  const units = jobUnitNames(spec.name);
  const rendered = renderCronUnits(ctx.repoDir, spec, unitVars(ctx));
  const s = writeIfChanged(join(ctx.unitDir, units.service), rendered.service);
  const t = writeIfChanged(join(ctx.unitDir, units.timer), rendered.timer);
  return s || t;
}

// Persistent=true consults the stamp's mtime for "did we miss a run"; create
// or touch it to NOW before every `enable --now` so a timer coming (back) to
// life does not immediately fire a catch-up run for a schedule slot that
// passed while it was new, disabled, or inactive — an unscheduled autonomous
// claude run is never worth the catch-up.
function touchStamp(ctx: Ctx, name: string): void {
  mkdirSync(ctx.stampDir, { recursive: true });
  const stamp = stampPath(ctx, name);
  writeFileSync(stamp, "", { flag: "a" });
  const now = new Date(ctx.now());
  utimesSync(stamp, now, now);
}

function readSpecNames(ctx: Ctx): string[] {
  if (!existsSync(ctx.jobsDir)) return [];
  return readdirSync(ctx.jobsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

// ---------------------------------------------------------------- subcommands

// The spec JSON on stdin, `edit <name>` forcing its name: a different name
// inside the JSON must not silently create a second job. null after a logged
// usage or parse error.
async function readSpecStdin(ctx: Ctx, mode: "add" | "edit", nameArg?: string): Promise<{ raw: unknown } | null> {
  if (mode === "edit" && !nameArg) { ctx.log(`usage: ${CLI_NAME} cron edit <name> < spec.json`); return null; }
  let raw: unknown;
  try { raw = JSON.parse(await ctx.readStdin()); }
  catch (e) { ctx.log(`invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`); return null; }
  if (mode === "edit" && raw && typeof raw === "object") (raw as Record<string, unknown>).name = nameArg;
  return { raw };
}

async function cmdAddEdit(ctx: Ctx, mode: "add" | "edit", nameArg?: string): Promise<number> {
  const read = await readSpecStdin(ctx, mode, nameArg);
  return read ? addEditSpec(ctx, mode, read.raw) : 1;
}

async function addEditSpec(ctx: Ctx, mode: "add" | "edit", raw: unknown): Promise<number> {
  const v = validateSpec(raw, { workdirExists: existsSync, now: ctx.now() });
  if (!v.ok) { ctx.log(`invalid spec: ${v.error}`); return 1; }
  const spec = v.spec;

  // systemd-analyze is the authority on OnCalendar syntax — check before any
  // write so a bad schedule never lands in a spec or a unit file.
  const cal = await ctx.run("systemd-analyze", ["calendar", spec.schedule]);
  if (cal.code !== 0) {
    ctx.log(`invalid schedule ${JSON.stringify(spec.schedule)}: ${cal.stderr.trim() || `systemd-analyze exit ${cal.code}`}`);
    return 1;
  }

  const file = specPath(ctx, spec.name);
  const installed = consoleInstalled(ctx);
  const err = await withLock(ctx.dataDir, async (): Promise<string | null> => {
    if (mode === "add" && existsSync(file)) return `job "${spec.name}" already exists — \`${CLI_NAME} cron edit ${spec.name}\` to change it`;
    if (mode === "edit" && !existsSync(file)) return `no such job "${spec.name}" — \`${CLI_NAME} cron add\` to create it`;
    await atomicWriteJson(file, spec);
    if (installed) {
      writeJobUnits(ctx, spec);
      // Stamp before the (post-lock) enable: see touchStamp.
      if (spec.enabled) touchStamp(ctx, spec.name);
    }
    return null;
  });
  if (err) { ctx.log(err); return 1; }

  if (installed) {
    await sysctl(ctx, "daemon-reload");
    const { timer } = jobUnitNames(spec.name);
    const verb = spec.enabled ? "enable" : "disable";
    const r = await sysctl(ctx, verb, "--now", timer);
    if (r.code !== 0) { ctx.log(`systemctl ${verb} --now ${timer} failed: ${r.stderr.trim() || `exit ${r.code}`}`); return 1; }
  }
  ctx.log(`${mode === "add" ? "added" : "updated"} job "${spec.name}" (${spec.enabled ? "enabled" : "disabled"}, ${spec.schedule})${installed ? "" : ` — units not written: console not installed (run \`pnpm ${CLI_NAME} setup\`)`}`);
  return 0;
}

async function cmdRm(ctx: Ctx, name?: string): Promise<number> {
  if (!name) { ctx.log(`usage: ${CLI_NAME} cron rm <name>`); return 1; }
  if (!existsSync(specPath(ctx, name))) { ctx.log(`no such job "${name}"`); return 1; }
  const { service, timer } = jobUnitNames(name);
  // Stop/disable while systemd still knows the unit — after the files are
  // gone there is nothing to act on. Ignore failure (job may never have run).
  await sysctl(ctx, "disable", "--now", timer);
  // A service whose last run failed lingers as a "not-found failed" row in
  // list-units even after its files are removed; clear that state too.
  await sysctl(ctx, "reset-failed", service, timer);
  await withLock(ctx.dataDir, async () => {
    rmSync(join(ctx.unitDir, service), { force: true });
    rmSync(join(ctx.unitDir, timer), { force: true });
    rmSync(stampPath(ctx, name), { force: true });
    rmSync(specPath(ctx, name), { force: true });
    rmSync(join(ctx.runsDir, name), { recursive: true, force: true });
  });
  await sysctl(ctx, "daemon-reload");
  ctx.log(`removed job "${name}"`);
  return 0;
}

async function cmdFlip(ctx: Ctx, enable: boolean, name?: string): Promise<number> {
  const verb = enable ? "enable" : "disable";
  if (!name) { ctx.log(`usage: ${CLI_NAME} cron ${verb} <name>`); return 1; }
  const file = specPath(ctx, name);
  const err = await withLock(ctx.dataDir, async (): Promise<string | null> => {
    const spec = await readJsonSafe<CronJobSpec>(file);
    if (!spec) {
      // A present-but-unreadable spec is an I/O fault, not a missing job —
      // rewriting it here would destroy the spec.
      return existsSync(file)
        ? `spec for "${name}" exists but cannot be read — refusing to overwrite it`
        : `no such job "${name}"`;
    }
    await atomicWriteJson(file, { ...spec, enabled: enable });
    // Stamp before the post-lock `enable --now`: see touchStamp.
    if (enable && consoleInstalled(ctx)) touchStamp(ctx, name);
    return null;
  });
  if (err) { ctx.log(err); return 1; }
  if (consoleInstalled(ctx)) {
    const { timer } = jobUnitNames(name);
    const r = await sysctl(ctx, verb, "--now", timer);
    if (r.code !== 0) { ctx.log(`spec updated, but systemctl ${verb} --now ${timer} failed: ${r.stderr.trim() || `exit ${r.code}`}`); return 1; }
  }
  ctx.log(`${verb}d job "${name}"`);
  return 0;
}

// noBlock: do not wait for the end of the run (the unit is a oneshot: a plain start waits
// until the task is done). The page's "Run now" uses it; the command line waits as before.
async function cmdRun(ctx: Ctx, name?: string, noBlock = false): Promise<number> {
  if (!name) { ctx.log(`usage: ${CLI_NAME} cron run <name>`); return 1; }
  if (!existsSync(specPath(ctx, name))) { ctx.log(`no such job "${name}"`); return 1; }
  const { service } = jobUnitNames(name);
  const r = noBlock ? await sysctl(ctx, "start", "--no-block", service) : await sysctl(ctx, "start", service);
  if (r.code !== 0) { ctx.log(`systemctl start ${service} failed: ${r.stderr.trim() || `exit ${r.code}`}`); return 1; }
  ctx.log(`started ${service} — logs: journalctl --user -u ${service} -f`);
  return 0;
}

// Re-render every spec'd job's units and remove units whose spec is gone.
// Shared by `choibot cron sync` and `choibot update` (steps.ts).
export async function cronSync(repoDir: string, overrides?: Partial<CronDeps>): Promise<void> {
  const ctx = makeCtx(repoDir, overrides);
  if (!consoleInstalled(ctx)) return;
  const reconcile: string[][] = []; // systemctl argvs deferred past the lock
  let changed = false;
  await withLock(ctx.dataDir, async () => {
    const specs: CronJobSpec[] = [];
    for (const name of readSpecNames(ctx)) {
      const spec = await readJsonSafe<CronJobSpec>(specPath(ctx, name));
      if (spec) specs.push(spec); // unreadable spec: leave its units alone
    }
    for (const spec of specs) {
      if (writeJobUnits(ctx, spec)) changed = true;
      // Stamp before the post-lock enable reconcile — sync may be reviving a
      // spec-enabled timer that was inactive, and a stale stamp would fire an
      // immediate catch-up run (see touchStamp).
      if (spec.enabled) touchStamp(ctx, spec.name);
      reconcile.push([spec.enabled ? "enable" : "disable", "--now", jobUnitNames(spec.name).timer]);
    }
    // Orphans: cron units (<cron prefix>*) whose spec is gone (rm'd elsewhere, hand-deleted).
    const known = new Set(specs.map((s) => s.name));
    const orphans = new Set<string>();
    const prefix = names().cronUnitPrefix;
    for (const f of existsSync(ctx.unitDir) ? readdirSync(ctx.unitDir) : []) {
      const m = f.startsWith(prefix) ? /^(.+)\.(?:service|timer)$/.exec(f.slice(prefix.length)) : null;
      if (m && !known.has(m[1])) orphans.add(m[1]);
    }
    for (const name of orphans) {
      const { service, timer } = jobUnitNames(name);
      // This systemctl call stays INSIDE the lock on purpose: disable must run
      // before the rmSync below deletes the unit file (and before another
      // holder could re-create it), so it cannot be deferred.
      await sysctl(ctx, "disable", "--now", timer);
      // Same as cmdRm: a service whose last run failed lingers as a
      // "not-found failed" row in list-units; clear that state too.
      await sysctl(ctx, "reset-failed", service, timer);
      rmSync(join(ctx.unitDir, service), { force: true });
      rmSync(join(ctx.unitDir, timer), { force: true });
      rmSync(stampPath(ctx, name), { force: true });
      changed = true;
    }
  });
  if (changed) await sysctl(ctx, "daemon-reload"); // once, after all unit edits
  for (const args of reconcile) await sysctl(ctx, ...args);
}

async function cmdSync(ctx: Ctx): Promise<number> {
  if (!consoleInstalled(ctx)) { ctx.log(`console units not installed — nothing to sync (run \`pnpm ${CLI_NAME} setup\`)`); return 0; }
  // Rebuild a ctx-free call so the CLI path and the update path share one body.
  await cronSync(ctx.repoDir, ctx);
  ctx.log("cron units synced");
  return 0;
}

// systemd's list-timers JSON says `next_elapse` (string) on some versions and
// `next` (µs since epoch) on others; show whichever is present. A timer with no
// scheduled elapse reports USEC_INFINITY (UINT64_MAX µs), which is past Date's
// ±8.64e15 ms range and makes toISOString() throw, so range-check before
// converting. Kept in sync with server/cron/api.ts's /api/cron/jobs.
const MAX_DATE_MS = 8.64e15;
async function listTimers(ctx: Ctx): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const r = await sysctl(ctx, "list-timers", "--all", "--output=json");
  if (r.code !== 0) return map;
  let rows: unknown;
  try { rows = JSON.parse(r.stdout); } catch { return map; }
  if (!Array.isArray(rows)) return map;
  for (const row of rows as Record<string, unknown>[]) {
    if (typeof row.unit !== "string") continue;
    if (typeof row.next_elapse === "string" && row.next_elapse) map.set(row.unit, row.next_elapse);
    else if (typeof row.next === "number" && row.next > 0 && row.next / 1000 <= MAX_DATE_MS) map.set(row.unit, new Date(row.next / 1000).toISOString());
  }
  return map;
}

async function cmdList(ctx: Ctx): Promise<number> {
  const names = readSpecNames(ctx);
  if (names.length === 0) { ctx.log(`no cron jobs — \`${CLI_NAME} cron add\` to create one`); return 0; }
  const timers = await listTimers(ctx);
  for (const name of names) {
    const spec = await readJsonSafe<CronJobSpec>(specPath(ctx, name));
    if (!spec) { ctx.log(`${name}  (spec unreadable)`); continue; }
    const next = timers.get(jobUnitNames(spec.name).timer) ?? "-";
    const last = await readJsonSafe<CronRunResult>(join(ctx.runsDir, spec.name, "last.json"));
    // Shape-check finishedAt (readJsonSafe only guards torn JSON): a hand-edited
    // last.json with a missing/garbage timestamp would make toISOString() throw
    // and lose the whole listing. Same guard as /api/cron/jobs.
    const lastCol = last && Number.isFinite(last.finishedAt)
      ? `${stateOfRun(last)} ${new Date(last.finishedAt).toISOString()}` : "-";
    ctx.log(`${spec.name}  ${spec.enabled ? "enabled" : "disabled"}  ${spec.schedule}  next: ${next}  last: ${lastCol}`);
  }
  return 0;
}

// ------------------------------------------------- the spool (hardened mode)

export type SpoolOp = "add" | "edit" | "rm" | "enable" | "disable" | "run";
export const SPOOL_OPS = ["add", "edit", "rm", "enable", "disable", "run"] as const satisfies readonly SpoolOp[];
export type SpoolRequest = { id: string; at: number; op: SpoolOp; name: string; spec?: unknown; by?: string };
// <ms since epoch>-<12 hex>; the file is <id>.json. The console reads no other name.
export const SPOOL_ID_RE = /^[0-9]{1,16}-[0-9a-f]{12}$/;
export const SPOOL_MAX_BYTES = 64 * 1024;
export const SPOOL_QUEUED = "queued for the user's approval in the console (Recurring, Changes that wait for you)";

// CHOIBOT_CRON_SPOOL (the console sets it in an agent's env only), else null.
export function spoolDir(env: Record<string, string | undefined> = process.env): string | null {
  const dir = envRead(env, "CRON_SPOOL");
  return dir ? dir : null;
}

// One request file, written atomically: a new tmp file (O_EXCL), mode 0660
// set explicitly (the console reads it through the group, whatever the
// umask), then renamed to <id>.json.
async function queueRequest(ctx: Ctx, dir: string, op: SpoolOp, name: string, spec?: unknown): Promise<number> {
  const at = ctx.now();
  const id = `${at}-${randomBytes(6).toString("hex")}`;
  const by = envRead(ctx.env, "AGENT_ID");
  const req: SpoolRequest = { id, at, op, name, ...(spec !== undefined ? { spec } : {}), ...(by ? { by } : {}) };
  const text = JSON.stringify(req);
  if (Buffer.byteLength(text) > SPOOL_MAX_BYTES) { ctx.log(`request too large: the spool takes at most 64 KiB`); return 1; }
  const tmp = join(dir, `.${id}.tmp`);
  try {
    await writeFile(tmp, text, { mode: 0o660, flag: "wx" });
    await chmod(tmp, 0o660);
    await rename(tmp, join(dir, `${id}.json`));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    ctx.log(`cannot queue the request in ${dir}: ${msg(e)}`);
    return 1;
  }
  ctx.log(SPOOL_QUEUED);
  return 0;
}

// add|edit: the spec is checked here only for an early answer (the workdir
// is not: this uid may not see it); the console checks it all on apply.
async function spoolAddEdit(ctx: Ctx, dir: string, mode: "add" | "edit", nameArg?: string): Promise<number> {
  const read = await readSpecStdin(ctx, mode, nameArg);
  if (!read) return 1;
  const v = validateSpec(read.raw, { workdirExists: () => true, now: ctx.now() });
  if (!v.ok) { ctx.log(`invalid spec: ${v.error}`); return 1; }
  // The spec's name as validated (a string): the console refuses a spec that names another job.
  return queueRequest(ctx, dir, mode, v.spec.name, { ...(read.raw as Record<string, unknown>), name: v.spec.name });
}

async function spoolByName(ctx: Ctx, dir: string, op: Exclude<SpoolOp, "add" | "edit">, name?: string): Promise<number> {
  if (!name) { ctx.log(`usage: ${CLI_NAME} cron ${op} <name>`); return 1; }
  if (!NAME_RE.test(name)) { ctx.log(`invalid name ${JSON.stringify(name)}: need ${NAME_RE}`); return 1; }
  return queueRequest(ctx, dir, op, name);
}

// `list` in an agent: GET /api/cron/jobs with the agent's own headers, never
// jobsDir or systemctl (neither is this uid's to read). Same line format.
async function cmdListViaConsole(ctx: Ctx): Promise<number> {
  let jobs: unknown;
  try {
    const client = createConsoleClient({ fetch: ctx.fetch, env: ctx.env, flags: {}, stderrIsTTY: false, readFile: () => null });
    jobs = (await client.call("GET", "/api/cron/jobs"))?.jobs;
  } catch (e) {
    ctx.log(`cron list: ${msg(e)}`);
    return 1;
  }
  const rows = (Array.isArray(jobs) ? jobs : []).filter((j): j is ConsoleJob => typeof j?.name === "string");
  if (rows.length === 0) { ctx.log(`no cron jobs — \`${CLI_NAME} cron add\` to create one`); return 0; }
  for (const j of rows) {
    const last = j.lastRun && Number.isFinite(j.lastRun.finishedAt)
      ? `${stateOfView(j.lastRun)} ${new Date(j.lastRun.finishedAt).toISOString()}` : "-";
    ctx.log(`${j.name}  ${j.enabled ? "enabled" : "disabled"}  ${j.schedule}  next: ${j.nextRun || "-"}  last: ${last}`);
  }
  return 0;
}
type ConsoleJob = { name: string; schedule: string; enabled: boolean; nextRun: string | null; lastRun: ({ finishedAt: number } & ConsoleView) | null };
// What the console says of a run (server/cron/result.ts RunView); an older console sends no state.
type ConsoleView = { ok: boolean; state?: unknown; sentence?: unknown; links?: unknown };

// The state of a run in the words of a digest line: did-not-finish, all-clear, needs-you, or
// ok for a run that finished with no result line (a task from before the result line).
type StateWord = "did-not-finish" | "all-clear" | "needs-you" | "ok";
function stateOfRun(r: Pick<CronRunResult, "ok" | "result">): StateWord {
  if (!r.ok) return "did-not-finish";
  const s = r.result && typeof r.result === "object" ? r.result.state : undefined;
  return s === "all-clear" || s === "needs-you" ? s : "ok";
}
function stateOfView(v: ConsoleView): StateWord {
  if (!v.ok || v.state === "failed") return "did-not-finish";
  return v.state === "clear" ? "all-clear" : v.state === "needs" ? "needs-you" : "ok";
}

// `show <name>`: the job's last run, read-only. The reader of the runs (the Coordinator, or the
// fleet master) reads a run with it after a `cron <name> <state>` digest line. The output is the
// job's own text. The ticket lines: the ticket linked to this run (`cron note`), or else the
// newest ticket linked to an earlier run of the job. In an agent (spool mode) it asks the
// console, as `list` does.
type Shown = {
  finishedAt: number; ok: boolean; exitCode: number | null; outputTail: string;
  state: StateWord; sentence: string | null; ticket: string | null; earlier: { id: string; finishedAt: number } | null;
};
async function cmdShow(ctx: Ctx, name: string | undefined): Promise<number> {
  if (!name || !NAME_RE.test(name)) { ctx.log(`usage: ${CLI_NAME} cron show <name>`); return 1; }
  const r = await readJsonSafe<CronRunResult>(join(ctx.runsDir, name, "last.json"));
  if (!r || typeof r.outputTail !== "string" || !Number.isFinite(r.finishedAt)) return printRun(ctx, name, null);
  const notes = await readRunTickets(runTicketsFile(ctx.dataDir, name));
  const state = stateOfRun(r);
  const said = r.result && typeof r.result === "object" && typeof r.result.sentence === "string" ? plainLine(r.result.sentence) : "";
  // The newest note of an earlier run: its run record gives the time the user reads.
  const at = [...notes.keys()].filter((t) => t < r.startedAt).sort((a, b) => b - a)[0];
  const earlierRun = at === undefined ? null : await readJsonSafe<CronRunResult>(join(ctx.runsDir, name, "ring", `${at}.json`));
  return printRun(ctx, name, {
    finishedAt: r.finishedAt, ok: r.ok, exitCode: r.exitCode, outputTail: r.outputTail, state,
    sentence: state === "did-not-finish" ? whyWordsOf(r.why) : state === "ok" ? null : said || null,
    ticket: notes.get(r.startedAt) ?? null,
    earlier: at === undefined ? null : { id: notes.get(at)!, finishedAt: earlierRun && Number.isFinite(earlierRun.finishedAt) ? earlierRun.finishedAt : at },
  });
}
const whyWordsOf = (why: unknown): string | null => (typeof why === "string" && Object.hasOwn(WHY_WORDS, why) ? WHY_WORDS[why as keyof typeof WHY_WORDS] : null);
async function cmdShowViaConsole(ctx: Ctx, name: string | undefined): Promise<number> {
  if (!name || !NAME_RE.test(name)) { ctx.log(`usage: ${CLI_NAME} cron show <name>`); return 1; }
  let runs: unknown;
  try {
    const client = createConsoleClient({ fetch: ctx.fetch, env: ctx.env, flags: {}, stderrIsTTY: false, readFile: () => null });
    runs = (await client.call("GET", `/api/cron/jobs/${name}/runs`))?.runs;
  } catch (e) {
    ctx.log(`cron show: ${msg(e)}`);
    return 1;
  }
  type Run = CronRunResult & ConsoleView;
  const list = (Array.isArray(runs) ? runs : []) as Run[];
  const r = list[0];
  if (!r || typeof r.outputTail !== "string" || !Number.isFinite(r.finishedAt)) return printRun(ctx, name, null);
  // The console checked every ticket link: one of this console's queue.
  const ticketOf = (v: Run): string | null => {
    const l = Array.isArray(v.links) ? v.links.find((x) => x && typeof x === "object" && x.kind === "ticket" && typeof x.id === "string") : undefined;
    return l ? String(l.id) : null;
  };
  const before = list.slice(1).find((v) => ticketOf(v) !== null);
  return printRun(ctx, name, {
    finishedAt: r.finishedAt, ok: r.ok, exitCode: r.exitCode, outputTail: r.outputTail, state: stateOfView(r),
    sentence: typeof r.sentence === "string" && r.sentence ? r.sentence : null,
    ticket: ticketOf(r),
    earlier: before ? { id: ticketOf(before)!, finishedAt: before.finishedAt } : null,
  });
}
function printRun(ctx: Ctx, name: string, r: Shown | null): number {
  if (!r) { ctx.log(`${name}: no run recorded`); return 1; }
  const exit = r.ok ? "" : `  ${r.exitCode === null ? "no exit code" : `exit ${r.exitCode}`}`;
  ctx.log(`${name}  ${r.state}  ${new Date(r.finishedAt).toISOString()}${exit}`);
  if (r.sentence) ctx.log(r.sentence);
  if (r.ticket) ctx.log(`ticket: ${r.ticket}`);
  else if (r.earlier) ctx.log(`earlier ticket: ${r.earlier.id} (linked to the run of ${new Date(r.earlier.finishedAt).toISOString()})`);
  ctx.log(r.outputTail || "(no output recorded)");
  return 0;
}

// `note <name> --ticket <id>`: links a ticket of the Queue to the job's last run. Always through
// the console, which checks the caller (the Coordinator, the fleet master or the user) and that
// the ticket is one of its queue.
// The ticket comes as the flag --ticket (bin/lib/cli.ts parseCli takes every --flag out of the words).
async function cmdNote(ctx: Ctx, rest: string[], flags: Record<string, string | true>): Promise<number> {
  const name = rest[0];
  const ticket = typeof flags.ticket === "string" ? flags.ticket : undefined;
  if (!name || !NAME_RE.test(name) || !ticket) { ctx.log(`usage: ${CLI_NAME} cron note <name> --ticket <id>`); return 1; }
  try {
    const client = createConsoleClient({ fetch: ctx.fetch, env: ctx.env, flags: {}, stderrIsTTY: false, readFile: () => null });
    const r = await client.call("POST", `/api/cron/jobs/${name}/note`, { ticket });
    const at = Number(r?.run);
    ctx.log(`linked ticket ${ticket} to the last run of ${name}${Number.isFinite(at) && at > 0 ? ` (started ${new Date(at).toISOString()})` : ""}`);
    return 0;
  } catch (e) {
    ctx.log(`cron note: ${msg(e)}`);
    return 1;
  }
}

// The console applies a spool request (as its own uid) through the very
// commands the CLI runs. add and edit take the job name from the request.
// The log lines are captured: the last one is the error.
export async function applyCronOp(ctx: CronCtx, op: SpoolOp, name: string, spec?: unknown, opts: { noBlock?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!NAME_RE.test(name)) return { ok: false, error: `invalid name ${JSON.stringify(name)}` };
  const lines: string[] = [];
  const c: Ctx = { ...ctx, log: (s) => lines.push(s) };
  const named = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw, name } : raw);
  let code: number;
  switch (op) {
    case "add":
    case "edit": code = await addEditSpec(c, op, named(spec)); break;
    case "rm": code = await cmdRm(c, name); break;
    case "enable": code = await cmdFlip(c, true, name); break;
    case "disable": code = await cmdFlip(c, false, name); break;
    case "run": code = await cmdRun(c, name, opts.noBlock === true); break;
    default: return { ok: false, error: `unknown op ${JSON.stringify(op)}` };
  }
  return code === 0 ? { ok: true } : { ok: false, error: lines.at(-1) ?? `${op} failed` };
}

// ------------------------------------------------------------------ dispatch

export async function runCron(sub: string | undefined, rest: string[], overrides?: Partial<CronDeps>, flags: Record<string, string | true> = {}): Promise<number> {
  // `pnpm choibot` always runs from the repo root (same contract as choibot.ts).
  const ctx = makeCtx(process.cwd(), overrides);
  // The Coordinator reads jobs and never changes one (server/coordinator/prompt.ts). A mistake
  // guard, as MASTER_IDS in agents.ts: the job files are local, so no route can refuse this.
  if (envRead(ctx.env, "AGENT_ID") === COORDINATOR_ID && sub !== undefined && !COORDINATOR_CRON.includes(sub)) {
    ctx.log(`refused: the Coordinator only reads cron jobs (${COORDINATOR_CRON.join(", ")})`);
    return 1;
  }
  const spool = spoolDir(ctx.env);
  if (spool !== null) {
    switch (sub) {
      case "list": return cmdListViaConsole(ctx);
      case "show": return cmdShowViaConsole(ctx, rest[0]);
      case "note": return cmdNote(ctx, rest, flags);
      case "add": return spoolAddEdit(ctx, spool, "add");
      case "edit": return spoolAddEdit(ctx, spool, "edit", rest[0]);
      case "rm":
      case "enable":
      case "disable":
      case "run": return spoolByName(ctx, spool, sub, rest[0]);
    }
  }
  switch (sub) {
    case "list": return cmdList(ctx);
    case "show": return cmdShow(ctx, rest[0]);
    case "note": return cmdNote(ctx, rest, flags);
    case "add": return cmdAddEdit(ctx, "add");
    case "edit": return cmdAddEdit(ctx, "edit", rest[0]);
    case "rm": return cmdRm(ctx, rest[0]);
    case "enable": return cmdFlip(ctx, true, rest[0]);
    case "disable": return cmdFlip(ctx, false, rest[0]);
    case "run": return cmdRun(ctx, rest[0]);
    case "sync": return cmdSync(ctx);
    default: ctx.log(HELP); return 2;
  }
}
