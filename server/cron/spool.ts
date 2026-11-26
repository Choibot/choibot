// server/cron/spool.ts — cron changes from agents in a hardened deployment
// (Phase 2c Task 2c-8, overview decision 42, review B4). An agent cannot write
// CRON_DATA_DIR, and no agent-callable route may create a console-uid job (all
// agents share one uid), so `choibot cron add|edit|rm|enable|disable|run` in an
// agent writes a request into <AGENT_HOME_ROOT>/cron-spool (bin/lib/cron.ts);
// the user applies or rejects it in the console's Cron pane, and the console runs the
// CLI's own command as its uid.
//
// The spool dir is agent-writable: every file in it is untrusted input. Only
// <id>.json names are read, each opened with O_NOFOLLOW (and the dir walked
// without following a symlink, as homes.ts does), regular files with one link
// only, at most 64 KiB, and zod-checked; anything else is skipped and logged.
// A job runs as the console uid with every permission skipped, so in a
// hardened deployment its cwd may not be a dir an agent can write (ruling
// 2c-8-a; the runner also skips the cwd's project settings and MCP servers).
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  applyCronOp, SPOOL_ID_RE, SPOOL_MAX_BYTES, SPOOL_OPS, type CronCtx, type SpoolRequest,
} from "../../bin/lib/cron.js";
import { NAME_RE } from "../../bin/lib/cronspec.js";
import { at, errCode, fdPath, openDirNoFollow } from "../agents/nofollow.js";
import type { ChiefGate } from "../chief/gate.js";
import { hardenedDeployment } from "../chief/hardened.js";
import { agentHomeRoot, mkdirHome } from "../chief/homes.js";
import type { Env } from "../chief/paths.js";

export { spoolDir, type SpoolRequest } from "../../bin/lib/cron.js";

// A request as the routes and the Cron pane see it: the sha256 of its bytes
// is what the user approves (an agent can rewrite the file after it is shown).
// The GET route adds cwd (where an add or edit would run) and changed.
export type SpoolEntry = SpoolRequest & { sha256: string; cwd?: string; changed?: true };
type Log = (s: string) => void;
const warn: Log = (s) => console.warn(s);

const SPOOL_NAME = "cron-spool";
// Console-owned, group (the shared agent group, checklist C1/C3) rwx, setgid
// so each request file gets that group.
const SPOOL_MODE = 0o2770;
const O_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const BY_MAX = 128;
// The listing shows at most this many requests, the oldest by `at`.
export const SPOOL_LIST_MAX = 100;

const NEEDS_SPEC = new Set<string>(["add", "edit"]);
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const idTime = (id: string): number => Number(id.slice(0, id.indexOf("-")));
const Schema = z.object({
  id: z.string().regex(SPOOL_ID_RE),
  at: z.number().finite(),
  op: z.enum(SPOOL_OPS),
  name: z.string().regex(NAME_RE),
  spec: z.unknown().optional(),
  // eslint-disable-next-line no-control-regex
  by: z.string().max(BY_MAX).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict()
  // add and edit carry a spec, the name-only ops none: what the user sees is what runs.
  .refine((r) => NEEDS_SPEC.has(r.op) === (r.spec !== undefined), { message: "spec on the wrong op" })
  // The tab shows both names; they must be one job.
  .refine((r) => !NEEDS_SPEC.has(r.op) || (isPlainObject(r.spec) && r.spec.name === r.name), { message: "spec names another job" })
  // `at` is the id's time (the CLI writes both), so the oldest are found by name.
  .refine((r) => r.at === idTime(r.id), { message: "at is not the id's time" });

// The spool routes' config: only in a hardened deployment with the chief
// gate (ruling P4); dir null when AGENT_HOME_ROOT is unusable (no agent gets
// CHOIBOT_CRON_SPOOL then). Otherwise undefined and no route is registered.
export function spoolRoutes(gate: ChiefGate | undefined, env: Env = process.env): { gate: ChiefGate; dir: string | null } | undefined {
  if (!gate || !hardenedDeployment(env)) return undefined;
  const root = agentHomeRoot(env);
  return { gate, dir: root === null ? null : join(root, SPOOL_NAME) };
}

// Boot, hardened (ruling P11): <root>/cron-spool, made without following a
// symlink, console-owned 2770 (put back when changed). Not ensureHomeModes:
// that makes a home dir 2750, which the agent uid could not write into.
// root must exist (checklist C3). A spool owned by another uid throws.
export async function ensureSpoolDir(root: string): Promise<string> {
  await (await openDirNoFollow(root)).close();
  const dir = join(root, SPOOL_NAME);
  await mkdirHome(dir, SPOOL_MODE);
  const fh = await openDirNoFollow(dir);
  try {
    const st = await fh.stat();
    if (st.uid !== process.getuid?.()) {
      throw new Error(`[cron] ${dir} is owned by uid ${st.uid}, not the console; move it away and the console makes it again`);
    }
    if ((st.mode & 0o7777) !== SPOOL_MODE) await fh.chmod(SPOOL_MODE);
  } finally {
    await fh.close();
  }
  return dir;
}

// The spool dir, opened without following a symlink; null (logged unless it
// is simply missing) when it cannot be.
async function openSpool(dir: string, log: Log): Promise<FileHandle | null> {
  try {
    return await openDirNoFollow(dir);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!/ does not exist$/.test(text)) log(`[cron] spool ${dir}: ${text}`);
    return null;
  }
}

// Reads at most SPOOL_MAX_BYTES + 1 bytes from fh.
async function readCapped(fh: FileHandle): Promise<Buffer> {
  const buf = Buffer.alloc(SPOOL_MAX_BYTES + 1);
  let n = 0;
  while (n < buf.length) {
    const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
    if (bytesRead === 0) break;
    n += bytesRead;
  }
  return buf.subarray(0, n);
}

// One <id>.json in the open spool dir, or null (logged) when it is anything
// but a valid request.
async function readEntry(dirFh: FileHandle, file: string, log: Log): Promise<SpoolEntry | null> {
  const skip = (why: string): null => { log(`[cron] spool ${JSON.stringify(file)}: ${why}; skipped`); return null; };
  let fh: FileHandle;
  try {
    fh = await open(at(dirFh, file), O_READ);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return null; // applied or rejected meanwhile
    return skip(code === "ELOOP" ? "a symlink" : `cannot open (${code || String(e)})`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1) return skip("not a regular file with one link");
    if (st.size > SPOOL_MAX_BYTES) return skip("over 64 KiB");
    const bytes = await readCapped(fh);
    if (bytes.length > SPOOL_MAX_BYTES) return skip("over 64 KiB");
    let json: unknown;
    try { json = JSON.parse(bytes.toString("utf8")); } catch { return skip("not JSON"); }
    const p = Schema.safeParse(json);
    // Codes, paths and our own messages only, quoted: an unknown key's text
    // (agent-chosen) never reaches the log raw.
    if (!p.success) return skip(`not a request ${JSON.stringify(p.error.issues.map((i) => (i.code === "custom" ? i.message : [i.code, ...i.path].join(":"))))}`);
    if (`${p.data.id}.json` !== file) return skip("id differs from the file name");
    return { ...(p.data as SpoolRequest), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (e) {
    return skip(`cannot read (${errCode(e) || String(e)})`);
  } finally {
    await fh.close();
  }
}

const fileOf = (id: string) => `${id}.json`;
const isRequestFile = (f: string) => f.endsWith(".json") && SPOOL_ID_RE.test(f.slice(0, -5));

let overflowLogged = false;

// The valid requests, oldest first, at most SPOOL_LIST_MAX (an overflow is
// logged once per process). Files are read oldest name first and only until
// the list is full. A missing or unusable dir is empty.
export async function listSpool(dir: string, log: Log = warn): Promise<SpoolEntry[]> {
  const fh = await openSpool(dir, log);
  if (!fh) return [];
  try {
    const names: string[] = [];
    for (const f of await readdir(fdPath(fh))) {
      if (isRequestFile(f)) names.push(f);
      else if (!f.startsWith(".")) log(`[cron] spool ${JSON.stringify(f)}: not a request file name; skipped`); // .<id>.tmp: a write in progress
    }
    names.sort((a, b) => idTime(a) - idTime(b) || (a < b ? -1 : a > b ? 1 : 0));
    const out: SpoolEntry[] = [];
    let i = 0;
    for (; i < names.length && out.length < SPOOL_LIST_MAX; i++) {
      const e = await readEntry(fh, names[i], log);
      if (e) out.push(e);
    }
    if (i < names.length && !overflowLogged) {
      overflowLogged = true;
      log(`[cron] spool ${dir} holds more than ${SPOOL_LIST_MAX} requests; the Cron pane shows the ${SPOOL_LIST_MAX} oldest`);
    }
    return out;
  } finally {
    await fh.close();
  }
}

// unlink never follows a symlink. false when the name is gone.
async function unlinkIn(dirFh: FileHandle, file: string): Promise<boolean> {
  try {
    await unlink(at(dirFh, file));
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false;
    throw e;
  }
}

// What the GET route showed, per id: the first sha256 listed, and whether the
// bytes changed after that (sticky: written back to the first bytes, it stays
// changed). A changed request is never applied; the user rejects it. Ids
// leave on apply or reject, never because a file vanished (an agent could
// delete and rewrite one id); the oldest go past `max` ids.
export class SpoolSeen {
  private readonly seen = new Map<string, { sha256: string; changed: boolean }>();
  constructor(private readonly max = 10_000) {}

  // true when the entry's bytes differ from the first ones listed for its id.
  note(id: string, sha256: string): boolean {
    const s = this.seen.get(id);
    if (!s) {
      this.seen.set(id, { sha256, changed: false });
      if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
      return false;
    }
    if (s.sha256 !== sha256) s.changed = true;
    return s.changed;
  }
  // false when the id changed after it was listed, or sha256 is not what was listed.
  appliable(id: string, sha256: string): boolean {
    const s = this.seen.get(id);
    return !s || (!s.changed && s.sha256 === sha256);
  }
  markChanged(id: string): void {
    const s = this.seen.get(id);
    if (s) s.changed = true;
  }
  forget(id: string): void { this.seen.delete(id); }
}

// Apply's claim, in one open of the dir: the request whose bytes hash to
// sha256 (what the user was shown), deleted before it runs, so of two applies
// only the one whose delete wins gets it. "missing": no valid request (or
// applied already); "changed": the agent rewrote it since it was shown.
export async function takeSpool(dir: string, id: string, sha256: string, log: Log = warn): Promise<SpoolEntry | "missing" | "changed"> {
  if (!SPOOL_ID_RE.test(id)) return "missing";
  const fh = await openSpool(dir, log);
  if (!fh) return "missing";
  try {
    const entry = await readEntry(fh, fileOf(id), log);
    if (!entry) return "missing";
    if (entry.sha256 !== sha256) return "changed";
    return (await unlinkIn(fh, fileOf(id))) ? entry : "missing";
  } finally {
    await fh.close();
  }
}

// Reject: deletes the request, whatever the file is. false when it is not there.
export async function removeSpool(dir: string, id: string, log: Log = warn): Promise<boolean> {
  if (!SPOOL_ID_RE.test(id)) return false;
  const fh = await openSpool(dir, log);
  if (!fh) return false;
  try {
    return await unlinkIn(fh, fileOf(id));
  } finally {
    await fh.close();
  }
}

// Where an add or edit would run: the runner's cwd (bin/cron-runner.mjs,
// spec.workdir || WORKSPACE_DIR || the unit's WorkingDirectory, the repo).
export function effectiveCwd(spec: unknown, ctx: Pick<CronCtx, "env" | "repoDir">): string {
  const wd = isPlainObject(spec) ? spec.workdir : undefined;
  return typeof wd === "string" && wd !== "" ? wd : ctx.env.WORKSPACE_DIR || ctx.repoDir;
}

const within = (p: string, root: string): boolean => {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const real = async (p: string): Promise<string> => { try { return await realpath(p); } catch { return resolve(p); } };

// Hardened (ruling S3): why the real cwd is not a dir only the console uid
// can write, or null. The job runs there as the console uid with every
// permission skipped, so a dir someone else owns or can write could hold the
// files it acts on. The cron runner checks the same at run time
// (bin/lib/chief-cron.mjs hardenedCwdRefusal).
async function cwdOwnerProblem(cwd: string): Promise<string | null> {
  let st;
  try { st = await stat(await realpath(resolve(cwd))); } catch (e) {
    return `job cwd ${JSON.stringify(cwd)} is not a directory the console can use (${errCode(e)})`;
  }
  if (!st.isDirectory()) return `job cwd ${JSON.stringify(cwd)} is not a directory the console can use (ENOTDIR)`;
  const self = process.getuid?.() ?? -1;
  if (st.uid !== self) return `job cwd ${JSON.stringify(cwd)} is owned by uid ${st.uid}, not the console`;
  const mode = st.mode & 0o7777;
  if ((mode & 0o022) !== 0) {
    return `job cwd ${JSON.stringify(cwd)} mode ${mode.toString(8).padStart(4, "0")} lets a group or others write it: it would run their code as the console`;
  }
  return null;
}

// Hardened (ruling 2c-8-a): the reason a job may not run in cwd, or null.
// Refused: under AGENT_HOME_ROOT, under any .agent-worktrees dir, or under an
// absolute AGENT_WORKTREE_ROOT, by the path as given and by its real path;
// then (S3) any real cwd that is not a dir the console owns and no group or
// other can write.
export async function refusedCwd(cwd: string, env: Env): Promise<string | null> {
  if (!hardenedDeployment(env)) return null;
  const asked = resolve(cwd);
  const paths = [asked, await real(asked)];
  const roots: [string, string | null][] = [
    ["AGENT_HOME_ROOT", agentHomeRoot(env)],
    ["AGENT_WORKTREE_ROOT", env.AGENT_WORKTREE_ROOT && isAbsolute(env.AGENT_WORKTREE_ROOT) ? env.AGENT_WORKTREE_ROOT : null],
  ];
  const agentDir = (where: string) => `job cwd ${JSON.stringify(cwd)} is under ${where}, which agents can write: it would run their code as the console`;
  for (const [label, root] of roots) {
    if (root === null) continue;
    const rootPaths = [resolve(root), await real(root)];
    if (paths.some((p) => rootPaths.some((r) => within(p, r)))) return agentDir(label);
  }
  if (paths.some((p) => p.split(sep).includes(".agent-worktrees"))) return agentDir("a .agent-worktrees dir");
  return cwdOwnerProblem(cwd);
}

// Applies a request as the console uid: validateSpec, systemd-analyze, the
// spec write and the units, all through the CLI's own commands
// (bin/lib/cron.ts applyCronOp). Hardened, an add or edit whose cwd agents
// can write is refused first. A throw (cron lock busy, a write error) is an
// error result too.
export async function applySpool(req: SpoolRequest, ctx: CronCtx): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!NAME_RE.test(req.name)) return { ok: false, error: `invalid name ${JSON.stringify(req.name)}` };
  if (NEEDS_SPEC.has(req.op)) {
    if (!isPlainObject(req.spec)) return { ok: false, error: `${req.op} needs a spec object` };
    if (req.spec.name !== req.name) return { ok: false, error: `the spec names job ${JSON.stringify(req.spec.name)}, the request ${JSON.stringify(req.name)}` };
  }
  try {
    if (NEEDS_SPEC.has(req.op)) {
      const why = await refusedCwd(effectiveCwd(req.spec, ctx), ctx.env);
      if (why) return { ok: false, error: why };
    }
    return await applyCronOp(ctx, req.op, req.name, req.spec);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// A log that writes each distinct line once: the Cron pane polls the list.
export function onceLog(log: Log = warn, max = 1000): Log {
  const seen = new Set<string>();
  return (s) => {
    if (seen.has(s)) return;
    if (seen.size >= max) seen.clear();
    seen.add(s);
    log(s);
  };
}
