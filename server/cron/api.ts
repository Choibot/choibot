// server/cron/api.ts — cron backend: the tasks and the runs that the Recurring
// section shows, runner notifications, and (hardened deployment
// only) the spool of cron changes agents asked for.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EventHub } from "../events.js";
import { NAME_RE, atomicWriteJson, cronPaths, jobUnitNames, readJsonSafe, readRunTickets, resolveCronDataDir, runTicketsFile, withLock, type CronJobSpec, type CronRunResult } from "../../bin/lib/cronspec.js";
import { applyCronOp, cronCtx, SPOOL_ID_RE, type CronCtx } from "../../bin/lib/cron.js";
import { gateRoute, gateUser, pairRequired, type ChiefGate } from "../chief/gate.js";
import { ITEM_ID_RE } from "../chief/queue/store.js";
import type { CronRunEvent } from "../events.js";
import { resolveWorkspaceDir } from "../defaults.js";
import { runView, type RunView, type TicketLookup } from "./result.js";
import { SpoolSeen, applySpool, effectiveCwd, listSpool, onceLog, refusedCwd, removeSpool, takeSpool, type SpoolEntry } from "./spool.js";
import { DRAFT_TEXT_MAX, readForm, specOfForm } from "./form.js";
import { draftTask } from "./draft.js";
// The runner's mark of a run in progress (running.ts, also read by the sign-out of a login).
import { runsNow } from "./running.js";
import type { GuideModel } from "../guide/model.js";
import type { Caller, CallerLevel } from "../chief/auth.js";

const execFileP = promisify(execFile);
const TIMERS_TTL_MS = 5_000;      // the Cron group polls; do not fork systemctl per poll
const PROMPT_MAX = 8_000;         // the instructions of a task, as the task page shows them
const SUMMARY_MAX = 3_900;        // stays under Telegram's 4096 with prefix room

// systemd's list-timers JSON says `next_elapse` (string) on some versions and
// `next` (µs since epoch) on others; read whichever is present (same as
// `choibot cron list`).
type TimerRow = { unit?: string; next_elapse?: string | null; next?: number };

// A timer with no scheduled elapse reports USEC_INFINITY (UINT64_MAX µs), and 0
// shows up too; both are out of Date's ±8.64e15 ms range or nonsense as a date,
// and toISOString() throws RangeError on them. The Cron group polls every 5s, so an
// unguarded conversion would 500 this route forever on such a host.
const MAX_DATE_MS = 8.64e15;
const isNextUsec = (n: number | undefined): n is number =>
  typeof n === "number" && n > 0 && n / 1000 <= MAX_DATE_MS;

function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type CronJobView = {
  name: string; schedule: string; enabled: boolean; notify: "always" | "on-failure";
  nextRun: string | null;               // ISO or null
  // What the task page says about the task: its instructions (text of a person or an agent:
  // plain text only), the name of its repo (never a path; null: the work folder or a place
  // outside it) and when it was made.
  prompt: string; repo: string | null; createdAt: number | null;
  // running: a run is in progress now (the runner's mark, not older than the task's time limit).
  running: boolean;
  // state, sentence, links: what the page says of the run (./result.ts runView).
  lastRun: ({ finishedAt: number; ok: boolean; summary: string } & RunView) | null;
};

// The name of the repo that a task runs in: a folder right under the work folder. The browser
// gets a name, never a path.
export function repoName(workdir: string | undefined, workspaceDir: string): string | null {
  if (!workdir) return null;
  const rel = relative(resolve(workspaceDir), resolve(workdir));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep) ? rel : null;
}

export function registerCronApi(
  app: FastifyInstance,
  deps: {
    hub: EventHub;
    cronDataDir?: string;
    listTimers?: () => Promise<TimerRow[]>;   // test seam
    timeZone?: () => string;                  // test seam: the zone of a timer line with no zone name
    workspaceDir?: string;                    // the work folder (a task's repo is a folder of it)
    // A ticket of this console's queue, for the link of a run (absent: no queue, no ticket link).
    ticket?: TicketLookup;
    // The gate of the chief of staff, for the routes that change a task (run, pause, resume,
    // delete): the paired user only. Absent: this console has no device pairing.
    gate?: ChiefGate;
    ctx?: () => CronCtx;                      // test seam: the cron ctx that a change runs with
    // The repos of the work folder, for the form of a task (name and folder; the browser gets
    // and sends names only). Absent: the form has no repo to choose.
    repos?: () => Promise<{ name: string; path: string }[]>;
    // "Fill in": the console's no-tool model (server/guide/model.ts). Absent: no such route.
    draft?: GuideModel;
    // Hardened deployment only (spoolRoutes in ./spool.ts); absent, no spool
    // route exists. ctx: the cron ctx an apply runs with (test seam).
    spool?: { gate: ChiefGate; dir: string | null; ctx?: () => CronCtx };
  },
): void {
  const dataDir = deps.cronDataDir ?? resolveCronDataDir();
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const ticket: TicketLookup = deps.ticket ?? (async () => null);
  const paths = cronPaths(dataDir);

  // Shared secret for the runner's notify POSTs (loopback is NOT an auth
  // boundary here — the gate proxies public traffic over loopback).
  const tokenReady = (async () => {
    await mkdir(dataDir, { recursive: true });
    await chmod(dataDir, 0o700).catch(() => {});
    if (!existsSync(paths.tokenFile)) {
      await writeFile(paths.tokenFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
    }
    return (await readFile(paths.tokenFile, "utf8")).trim();
  })();
  // Side-branch handler: if the setup rejects before any request awaits it
  // (unwritable CRON_DATA_DIR, ENOSPC), Node's unhandled-rejection policy would
  // crash the server. The notify route still awaits the original (rejected)
  // promise, so bad setup fails loudly per-request instead.
  tokenReady.catch(() => {});

  const defaultListTimers = async (): Promise<TimerRow[]> => {
    try {
      const { stdout } = await execFileP("systemctl", ["--user", "list-timers", "--all", "--output=json"], { timeout: 10_000 });
      const rows = JSON.parse(stdout);
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  };
  const listTimers = deps.listTimers ?? defaultListTimers;
  let timersCache: { at: number; rows: TimerRow[] } | null = null;
  const cachedTimers = async (): Promise<TimerRow[]> => {
    if (timersCache && Date.now() - timersCache.at < TIMERS_TTL_MS) return timersCache.rows;
    const rows = await listTimers();
    timersCache = { at: Date.now(), rows };
    return rows;
  };

  app.get("/api/cron/jobs", async () => {
    let names: string[] = [];
    try { names = (await readdir(paths.jobsDir)).filter((n) => n.endsWith(".json")); } catch { /* no jobs yet */ }
    const timers = await cachedTimers();
    const jobs = (await Promise.all(names.map(async (file) => {
      const spec = await readJsonSafe<CronJobSpec>(join(paths.jobsDir, file));
      if (!spec) return null;
      const timer = timers.find((t) => t.unit === jobUnitNames(spec.name).timer);
      const nextUsec = timer?.next;
      const last = await readJsonSafe<CronRunResult>(join(paths.runsDir, spec.name, "last.json"));
      // readJsonSafe guards torn JSON but not shape: a hand-edited last.json
      // missing outputTail would make .slice() throw and 500 this polled route
      // forever. Treat a shape-invalid record as "no last run".
      const lastValid = last && typeof last.outputTail === "string" ? last : null;
      const noted = lastValid ? (await readRunTickets(runTicketsFile(dataDir, spec.name))).get(lastValid.startedAt) : undefined;
      return {
        name: spec.name, schedule: spec.schedule, enabled: spec.enabled, notify: spec.notify,
        nextRun: timer?.next_elapse || (isNextUsec(nextUsec) ? new Date(nextUsec / 1000).toISOString() : null),
        prompt: typeof spec.prompt === "string" ? spec.prompt.slice(0, PROMPT_MAX) : "",
        repo: repoName(typeof spec.workdir === "string" ? spec.workdir : undefined, workspaceDir),
        createdAt: Number.isFinite(spec.createdAt) ? spec.createdAt : null,
        running: await runsNow(join(paths.runsDir, spec.name, "running.json"), spec.timeoutMinutes),
        lastRun: lastValid ? {
          finishedAt: lastValid.finishedAt, ok: lastValid.ok, summary: lastValid.outputTail.slice(-300),
          ...(await runView(lastValid, ticket, noted)),
        } : null,
      };
    }))).filter((j) => j !== null);
    jobs.sort((a, b) => a!.name.localeCompare(b!.name));
    // timeZone: a timer line with no zone name runs in the server's own zone; the page says it.
    return { jobs, timeZone: (deps.timeZone ?? serverTimeZone)() };
  });

  // Full run history for one job (the ring, newest first) — feeds the Cron
  // job pane (CronHistory). The slug check doubles as path-traversal protection.
  app.get("/api/cron/jobs/:name/runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = req.params as { name: string };
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
    const ringDir = join(paths.runsDir, name, "ring");
    let files: string[] = [];
    try { files = (await readdir(ringDir)).filter((f) => f.endsWith(".json")); } catch { /* no runs yet */ }
    const runs = (await Promise.all(files.map((f) => readJsonSafe<CronRunResult>(join(ringDir, f)))))
      // Same shape guard as lastRun above: a torn or hand-mangled ring entry
      // must drop out, not 500 the panel.
      .filter((r): r is CronRunResult =>
        r !== null && typeof r.outputTail === "string" && Number.isFinite(r.startedAt) && Number.isFinite(r.finishedAt))
      .sort((a, b) => b.startedAt - a.startedAt);
    // Each run with what the page says of it. A ticket is read once for all the runs.
    const known = new Map<string, ReturnType<TicketLookup>>();
    const once: TicketLookup = (id) => { if (!known.has(id)) known.set(id, ticket(id)); return known.get(id)!; };
    const notes = await readRunTickets(runTicketsFile(dataDir, name));
    return { runs: await Promise.all(runs.map(async (r) => ({
      startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode, ok: r.ok, outputTail: r.outputTail,
      ...(await runView(r, once, notes.get(r.startedAt))),
    }))) };
  });

  app.post("/api/cron/notify", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = await tokenReady;
    const got = String(req.headers["x-cron-token"] ?? "");
    const a = Buffer.from(got), b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "bad token" });
    const { name, ok, summary, telegram, result, why } = (req.body as { name?: string; ok?: boolean; summary?: string; telegram?: boolean; result?: unknown; why?: unknown }) ?? {};
    if (!name) return reply.code(400).send({ error: "missing name" });
    // A runner from before the `telegram` field sends none: Telegram as before. A runner from
    // before the result (or a run with no result line) sends no `result` and no `why`: no `said`.
    const said = await saidOf(Boolean(ok), result, why);
    deps.hub.emitEvent({
      type: "cron-run", name, ok: Boolean(ok), summary: String(summary ?? "").slice(0, SUMMARY_MAX),
      ...(telegram === false ? { telegram: false as const } : {}),
      ...(said ? { said } : {}),
    });
    return reply.code(204).send();
  });

  // `cron note <name> --ticket <id>`: the reader of a run says "this run's ticket is <id>". The
  // task page then shows the ticket on the run, and the Coordinator sees that a broken task
  // has a ticket. For the Coordinator, the fleet master and the paired user only: never a
  // worker or a lead. The id must be a ticket of this console's queue. The note goes to its own
  // file (runTicketsFile) and is for the last run: the run itself does not change. Body: { ticket }.
  app.post("/api/cron/jobs/:name/note", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.gate || !deps.ticket) return reply.code(403).send(RECURRING_NO_PAIRING);
    if (!gateRoute(deps.gate, reply)) return reply;
    const caller = await deps.gate.caller(req);
    if (!NOTE_LEVELS.has(caller.level)) return caller.agentHeaders ? reply.code(403).send({ error: NOTE_REFUSAL }) : pairRequired(deps.gate, reply);
    const { name } = req.params as { name: string };
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
    const body = (req.body ?? {}) as { ticket?: unknown };
    if (typeof body.ticket !== "string" || !ITEM_ID_RE.test(body.ticket)) return reply.code(400).send({ error: "ticket must be a ticket id (q + 8 characters)" });
    if (!(await ticket(body.ticket).catch(() => null))) return reply.code(404).send({ error: "no such ticket in this console's queue" });
    const runDir = join(paths.runsDir, name);
    const startedAt = (await readJsonSafe<CronRunResult>(join(runDir, "last.json")))?.startedAt;
    if (!Number.isSafeInteger(startedAt) || !existsSync(join(runDir, "ring", `${startedAt}.json`))) return reply.code(404).send({ error: "this task has no run" });
    const id = body.ticket;
    await withLock(dataDir, async () => {
      // Keep the notes of the runs that are still in the history: the runner drops the old ones.
      const file = runTicketsFile(dataDir, name);
      const notes: Record<string, string> = {};
      for (const [at, t] of await readRunTickets(file)) if (existsSync(join(runDir, "ring", `${at}.json`))) notes[String(at)] = t;
      notes[String(startedAt)] = id;
      await atomicWriteJson(file, notes);
    });
    console.log(`[cron] note ${name} run ${startedAt}: ticket ${id} by ${caller.level === "user" ? caller.device ?? "user" : caller.agentId}`);
    return { ok: true, run: startedAt, ticket: id };
  });

  // The changes that the page makes: Run now, Pause, Resume, Delete. For the paired USER only
  // (an agent, a lead and the fleet master are refused: an agent asks through the command line,
  // and on a protected install its change waits in the spool for the user, as before).
  // The browser sends the name of the task and one of 4 fixed words, nothing more: the server
  // checks the name by its pattern and builds the unit names itself (jobUnitNames, in the
  // same code that the command line runs).
  const changeCtx = deps.ctx ?? (() => cronCtx(process.cwd(), { env: { ...process.env, CRON_DATA_DIR: dataDir } }));
  // Every route that changes a task, and "Fill in": the paired user, or nobody. A console
  // with no device pairing cannot tell its user from an agent, so it refuses.
  const userOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> => {
    if (!deps.gate) { reply.code(403).send(RECURRING_NO_PAIRING); return null; }
    return gateUser(deps.gate, req, reply);
  };
  app.post("/api/cron/jobs/:name/:action", async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = await userOnly(req, reply);
    if (!caller) return reply;
    const { name, action } = req.params as { name: string; action: string };
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: "bad name" });
    if (!Object.hasOwn(TASK_ACTIONS, action)) return reply.code(404).send({ error: "no such action" });
    const op = TASK_ACTIONS[action as TaskAction];
    const spec = await readJsonSafe<CronJobSpec>(join(paths.jobsDir, `${name}.json`));
    if (!spec) return reply.code(404).send({ error: "This task is not in the list now." });
    // The runner does nothing for a paused task: say so, do not start a run that is empty.
    if (op === "run" && !spec.enabled) return reply.code(409).send({ error: "This task is paused. Resume it first." });
    const r = await applyCronOp(changeCtx(), op, name, undefined, { noBlock: true }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    timersCache = null; // the next read of the list has the new next run
    // The error has unit names and the words of the service manager: for the log only.
    console.log(`[cron] ${action} ${name} by ${caller.device ?? "user"}: ${r.ok ? "done" : `failed: ${JSON.stringify(r.error)}`}`);
    return r.ok ? { ok: true } : reply.code(422).send({ error: "Your server could not do this. Try again." });
  });

  // The form: "New task" (POST /api/cron/tasks) and "Change" (POST /api/cron/tasks/:name).
  // The body is the form's fields (./form.ts readForm checks each one). The server makes the
  // task definition: the folder from its own repo list, the timer line from the plain-words
  // model (buildSchedule), all else from the task as it is. Then the same code as the command
  // line writes it (applyCronOp: it checks the definition again and asks systemd-analyze).
  const repoList = deps.repos ?? (async () => []);
  const saveTask = async (req: FastifyRequest, reply: FastifyReply, mode: "new" | "change") => {
    const caller = await userOnly(req, reply);
    if (!caller) return reply;
    const read = readForm(req.body, mode, (req.params as { name?: string }).name);
    if (!read.ok) return reply.code(400).send({ field: read.field, error: read.error });
    const form = read.form;
    const old = await readJsonSafe<CronJobSpec>(join(paths.jobsDir, `${form.name}.json`));
    if (mode === "new" && (old || existsSync(join(paths.jobsDir, `${form.name}.json`)))) return reply.code(409).send({ field: "name", error: "A task with this name exists. Choose another name." });
    if (mode === "change" && !old) return reply.code(404).send({ error: "This task is not in the list now." });
    // The repo: a name of the server's own list gives the folder. A change that keeps the
    // repo of the task (the same name) keeps the task's folder as it is.
    let workdir: string | undefined;
    if (form.repo !== null) {
      const keep = old && repoName(old.workdir, workspaceDir) === form.repo ? old.workdir : undefined;
      workdir = keep ?? (await repoList()).find((r) => r.name === form.repo)?.path;
      if (!workdir) return reply.code(400).send({ field: "repo", error: "Choose a repo of the list." });
    } else if (old?.workdir && repoName(old.workdir, workspaceDir) === null) {
      // A task whose folder is not a repo of the list (made from the command line): the form shows no repo for it, and a change keeps the folder.
      workdir = old.workdir;
    }
    // A text that is longer than the form shows (made from the command line) and that the form sent back as it was cut: keep the full text.
    if (old && typeof old.prompt === "string" && old.prompt.length > PROMPT_MAX && form.what === old.prompt.slice(0, PROMPT_MAX).trim()) form.what = old.prompt;
    const spec = specOfForm(form, workdir, old ?? undefined);
    const c = changeCtx();
    // A protected install: never a folder that an agent can write (the rule of the spool's Apply).
    const refused = await refusedCwd(effectiveCwd(spec, c), c.env).catch(() => "check failed");
    if (refused) {
      console.log(`[cron] ${mode} ${form.name} refused: ${JSON.stringify(refused)}`);
      return reply.code(422).send({ field: "repo", error: "Your server does not let a task run in this folder." });
    }
    const r = await applyCronOp(c, mode === "new" ? "add" : "edit", form.name, spec).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    timersCache = null;
    console.log(`[cron] ${mode} ${form.name} by ${caller.device ?? "user"}: ${r.ok ? "done" : `failed: ${JSON.stringify(r.error)}`}`);
    if (r.ok) return { ok: true, name: form.name };
    if (r.error.startsWith("invalid schedule")) return reply.code(422).send({ field: "when", error: "Your server does not take this schedule." });
    return reply.code(422).send({ error: "Your server could not save the task. Try again." });
  };
  app.post("/api/cron/tasks", (req, reply) => saveTask(req, reply, "new"));
  app.post("/api/cron/tasks/:name", (req, reply) => saveTask(req, reply, "change"));

  // What the form needs to start: the repos to choose from (names only), and if "Fill in" is there.
  app.get("/api/cron/form", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    return { repos: (await repoList()).map((r) => r.name).sort(), fillIn: deps.draft !== undefined };
  });

  // "Fill in": the user's sentence becomes the fields of the form. One model call with no
  // tool, only on the user's press, one at a time. Nothing is saved: the user reads the form
  // and presses Save.
  let drafting = false;
  app.post("/api/cron/draft", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    if (!deps.draft) return reply.code(404).send({ error: "not available" });
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "Write one sentence first." });
    if (text.length > DRAFT_TEXT_MAX) return reply.code(400).send({ error: "The text is too long." });
    if (drafting) return reply.code(429).send({ error: "Wait for the answer of the first press." });
    drafting = true;
    try {
      const answer = await draftTask(deps.draft, text.trim(), (await repoList()).map((r) => r.name));
      return answer.ok ? answer : { ok: false, why: answer.why, ...(answer.until ? { until: answer.until } : {}) };
    } finally { drafting = false; }
  });

  if (deps.spool) registerSpoolRoutes(app, deps.spool, dataDir);
}

// Who may link a ticket to a run (`cron note`): the readers of the runs and the user.
const NOTE_LEVELS: ReadonlySet<CallerLevel> = new Set(["user", "master", "coordinator"]);
export const NOTE_REFUSAL = "only the Coordinator, the fleet master and the user link a ticket to a run";

// What the run said, for the event of a run: the state in the user's words and one plain
// sentence (for did-not-finish: the fixed reason words). Undefined for a run with no result line
// and no known reason (a task or a runner from before): the event is then as before.
async function saidOf(ok: boolean, result: unknown, why: unknown): Promise<CronRunEvent["said"]> {
  const v = await runView({ startedAt: 0, finishedAt: 0, exitCode: null, ok, outputTail: "", result: result as CronRunResult["result"], why });
  if (v.state === "clear") return { state: "all-clear", sentence: v.sentence };
  if (v.state === "needs") return { state: "needs-you", sentence: v.sentence };
  if (v.state === "failed" && v.sentence) return { state: "did-not-finish", sentence: v.sentence };
  return undefined;
}

// The answer of a changing route on a console with no device pairing.
export const RECURRING_NO_PAIRING = { error: "needs-pairing", text: "Pair a device first. Only a paired device can change a recurring task." };

// What the page can do to a task, and the command of the cron engine for each.
export const TASK_ACTIONS = { run: "run", pause: "disable", resume: "enable", delete: "rm" } as const;
export type TaskAction = keyof typeof TASK_ACTIONS;


// The spool (Task 2c-8): GET for any caller; apply and reject USER only, both
// delete the request. Apply runs the CLI's command as the console uid and
// only on the bytes GET first listed for that id (SpoolSeen) and the user was
// sent (the sha256): an agent may rewrite the file at any time, and a request
// rewritten after it was listed is shown as changed and never applied.
const CHANGED = "the request changed after it was shown; reject it";
function registerSpoolRoutes(app: FastifyInstance, spool: NonNullable<Parameters<typeof registerCronApi>[1]["spool"]>, dataDir: string): void {
  const log = onceLog();
  const seen = new SpoolSeen();
  // The console's own cron ctx: the same CRON_DATA_DIR as the routes above.
  const ctx = spool.ctx ?? (() => cronCtx(process.cwd(), { env: { ...process.env, CRON_DATA_DIR: dataDir } }));
  type IdReq = FastifyRequest<{ Params: { id: string } }>;

  app.get("/api/cron/spool", async () => {
    if (spool.dir === null) return { requests: [] };
    const c = ctx();
    const requests: SpoolEntry[] = (await listSpool(spool.dir, log)).map((e) => ({
      ...e,
      ...(e.op === "add" || e.op === "edit" ? { cwd: effectiveCwd(e.spec, c) } : {}),
      ...(seen.note(e.id, e.sha256) ? { changed: true as const } : {}),
    }));
    return { requests };
  });

  app.post("/api/cron/spool/:id/apply", async (req: IdReq, reply: FastifyReply) => {
    const caller = await gateUser(spool.gate, req, reply);
    if (!caller) return reply;
    const { id } = req.params;
    if (!SPOOL_ID_RE.test(id)) return reply.code(400).send({ error: "bad id" });
    const sha256 = (req.body as { sha256?: unknown } | undefined)?.sha256;
    if (typeof sha256 !== "string") return reply.code(400).send({ error: "sha256 of the shown request is required" });
    if (spool.dir === null) return reply.code(404).send({ error: "no such request" });
    if (!seen.appliable(id, sha256)) return reply.code(409).send({ error: CHANGED });
    const entry = await takeSpool(spool.dir, id, sha256, log);
    if (entry === "missing") return reply.code(404).send({ error: "no such request" });
    if (entry === "changed") {
      seen.markChanged(id);
      return reply.code(409).send({ error: CHANGED });
    }
    seen.forget(id);
    const r = await applySpool(entry, ctx());
    // by and the error carry agent-written text: quoted, one log line.
    console.log(`[cron] spool ${id} (${entry.op} ${entry.name}, by ${JSON.stringify(entry.by ?? "?")}) ${r.ok ? "applied" : `failed: ${JSON.stringify(r.error)}`} by ${caller.device ?? "user"}`);
    return r.ok ? { ok: true } : reply.code(422).send(r);
  });

  app.post("/api/cron/spool/:id/reject", async (req: IdReq, reply: FastifyReply) => {
    const caller = await gateUser(spool.gate, req, reply);
    if (!caller) return reply;
    const { id } = req.params;
    if (!SPOOL_ID_RE.test(id)) return reply.code(400).send({ error: "bad id" });
    if (spool.dir === null || !(await removeSpool(spool.dir, id, log))) return reply.code(404).send({ error: "no such request" });
    seen.forget(id);
    console.log(`[cron] spool ${id} rejected by ${caller.device ?? "user"}`);
    return { ok: true };
  });
}
