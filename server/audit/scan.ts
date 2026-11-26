// server/audit/scan.ts — the facts of the clean-up audit: what on the disk could be removed, found
// by CODE. It reads names, kinds, owners, sizes and times. It never reads the content of a file,
// never follows a link, never looks into a place that the Files tab refuses (files/wide.ts), and
// it changes nothing. (The one part that removes a thing, on the user's press, is ./remove.ts.)
//
// A candidate is a folder or a file that a tool can make again (a build output, installed parts,
// a tool's downloads, an old build of the console, temp files, an old log), a copy of a repo that
// no open agent uses, or a big file or old archive that only the user can judge. Each candidate
// has a `floor`: "check" means that no later step (the AI's words) may call it safe.
//
// A folder that a running program uses is never a candidate either (./temp.ts): "not changed for
// days" does not prove that it is dead.
//
// NEVER a candidate, whatever its size: a secret place or a private place (the refusal list), the
// console's own data and its running build, a repo itself or its Git history, the work folder of
// an agent that is open, a database or a volume folder, anything that another user owns.
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { whyRefused, type Wide } from "../files/wide.js";
import { NEVER_NAME, OUR_NAME, useFacts, useState, type UseDeps } from "./temp.js";

export type Kind = "build-output" | "installed-parts" | "tool-cache" | "old-build" | "unused-copy" | "closed-copy" | "temp" | "old-log" | "old-archive" | "big-file";
export type Group = "safe" | "check";

export type Candidate = {
  id: string;
  // The real path (it stays on the server) and the short path that the user reads ("~/work/shop/dist").
  path: string;
  where: string;
  kind: Kind;
  floor: Group;
  bytes: number;
  // Days since the last change of anything in it. Null: not known.
  ageDays: number | null;
  // The repo it is in, the tool that made it, the agent it was of.
  repo?: string;
  madeBy?: string;
  agent?: string;
  agentId?: string;
  // Not one thing but many small ones in `path` (old folders of the temp folder): how many, and
  // which ones: "ours" = made by ChoiBot's own tests and tools (by their names), "other" = all others.
  count?: number;
  bulk?: "ours" | "other";
  // Facts for the user, from code: "2 agents work in this repo", "has work that is not saved on GitHub".
  notes: string[];
};

// closed: the agent is closed but not deleted (its record is still there).
export type AgentRef = { id: string; title: string; repo: string; worktree: string; closed: boolean };

export type Measured = { bytes: number; newest: number | null };

// The output of a read-only git command in a folder (audit/api.ts auditGit runs it through runGit).
export type GitRun = (cwd: string, args: string[]) => Promise<string | null>;

export type ScanDeps = UseDeps & {
  wide: Wide;
  workDir: string;
  // The console's own checkout: only its old builds are candidates.
  checkout: string;
  agents: AgentRef[];
  tmpDirs: string[];
  uid: number;
  now: number;
  // The size of a folder and the time of its newest file (du, low priority). Null: no answer in time.
  measure: (path: string) => Promise<Measured | null>;
  // The same for each folder directly in `dir`, in ONE run (a temp folder can hold a hundred
  // thousand folders). `skip`: full paths that the run must not go into. Null: no answer in time.
  measureChildren: (dir: string, skip: string[]) => Promise<Map<string, Measured> | null>;
  // The output of a git command in a folder. Null: git gave an error.
  git: GitRun;
  // A smaller thing than this is not worth a row.
  minBytes?: number;
  archiveBytes?: number;
  bigBytes?: number;
  // The scan stops at this time (ms) and says that it is not complete.
  deadline?: number;
};

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60_000;
const MAX_CANDIDATES = 300;
const PROJECT_DEPTH = 3;
const TEMP_MIN_DAYS = 2;
export const TEMP_SAFE_DAYS = 7;
const LOG_MIN_DAYS = 14;
const ARCHIVE_MIN_DAYS = 30;
// More refused places than this directly in a temp folder: the folder is not measured.
const SKIP_MAX = 200;

// Names that say what a folder is with no other mark.
const BUILD_ALWAYS = new Set([".next", ".turbo", ".nuxt", ".svelte-kit", ".parcel-cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const BUILD_OF_NODE = new Set(["dist", "build", "out", "coverage"]);
const NODE_MARKS = ["package.json"];
const PYTHON_MARKS = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
// A database or a volume: never looked into, never a candidate.
const DATA_NAMES = new Set(["pgdata", "postgres", "postgresql", "postgres-data", "mysql", "mariadb", "mongodb", "mongo-data", "redis-data", "volumes", "docker-volumes", "data.ms"]);
const DATA_MARKS = ["PG_VERSION", "ibdata1", "mongod.lock", "WiredTiger"];
const DATA_FILE = /\.(sqlite3?|db|mdb|rdb|dump|sql)$/i;
const ARCHIVE = /\.(zip|tar|tgz|tar\.(gz|bz2|xz|zst)|7z|rar|iso|dmg|deb|rpm|AppImage)$/i;
const LOG_FILE = /\.log(\.\d+)?(\.gz)?$/i;
// A child of ~/.cache whose name is a known tool: the tool downloads or builds it again.
const KNOWN_CACHES = new Set(["pnpm", "pip", "yarn", "ms-playwright", "puppeteer", "node-gyp", "go-build", "uv", "typescript", "Cypress", "electron", "turbo", "bun", "deno", "pre-commit", "npm"]);
// More download folders of tools under the home folder: [path, tool, a note].
const TOOL_STORES: [string, string, string?][] = [
  [".npm/_cacache", "npm"], [".npm/_npx", "npx"], [".local/share/pnpm/store", "pnpm", "the installed parts of your repos share files with it: less space than this can come back"],
  [".cargo/registry", "cargo"], [".bun/install/cache", "bun"], ["go/pkg/mod", "go"], [".gradle/caches", "gradle"], [".m2/repository", "maven"],
];

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir === sep ? sep : dir + sep);
const real = (p: string): Promise<string> => realpath(p).catch(() => p);

// What git says about a folder in a folder of copies:
//   saved    a copy (a git worktree) of a repo, with no changed file and no commit that is on no remote
//   unsaved  a copy with a changed file or such a commit, or git gave an error (not known = unsaved)
//   own-repo a full repo of its own (a clone): its other branches cannot be checked from here
//   plain    git does not know the folder (a left-over with no repo in it)
// --no-optional-locks: `git status` then does not write the index of the copy (the audit
// changes nothing).
export type CopyState = { state: "saved" | "unsaved" | "own-repo" | "plain"; repo?: string };
export async function copyState(copy: string, git: GitRun): Promise<CopyState> {
  const top = await git(copy, ["rev-parse", "--show-toplevel"]);
  if (top === null || top.trim() !== copy) return { state: "plain" };
  const common = (await git(copy, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim();
  if (!common) return { state: "unsaved" };
  if (common === join(copy, ".git")) return { state: "own-repo" };
  const dirty = await git(copy, ["--no-optional-locks", "status", "--porcelain"]);
  if (dirty === null || dirty.trim() !== "") return { state: "unsaved" };
  const ahead = await git(copy, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  if (ahead === null || Number(ahead.trim()) !== 0) return { state: "unsaved" };
  return basename(common) === ".git" ? { state: "saved", repo: dirname(common) } : { state: "unsaved" };
}
// The note of a copy that is not "saved", for the row.
export const UNSAVED = "has work that is not saved on GitHub";
export const LOCKED = "holds a lock file: a program can still use it";
export const OWN_REPO = "is a full repo of its own: its branches cannot be checked from here";
export const PLAIN = "is a folder that Git does not know";
export const copyNote = (c: CopyState): string[] => (c.state === "unsaved" ? [UNSAVED] : c.state === "own-repo" ? [OWN_REPO] : c.state === "plain" ? [PLAIN] : []);

export type ScanResult = { candidates: Candidate[]; partial: boolean };

export async function scan(d: ScanDeps): Promise<ScanResult> {
  const minBytes = d.minBytes ?? 10 * MB;
  const home = d.wide.home;
  const workDir = await real(d.workDir);
  const checkout = await real(d.checkout);
  const found: Omit<Candidate, "id">[] = [];
  const taken: string[] = [];
  let partial = false;
  // Out of time: the scan stops. (A part that was left out for another cause does not stop the rest.)
  let timedOut = false;
  const late = (): boolean => { if (d.deadline !== undefined && Date.now() > d.deadline) timedOut = partial = true; return timedOut; };

  // What the running programs of this user have open or work in. Not known: no temp folder is
  // looked at, and the list says that it is not complete.
  const used = d.inUse();
  const busy = (p: string): boolean => (used ?? []).some((u) => within(u, p));

  const whereOf = (p: string): string => (home !== sep && within(p, home) ? `~${p.slice(home.length)}` : p);
  const ageOf = (newest: number | null): number | null => (newest === null ? null : Math.max(0, Math.floor((d.now - newest) / DAY)));

  // An entry that the audit may look at: this user's, not a link, not a refused or private place.
  async function mine(p: string): Promise<{ dir: boolean; file: boolean; bytes: number; mtime: number } | null> {
    if (whyRefused(p, d.wide)) return null;
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || st.uid !== d.uid) return null;
      return { dir: st.isDirectory(), file: st.isFile(), bytes: st.blocks * 512, mtime: st.mtimeMs };
    } catch { return null; }
  }
  const list = async (dir: string): Promise<Dirent[]> => {
    try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
  };

  // A folder as a candidate, when it is big enough and not inside one that was taken.
  // known: its size, when a run for the folder above gave it.
  async function addDir(path: string, c: Pick<Candidate, "kind" | "floor" | "notes"> & Partial<Candidate>, o: { minDays?: number; known?: Measured } = {}): Promise<void> {
    if (late() || found.length >= MAX_CANDIDATES || taken.some((t) => within(path, t)) || busy(path)) return;
    const m = await mine(path);
    if (!m?.dir) return;
    const size = o.known ?? await d.measure(path);
    if (!size || size.bytes < minBytes) return;
    const ageDays = ageOf(size.newest);
    if (o.minDays !== undefined && (ageDays === null || ageDays < o.minDays)) return;
    taken.push(path);
    found.push({ ...c, path, where: whereOf(path), bytes: size.bytes, ageDays });
  }

  async function addFile(path: string, c: Pick<Candidate, "kind" | "floor" | "notes"> & Partial<Candidate>, o: { min: number; minDays: number }): Promise<void> {
    if (found.length >= MAX_CANDIDATES || taken.some((t) => within(path, t)) || busy(path)) return;
    const m = await mine(path);
    if (!m?.file || m.bytes < o.min) return;
    const ageDays = ageOf(m.mtime);
    if (ageDays === null || ageDays < o.minDays) return;
    found.push({ ...c, path, where: whereOf(path), bytes: m.bytes, ageDays });
  }

  // The build outputs and the installed parts of one project folder (a repo, or a copy that no
  // agent uses is taken whole before this is asked).
  async function project(root: string, repo: string, usedBy: number): Promise<void> {
    const queue: [string, number][] = [[root, 0]];
    while (queue.length && !late()) {
      const [dir, depth] = queue.shift() as [string, number];
      const entries = await list(dir);
      const names = new Set(entries.map((e) => e.name));
      const has = (marks: string[]) => marks.some((m) => names.has(m));
      if (dir !== root && has(DATA_MARKS)) continue;
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name);
        if (e.name === ".git" || e.name === d.wide.worktreeName || DATA_NAMES.has(e.name) || within(checkout, p)) continue;
        const used = usedBy > 0 ? [`${usedBy} ${usedBy === 1 ? "agent works" : "agents work"} in this repo`] : [];
        if ((e.name === "node_modules" && has(NODE_MARKS)) || ((e.name === ".venv" || e.name === "venv") && has(PYTHON_MARKS))) {
          await addDir(p, { kind: "installed-parts", floor: usedBy > 0 ? "check" : "safe", repo, madeBy: e.name === "node_modules" ? "the package installer" : "Python", notes: used });
        } else if (BUILD_ALWAYS.has(e.name) || (BUILD_OF_NODE.has(e.name) && has(NODE_MARKS)) || (e.name === "target" && names.has("Cargo.toml"))) {
          await addDir(p, { kind: "build-output", floor: "safe", repo, madeBy: "a build", notes: used });
        } else if (depth < PROJECT_DEPTH) {
          queue.push([p, depth + 1]);
        }
      }
    }
  }

  // One folder of copies: each copy is of an open agent (never a candidate), of a closed agent, or of no agent.
  async function copies(root: string, repoOf: (a: AgentRef | undefined) => string | undefined): Promise<void> {
    const byPath = new Map<string, AgentRef>();
    for (const a of d.agents) byPath.set(await real(a.worktree), a);
    const openNames = d.agents.filter((a) => !a.closed).map((a) => basename(a.worktree));
    for (const e of await list(root)) {
      if (late()) return;
      if (!e.isDirectory()) continue;
      const p = join(root, e.name);
      const agent = byPath.get(p);
      // The folder of an open agent, and a second copy that it made beside it ("<its folder>-b").
      if ((agent && !agent.closed) || openNames.some((n) => e.name.startsWith(n))) continue;
      if (!(await mine(p))?.dir) continue;
      const notes = copyNote(await copyState(p, d.git));
      const repo = repoOf(agent);
      if (agent) await addDir(p, { kind: "closed-copy", floor: "check", repo, agent: agent.title, agentId: agent.id, notes });
      else await addDir(p, { kind: "unused-copy", floor: notes.length ? "check" : "safe", repo, notes });
    }
  }

  // 1. The console's own checkout: only a build that failed its check at a deploy.
  // (.next-prev is the build that a deploy goes back to: never a candidate.)
  await addDir(join(checkout, ".next-failed"), { kind: "old-build", floor: "safe", madeBy: "ChoiBot", notes: [] });

  // 2. The work folder: the copies first (a copy is taken whole), then each repo's own outputs.
  const tops = (await list(workDir)).filter((e) => e.isDirectory()).map((e) => join(workDir, e.name));
  const openRepos = new Map<string, number>();
  for (const a of d.agents) if (!a.closed) { const r = await real(a.repo); openRepos.set(r, (openRepos.get(r) ?? 0) + 1); }
  for (const top of tops) await copies(join(top, d.wide.worktreeName), () => basename(top));
  if (d.wide.worktreeRoot) await copies(d.wide.worktreeRoot, (a) => (a ? basename(a.repo) : undefined));
  for (const top of tops) {
    if (late()) break;
    if (!(await mine(top))?.dir) continue;
    if (top !== checkout) await project(top, basename(top), openRepos.get(top) ?? 0);
    for (const e of await list(top)) if (e.isFile() && LOG_FILE.test(e.name)) await addFile(join(top, e.name), { kind: "old-log", floor: "safe", repo: basename(top), notes: [] }, { min: minBytes, minDays: LOG_MIN_DAYS });
  }

  // 3. The downloads of tools under the home folder.
  for (const e of await list(join(home, ".cache"))) {
    if (e.isDirectory()) await addDir(join(home, ".cache", e.name), { kind: "tool-cache", floor: KNOWN_CACHES.has(e.name) ? "safe" : "check", madeBy: e.name, notes: [] });
  }
  for (const [rel, tool, note] of TOOL_STORES) await addDir(join(home, rel), { kind: "tool-cache", floor: "safe", madeBy: tool, notes: note ? [note] : [] });
  await addDir(join(home, ".npm", "_logs"), { kind: "old-log", floor: "safe", madeBy: "npm", notes: [] });

  // 4. Temp folders of this user that nothing changed for some days AND that no running program
  // uses (./temp.ts). One run measures every folder of a temp folder and one run finds the
  // sockets, pipes, pid files and lock files in it. A big folder is a row. The many small old
  // ones are two rows: the ones of ChoiBot's own tests and tools (by their names), and all others.
  const seenTmp = new Set<string>();
  for (const t of d.tmpDirs) {
    const tmp = await real(t);
    if (seenTmp.has(tmp) || late()) continue;
    seenTmp.add(tmp);
    if (used === null) { partial = true; continue; }
    const all = (await list(tmp)).filter((e) => e.isDirectory()).map((e) => join(tmp, e.name));
    if (all.length === 0) continue;
    // Not walked at all: a refused place, and a folder with a name that is never touched.
    const skip = all.filter((p) => whyRefused(p, d.wide) || NEVER_NAME.test(basename(p)));
    const dirs = all.filter((p) => !skip.includes(p));
    if (skip.length > SKIP_MAX) { partial = true; continue; }
    const facts = await useFacts(tmp, dirs, skip, d);
    const sizes = facts ? await d.measureChildren(tmp, skip) : null;
    if (!facts || !sizes) { partial = true; continue; }
    const small: { path: string; m: Measured; ours: boolean }[] = [];
    for (const p of dirs) {
      const m = sizes.get(p);
      const age = m ? ageOf(m.newest) : null;
      if (!m || age === null || age < TEMP_MIN_DAYS) continue;
      const state = useState(p, facts, { temp: true });
      if (state === "never") continue;
      const ours = OUR_NAME.test(basename(p));
      if (m.bytes >= minBytes) {
        // "Safe" only for a folder of ChoiBot's own tests and tools that holds no lock file.
        const safe = ours && state === "free" && age >= TEMP_SAFE_DAYS;
        await addDir(p, { kind: "temp", floor: safe ? "safe" : "check", madeBy: ours ? "ChoiBot's tests" : undefined, notes: state === "locked" ? [LOCKED] : [] }, { known: m });
      } else if (state === "free" && age >= TEMP_SAFE_DAYS) small.push({ path: p, m, ours });
    }
    // The small old ones: this user's only (a cheap check of each, some at a time).
    for (const bulk of ["ours", "other"] as const) {
      const part = small.filter((x) => x.ours === (bulk === "ours"));
      let bytes = 0;
      let count = 0;
      let newest = 0;
      for (let i = 0; i < part.length && !late(); i += 64) {
        const some = part.slice(i, i + 64);
        const ok = await Promise.all(some.map((x) => mine(x.path)));
        some.forEach((x, n) => { if (ok[n]?.dir) { bytes += x.m.bytes; count += 1; newest = Math.max(newest, x.m.newest ?? 0); } });
      }
      if (count > 1 && bytes >= minBytes && found.length < MAX_CANDIDATES) {
        found.push({
          kind: "temp", floor: bulk === "ours" ? "safe" : "check", notes: [], count, bulk, path: tmp, bytes, ageDays: ageOf(newest || null),
          ...(bulk === "ours" ? { madeBy: "ChoiBot's tests" } : {}),
          where: `${whereOf(tmp)}: ${count} small folders ${bulk === "ours" ? "made by test runs of ChoiBot" : "of other programs"}, not changed for ${TEMP_SAFE_DAYS} days or more`,
        });
      }
    }
  }

  // 5. Big files and old archives where a person puts files: only the user can judge them.
  for (const dir of [home, join(home, "Downloads"), workDir]) {
    for (const e of await list(dir)) {
      if (late()) break;
      if (!e.isFile() || DATA_FILE.test(e.name)) continue;
      const p = join(dir, e.name);
      if (LOG_FILE.test(e.name)) await addFile(p, { kind: "old-log", floor: "safe", notes: [] }, { min: minBytes, minDays: LOG_MIN_DAYS });
      else if (ARCHIVE.test(e.name)) await addFile(p, { kind: "old-archive", floor: "check", notes: [] }, { min: d.archiveBytes ?? 50 * MB, minDays: ARCHIVE_MIN_DAYS });
      else await addFile(p, { kind: "big-file", floor: "check", notes: [] }, { min: d.bigBytes ?? 200 * MB, minDays: 0 });
    }
  }

  found.sort((a, b) => b.bytes - a.bytes);
  return { candidates: found.map((c, i) => ({ ...c, id: `c${i + 1}` })), partial };
}
