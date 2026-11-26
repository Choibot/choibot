// server/chief/homes.ts — the agent homes of a hardened deployment (spec
// Appendix B, Phase 2c; ruling P5; overview decision 41, amended by ruling
// 2c-7-e). In a hardened deployment the persistent agents (fleet master, cron
// master, leads) keep their cwd, memory and photo inbox under
// AGENT_HOME_ROOT, outside the console-only 0700 data dirs; otherwise every
// path is today's.
//
// AGENT_HOME_ROOT is root-owned (or console-owned), group choibot, 3770
// (checklist C3): the agent uid can write in it, so an entry it made may be
// swapped at any time. The console never follows a symlink there
// (server/agents/nofollow.ts): a symlink in a home path makes the call fail,
// a symlink inside a home is left alone. A home dir (<root>/<kind>,
// <root>/leads/<area>) is console-owned 2750, so the agent uid enters it but
// cannot rename its agent/ (3770, sticky: no rename of the console's .git or
// .choibot-hooks.json in it), memory/ and inbox/ (2770, the agent's to write).
import { open, readdir, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { O_DIR, at, errCode, fdPath, openDirNoFollow, writeNew } from "../agents/nofollow.js";
import type { AgentRecord } from "../agents/store.js";
import { CHIEF_HOMES, chiefWanted } from "./chiefaccount.js";
import { hardenedDeployment } from "./hardened.js";
import { chiefFlag, type Env } from "./paths.js";

// AGENT_HOME_ROOT (trimmed) when it is an absolute path, else null.
function configuredRoot(env: Env): string | null {
  const root = env.AGENT_HOME_ROOT?.trim() ?? "";
  return root !== "" && isAbsolute(root) ? root : null;
}

// AGENT_HOME_ROOT (trimmed) in a hardened deployment when it is an absolute
// path, else null: no agent home outside a hardened deployment (rollback).
export function agentHomeRoot(env: Env = process.env): string | null {
  return hardenedDeployment(env) ? configuredRoot(env) : null;
}

export type PersistentKind = "fleet-master" | "cron-master" | "lead" | "coordinator";
export type PersistentHome = { agentDir: string; memoryDir: string; inboxDir?: string };

// One plain path segment: no "/", no leading dot (so never "." or "..").
const AREA_DIR = /^[\w-][\w.-]{0,63}$/;

// The root of the homes of `kind`: AGENT_HOME_ROOT, or for a persistent agent of the second
// account (chiefaccount.ts) AGENT_HOME_ROOT/chief, that account's own folder (root's, its group,
// 3770: strong-setup makes it; the console never does). The retired cron master stays.
export function persistentHomeRoot(kind: PersistentKind, env: Env = process.env): string | null {
  const root = agentHomeRoot(env);
  if (root === null || kind === "cron-master" || !chiefWanted(env)) return root;
  return join(root, CHIEF_HOMES);
}

// Hardened: <root>/fleet-master/{agent,memory,inbox}, <root>/cron-master/
// {agent,memory} or <root>/leads/<area>/{agent,memory}, with <root> of
// persistentHomeRoot. Otherwise `legacy` itself (today's paths, byte-identical).
export function persistentHome(
  kind: PersistentKind, o: { env?: Env; area?: string; legacy: PersistentHome },
): PersistentHome {
  const root = persistentHomeRoot(kind, o.env);
  if (root === null) return o.legacy;
  if (kind === "lead") {
    if (o.area === undefined || !AREA_DIR.test(o.area)) throw new Error(`lead area refused as a home dir: ${JSON.stringify(o.area)}`);
    const dir = join(root, "leads", o.area);
    return { agentDir: join(dir, "agent"), memoryDir: join(dir, "memory") };
  }
  const dir = join(root, kind);
  return {
    agentDir: join(dir, "agent"), memoryDir: join(dir, "memory"),
    ...(kind === "fleet-master" ? { inboxDir: join(dir, "inbox") } : {}),
  };
}

// {cwd, worktree} when they differ from the home's agent dir, else null.
export function retargetRecord(rec: AgentRecord, home: { agentDir: string }): Partial<AgentRecord> | null {
  if (rec.cwd === home.agentDir && rec.worktree === home.agentDir) return null;
  return { cwd: home.agentDir, worktree: home.agentDir };
}

const isUnder = (path: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// The patch an ensure writes to an existing persistent agent's record before
// its resume (resumeAgent spawns in rec.cwd), or null for no write. `home` is
// what persistentHome gave. Hardened: into the home. Flag on but not hardened:
// back to the legacy home only for a record whose cwd is under
// AGENT_HOME_ROOT (rollback, checklist C10 keeps it set); with AGENT_HOME_ROOT
// unset too, a record outside the legacy home is left as is and logged. Flag
// off: never a write.
export function homeRecordPatch(
  rec: AgentRecord, home: { agentDir: string }, env: Env = process.env, log: (s: string) => void = (s) => console.warn(s),
): Partial<AgentRecord> | null {
  if (agentHomeRoot(env) !== null) return retargetRecord(rec, home);
  if (!chiefFlag(env)) return null;
  const cwd = rec.cwd ?? "";
  const root = configuredRoot(env);
  if (root !== null) return cwd !== "" && isUnder(cwd, root) ? retargetRecord(rec, home) : null;
  if (cwd !== home.agentDir) log(`[chief] ${rec.id} cwd ${cwd} is outside the legacy home; set AGENT_HOME_ROOT to move it back`);
  return null;
}

// A hardened deployment with no usable AGENT_HOME_ROOT keeps the legacy
// homes, which sit in the console's 0700 data dirs: the helper refuses them as
// an agent cwd. One line per ensure says so.
export function warnLegacyHome(id: string, env: Env = process.env, log: (s: string) => void = (s) => console.warn(s)): void {
  if (hardenedDeployment(env) && configuredRoot(env) === null) {
    log(`[chief] ${id}: CHIEF_AGENT_UID is set but AGENT_HOME_ROOT is unset or not absolute; it keeps its legacy home, which the agent uid cannot use (set AGENT_HOME_ROOT)`);
  }
}

// ---- no-follow file operations under AGENT_HOME_ROOT ------------------------

const HOME_MODE = 0o2750;
const DIR_MODE = 0o2770;
// S1: a home's agent/ (the agent's cwd) is also sticky, so the agent uid
// cannot rename or replace the console's .git or .choibot-hooks.json in it.
const AGENT_DIR_MODE = 0o3770;
const AGENT_DIR = "agent";
const FILE_MODE = 0o660;
// An entry that changed under the walk: gone, now a symlink or not a dir.
const VANISHED = new Set(["ENOENT", "ELOOP", "ENOTDIR"]);

const consoleUid = (): number => process.getuid?.() ?? -1;
const homeDirs = (mode: number) => ({ mode, parentMode: HOME_MODE });

// mkdir -p for a dir in a home, no symlink followed: the dir it makes gets
// `mode` (2770: the console's umask 022 would leave 2755, unwritable for the
// agent uid), a missing parent 2750 (a home dir).
export async function mkdirHome(dir: string, mode: number = DIR_MODE): Promise<void> {
  await (await openDirNoFollow(dir, homeDirs(mode))).close();
}

// A home dir, before anything goes in it and after: console-owned 2750, and
// each console-owned dir right in it 2770 (memory/, inbox/), agent/ 3770
// (sticky, S1). Nothing
// below those changes: files get their mode when the console writes them,
// and the masters' .git stays console-owned 0755/0644 (ruling 2c-7-b), so
// the console's git there never reads agent-written config. A home dir owned
// by another uid throws.
export async function ensureHomeModes(homeDir: string): Promise<void> {
  const fh = await openDirNoFollow(homeDir);
  try {
    const st = await fh.stat();
    if (st.uid !== consoleUid()) {
      throw new Error(`[chief] ${homeDir} is owned by uid ${st.uid}, not the console; move it away and the console makes it again`);
    }
    if ((st.mode & 0o7777) !== HOME_MODE) await fh.chmod(HOME_MODE);
    for (const name of await readdir(fdPath(fh))) {
      let child: FileHandle | undefined;
      try {
        child = await open(at(fh, name), O_DIR);
        const c = await child.stat();
        const want = name === AGENT_DIR ? AGENT_DIR_MODE : DIR_MODE;
        if (c.uid === consoleUid() && (c.mode & 0o7777) !== want) await child.chmod(want);
      } catch (e) {
        if (!VANISHED.has(errCode(e))) throw e;
      } finally {
        await child?.close();
      }
    }
  } finally {
    await fh.close();
  }
}

// First hardened launch: copies the legacy *.md files into the home's memory
// dir (made 2770 if missing) when that dir is empty, each copy a new file
// (never through a symlink) with mode 0660. "present": the dir already holds
// something, nothing is copied (the agent's memory wins); "none": no legacy
// *.md file. A file that appears in the dir during the copy is kept and
// logged, not overwritten.
export async function migrateMemory(
  from: string, to: string, log: (s: string) => void = (s) => console.warn(s),
): Promise<"copied" | "present" | "none"> {
  const dst = await openDirNoFollow(to, homeDirs(DIR_MODE));
  try {
    if ((await readdir(fdPath(dst))).length > 0) return "present";
    let names: string[];
    try {
      names = (await readdir(from, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    } catch (e) {
      if (errCode(e) === "ENOENT") return "none";
      throw e;
    }
    let copied = 0;
    for (const name of names) {
      try {
        await writeNew(dst, name, await readFile(join(from, name)), FILE_MODE);
        copied++;
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
        log(`[chief] memory ${name} already in ${to}; not copied`);
      }
    }
    return copied > 0 ? "copied" : names.length > 0 ? "present" : "none";
  } finally {
    await dst.close();
  }
}

// AGENT_HOME_ROOT/chief, open as `fh`: mode 3770 and not the group of AGENT_HOME_ROOT (the
// workers' group), else a [chief] error and no home is made (the strong check says the same).
async function assertChiefHomes(fh: FileHandle, root: string): Promise<void> {
  const st = await fh.stat();
  const shared = await stat(dirname(root));
  if ((st.mode & 0o7777) !== 0o3770 || st.gid === shared.gid) {
    throw new Error(`[chief] the persistent homes folder ${root} is not closed to the workers (mode ${(st.mode & 0o7777).toString(8)}, gid ${st.gid}; want 3770 and the persistent agents' group): run strong-setup`);
  }
}

// The second account's git-safe (deploy/choibot-agent-exec): its own git config names the agent
// folder of a home by its exact path (the console owns that repository; git refuses a repository
// of another account unless the reader names it). index.ts sets it with that account's helper.
let gitSafe: ((agentDir: string) => Promise<void>) | null = null;
export function setChiefGitSafe(fn: ((agentDir: string) => Promise<void>) | null): void { gitSafe = fn; }

// Makes a persistent agent's home (hardened): root (AGENT_HOME_ROOT) must
// exist (checklist C3: root-owned, group choibot, 3770, made by the user), then the home dir
// (refused when another uid owns it), its agent dir, the memory copied once,
// initRepo (the masters' git init) and the modes. Returns migrateMemory's.
export async function prepareHome(
  root: string, home: PersistentHome, legacyMemoryDir: string, initRepo: () => Promise<void>,
): Promise<"copied" | "present" | "none"> {
  const r = await openDirNoFollow(root);
  const chiefHome = chiefWanted() && root === join(agentHomeRoot() ?? "", CHIEF_HOMES);
  try {
    // The second account's homes folder must be closed to the workers before a token goes in.
    if (chiefHome) await assertChiefHomes(r, root);
  } finally {
    await r.close();
  }
  const homeDir = dirname(home.agentDir);
  await mkdirHome(homeDir, HOME_MODE);
  await ensureHomeModes(homeDir);
  await mkdirHome(home.agentDir, AGENT_DIR_MODE);
  const memory = await migrateMemory(legacyMemoryDir, home.memoryDir);
  await initRepo();
  await ensureHomeModes(homeDir);
  // Its git in its own folder works only when its git config names that folder. A failure is not
  // fatal: the agent starts, and its git there says "dubious ownership".
  if (chiefHome) {
    try {
      if (!gitSafe) throw new Error("no helper of the second account");
      await gitSafe(home.agentDir);
    } catch (e) {
      console.warn(`[chief] ${home.agentDir} is not named safe in the second account's git config (${(e as Error).message}): its git there says "dubious ownership"`);
    }
  }
  return memory;
}

// Writes <dir>/<name> in a home (the fleet master's photo inbox): dir made as
// mkdirHome does, an old entry of that name removed (a symlink is removed,
// never followed), the file created new, mode 0660. Returns its path.
export async function writeHomeFile(dir: string, name: string, data: Uint8Array): Promise<string> {
  if (name.includes("/") || name === "." || name === "..") throw new Error(`home file name refused: ${name}`);
  const d = await openDirNoFollow(dir, homeDirs(DIR_MODE));
  try {
    try { await unlink(at(d, name)); } catch (e) { if (errCode(e) !== "ENOENT") throw e; }
    await writeNew(d, name, data, FILE_MODE);
  } finally {
    await d.close();
  }
  return join(dir, name);
}
