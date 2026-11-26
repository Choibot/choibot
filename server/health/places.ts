// server/health/places.ts — what fills the disk: the size of the big, known places (each folder
// of the work folder, each agent's own copy of a repo, the console's records, the tools'
// downloads), biggest first.
//
// A size is slow to read (every file is counted), so no request reads one: a run in the
// background measures the places one after the other with `du` at the lowest priority, each with
// a time limit, and the page gets the last answer with its time. One run at a time.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type Part = { name: string; bytes: number };
export type PlaceKind = "repo" | "folder" | "agent" | "closed" | "console" | "claude" | "downloads";
export type PlaceSize = {
  id: string;
  kind: PlaceKind;
  // "app" (a repo or a folder), the agent's title, or the fixed name of the place.
  name: string;
  // kind agent and closed: the repo that the copy is of.
  repo?: string;
  agentId?: string;
  // Null: the place was not measured (the time limit).
  bytes: number | null;
  // What is in it, where the user can know it: installed parts, build outputs, the Git history.
  parts: Part[];
  // The place is on the disk that holds the work folder.
  workDisk: boolean;
};

// repo: the name of the repo that the agent's copy is of.
export type AgentCopy = { id: string; title: string; worktree: string; repo?: string };

// One target of a run: a folder and how deep `du` reports its folders.
type Target = { path: string; depth: number };
// path → bytes, for each folder that du printed. Null: du gave no answer in time.
export type Du = (t: Target) => Promise<Map<string, number> | null>;

const BUILD_DIRS = new Set([".next", ".next-build", ".next-prev", ".next-failed", "dist", "build", "out", "target", ".turbo"]);
const INSTALLED_DIRS = new Set(["node_modules", ".venv", "vendor"]);

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const dev = (p: string): number | null => {
  try { return statSync(p).dev; } catch { return null; }
};

// The parts of a folder that the user knows by name, from du's sizes of its sub-folders.
function partsOf(dir: string, sizes: Map<string, number>, skip?: string): Part[] {
  let installed = 0;
  let built = 0;
  let history = 0;
  for (const [path, bytes] of sizes) {
    if (dirname(path) !== dir || path === skip) continue;
    const name = basename(path);
    if (INSTALLED_DIRS.has(name)) installed += bytes;
    else if (BUILD_DIRS.has(name)) built += bytes;
    else if (name === ".git") history += bytes;
  }
  return [
    { name: "installed parts", bytes: installed }, { name: "build outputs", bytes: built }, { name: "Git history", bytes: history },
  ].filter((p) => p.bytes > 0);
}

export type PlacesInput = {
  workDir: string;
  // The folder name of the agents' copies in a repo (".agent-worktrees"), or the one folder
  // (an absolute path) that holds the copies of every repo.
  worktreeDir: string;
  agents: AgentCopy[];
  // The console's own places: its name, and each folder (a folder that is not there is left out).
  fixed: { id: string; kind: PlaceKind; name: string; paths: string[] }[];
};

/** One run: every place, measured one after the other. */
export async function measure(input: PlacesInput, du: Du): Promise<PlaceSize[]> {
  const workDir = real(input.workDir);
  const workDev = dev(workDir);
  const onWorkDisk = (p: string): boolean => workDev !== null && dev(p) === workDev;
  const copies = new Map(input.agents.map((a) => [real(a.worktree), a]));
  const out: PlaceSize[] = [];
  const counted: string[] = [];

  let names: string[] = [];
  try { names = readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no work folder yet */ }
  for (const name of names) {
    const dir = join(workDir, name);
    counted.push(dir);
    const repo = existsSync(join(dir, ".git"));
    // Depth 3: <dir>/<the agents' copies>/<one copy>/<its installed parts>.
    const sizes = await du({ path: dir, depth: 3 });
    const wtRoot = join(dir, input.worktreeDir);
    const total = sizes?.get(dir) ?? null;
    const copiesBytes = sizes?.get(wtRoot) ?? 0;
    out.push({
      id: `dir:${name}`, kind: repo ? "repo" : "folder", name,
      bytes: total === null ? null : Math.max(0, total - copiesBytes),
      parts: sizes ? partsOf(dir, sizes, wtRoot) : [], workDisk: true,
    });
    if (!sizes) continue;
    for (const [path, bytes] of sizes) {
      if (dirname(path) !== wtRoot) continue;
      const agent = copies.get(path);
      out.push({
        id: `copy:${name}/${basename(path)}`, kind: agent ? "agent" : "closed", name: agent ? agent.title : basename(path), repo: name,
        ...(agent ? { agentId: agent.id } : {}), bytes, parts: partsOf(path, sizes), workDisk: true,
      });
    }
  }

  // The copies of every repo in one folder of their own.
  const wtRoot = isAbsolute(input.worktreeDir) ? real(input.worktreeDir) : null;
  if (wtRoot && existsSync(wtRoot) && !counted.some((c) => wtRoot === c || wtRoot.startsWith(c + sep))) {
    counted.push(wtRoot);
    const sizes = await du({ path: wtRoot, depth: 2 });
    for (const [path, bytes] of sizes ?? []) {
      if (dirname(path) !== wtRoot) continue;
      const agent = copies.get(path);
      out.push({
        id: `copy:${basename(path)}`, kind: agent ? "agent" : "closed", name: agent ? agent.title : basename(path),
        ...(agent?.repo ? { repo: agent.repo } : {}), ...(agent ? { agentId: agent.id } : {}), bytes, parts: partsOf(path, sizes as Map<string, number>), workDisk: onWorkDisk(path),
      });
    }
  }

  for (const f of input.fixed) {
    let bytes = 0;
    let found = false;
    let missed = false;
    let workDisk = false;
    for (const p of [...new Set(f.paths.map(real))]) {
      // A place inside a folder that was measured already (the console's checkout in the work
      // folder) is in that folder's size.
      if (!existsSync(p) || counted.some((c) => p === c || p.startsWith(c + sep))) continue;
      found = true;
      counted.push(p);
      workDisk ||= onWorkDisk(p);
      const sizes = await du({ path: p, depth: 0 });
      if (sizes?.has(p)) bytes += sizes.get(p) as number;
      else missed = true;
    }
    if (found) out.push({ id: f.id, kind: f.kind, name: f.name, bytes: missed && bytes === 0 ? null : bytes, parts: [], workDisk });
  }
  return out.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

// The first `name` on PATH that can run, else null.
function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch { /* not here */ }
  }
  return null;
}

export const DU_TIMEOUT_MS = 120_000;

// `du` lines: "<kilobytes>\t<path>".
export function parseDu(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    const kb = Number(line.slice(0, tab));
    if (tab > 0 && Number.isFinite(kb)) out.set(line.slice(tab + 1), kb * 1024);
  }
  return out;
}

// du at the lowest priority for the processor (nice) and, where the tool is there, for the disk
// (ionice idle). -x: it does not leave the disk of the folder. No shell: the path is one argument.
// A command at the lowest priority for the processor (nice) and, where the tool is there, for
// the disk (ionice idle).
export function lowPriority(argv: string[]): string[] {
  const ionice = onPath("ionice");
  return [...(ionice ? [ionice, "-c", "3"] : []), "nice", "-n", "19", ...argv];
}

export function systemDu(timeoutMs = DU_TIMEOUT_MS): Du {
  return (t) => new Promise((done) => {
    const argv = lowPriority(["du", "-k", "-x", "-d", String(t.depth), "--", t.path]);
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      // du ends with an error when it cannot read one sub-folder: its other sizes still count.
      const killed = !!err && ((err as { killed?: boolean }).killed === true || (err as { code?: unknown }).code === "ENOENT");
      const sizes = killed ? null : parseDu(stdout);
      done(sizes && sizes.has(t.path) ? sizes : null);
    });
  });
}

export type PlacesView = { rows: PlaceSize[]; checkedAt: number | null; checking: boolean };

export class Places {
  private rows: PlaceSize[] = [];
  private checkedAt: number | null = null;
  private run: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: {
    input: () => Promise<PlacesInput>;
    du?: Du;
    now?: () => number;
    log?: (s: string) => void;
  }) {}

  view(): PlacesView {
    return { rows: this.rows, checkedAt: this.checkedAt, checking: this.run !== null };
  }

  // A new run, unless one is in progress (the caller then gets that one).
  check(): Promise<void> {
    if (this.run) return this.run;
    const p = (async () => {
      try {
        this.rows = await measure(await this.d.input(), this.d.du ?? systemDu());
        this.checkedAt = (this.d.now ?? Date.now)();
      } catch (e) {
        (this.d.log ?? console.warn)(`[server] the disk sizes were not read: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().finally(() => { this.run = null; });
    this.run = p;
    return p;
  }

  // The first run soon after the start, then one each `everyMs`.
  start(everyMs: number, firstMs: number): void {
    if (this.timer) return;
    const first = setTimeout(() => {
      void this.check();
      this.timer = setInterval(() => { void this.check(); }, everyMs);
      this.timer.unref();
    }, firstMs);
    first.unref();
    this.timer = first;
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); }
    this.timer = null;
  }
}
