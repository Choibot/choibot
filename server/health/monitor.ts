// server/health/monitor.ts — the health of the server for the Server page: one sample each 15
// seconds (sys.ts, procs.ts), a short history in memory (history.ts), the warnings (warn.ts) and
// the disk sizes of the known places (places.ts). The sampler always runs: its cost is small and
// fixed (`costMs` in the view is the mean time of one sample).
import { DISPLAY_NAME } from "../brand.js";
import { History, COARSE_STEP_MS, type Point } from "./history.js";
import type { Places, PlacesView } from "./places.js";
import { ProcScan, type Group } from "./procs.js";
import { readDisks, readFacts, readSys, cpuPercent, type CpuTicks, type Disk, type Memory, type SysFacts, type SysSample } from "./sys.js";
import { CPU_WARN, levelOf, MEMORY_WARN, SWAP_WARN, warningsOf, type Level, type Top, type Warning } from "./warn.js";
import { percent, size } from "./words.js";

export const SAMPLE_MS = 15_000;
// A known place is named as the cause of a full disk from this share of the used space.
const CAUSE_SHARE = 0.1;
// Under this share of the used space, the known places do not explain the disk.
const OUTSIDE_SHARE = 0.5;
const TOP = 8;

// An agent as the page names it.
export type AgentName = { id: string; title: string; kind: "agent" | "lead" | "fleet-master" };
// A user of the processor or the memory, with its name.
export type Use = { kind: Group["kind"]; name: string; agentId?: string; cpu: number; mem: number; procs: number };

export type HealthView = {
  at: number;
  // The time of the first sample: the history starts there (a restart of the console empties it).
  since: number;
  facts: SysFacts;
  cores: number;
  uptimeSec: number | null;
  cpu: number | null;
  load: [number, number, number] | null;
  memory: Memory | null;
  disks: Disk[];
  history: { fine: Point[]; coarse: Point[]; fineStepMs: number; coarseStepMs: number };
  topCpu: Use[];
  topMemory: Use[];
  // Each agent that has a process, the heaviest on the processor first.
  agents: Use[];
  places: PlacesView;
  warnings: Warning[];
  level: Level;
  costMs: number;
};

export function nameOf(g: Group, agents: Map<string, AgentName>): string {
  if (g.kind === "console") return DISPLAY_NAME;
  if (g.kind === "build") return "a build";
  if (g.kind !== "agent") return g.name;
  const a = agents.get(g.agentId ?? "");
  // A session whose agent is not in the list (it was deleted a moment ago).
  if (!a) return "an agent";
  return a.kind === "agent" ? `agent ${a.title}` : a.title;
}

const round = (n: number): number => Math.round(n * 10) / 10;

const top = (uses: Use[], by: "cpu" | "mem"): Use[] =>
  [...uses].sort((a, b) => b[by] - a[by]).filter((u) => u[by] > 0).slice(0, TOP);

export class HealthMonitor {
  private readonly history = new History();
  private readonly scan: ProcScan;
  private readonly facts: SysFacts;
  private timer: NodeJS.Timeout | null = null;
  private prevCpu: CpuTicks | null = null;
  private last: { at: number; sys: SysSample; cpu: number | null; disks: Disk[]; uses: Use[] } | null = null;
  private since = 0;
  private cost = { ms: 0, n: 0 };
  // The agents and their session names, read between two samples (the store reads files).
  private agents = new Map<string, AgentName>();
  private sessions = new Map<string, string>();

  constructor(private readonly d: {
    workDir: string;
    places: Places;
    // The agents of the console, and the socket name of an agent's session.
    agents: () => Promise<AgentName[]>;
    sessionName: (agentId: string) => string;
    now?: () => number;
    procRoot?: string;
    scan?: ProcScan;
    facts?: SysFacts;
  }) {
    this.scan = d.scan ?? new ProcScan({ procRoot: d.procRoot });
    this.facts = d.facts ?? readFacts();
  }

  private async readAgents(): Promise<void> {
    try {
      const list = await this.d.agents();
      this.agents = new Map(list.map((a) => [a.id, a]));
      this.sessions = new Map(list.map((a) => [this.d.sessionName(a.id), a.id]));
    } catch { /* keep the last list */ }
  }

  /** One sample. Sync reads of /proc only. */
  sample(): void {
    const t0 = performance.now();
    const at = (this.d.now ?? Date.now)();
    const sys = readSys(this.d.procRoot);
    const cpu = sys.cpu && this.prevCpu ? round(cpuPercent(this.prevCpu, sys.cpu)) : null;
    const ticks = sys.cpu && this.prevCpu ? sys.cpu.total - this.prevCpu.total : 0;
    if (sys.cpu) this.prevCpu = sys.cpu;
    const uses = this.scan.scan(this.sessions, ticks).map((g): Use => ({
      kind: g.kind, name: nameOf(g, this.agents), ...(g.agentId ? { agentId: g.agentId } : {}), cpu: round(g.cpu), mem: g.mem, procs: g.procs,
    }));
    const disks = readDisks(this.d.workDir, { procRoot: this.d.procRoot });
    if (!this.since) this.since = at;
    // The first sample has no interval to measure the processor over: it is not in the history.
    if (cpu !== null && sys.memory) {
      const m = sys.memory;
      this.history.add(at, cpu, (m.used / m.total) * 100, m.swapTotal > 0 ? (m.swapUsed / m.swapTotal) * 100 : 0);
    }
    this.last = { at, sys, cpu, disks, uses };
    this.cost.ms += performance.now() - t0;
    this.cost.n += 1;
  }

  start(everyMs = SAMPLE_MS): void {
    if (this.timer) return;
    void this.readAgents().then(() => this.sample());
    this.timer = setInterval(() => {
      this.sample();
      void this.readAgents();
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private warnings(): Warning[] {
    if (!this.last) return [];
    const { uses, disks, sys } = this.last;
    const first = (by: "cpu" | "mem"): Top => {
      const u = top(uses, by)[0];
      return u ? { name: u.name, amount: by === "cpu" ? percent(u.cpu) : size(u.mem) } : null;
    };
    // The cause of a full disk: the biggest known place, but only when it is a real part of the
    // used space. When most of the space is outside the known places, the warning says that.
    const places = this.d.places.view();
    const onWork = places.rows.filter((r) => r.workDisk && r.bytes !== null);
    const used = disks.find((d) => d.holdsWork)?.used ?? 0;
    const known = onWork.reduce((sum, r) => sum + (r.bytes as number), 0);
    const mostOutside = places.checkedAt !== null && used > 0 && known < used * OUTSIDE_SHARE;
    const place = onWork.find((r) => (r.bytes as number) >= used * CAUSE_SHARE);
    return warningsOf({
      mostOutside,
      disks, memory: sys.memory,
      held: { cpuMs: this.history.heldMs(1, CPU_WARN), memoryMs: this.history.heldMs(2, MEMORY_WARN), swapMs: this.history.heldMs(3, SWAP_WARN) },
      topCpu: first("cpu"), topMemory: first("mem"),
      topPlace: place ? { name: placeTitle(place), amount: size(place.bytes as number) } : null,
    });
  }

  level(): Level {
    return levelOf(this.warnings());
  }

  view(): HealthView {
    if (!this.last) this.sample();
    const l = this.last as NonNullable<typeof this.last>;
    const warnings = this.warnings();
    return {
      at: l.at, since: this.since, facts: this.facts, cores: l.sys.cpu?.cores ?? 1, uptimeSec: l.sys.uptimeSec,
      cpu: l.cpu, load: l.sys.load, memory: l.sys.memory, disks: l.disks,
      history: { fine: this.history.fine, coarse: this.history.coarse, fineStepMs: SAMPLE_MS, coarseStepMs: COARSE_STEP_MS },
      topCpu: top(l.uses, "cpu"), topMemory: top(l.uses, "mem"),
      agents: l.uses.filter((u) => u.kind === "agent" && u.agentId && this.agents.has(u.agentId)).sort((a, b) => b.cpu - a.cpu || b.mem - a.mem),
      places: this.d.places.view(), warnings, level: levelOf(warnings),
      costMs: this.cost.n ? Math.round((this.cost.ms / this.cost.n) * 100) / 100 : 0,
    };
  }
}

// A place of the disk list as a warning names it.
export function placeTitle(p: { kind: string; name: string; repo?: string }): string {
  if (p.kind === "repo") return `the repo ${p.name}`;
  if (p.kind === "folder") return `the folder ${p.name}`;
  if (p.kind === "agent") return `the copy of ${p.repo ?? "a repo"} of agent ${p.name}`;
  if (p.kind === "closed") return `a copy of ${p.repo ?? "a repo"} that no agent uses`;
  return p.name;
}
