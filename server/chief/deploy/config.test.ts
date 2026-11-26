// server/chief/deploy/config.test.ts — the facts that decide where a deploy acts (spec §5.7).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEPLOY_UNIT, checkUrlOf, deployUnit, ownUnit, pnpmArgv, readBuildCommit, runnerUnitOf, type SelfFacts } from "./config.js";

const CG = (unit: string): string => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
const stat = (pid: number, ppid: number, comm = "node"): string => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 1 0`;

// pnpm (100) → sh (101) → tsx (102) → node server (103), as the live unit runs.
function facts(o: Partial<SelfFacts> & { tree?: Record<number, number>; unit?: string; main?: number } = {}): SelfFacts {
  const tree = o.tree ?? { 103: 102, 102: 101, 101: 100, 100: 1 };
  return {
    pid: 103,
    cgroup: async () => CG(o.unit ?? "choibot.service"),
    stat: async (pid) => { if (!(pid in tree)) throw new Error("ESRCH"); return stat(pid, tree[pid]!); },
    mainPid: async () => o.main ?? 100,
    ...o,
  };
}

describe("ownUnit: only the unit's own process may restart the unit", () => {
  it("the live console: its cgroup is the unit's and the unit's main pid is a near ancestor", async () => {
    expect(await ownUnit("choibot.service", facts())).toEqual({ ok: true });
    expect(await ownUnit("choibot.service", facts({ main: 103 }))).toEqual({ ok: true });
  });

  it("a test instance or a dev server (another cgroup) is refused, whatever unit it names", async () => {
    const scope = facts({ unit: "run-r57e47aa3110a4cef81279e56f400065c.scope" });
    expect(await ownUnit("choibot.service", scope)).toEqual({ ok: false, why: "this console does not run in choibot.service" });
  });

  it("a process inside the unit's cgroup that is not its main process tree is refused", async () => {
    // Started from a shell tab of the live console: far below the main pid.
    const deep = facts({ tree: { 103: 110, 110: 109, 109: 108, 108: 107, 107: 106, 106: 100, 100: 1 } });
    expect(await ownUnit("choibot.service", deep)).toEqual({ ok: false, why: "this console is not the main process of choibot.service" });
    // Reparented (a daemon): its ancestors never reach the main pid.
    expect((await ownUnit("choibot.service", facts({ tree: { 103: 1 } }))).ok).toBe(false);
  });

  it("fails closed: no main pid, an unreadable /proc, a failed systemctl, a bad unit name", async () => {
    expect((await ownUnit("choibot.service", facts({ main: 0 }))).ok).toBe(false);
    expect((await ownUnit("choibot.service", facts({ cgroup: async () => { throw new Error("EACCES"); } }))).ok).toBe(false);
    expect((await ownUnit("choibot.service", facts({ mainPid: async () => { throw new Error("Failed to connect to bus"); } }))).ok).toBe(false);
    expect(await ownUnit("x; rm -rf /", facts())).toEqual({ ok: false, why: "the unit name is not valid" });
  });

  it("reads the parent pid after the last bracket of the comm field", async () => {
    const odd = facts({ stat: async (pid) => (pid === 103 ? "103 (my (odd) name) S 100 103 103 0" : stat(pid, 1)) });
    expect(await ownUnit("choibot.service", odd)).toEqual({ ok: true });
  });
});

describe("the unit, the runner unit, pnpm", () => {
  it("the unit is choibot.service unless the server config names a valid one", () => {
    expect(deployUnit({})).toBe(DEFAULT_DEPLOY_UNIT);
    expect(DEFAULT_DEPLOY_UNIT).toBe("choibot.service");
    expect(deployUnit({ CHIEF_DEPLOY_UNIT: "choibot-scratch-1.service" })).toBe("choibot-scratch-1.service");
    for (const bad of ["", "x", "a b.service", "../x.service", "x.service; reboot", "-x.service", "x.timer"]) {
      expect(deployUnit({ CHIEF_DEPLOY_UNIT: bad })).toBe(DEFAULT_DEPLOY_UNIT);
    }
    expect(runnerUnitOf("choibot.service")).toBe("choibot-deploy.service");
  });

  it("pnpm: the one the console was started with, else the standalone install, else PATH", () => {
    const has = (...paths: string[]) => (p: string): boolean => paths.includes(p);
    expect(pnpmArgv({ npm_execpath: "/opt/pnpm/exe/pnpm" }, has("/opt/pnpm/exe/pnpm"))).toEqual(["/opt/pnpm/exe/pnpm"]);
    expect(pnpmArgv({ npm_execpath: "/opt/pnpm/bin/pnpm.cjs" }, has("/opt/pnpm/bin/pnpm.cjs"))).toEqual([process.execPath, "/opt/pnpm/bin/pnpm.cjs"]);
    // npm's own cli, a relative path or a missing file: not taken.
    expect(pnpmArgv({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js", HOME: "/h" }, has("/usr/lib/node_modules/npm/bin/npm-cli.js", "/h/.local/share/pnpm/bin/pnpm")))
      .toEqual(["/h/.local/share/pnpm/bin/pnpm"]);
    expect(pnpmArgv({ npm_execpath: "/gone/pnpm", PNPM_HOME: "/p" }, has("/p/pnpm"))).toEqual(["/p/pnpm"]);
    expect(pnpmArgv({}, has())).toEqual(["pnpm"]);
  });
});

describe("readBuildCommit", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("is the commit next build recorded, or null: never a guess", async () => {
    dir = mkdtempSync(join(tmpdir(), "chief-deploy-build-"));
    expect(await readBuildCommit(dir)).toBeNull();
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "BUILD_ID"), "kQ3xS1random-next-id");
    expect(await readBuildCommit(dir)).toBeNull();
    writeFileSync(join(dir, ".next", "BUILD_ID"), `${"a1".repeat(20)}\n`);
    expect(await readBuildCommit(dir)).toBe("a1".repeat(20));
  });
});

describe("checkUrlOf: where the runner checks the new server", () => {
  it("the loopback address of the port the console listens on (index.ts defaults: 0.0.0.0:3000)", () => {
    expect(checkUrlOf({})).toBe("http://127.0.0.1:3000");
    expect(checkUrlOf({ HOST: "127.0.0.1", PORT: "3100" })).toBe("http://127.0.0.1:3100");
    expect(checkUrlOf({ HOST: "0.0.0.0", PORT: "3100" })).toBe("http://127.0.0.1:3100");
    expect(checkUrlOf({ HOST: "localhost", PORT: "3100" })).toBe("http://127.0.0.1:3100");
    expect(checkUrlOf({ HOST: "::1", PORT: "3100" })).toBe("http://[::1]:3100");
  });

  it("no check for a console bound to one other address (a remote peer needs a cookie) or a bad port", () => {
    expect(checkUrlOf({ HOST: "100.64.0.9", PORT: "3100" })).toBeNull();
    expect(checkUrlOf({ PORT: "x" })).toBeNull();
    expect(checkUrlOf({ PORT: "70000" })).toBeNull();
  });
});
