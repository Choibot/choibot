// server/health/sys.ts — the state of the server, read from /proc and statfs. Nothing here starts
// a process: one sample is a handful of small reads. The parsers are pure (a text in, numbers
// out); read* does the reads. Linux only: on another system a read fails and the field is null.
import { readFileSync, realpathSync, statfsSync } from "node:fs";
import { hostname, release } from "node:os";
import { resolve, sep } from "node:path";

// The processor time of all cores since boot, in clock ticks.
export type CpuTicks = { busy: number; total: number; cores: number };

// The first line of /proc/stat: cpu user nice system idle iowait irq softirq steal …
export function parseCpu(stat: string): CpuTicks | null {
  const lines = stat.split("\n");
  const f = (lines[0] ?? "").trim().split(/\s+/);
  if (f[0] !== "cpu") return null;
  const n = f.slice(1, 9).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  const total = n.reduce((a, b) => a + b, 0);
  const idle = n[3] + (n[4] ?? 0); // idle and the wait for the disk
  return { busy: total - idle, total, cores: Math.max(1, lines.filter((l) => /^cpu\d+ /.test(l)).length) };
}

// The busy share of the time between two reads, 0 to 100.
export function cpuPercent(prev: CpuTicks, now: CpuTicks): number {
  const total = now.total - prev.total;
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, ((now.busy - prev.busy) / total) * 100));
}

export type Memory = { total: number; used: number; swapTotal: number; swapUsed: number };

// /proc/meminfo, in bytes. Used = what a program cannot get: total less "available".
export function parseMeminfo(text: string): Memory | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  const free = kb("MemAvailable") ?? kb("MemFree");
  if (total === null || free === null) return null;
  const swapTotal = kb("SwapTotal") ?? 0;
  return { total, used: Math.max(0, total - free), swapTotal, swapUsed: Math.max(0, swapTotal - (kb("SwapFree") ?? swapTotal)) };
}

// /proc/loadavg: the load of the last 1, 5 and 15 minutes.
export function parseLoad(text: string): [number, number, number] | null {
  const f = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return f.length === 3 && f.every((x) => Number.isFinite(x)) ? [f[0], f[1], f[2]] : null;
}

// /proc/uptime: seconds since the server started.
export function parseUptime(text: string): number | null {
  const s = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(s) ? s : null;
}

// The system's own name ("Ubuntu 24.04.1 LTS") from /etc/os-release.
export function parseOsName(text: string): string | null {
  const m = /^PRETTY_NAME=(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/^"(.*)"$/, "$1") || null : null;
}

export type Mount = { device: string; path: string; type: string };

// Filesystems that are a disk of this server. Not in the list: memory and kernel filesystems,
// read-only images, and network shares (a share that does not answer would hold a read).
const DISK_TYPES = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "bcachefs"]);

// /proc/mounts: one line per mount; a space in a path is written \040.
export function parseMounts(text: string): Mount[] {
  const out: Mount[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 3) continue;
    const un = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    out.push({ device: un(f[0]), path: un(f[1]), type: f[2] });
  }
  return out;
}

const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir === sep ? sep : dir + sep);

// The mounts to show, in order: the one that holds the work folder, then "/", then the other
// disks. The first two are always there, also on a filesystem that is not in the list (a
// container's root). /boot holds no data of the user.
export function pickMounts(mounts: Mount[], workDir: string): { mount: Mount; holdsWork: boolean }[] {
  // The last mount on a path is the one in use.
  const byPath = new Map<string, Mount>();
  for (const m of mounts) if (m.path.startsWith(sep)) byPath.set(m.path, m);
  const all = [...byPath.values()];
  const work = all.filter((m) => inside(workDir, m.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const rest = all.filter((m) => m !== work && (m.path === sep || (DISK_TYPES.has(m.type) && !inside(m.path, "/boot"))))
    .sort((a, b) => (a.path === sep ? -1 : b.path === sep ? 1 : a.path.localeCompare(b.path)));
  return [...(work ? [{ mount: work, holdsWork: true }] : []), ...rest.map((mount) => ({ mount, holdsWork: false }))];
}

export type Disk = {
  // Where the disk is in the folder tree ("/" is the main disk).
  path: string;
  total: number; used: number; free: number;
  // Used, of what a program can use (as `df` counts it), 0 to 100.
  percent: number;
  // The agents' work folder is on this disk.
  holdsWork: boolean;
};

type Statfs = { blocks: number; bfree: number; bavail: number; bsize: number };

export function diskOf(path: string, st: Statfs, holdsWork: boolean): Disk | null {
  if (!(st.blocks > 0)) return null;
  const used = (st.blocks - st.bfree) * st.bsize;
  const free = st.bavail * st.bsize;
  return { path, total: st.blocks * st.bsize, used, free, percent: used + free > 0 ? (used / (used + free)) * 100 : 0, holdsWork };
}

const read = (file: string): string | null => {
  try { return readFileSync(file, "utf8"); } catch { return null; }
};

export function readDisks(workDir: string, o: { procRoot?: string; statfs?: (p: string) => Statfs } = {}): Disk[] {
  const statfs = o.statfs ?? ((p: string) => statfsSync(p));
  let work = resolve(workDir);
  try { work = realpathSync(work); } catch { /* not made yet: its parent's disk is found by the path */ }
  const out: Disk[] = [];
  const seen = new Set<string>();
  for (const { mount, holdsWork } of pickMounts(parseMounts(read(`${o.procRoot ?? "/proc"}/mounts`) ?? ""), work)) {
    let st: Statfs;
    try { st = statfs(mount.path); } catch { continue; }
    // One disk mounted in two places (a bind mount, a container's files) shows one time.
    const same = `${st.blocks}:${st.bfree}:${st.bavail}:${st.bsize}`;
    if (seen.has(same) || seen.has(mount.device)) continue;
    seen.add(same);
    if (mount.device.startsWith(sep)) seen.add(mount.device);
    const d = diskOf(mount.path, st, holdsWork);
    if (d) out.push(d);
  }
  return out;
}

export type SysSample = { cpu: CpuTicks | null; memory: Memory | null; load: [number, number, number] | null; uptimeSec: number | null };

export function readSys(procRoot = "/proc"): SysSample {
  const at = <T>(file: string, parse: (text: string) => T | null): T | null => {
    const text = read(`${procRoot}/${file}`);
    return text === null ? null : parse(text);
  };
  return { cpu: at("stat", parseCpu), memory: at("meminfo", parseMeminfo), load: at("loadavg", parseLoad), uptimeSec: at("uptime", parseUptime) };
}

// What does not change while the server runs: read one time.
export type SysFacts = { name: string; system: string | null; kernel: string };

export function readFacts(): SysFacts {
  return { name: hostname(), system: parseOsName(read("/etc/os-release") ?? ""), kernel: release() };
}
