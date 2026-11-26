// server/health/procs.ts — what uses the processor and the memory, under a name the user knows:
// an agent (every process of its session), the console, a build, else the program's name.
// Each process is in one group only: a process of an agent counts for the agent and for nothing
// else. Threads of the kernel are left out. One scan reads /proc/<pid>/stat of each process; the command line of a process is read one
// time, when the process is first seen. No process is started.
//
// An agent's processes are the tree under its session's dtach master (the socket name holds the
// agent id) and every member of the master's own systemd scope (a child that left the tree is
// still in the scope): the same rule as sessionTreePids (agents/terminal.ts), which stops them.
//
// A name is the program's name and, for a script runner, the script's file name. No other
// argument of a command line leaves this module: an argument can hold a token.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ProcStat = { pid: number; ppid: number; start: string; comm: string; ticks: number; rssPages: number };

// /proc/<pid>/stat. The name is in parentheses and can hold spaces and parentheses.
export function parseProcStat(pid: number, text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).split(" ");
  const ticks = Number(f[11]) + Number(f[12]); // user and system time
  const rssPages = Number(f[21]);
  const ppid = Number(f[1]);
  if (![ticks, rssPages, ppid].every((n) => Number.isFinite(n))) return null;
  return { pid, ppid, start: f[19] ?? "", comm: text.slice(open + 1, close), ticks, rssPages };
}

// Programs that run a script: the script's file name says what the process is.
const RUNNERS = new Set(["node", "nodejs", "bun", "deno", "tsx", "python", "python3", "ruby", "perl", "bash", "sh", "zsh", "dash", "java"]);
const NAME_MAX = 40;

export function programName(comm: string, argv: string[]): string {
  if (!argv[0]) return comm; // a process with no command line (it is gone, or it ended)
  // argv[0] can be a title that the program set ("next-server (v15.0.0)"): its first word.
  const prog = basename(argv[0].split(" ")[0]) || comm;
  let name = prog;
  if (RUNNERS.has(prog)) {
    const script = argv.slice(1).find((a) => a && !a.startsWith("-"));
    if (script) name = `${prog} ${basename(script)}`;
  }
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

// A process that builds code (its own command, not what it builds).
const BUILD = /(^|[/\s])(next(\.js)?\s+build|tsc|webpack|esbuild|vite\s+build|turbo|cargo|rustc|cc1(plus)?|make|gradle)(\s|$)/;
export const isBuild = (argv: string[]): boolean => BUILD.test(argv.slice(0, 4).join(" "));

// The dtach socket in a command line: [the socket file's name, without ".sock"], or null.
export function sessionOf(argv: string[]): string | null {
  if (!argv[0] || basename(argv[0]) !== "dtach") return null;
  const sock = argv.find((a) => a.endsWith(".sock"));
  return sock ? basename(sock, ".sock") : null;
}

export type Group = {
  kind: "agent" | "console" | "build" | "program";
  // kind "agent": the agent's id.
  agentId?: string;
  // kind "program": the program's name. The caller names the other kinds.
  name: string;
  // Share of the whole server (all cores), 0 to 100, since the scan before.
  cpu: number;
  // Memory in use (resident), bytes.
  mem: number;
  procs: number;
};

// kernel: a thread of the kernel (no command line, a child of kthreadd): not a program of the user.
type Info = { start: string; name: string; session: string | null; build: boolean; kernel: boolean };
const KTHREADD = 2;

export class ProcScan {
  private readonly procRoot: string;
  private readonly cgroupRoot: string;
  private readonly selfPid: number;
  private readonly pageSize: number;
  private readonly info = new Map<number, Info>();
  private prev = new Map<number, { start: string; ticks: number }>();
  private first = true;

  constructor(o: { procRoot?: string; cgroupRoot?: string; selfPid?: number; pageSize?: number } = {}) {
    this.procRoot = o.procRoot ?? "/proc";
    this.cgroupRoot = o.cgroupRoot ?? "/sys/fs/cgroup";
    this.selfPid = o.selfPid ?? process.pid;
    this.pageSize = o.pageSize ?? pageSize(this.procRoot);
  }

  private infoOf(p: ProcStat): Info {
    const known = this.info.get(p.pid);
    if (known && known.start === p.start) return known;
    let argv: string[] = [];
    try { argv = readFileSync(join(this.procRoot, String(p.pid), "cmdline"), "utf8").split("\0"); } catch { /* gone, or not ours to read */ }
    const kernel = !argv[0] && (p.pid === KTHREADD || p.ppid === KTHREADD);
    const i: Info = { start: p.start, name: programName(p.comm, argv), session: sessionOf(argv), build: isBuild(argv), kernel };
    this.info.set(p.pid, i);
    return i;
  }

  // The members of the systemd scope of a session's master, when it has its own.
  private scopeMembers(pid: number): number[] {
    try {
      const line = readFileSync(join(this.procRoot, String(pid), "cgroup"), "utf8").split("\n").find((l) => l.startsWith("0::"));
      const path = line?.slice(3).trim() ?? "";
      if (!/\/run-[^/]+\.scope$/.test(path)) return [];
      const members = readFileSync(join(this.cgroupRoot, path, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
      return members.includes(this.selfPid) ? [] : members;
    } catch { return []; }
  }

  /**
   * One scan. sessions: socket name → agent id, for the agents of the console. totalTicks: the
   * clock ticks of all cores since the scan before (the same clock as a process's own ticks).
   */
  scan(sessions: Map<string, string>, totalTicks: number): Group[] {
    let pids: number[];
    try { pids = readdirSync(this.procRoot).filter((d) => /^\d+$/.test(d)).map(Number); } catch { return []; }
    const procs = new Map<number, ProcStat>();
    for (const pid of pids) {
      let text: string;
      try { text = readFileSync(join(this.procRoot, String(pid), "stat"), "utf8"); } catch { continue; }
      const p = parseProcStat(pid, text);
      if (p) procs.set(pid, p);
    }
    for (const pid of [...this.info.keys()]) if (!procs.has(pid)) this.info.delete(pid);

    // Each process's agent: the session master above it, else the scope it is in.
    const agentOf = new Map<number, string | null>();
    const findAgent = (pid: number): string | null => {
      const chain: number[] = [];
      let at = pid;
      let found: string | null = null;
      while (at > 1 && chain.length < 64) {
        const p = procs.get(at);
        if (!p) break;
        if (agentOf.has(at)) { found = agentOf.get(at) ?? null; break; }
        chain.push(at);
        const session = this.infoOf(p).session;
        const id = session === null ? undefined : sessions.get(session);
        if (id !== undefined) { found = id; break; }
        at = p.ppid;
      }
      for (const c of chain) agentOf.set(c, found);
      return found;
    };
    for (const p of procs.values()) {
      const session = this.infoOf(p).session;
      const id = session === null ? undefined : sessions.get(session);
      if (id === undefined) continue;
      for (const m of this.scopeMembers(p.pid)) if (m !== this.selfPid && procs.has(m)) agentOf.set(m, id);
    }

    // Not an agent's: a build (the process or one above it builds), else the console (this
    // process and what it started), else the program itself.
    const restOf = new Map<number, "build" | "console" | null>();
    const findRest = (pid: number): "build" | "console" | null => {
      const chain: number[] = [];
      let at = pid;
      let found: "build" | "console" | null = null;
      while (at > 1 && chain.length < 64) {
        const p = procs.get(at);
        if (!p) break;
        if (restOf.has(at)) { found = restOf.get(at) ?? null; break; }
        chain.push(at);
        if (this.infoOf(p).build) { found = "build"; break; }
        if (at === this.selfPid) { found = "console"; break; }
        at = p.ppid;
      }
      for (const c of chain) restOf.set(c, found);
      return found;
    };

    const groups = new Map<string, Group & { ticks: number }>();
    const next = new Map<number, { start: string; ticks: number }>();
    for (const p of procs.values()) {
      next.set(p.pid, { start: p.start, ticks: p.ticks });
      if (this.infoOf(p).kernel) continue; // the lists are of programs
      const before = this.prev.get(p.pid);
      // A process that was not there at the scan before is new: all its time is of this interval.
      const used = this.first ? 0 : before && before.start === p.start ? Math.max(0, p.ticks - before.ticks) : p.ticks;
      const agentId = findAgent(p.pid);
      const rest = agentId === null ? findRest(p.pid) : null;
      const name = this.infoOf(p).name;
      const key = agentId !== null ? `agent\n${agentId}` : rest ?? `program\n${name}`;
      let g = groups.get(key);
      if (!g) {
        g = { kind: agentId !== null ? "agent" : rest ?? "program", ...(agentId !== null ? { agentId } : {}), name: agentId !== null || rest ? "" : name, cpu: 0, mem: 0, procs: 0, ticks: 0 };
        groups.set(key, g);
      }
      g.ticks += used;
      g.mem += p.rssPages * this.pageSize;
      g.procs += 1;
    }
    this.prev = next;
    this.first = false;
    return [...groups.values()].map(({ ticks, ...g }) => ({ ...g, cpu: totalTicks > 0 ? Math.min(100, (ticks / totalTicks) * 100) : 0 }));
  }
}

// The size of a memory page: this process's own memory in bytes over the same in pages.
function pageSize(procRoot: string): number {
  try {
    const pages = Number(readFileSync(join(procRoot, "self", "statm"), "utf8").split(" ")[1]);
    const guess = process.memoryUsage.rss() / pages;
    return [4096, 16384, 65536].reduce((a, b) => (Math.abs(b - guess) < Math.abs(a - guess) ? b : a));
  } catch { return 4096; }
}
