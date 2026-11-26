// bin/lib/cronspec.ts — cron job spec: types, validation, paths, atomic IO.
// Single source of truth shared by the CLI (bin/lib/cron.ts) and the server
// (server/cron/*). The runner (bin/cron-runner.mjs) is plain JS and instead
// receives CRON_DATA_DIR pre-resolved via its unit's Environment= line.
import { isAbsolute, join, dirname } from "node:path";
import { mkdir, rename, writeFile, readFile, rmdir, stat } from "node:fs/promises";
import { resolveAppDataDir } from "../../server/defaults.js";
import { names } from "../../server/names.mjs";
import { ITEM_ID_RE } from "../../server/chief/queue/store.js";

export type CronJobSpec = {
  name: string; schedule: string; prompt: string;
  workdir?: string; model?: string | null; effort?: string | null;
  // Claude login to run under (an account id, see server/agents/accounts.ts).
  // Absent: the console's default login (bin/lib/cron-login.mjs); "default": the box's own login.
  account?: string;
  timeoutMinutes: number; notify: "always" | "on-failure";
  enabled: boolean; createdAt: number;
};
export type CronRunResult = {
  startedAt: number; finishedAt: number; exitCode: number | null;
  ok: boolean; outputTail: string;
  // The task's own words of a run that finished (bin/lib/cron-result.mjs). Text of an agent:
  // server/cron/result.ts checks every field before the page gets it.
  result?: { state?: unknown; sentence?: unknown; refs?: unknown };
  // Why a run did not finish: one of RUN_WHYS.
  why?: unknown;
};

// Widened to readonly string[] (not `as const`) so callers can test arbitrary
// strings with .includes() without TS2345 on the literal-union element type.
export const RESERVED_NAMES: readonly string[] = ["console", "gate", "tunnel"];
export const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// argv-safe model id: no leading dash, no spaces/quotes.
const MODEL_RE = /^[a-z0-9][a-z0-9.:_-]*$/;
// Same as isAccountId() in server/agents/accounts.ts: it becomes a dir name.
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function resolveCronDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.CRON_DATA_DIR) return env.CRON_DATA_DIR;
  return join(resolveAppDataDir(env), "cron");
}

export function cronPaths(dataDir: string) {
  return {
    jobsDir: join(dataDir, "jobs"), runsDir: join(dataDir, "runs"),
    memoryDir: join(dataDir, "memory"), agentDir: join(dataDir, "agent"),
    tokenFile: join(dataDir, "notify-token"), lockDir: join(dataDir, ".lock"),
  };
}

// The tickets that the reader of a run linked to it (`cron note`): { "<startedAt>": "<ticket id>" }.
// Only the console writes it (server/cron/api.ts) and the runner never reads it, so a note
// changes nothing of the run itself. `cron rm` removes it with the runs.
export const runTicketsFile = (dataDir: string, name: string): string => join(cronPaths(dataDir).runsDir, name, "tickets.json");

/** The notes of a task, run start time → ticket id; what is not a time and a ticket id is left out. */
export async function readRunTickets(file: string): Promise<Map<number, string>> {
  const raw = await readJsonSafe<Record<string, unknown>>(file);
  const out = new Map<number, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (/^[0-9]{1,16}$/.test(k) && typeof v === "string" && ITEM_ID_RE.test(v)) out.set(Number(k), v);
  }
  return out;
}

export function jobUnitNames(name: string): { service: string; timer: string } {
  const prefix = names().cronUnitPrefix;
  return { service: `${prefix}${name}.service`, timer: `${prefix}${name}.timer` };
}

export function validateSpec(
  raw: unknown, opts: { workdirExists: (p: string) => boolean; now: number },
): { ok: true; spec: CronJobSpec } | { ok: false; error: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, error: "spec must be a JSON object" };
  const name = String(r.name ?? "");
  if (!NAME_RE.test(name)) return { ok: false, error: `invalid name ${JSON.stringify(name)}: need ${NAME_RE}` };
  if (RESERVED_NAMES.includes(name)) return { ok: false, error: `name "${name}" is reserved` };
  const schedule = String(r.schedule ?? "").trim();
  if (!schedule) return { ok: false, error: "schedule is required (systemd OnCalendar syntax)" };
  // The schedule is rendered into an OnCalendar= line; an embedded \n (or any
  // control char) would smuggle extra directives into the unit file.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(schedule)) return { ok: false, error: "schedule must not contain control characters" };
  const prompt = String(r.prompt ?? "").trim();
  if (!prompt) return { ok: false, error: "prompt is required" };
  // The runner invokes `claude -p <prompt>`; a leading dash would bind as a
  // CLI flag instead of the prompt argument.
  if (prompt.startsWith("-")) return { ok: false, error: 'prompt must not start with "-"' };
  let workdir: string | undefined;
  if (r.workdir != null && r.workdir !== "") {
    workdir = String(r.workdir);
    if (!isAbsolute(workdir)) return { ok: false, error: "workdir must be an absolute path" };
    if (!opts.workdirExists(workdir)) return { ok: false, error: `workdir does not exist: ${workdir}` };
  }
  let model: string | null = null;
  if (r.model != null && r.model !== "") {
    model = String(r.model);
    if (!MODEL_RE.test(model)) return { ok: false, error: `invalid model ${JSON.stringify(model)}` };
  }
  let effort: string | null = null;
  if (r.effort != null && r.effort !== "") {
    effort = String(r.effort);
    if (!EFFORTS.includes(effort)) return { ok: false, error: `effort must be one of ${EFFORTS.join(", ")}` };
  }
  let account: string | undefined;
  if (r.account != null && r.account !== "") {
    account = String(r.account);
    if (!ACCOUNT_RE.test(account)) return { ok: false, error: `invalid account ${JSON.stringify(account)}` };
  }
  const timeoutMinutes = r.timeoutMinutes == null ? 30 : Number(r.timeoutMinutes);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 720) {
    return { ok: false, error: "timeoutMinutes must be an integer 1..720" };
  }
  const notify = r.notify == null ? "always" : String(r.notify);
  if (notify !== "always" && notify !== "on-failure") return { ok: false, error: 'notify must be "always" or "on-failure"' };
  const enabled = r.enabled == null ? true : Boolean(r.enabled);
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : opts.now;
  return { ok: true, spec: {
    name, schedule, prompt, workdir, model, effort, ...(account ? { account } : {}),
    timeoutMinutes, notify, enabled, createdAt,
  } };
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function readJsonSafe<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

// Cross-process mutex via exclusive mkdir; stale (>60s) locks are broken so a
// crashed CLI can't wedge cron forever.
export async function withLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lock = cronPaths(dataDir).lockDir;
  await mkdir(dataDir, { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch {
      try { const s = await stat(lock); if (Date.now() - s.mtimeMs > 60_000) { await rmdir(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`cron lock busy: ${lock}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { await rmdir(lock).catch(() => {}); }
}
