// server/chief/deploy/config.ts — where the deploy acts (spec §5.7), all from the server's own
// boot facts: the checkout is the directory the console runs from, the unit is the one the
// console runs in, the branch and the remote are constants (ticket.ts). No request, ticket field
// or agent call reaches any of these.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { UNIT_NAMES } from "../../../bin/lib/units.js";

const execFileP = promisify(execFile);

export const DEFAULT_DEPLOY_UNIT = UNIT_NAMES[0];
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}\.service$/;
// The live console is 3 processes below its unit's main pid (pnpm → sh → tsx → node).
const MAX_HOPS = 4;
const SHA_RE = /^[0-9a-f]{40}$/;

type Env = Record<string, string | undefined>;

// The unit the console runs in: the unit of the install (server/names.mjs), or CHIEF_DEPLOY_UNIT (server config, for
// a console installed under another name and for the isolated test instance).
export function deployUnit(env: Env = process.env): string {
  const u = env.CHIEF_DEPLOY_UNIT;
  return u && UNIT_RE.test(u) ? u : DEFAULT_DEPLOY_UNIT;
}

// The transient unit of the runner. One name: systemd itself refuses a second run.
export function runnerUnitOf(unit: string): string {
  return `${unit.replace(/\.service$/, "")}-deploy.service`;
}

// The pnpm the console itself was started with (`pnpm start` sets npm_execpath), else the
// standalone install, else PATH. The first `pnpm` on the unit's PATH can be an old one.
export function pnpmArgv(env: Env = process.env, exists: (p: string) => boolean = existsSync): string[] {
  const own = env.npm_execpath;
  if (own && own.startsWith("/") && /^pnpm(\.[cm]?js)?$/.test(basename(own)) && exists(own)) {
    return /\.[cm]?js$/.test(own) ? [process.execPath, own] : [own];
  }
  const home = env.PNPM_HOME || (env.HOME ? join(env.HOME, ".local", "share", "pnpm") : "");
  for (const p of home ? [join(home, "bin", "pnpm"), join(home, "pnpm")] : []) if (exists(p)) return [p];
  return ["pnpm"];
}

// The console's own address for the runner's check after a restart, from the same PORT and HOST
// that index.ts listens on. Loopback only: a loopback peer needs no session cookie (auth.ts). A
// console bound to one other address gets no check (null): the new server writes the result.
export function checkUrlOf(env: Env = process.env): string | null {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = env.HOST ?? "0.0.0.0";
  if (["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(host)) return `http://127.0.0.1:${port}`;
  if (host === "::1") return `http://[::1]:${port}`;
  return null;
}

export type Armed = { ok: true } | { ok: false; why: string };

export type SelfFacts = {
  pid: number;
  // The text of /proc/<pid>/cgroup and /proc/<pid>/stat.
  cgroup(pid: number): Promise<string>;
  stat(pid: number): Promise<string>;
  // `systemctl --user show <unit> -p MainPID --value`; 0 when the unit is not running.
  mainPid(unit: string): Promise<number>;
};

export const procFacts: SelfFacts = {
  pid: process.pid,
  cgroup: (pid) => readFile(`/proc/${pid}/cgroup`, "utf8"),
  stat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
  mainPid: async (unit) => {
    const { stdout } = await execFileP("systemctl", ["--user", "show", unit, "-p", "MainPID", "--value"], { timeout: 10_000 });
    const n = Number(stdout.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  },
};

// Field 4 of /proc/<pid>/stat. The comm field can hold spaces and brackets: read after the last ")".
function ppidOf(stat: string): number {
  const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const n = Number(rest[1]);
  return Number.isSafeInteger(n) ? n : 0;
}

// May this process restart `unit`? Only when it IS that unit: its cgroup is the unit's, and the
// unit's main pid is this process or a near ancestor. So a test instance, a dev server or a
// second console can never restart the live unit, whatever its config says. Fails closed.
export async function ownUnit(unit: string, f: SelfFacts = procFacts): Promise<Armed> {
  const no = (why: string): Armed => ({ ok: false, why });
  if (!UNIT_RE.test(unit)) return no("the unit name is not valid");
  try {
    const line = (await f.cgroup(f.pid)).split("\n").find((l) => l.startsWith("0::")) ?? "";
    const own = line.slice(3).trim().split("/").pop() ?? "";
    if (own !== unit) return no(`this console does not run in ${unit}`);
    const main = await f.mainPid(unit);
    if (main <= 0) return no(`${unit} has no main process`);
    let pid = f.pid;
    for (let hop = 0; hop <= MAX_HOPS && pid > 1; hop++) {
      if (pid === main) return { ok: true };
      pid = ppidOf(await f.stat(pid));
    }
    return no(`this console is not the main process of ${unit}`);
  } catch (e) {
    return no(`the unit check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The commit `next build` recorded (next.config.mjs writes the commit as the build id), or null
// for a build that recorded none. Never a guess from file times.
export async function readBuildCommit(dir: string): Promise<string | null> {
  try {
    const id = (await readFile(join(dir, ".next", "BUILD_ID"), "utf8")).trim();
    return SHA_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}
