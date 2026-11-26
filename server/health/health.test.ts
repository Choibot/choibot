// server/health/health.test.ts — the readers of the server's state, the history, the warnings
// and the words. Every input is a made-up text or a made-up folder tree.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COARSE_STEP_MS, FINE_KEEP_MS, History } from "./history.js";
import { HealthMonitor, nameOf } from "./monitor.js";
import { Places } from "./places.js";
import { isBuild, parseProcStat, ProcScan, programName, sessionOf } from "./procs.js";
import { cpuPercent, diskOf, parseCpu, parseLoad, parseMeminfo, parseMounts, parseOsName, parseUptime, pickMounts, readDisks } from "./sys.js";
import { CPU_HELD_MS, levelOf, MEMORY_HELD_MS, warningsOf } from "./warn.js";
import { diskName, percent, size, span } from "./words.js";

const GB = 1024 ** 3;

describe("the readers of /proc", () => {
  it("the processor: all cores as one share of the time between two reads", () => {
    const a = parseCpu("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\nintr 1\n");
    const b = parseCpu("cpu  400 0 200 1300 100 0 0 0 0 0\ncpu0 1 1 1 1\ncpu1 1 1 1 1\n");
    expect(a).toEqual({ busy: 200, total: 1000, cores: 2 });
    expect(cpuPercent(a!, b!)).toBe(40); // 400 busy ticks of 1000
    expect(cpuPercent(b!, b!)).toBe(0);
    expect(parseCpu("nothing")).toBeNull();
  });

  it("the memory: used is the total less what a program can still get", () => {
    const m = parseMeminfo("MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n");
    expect(m).toEqual({ total: 16000000 * 1024, used: 12000000 * 1024, swapTotal: 2000000 * 1024, swapUsed: 500000 * 1024 });
    expect(parseMeminfo("MemTotal: 1000 kB\nMemFree: 400 kB\n")).toEqual({ total: 1024000, used: 614400, swapTotal: 0, swapUsed: 0 });
    expect(parseMeminfo("")).toBeNull();
  });

  it("the load, the uptime and the system's name", () => {
    expect(parseLoad("0.70 0.87 1.42 2/1234 5678\n")).toEqual([0.7, 0.87, 1.42]);
    expect(parseUptime("93784.12 700000.00\n")).toBe(93784.12);
    expect(parseOsName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe("Ubuntu 24.04.1 LTS");
    expect(parseOsName("ID=x\n")).toBeNull();
  });

  it("the disks: the one of the work folder first, then the main disk; no memory or boot filesystem", () => {
    const mounts = parseMounts([
      "proc /proc proc rw 0 0", "tmpfs /run tmpfs rw 0 0", "/dev/sda1 / ext4 rw 0 0", "/dev/sda15 /boot/efi vfat rw 0 0",
      "/dev/sdb1 /data ext4 rw 0 0", "/dev/sdc1 /mnt/my\\040disk xfs rw 0 0", "server:/x /net nfs4 rw 0 0",
    ].join("\n"));
    expect(pickMounts(mounts, "/data/work").map((p) => [p.mount.path, p.holdsWork])).toEqual([["/data", true], ["/", false], ["/mnt/my disk", false]]);
    expect(pickMounts(mounts, "/home/you/workspace").map((p) => p.mount.path)).toEqual(["/", "/data", "/mnt/my disk"]);
    // A container: the root is an overlay, and one disk shows under three file mounts.
    const box = parseMounts("overlay / overlay rw 0 0\n/dev/vda1 /etc/hosts ext4 rw 0 0\n/dev/vda1 /etc/hostname ext4 rw 0 0\n");
    const statfs = () => ({ blocks: 1000, bfree: 400, bavail: 300, bsize: 4096 });
    const dir = mkdtempSync(join(tmpdir(), "health-mounts-"));
    try {
      writeFileSync(join(dir, "mounts"), box.map((m) => `${m.device} ${m.path} ${m.type} rw 0 0`).join("\n"));
      expect(readDisks("/work", { procRoot: dir, statfs })).toEqual([{ path: "/", total: 4096000, used: 2457600, free: 1228800, percent: (600 / 900) * 100, holdsWork: true }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(diskOf("/", { blocks: 0, bfree: 0, bavail: 0, bsize: 4096 }, false)).toBeNull();
  });
});

describe("the history", () => {
  it("keeps one hour of samples and 24 hours of 5-minute means", () => {
    const h = new History();
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % COARSE_STEP_MS);
    for (let i = 0; i < 26 * 60 * 4; i += 1) h.add(t0 + i * 15_000, i % 2 ? 20 : 40, 50, 0);
    expect(h.fine.length).toBe(FINE_KEEP_MS / 15_000 + 1);
    expect(h.coarse.length).toBeLessThanOrEqual(24 * 12 + 1);
    expect(h.coarse.length).toBeGreaterThanOrEqual(24 * 12 - 1);
    expect(h.coarse.at(-1)!.slice(1)).toEqual([30, 50, 0]);
  });

  it("says for how long a value was over a limit, up to now", () => {
    const h = new History();
    [10, 96, 97, 99, 98].forEach((cpu, i) => h.add(i * 15_000, cpu, 91, 0));
    expect(h.heldMs(1, 95)).toBe(45_000);
    expect(h.heldMs(2, 90)).toBe(60_000);
    h.add(75_000, 50, 91, 0);
    expect(h.heldMs(1, 95)).toBe(0);
    expect(new History().heldMs(1, 95)).toBe(0);
  });
});

describe("the warnings", () => {
  const disk = (percentUsed: number, o: { path?: string; holdsWork?: boolean } = {}) => ({
    path: o.path ?? "/", total: 100 * GB, used: percentUsed * GB, free: (100 - percentUsed) * GB, percent: percentUsed, holdsWork: o.holdsWork ?? true,
  });
  const quiet = { cpuMs: 0, memoryMs: 0, swapMs: 0 };
  const memory = { total: 16 * GB, used: 15 * GB, swapTotal: 4 * GB, swapUsed: 3 * GB };
  const none = { topCpu: null, topMemory: null, topPlace: null };

  it("a healthy server has none", () => {
    const w = warningsOf({ disks: [disk(60)], memory, held: quiet, ...none });
    expect(w).toEqual([]);
    expect(levelOf(w)).toBe("ok");
  });

  it("a disk over 85% warns, over 95% is an error, each with the cause and what to do", () => {
    const w = warningsOf({ disks: [disk(91), disk(97, { path: "/data", holdsWork: false })], memory, held: quiet, ...none, topPlace: { name: "the repo shop", amount: "41.0 GB" } });
    expect(w.map((x) => [x.id, x.level, x.title])).toEqual([
      ["disk:/", "warn", "The main disk is 91% full"], ["disk:/data", "error", "The disk at /data is almost full"],
    ]);
    expect(w[0].text).toBe("9.0 GB of 100 GB is free. The biggest place is the repo shop (41.0 GB).");
    expect(w[1].text).toContain("When a disk is full, agents and builds fail.");
    expect(w[1].text).not.toContain("biggest place"); // the known places are on the other disk
    expect(w[0].todo).toContain("Delete the agents that you do not need");
    // The known places are a small part of the used space: no place is named as the cause.
    const outside = warningsOf({ disks: [disk(91)], memory, held: quiet, ...none, topPlace: { name: "the repo shop", amount: "25 MB" }, mostOutside: true });
    expect(outside[0].text).toBe("9.0 GB of 100 GB is free. Most of the used space is outside the places that ChoiBot knows.");
    expect(outside[0].todo).not.toContain("Delete the agents");
    expect(levelOf(w)).toBe("error");
    expect(levelOf([w[0]])).toBe("warn");
  });

  it("memory, swap and the processor warn only after some minutes over the limit", () => {
    const short = warningsOf({ disks: [], memory, held: { cpuMs: CPU_HELD_MS - 1, memoryMs: MEMORY_HELD_MS - 1, swapMs: 0 }, ...none });
    expect(short).toEqual([]);
    const w = warningsOf({
      disks: [], memory, held: { cpuMs: 6 * 60_000, memoryMs: 4 * 60_000, swapMs: 4 * 60_000 },
      topCpu: { name: "a build", amount: "88%" }, topMemory: { name: "agent Fix the login", amount: "6.1 GB" }, topPlace: null,
    });
    expect(w.map((x) => x.id)).toEqual(["memory", "swap", "cpu"]);
    expect(w[0].text).toBe("It has been so for 4 minutes: 15.0 GB of 16.0 GB is in use. Agent Fix the login uses the most (6.1 GB).");
    expect(w[2].text).toBe("It has been at 100% for 6 minutes. A build uses the most (88%).");
    // No swap on the server: no swap warning.
    expect(warningsOf({ disks: [], memory: { ...memory, swapTotal: 0, swapUsed: 0 }, held: { ...quiet, swapMs: 10 * 60_000 }, ...none })).toEqual([]);
  });
});

describe("the words", () => {
  it("sizes, shares and times in plain units", () => {
    expect([size(0), size(900), size(300 * 1024), size(512 * 1024 ** 2), size(3.44 * GB), size(120 * GB), size(2300 * GB)])
      .toEqual(["0 bytes", "900 bytes", "300 KB", "512 MB", "3.4 GB", "120 GB", "2.2 TB"]);
    expect([percent(0), percent(0.44), percent(7.4), percent(100)]).toEqual(["0%", "0.4%", "7%", "100%"]);
    expect([span(20), span(60), span(12 * 60), span(3600 + 120), span(7 * 3600), span(86400), span(3 * 86400 + 4 * 3600)])
      .toEqual(["less than a minute", "1 minute", "12 minutes", "1 hour 2 minutes", "7 hours", "1 day", "3 days 4 hours"]);
    expect([diskName("/"), diskName("/data")]).toEqual(["The main disk", "The disk at /data"]);
  });
});

// A made-up /proc: one folder per process with stat, cmdline and cgroup.
describe("who uses the processor and the memory", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "health-proc-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const proc = (pid: number, ppid: number, comm: string, argv: string[], ticks: number, rssPages: number, cgroup = "0::/user.slice") => {
    const dir = join(root, "proc", String(pid));
    mkdirSync(dir, { recursive: true });
    const f = Array(22).fill("0");
    f[0] = "S"; f[1] = String(ppid); f[11] = String(ticks); f[12] = "0"; f[19] = String(1000 + pid); f[21] = String(rssPages);
    writeFileSync(join(dir, "stat"), `${pid} (${comm}) ${f.join(" ")}\n`);
    writeFileSync(join(dir, "cmdline"), argv.join("\0"));
    writeFileSync(join(dir, "cgroup"), `${cgroup}\n`);
  };
  const scope = (path: string, pids: number[]) => {
    mkdirSync(join(root, "cgroup", path), { recursive: true });
    writeFileSync(join(root, "cgroup", path, "cgroup.procs"), pids.join("\n") + "\n");
  };

  it("reads a stat line whose name holds spaces and parentheses", () => {
    const f = Array(22).fill("0");
    f[1] = "7"; f[11] = "30"; f[12] = "12"; f[19] = "555"; f[21] = "100";
    expect(parseProcStat(9, `9 (my (odd) name) ${f.join(" ")}`)).toEqual({ pid: 9, ppid: 7, start: "555", comm: "my (odd) name", ticks: 42, rssPages: 100 });
    expect(parseProcStat(9, "broken")).toBeNull();
  });

  it("names a program by its name and its script, never by another argument", () => {
    expect(programName("node", ["/usr/bin/node", "--max-old-space-size=4096", "/srv/app/server.js", "--token=made-up-secret"])).toBe("node server.js");
    expect(programName("python3", ["python3", "-m", "http.server"])).toBe("python3 http.server");
    expect(programName("postgres", ["/usr/lib/postgresql/16/bin/postgres", "-D", "/var/lib/postgresql"])).toBe("postgres");
    expect(programName("next-server (v1", ["next-server (v15.0.0)"])).toBe("next-server");
    expect(programName("old-name", [""])).toBe("old-name");
    expect(programName("node", ["node", `/x/${"a".repeat(80)}.js`]).length).toBe(40);
    expect(isBuild(["node", "/app/node_modules/.bin/next", "build"])).toBe(true);
    expect(isBuild(["/usr/bin/cargo", "build", "--release"])).toBe(true);
    expect(isBuild(["node", "server.js", "--port", "80", "--note", "next build"])).toBe(false);
    expect(sessionOf(["/home/you/.local/bin/dtach", "-A", "/tmp/choibot-dtach/choibot-a1.sock", "-E", "claude"])).toBe("choibot-a1");
    expect(sessionOf(["claude", "/tmp/x.sock"])).toBeNull();
  });

  it("gives each process to its agent, to the console, to a build, else to its program", () => {
    proc(1, 0, "systemd", ["/sbin/init"], 0, 10);
    proc(50, 1, "node", ["node", "server/index.js"], 100, 1000); // the console
    proc(51, 50, "git", ["git", "status"], 10, 10); // started by the console
    proc(60, 1, "dtach", ["dtach", "-A", "/tmp/d/choibot-a1.sock", "claude"], 0, 5, "0::/user.slice/run-r1.scope");
    proc(61, 60, "claude", ["claude"], 300, 2000, "0::/user.slice/run-r1.scope");
    proc(62, 61, "node", ["node", "/w/node_modules/.bin/next", "build"], 500, 3000, "0::/user.slice/run-r1.scope"); // the agent's build: the agent's
    proc(63, 1, "chrome", ["chrome"], 50, 500, "0::/user.slice/run-r1.scope"); // left the tree, still in the scope
    proc(70, 1, "dtach", ["dtach", "-A", "/tmp/d/choibot-gone.sock", "claude"], 5, 5); // no agent of that name
    proc(80, 1, "sh", ["sh", "-c", "next build"], 0, 10); // the shell of the build: a part of it
    proc(81, 80, "node", ["node", "/srv/app/node_modules/.bin/next", "build"], 200, 800); // a build of nobody
    proc(82, 81, "node", ["node", "/srv/app/jest-worker/processChild.js"], 100, 400); // under the build
    proc(90, 1, "postgres", ["postgres"], 40, 700);
    proc(91, 1, "postgres", ["postgres", "writer"], 10, 300);
    proc(2, 0, "kthreadd", [""], 5, 0); // the kernel's threads: in no list
    proc(3, 2, "kworker/0:1-events", [""], 900, 0);
    scope("user.slice/run-r1.scope", [60, 61, 62, 63]);

    const scan = new ProcScan({ procRoot: join(root, "proc"), cgroupRoot: join(root, "cgroup"), selfPid: 50, pageSize: 4096 });
    const sessions = new Map([["choibot-a1", "a1"]]);
    // The first scan has no interval: it gives the memory, and no processor share.
    const first = scan.scan(sessions, 0);
    expect(first.every((g) => g.cpu === 0)).toBe(true);
    // Each process counts one time: 13 processes that are not of the kernel, in all groups.
    expect(first.reduce((n, g) => n + g.procs, 0)).toBe(13);
    // A process of an agent is in the agent's group only: no bare "claude", "chrome" or "node next" row.
    expect(first.filter((g) => g.kind === "program").map((g) => g.name).sort()).toEqual(["dtach", "init", "postgres"]);
    const mem = Object.fromEntries(first.map((g) => [g.kind === "program" ? g.name : g.agentId ?? g.kind, [g.mem / 4096, g.procs]]));
    expect(mem).toMatchObject({ a1: [5505, 4], console: [1010, 2], build: [1210, 3], postgres: [1000, 2], dtach: [5, 1], init: [10, 1] });

    // 15 seconds later: 1000 ticks of all cores went by.
    proc(61, 60, "claude", ["claude"], 400, 2000, "0::/user.slice/run-r1.scope"); // +100
    proc(62, 61, "node", ["node", "/w/node_modules/.bin/next", "build"], 700, 3000, "0::/user.slice/run-r1.scope"); // +200
    proc(81, 80, "node", ["node", "/srv/app/node_modules/.bin/next", "build"], 250, 800); // +50
    proc(64, 61, "rg", ["rg", "x"], 30, 20, "0::/user.slice/run-r1.scope"); // new: all of its 30
    rmSync(join(root, "proc", "91"), { recursive: true });
    const second = scan.scan(sessions, 1000);
    const cpu = Object.fromEntries(second.map((g) => [g.kind === "program" ? g.name : g.agentId ?? g.kind, g.cpu]));
    expect(cpu).toMatchObject({ a1: 33, console: 0, build: 5, postgres: 0 });
    expect(second.find((g) => g.name === "postgres")!.procs).toBe(1);
  });

  it("the monitor names each user, lists the agents and counts its own cost", async () => {
    proc(1, 0, "systemd", ["/sbin/init"], 0, 10);
    proc(50, 1, "node", ["node", "server/index.js"], 100, 1000);
    proc(60, 1, "dtach", ["dtach", "-A", "/tmp/d/choibot-a1.sock", "claude"], 0, 5);
    proc(61, 60, "claude", ["claude"], 300, 2000);
    proc(70, 1, "dtach", ["dtach", "-A", "/tmp/d/choibot-lead-shop.sock", "claude"], 0, 5);
    const p = join(root, "proc");
    writeFileSync(join(p, "stat"), "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1\n");
    writeFileSync(join(p, "meminfo"), "MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
    writeFileSync(join(p, "loadavg"), "0.10 0.20 0.30 1/5 99\n");
    writeFileSync(join(p, "uptime"), "7200.00 1.00\n");
    writeFileSync(join(p, "mounts"), "");
    let now = 1_000_000;
    const monitor = new HealthMonitor({
      workDir: root, procRoot: p, now: () => now, facts: { name: "box-1", system: "Made-up OS 1", kernel: "1.0" },
      scan: new ProcScan({ procRoot: p, cgroupRoot: join(root, "cgroup"), selfPid: 50, pageSize: 4096 }),
      places: new Places({ input: async () => ({ workDir: root, worktreeDir: ".agent-worktrees", agents: [], fixed: [] }) }),
      agents: async () => [{ id: "a1", title: "Fix the login", kind: "agent" }, { id: "lead-shop", title: "Lead · shop", kind: "lead" }],
      sessionName: (id) => `choibot-${id}`,
    });
    monitor.start(3_600_000);
    await new Promise((r) => setTimeout(r, 20));
    monitor.stop();
    now += 15_000;
    writeFileSync(join(p, "stat"), "cpu  600 0 100 1300 0 0 0 0 0 0\ncpu0 1 1 1 1\n"); // 500 of 1000 ticks busy
    proc(61, 60, "claude", ["claude"], 700, 2000); // +400
    monitor.sample();
    const v = monitor.view();
    expect(v).toMatchObject({ cpu: 50, cores: 1, uptimeSec: 7200, load: [0.1, 0.2, 0.3], level: "ok", warnings: [], facts: { name: "box-1" }, since: 1_000_000 });
    expect(v.history.fine).toEqual([[1_015_000, 50, 25, 0]]);
    expect(v.topCpu.map((u) => [u.name, u.cpu])).toEqual([["agent Fix the login", 40]]);
    expect(v.topMemory.map((u) => u.name)).toEqual(["agent Fix the login", "ChoiBot", "init", "Lead · shop"]);
    expect(v.agents.map((u) => [u.agentId, u.name, u.procs])).toEqual([["a1", "agent Fix the login", 2], ["lead-shop", "Lead · shop", 1]]);
    expect(v.costMs).toBeGreaterThan(0);
    expect(nameOf({ kind: "agent", agentId: "zz", name: "", cpu: 0, mem: 0, procs: 1 }, new Map())).toBe("an agent");
  });
});
