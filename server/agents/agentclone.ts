// server/agents/agentclone.ts — design B of strong protection: each agent works in a repo of its
// OWN, made and changed only by the agents' account; the console's repo of the workspace stays the
// console's alone (agents read it). The only contact is git's transport. Two rules:
//   - the console's git never writes in a place where an agent can write;
//   - the console never opens a path inside a folder that an agent can write (O_NOFOLLOW guards
//     only the last part of a path): such a file is read AS the agent, through the helper.
// The folders under AGENT_HOME_ROOT (made by strong-setup, as root, before any agent ran):
//   clones/    root:<group> 3770: each agent's clone, clones/<id>, made by the helper as the agent;
//   uploads/   <console user>:<group> 2750: the files that the user gives an agent;
//   settings/  <console user>:<group> 2750: the hook settings file of each agent (it carries the
//              agent's hook token: a mistake guard, as before).
// The console checks its own two folders (lstat: its owner, a real folder, no group or other
// write) before each use, and refuses else.
import { execFile } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isAgentId } from "../ids.js";
import { agentHomeRoot } from "../chief/homes.js";
import { runGit } from "./git.js";
import { helperArgv, helperEnv, type AgentExec } from "./terminal.js";
import { changedFilesOf, gitStateOf, plainRefName, validBranchName, type ChangedFile, type GitState } from "./worktree.js";

type Env = Record<string, string | undefined>;
export type Run = (bin: string, args: string[], o: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: "buffer" }, cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => unknown;

// The helper of a strong deployment whose probe passed (index.ts sets it). Null: basic mode, or
// strong with no helper: agents then work in worktrees, as before.
let cloneExec: AgentExec | null = null;
// `run`: a test's fake for the helper calls (never set in production).
let cloneRun: Run | undefined;
export function setCloneExec(x: AgentExec | null, run?: Run): void { cloneExec = x; cloneRun = run; reads.clear(); }
export function agentClones(): AgentExec | null { return cloneExec; }

export type CloneFolders = { clones: string; uploads: string; settings: string };
export function cloneFolders(env: Env = process.env): CloneFolders | null {
  const root = agentHomeRoot(env);
  return root === null ? null : { clones: join(root, "clones"), uploads: join(root, "uploads"), settings: join(root, "settings") };
}

export const clonePath = (f: CloneFolders, id: string): string => join(f.clones, id);

// This agent works in its own clone (strong protection, design B): the console runs no git and
// opens no path there. A fact of its record, set at spawn (no request sets it), never of this
// start of the console: with no helper, or another AGENT_HOME_ROOT, the agent still has its clone,
// and each action on it refuses (CLONE_NO_HELPER). Nothing falls back to the console's git.
export function isClone(rec: { clone?: boolean }): boolean {
  return rec.clone === true;
}

export const CLONE_NO_HELPER = "This agent works in its own copy of the repo, and the helper of strong protection is not ready. The console does nothing with the copy without it.";

// A Codex agent cannot work in its own clone in this version: its home would be a folder of the
// console's inside the clone. Spawn refuses it; the Codex paths refuse a clone.
export const CLONE_CLAUDE_ONLY = "With strong protection, only a Claude agent can work on a repo in this version.";

// The helper for an action on an agent's clone, or the refusal.
export function cloneExecOrRefuse(): AgentExec {
  if (!cloneExec) throw new Error(CLONE_NO_HELPER);
  return cloneExec;
}

// The console's own files of an agent with a clone: its hook settings file and its uploads. Each
// folder is checked first; a folder that is not the console's own is left as it is.
export async function removeCloneFiles(id: string, env: Env = process.env): Promise<void> {
  if (!isAgentId(id)) throw new Error("invalid agent id");
  const f = cloneFolders(env);
  if (!f) return;
  if ((await ownFolderProblem(f.settings)) === null) await rm(join(f.settings, `${id}.json`), { force: true });
  const up = join(f.uploads, id);
  if ((await ownFolderProblem(f.uploads)) === null && (await ownFolderProblem(up)) === null) await rm(up, { recursive: true, force: true });
}

// The refusal of a git action on an agent's own clone (the console's git never runs there). Git's
// ownership check alone is not enough: the agent can put a link to the console's own repo in place
// of its clone, and that one passes the check. The read-only views go through the helper's
// repo-read (below); the push and the PR through the console's own repo (part 3 of design B).
export const CLONE_NO_GIT = "With strong protection, the console does not change the agent's own copy. This action is not available yet.";

// Why a folder of the console's under AGENT_HOME_ROOT cannot be used, or null: it must be a real
// folder (not a link) of the console's user, with no group or other write. AGENT_HOME_ROOT is
// group-writable, so an agent could have made it first.
export async function ownFolderProblem(dir: string, uid: number = process.getuid?.() ?? -1): Promise<string | null> {
  let st;
  try { st = await lstat(dir); } catch { return `${dir} does not exist`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a folder`;
  if (st.uid !== uid) return `${dir} is not the console's (owner uid ${st.uid})`;
  if ((st.mode & 0o022) !== 0) return `${dir} is writable by its group or others`;
  return null;
}

// A new folder of the console's below one of its own (uploads/<id>): checked, then made 2750.
export async function ownSubfolder(parent: string, id: string): Promise<string> {
  if (!isAgentId(id)) throw new Error("invalid agent id");
  const why = await ownFolderProblem(parent);
  if (why) throw new Error(why);
  const dir = join(parent, id);
  await mkdir(dir, { mode: 0o2750 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const sub = await ownFolderProblem(dir);
  if (sub) throw new Error(sub);
  return dir;
}

const realRun: Run = (bin, args, o, cb) => execFile(bin, args, o, (err, stdout, stderr) => cb(err, stdout as Buffer, stderr as Buffer));

function call(x: AgentExec, verb: "repo-clone" | "repo-remove" | "repo-read" | "read-file", rest: string[], o: { timeoutMs: number; maxBytes: number; env?: Env; run?: Run }): Promise<Buffer> {
  const argv = helperArgv(x, verb, rest);
  return new Promise((resolve, reject) => {
    (o.run ?? cloneRun ?? realRun)(argv[0], argv.slice(1), { env: helperEnv(o.env ?? process.env) as unknown as NodeJS.ProcessEnv, timeout: o.timeoutMs, maxBuffer: o.maxBytes + 4096, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err) {
          // The helper's one reason line (its own words, never a file's content).
          const line = stderr.toString("utf8").trim().split("\n").pop()?.slice(0, 300) || err.message.split("\n")[0];
          return reject(new Error(line));
        }
        resolve(stdout);
      });
  });
}

// The agent's clone of the console's repo `repo`, on `branch` at `sha` (a commit of the console's
// repo). Returns the clone's folder.
export async function cloneForAgent(x: AgentExec, f: CloneFolders, repo: string, id: string, branch: string, sha: string, o: { env?: Env; run?: Run } = {}): Promise<string> {
  if (!isAgentId(id)) throw new Error("invalid agent id");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid start commit");
  await call(x, "repo-clone", [repo, id, branch, sha], { timeoutMs: 600_000, maxBytes: 4096, ...o });
  return clonePath(f, id);
}

export async function removeClone(x: AgentExec, id: string, o: { env?: Env; run?: Run } = {}): Promise<void> {
  if (!isAgentId(id)) throw new Error("invalid agent id");
  await call(x, "repo-remove", [id], { timeoutMs: 120_000, maxBytes: 4096, ...o });
}

// One file of an agent's folder, read as the agent user: a link in any part of its path leads only
// where that user may read. At most `maxBytes`.
export async function readAsAgent(x: AgentExec, path: string, maxBytes: number, o: { env?: Env; run?: Run } = {}): Promise<Buffer> {
  const out = await call(x, "read-file", [path, String(maxBytes)], { timeoutMs: 30_000, maxBytes, ...o });
  if (out.length > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
  return out;
}

// ---- repo-read: the read-only git views of an agent's own clone (B2) ----
// The helper runs fixed git commands as the agent in clones/<id>, against the console's base
// commit, and frames each output: "== <step> <exit> <bytes>\n", the bytes, "\n". Every byte is
// untrusted (the agent writes its repo and its git config): a frame of another shape ends the
// parse, a missing step counts as failed, and the outputs go through the same parsers as a
// worktree's (worktree.ts gitStateOf, changedFilesOf).
export type ReadStep = { code: number; out: string };
export function parseRead(buf: Buffer): Map<string, ReadStep> {
  const m = new Map<string, ReadStep>();
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0 || nl - i > 64) break;
    const head = /^== ([a-z]{1,20}) (\d{1,3}) (\d{1,9})$/.exec(buf.toString("utf8", i, nl));
    if (!head) break;
    const start = nl + 1;
    const size = Number(head[3]);
    if (start + size >= buf.length || buf[start + size] !== 10) break;
    if (!m.has(head[1])) m.set(head[1], { code: Number(head[2]), out: buf.toString("utf8", start, start + size) });
    i = start + size + 1;
  }
  return m;
}

// The most bytes of one answer: the helper caps a list step at 1 MB and the diff at 4 MB
// (REPO_READ_LIST_MAX, REPO_READ_DIFF_MAX); "state" has 7 steps, "changed" 4, "diff" 1.
const MB = 1024 * 1024;
const READ_MAX_BYTES = { state: 7 * MB + 4096, changed: 4 * MB + 4096, diff: 4 * MB + 4096 } as const;
// The step exit of an output above its cap.
const TOO_LARGE = 98;
export const CLONE_DIFF_TOO_LARGE = "The diff of the agent's copy is too large to show.";
const okOut = (m: Map<string, ReadStep>, step: string): string | null => {
  const s = m.get(step);
  return s && s.code === 0 ? s.out : null;
};

// Each answer is kept READ_KEEP_MS for (id, read, sha), and calls in that time share one run: the
// page polls these views and each run is one sudo line and up to 7 git commands. A failed run is
// not kept. A stop of the agent's turn drops its answers (dropCloneReads, the hook route).
const READ_KEEP_MS = 3000;
const reads = new Map<string, { done: number | null; p: Promise<Map<string, ReadStep>> }>();
export function dropCloneReads(id: string): void {
  for (const k of reads.keys()) if (k.startsWith(`${id}\0`)) reads.delete(k);
}

function readClone(x: AgentExec, id: string, what: "state" | "changed" | "diff", sha: string, o: { env?: Env; run?: Run }): Promise<Map<string, ReadStep>> {
  if (!isAgentId(id)) return Promise.reject(new Error("invalid agent id"));
  if (!/^[0-9a-f]{40}$/.test(sha)) return Promise.reject(new Error("invalid base commit"));
  const now = Date.now();
  for (const [k, e] of reads) if (e.done !== null && now - e.done >= READ_KEEP_MS) reads.delete(k);
  const key = `${id}\0${what}\0${sha}`;
  const hit = reads.get(key);
  if (hit) return hit.p;
  const entry: { done: number | null; p: Promise<Map<string, ReadStep>> } = { done: null, p: Promise.resolve(new Map()) };
  entry.p = call(x, "repo-read", [id, what, sha], { timeoutMs: 240_000, maxBytes: READ_MAX_BYTES[what], ...o }).then(
    (buf) => { entry.done = Date.now(); return parseRead(buf); },
    (e: unknown) => { if (reads.get(key) === entry) reads.delete(key); throw e; },
  );
  reads.set(key, entry);
  return entry.p;
}

type CloneRec = { id: string; worktree: string; branch: string; baseBranch: string };

// The git bar of an agent with its own clone. Any failure: the state with error (the bar says so).
export async function cloneGitState(x: AgentExec, rec: CloneRec, sha: string, o: { env?: Env; run?: Run } = {}): Promise<GitState> {
  let m = new Map<string, ReadStep>();
  try { m = await readClone(x, rec.id, "state", sha, o); } catch { /* every step failed */ }
  const t = (step: string) => okOut(m, step)?.trim() ?? null;
  return gitStateOf({
    head: t("head"), sha: t("sha"), aheadBehind: t("aheadbehind"),
    staged: t("staged"), unstaged: t("unstaged"), untracked: t("untracked"), stashes: t("stashes"),
  }, rec.branch, rec.baseBranch);
}

// The Changes rail of an agent with its own clone ([] on any failure, as for a worktree). New files
// get no line count here: the console opens no file in the clone.
export async function cloneChangedFiles(x: AgentExec, rec: CloneRec, sha: string, o: { env?: Env; run?: Run } = {}): Promise<ChangedFile[]> {
  try {
    const m = await readClone(x, rec.id, "changed", sha, o);
    const dirty = okOut(m, "dirty");
    const nameStatus = okOut(m, "namestatus");
    const untracked = okOut(m, "untracked");
    if (dirty === null || nameStatus === null || untracked === null) return [];
    return changedFilesOf(rec.worktree, { dirty, nameStatus, untracked, numstat: okOut(m, "numstat") });
  } catch {
    return [];
  }
}

// The review diff of an agent with its own clone (new files included).
export async function cloneDiff(x: AgentExec, rec: CloneRec, sha: string, o: { env?: Env; run?: Run } = {}): Promise<string> {
  const m = await readClone(x, rec.id, "diff", sha, o);
  if (m.get("diff")?.code === TOO_LARGE) throw new Error(CLONE_DIFF_TOO_LARGE);
  const d = okOut(m, "diff");
  if (d === null) throw new Error("The diff of the agent's copy could not be read.");
  return d;
}

// ---- part 3: the console's own repo fetches an agent's branch from its clone ----
// The console's repo (agents only read it) fetches refs/heads/<branch> of clones/<id> into
// refs/agents/<id>/<branch>: a name space of the console, never one of its branches. The helper runs
// upload-pack as the agent, in the agent's own repo (`--upload-pack`: git appends the clone's path,
// the helper checks it), and fetch.fsckObjects checks each object that the agent's repo sends. No
// git runs in the clone as the console, and nothing of the clone's config reaches the console's git.
// The address is a file:// URL, never a plain path: for a plain path git first checks whether it is
// a bundle file, and then reads that file itself as the console, with no upload-pack (an agent can
// put a bundle, or a link to one, at clones/<id>). The path holds only [A-Za-z0-9._/-] (strong-setup
// allows no other), so the URL needs no escape.
export const agentRefPrefix = (id: string): string => `refs/agents/${id}/`;
export const agentRef = (id: string, branch: string): string => `${agentRefPrefix(id)}${branch}`;
const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
// The longest fetch: the helper ends upload-pack after 300 s.
const FETCH_TIMEOUT_MS = 330_000;

export async function fetchAgentBranch(x: AgentExec, f: CloneFolders, repo: string, id: string, branch: string, o: { env?: Env } = {}): Promise<string> {
  if (!isAgentId(id)) throw new Error("invalid agent id");
  if (validBranchName(branch) === null || !plainRefName(branch)) throw new Error(`invalid branch: ${branch}`);
  const env = o.env ?? process.env;
  // The env of the fetch: no console secret (sudo resets the env in any case).
  const fetchEnv = { ...helperEnv(env), ...(env.PATH ? { PATH: env.PATH } : {}), ...(env.HOME ? { HOME: env.HOME } : {}) };
  const path = clonePath(f, id);
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("//")) throw new Error("the path of the agent's copy has a character that the console does not give git");
  const uploadPack = helperArgv(x, "upload-pack", [id]).map(shellQuote).join(" ");
  const ref = agentRef(id, branch);
  await runGit(repo, [
    "-C", repo, "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true",
    "fetch", "--no-tags", "--no-write-fetch-head", `--upload-pack=${uploadPack}`, `file://${path}`, `+refs/heads/${branch}:${ref}`,
  ], { env: fetchEnv as NodeJS.ProcessEnv, timeout: FETCH_TIMEOUT_MS }, repo);
  const { stdout } = await runGit(repo, ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], undefined, repo);
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("the fetched branch is not a commit");
  return sha;
}

// The console's refs of an agent (its fetched branch), gone when the agent is deleted.
export async function dropAgentRefs(repo: string, id: string): Promise<void> {
  if (!isAgentId(id)) return;
  const { stdout } = await runGit(repo, ["-C", repo, "for-each-ref", "--format=%(refname)", agentRefPrefix(id)], undefined, repo);
  for (const ref of stdout.split("\n").filter((r) => r.startsWith(agentRefPrefix(id)))) {
    await runGit(repo, ["-C", repo, "update-ref", "-d", ref], undefined, repo);
  }
}
