// The second account of strong protection (chiefaccount.ts): its settings, which agents run as
// it, and the strong check per kind (hardened.ts): a persistent agent runs only as that account,
// in its own dtach folder, and its folders are closed to the workers.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chiefAccount, chiefFacts, chiefMisconfigured, chiefTestSwitch, chiefWanted, isChiefId, runsAsChief } from "./chiefaccount.js";
import { checkHardened, type HardenedFacts, type HardenedFs } from "./hardened.js";
import { names } from "../names.mjs";

// The socket names of this install (the tests run with the old names: choibot-<id>.sock).
const S = (id: string): string => `${names().dtachPrefix}${id}.sock`;

const SELF = process.getuid?.() ?? 1000;
const AGENT = SELF + 1;
const CHIEF = SELF + 2;
const BASE = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: String(AGENT) };
const ON = {
  ...BASE, CHIEF_PERSISTENT_UID: String(CHIEF), AGENT_HOME_ROOT: "/srv/homes", AGENT_DTACH_DIR: "/run/dtach",
  AGENT_CLAUDE_CONFIG_DIR: "/home/agent/.claude", AGENT_CHIEF_CLAUDE_CONFIG_DIR: "/home/chief/.claude", AGENT_CHIEF_DTACH_DIR: "/run/dtach-chief",
};

describe("which agents run as the second account", () => {
  it("the fixed ids of the persistent kinds; never a worker's id", () => {
    for (const id of ["fleet-master", "coordinator", "lead-app-shop", "lead-a"]) expect(isChiefId(id), id).toBe(true);
    for (const id of ["0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e", "lead-", "lead-App", "lead-a/b", "fleet-master2", "cron-master", "svc:x", "lead-a.b"]) expect(isChiefId(id), id).toBe(false);
  });

  it("only with CHIEF_PERSISTENT_UID set and strong protection on", () => {
    expect(runsAsChief("fleet-master", ON)).toBe(true);
    expect(runsAsChief("fleet-master", BASE)).toBe(false);
    expect(runsAsChief("fleet-master", { ...ON, CHIEF_AGENT_UID: "" })).toBe(false);
    expect(runsAsChief("0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e", ON)).toBe(false);
    // Asked for but broken: still the second account's (refused there), never the workers'.
    expect(runsAsChief("fleet-master", { ...ON, AGENT_CHIEF_DTACH_DIR: "" })).toBe(true);
  });
});

describe("the second account's settings", () => {
  it("unset: nothing is asked for, nothing is wrong", () => {
    expect(chiefWanted(BASE)).toBe(false);
    expect(chiefMisconfigured(BASE)).toBeNull();
    expect(chiefAccount(BASE)).toBeNull();
  });

  it("set right: its uid, its own Claude and dtach folders, its homes under AGENT_HOME_ROOT/chief", () => {
    expect(chiefMisconfigured(ON)).toBeNull();
    expect(chiefAccount(ON)).toEqual({ uid: CHIEF, claudeDir: "/home/chief/.claude", dtachDir: "/run/dtach-chief", homeRoot: "/srv/homes/chief" });
    expect(chiefFacts(true, ON)).toEqual({ uid: CHIEF, problem: null, dtachDir: "/run/dtach-chief", homeRoot: "/srv/homes/chief", exec: true });
  });

  it("set wrong: a reason, and no account (never the workers' instead)", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ CHIEF_AGENT_UID: "" }, /strong protection is off/],
      [{ CHIEF_PERSISTENT_UID: "0" }, /not a uid/],
      [{ CHIEF_PERSISTENT_UID: "x" }, /not a uid/],
      [{ CHIEF_PERSISTENT_UID: String(AGENT) }, /equals CHIEF_AGENT_UID/],
      [{ CHIEF_PERSISTENT_UID: String(SELF) }, /equals the console's uid/],
      [{ AGENT_CHIEF_CLAUDE_CONFIG_DIR: "" }, /AGENT_CHIEF_CLAUDE_CONFIG_DIR is not set to an absolute path/],
      [{ AGENT_CHIEF_DTACH_DIR: "rel" }, /AGENT_CHIEF_DTACH_DIR is not set to an absolute path/],
      [{ AGENT_CHIEF_DTACH_DIR: "/run/dtach" }, /AGENT_CHIEF_DTACH_DIR equals AGENT_DTACH_DIR/],
      [{ AGENT_CHIEF_CLAUDE_CONFIG_DIR: "/home/agent/.claude" }, /AGENT_CHIEF_CLAUDE_CONFIG_DIR equals AGENT_CLAUDE_CONFIG_DIR/],
    ];
    for (const [over, why] of cases) {
      const env = { ...ON, ...over };
      expect(chiefMisconfigured(env), JSON.stringify(over)).toMatch(why);
      expect(chiefAccount(env), JSON.stringify(over)).toBeNull();
      expect(chiefFacts(true, env).problem, JSON.stringify(over)).toMatch(why);
    }
  });
});

// ---- the strong check per kind ----------------------------------------------------------------

const DTACH = "/run/dtach";
const CDTACH = "/run/dtach-chief";
const HOMES = "/srv/homes";
const CHOMES = "/srv/homes/chief";
const PROC = "/proc-fx";
const SHARED_GID = 2000;
const CHIEF_GID = 2001;

type Sock = { dir: string; name: string; owner: number };
type World = { sockets?: Sock[]; procs?: { pid: number; sock: string; uid: number; fd0?: string }[]; chiefHomes?: { owner?: number; mode?: number; gid?: number }; chiefDtach?: { owner?: number; mode?: number; gid?: number } };

const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
function worldFs(w: World): HardenedFs {
  const owners = new Map<string, number>([["/data", SELF], ["/cron", SELF], [HOMES, 0], [CHOMES, w.chiefHomes?.owner ?? 0], [DTACH, SELF], [CDTACH, w.chiefDtach?.owner ?? SELF]]);
  const modes = new Map<string, number>([["/data", 0o40700], ["/cron", 0o40700], [HOMES, 0o43770], [CHOMES, w.chiefHomes?.mode ?? 0o43770], [DTACH, 0o43770], [CDTACH, w.chiefDtach?.mode ?? 0o43770]]);
  const gids = new Map<string, number>([[HOMES, SHARED_GID], [CHOMES, w.chiefHomes?.gid ?? CHIEF_GID], [DTACH, SHARED_GID], [CDTACH, w.chiefDtach?.gid ?? CHIEF_GID]]);
  const dirs = new Map<string, string[]>([[DTACH, []], [CDTACH, []], [PROC, []]]);
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  for (const s of w.sockets ?? []) {
    dirs.get(s.dir)!.push(s.name);
    owners.set(join(s.dir, s.name), s.owner);
  }
  for (const p of w.procs ?? []) {
    dirs.get(PROC)!.push(String(p.pid));
    files.set(join(PROC, String(p.pid), "cmdline"), ["/usr/local/bin/dtach", "-A", p.sock, "-E", "claude"].join("\0") + "\0");
    files.set(join(PROC, String(p.pid), "status"), `Name:\tdtach\nState:\tS\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`);
    if (p.fd0) links.set(join(PROC, String(p.pid), "fd", "0"), p.fd0);
  }
  const get = <T>(m: Map<string, T>, p: string): T => { const v = m.get(p); if (v === undefined) throw enoent(p); return v; };
  return {
    ownerUid: (p) => get(owners, p), linkOwnerUid: (p) => get(owners, p), mode: (p) => get(modes, p), gid: (p) => get(gids, p),
    readdir: (p) => get(dirs, p), readFile: (p) => get(files, p), readlink: (p) => get(links, p),
  };
}
const check = (w: World, over: Partial<HardenedFacts> = {}) => checkHardened({
  dataDir: "/data", cronDir: "/cron", envFile: "/nope/.env", homeRoot: HOMES, selfUid: SELF, agentUid: AGENT, dtachDir: DTACH,
  procRoot: PROC, agentExec: true, codeRouteGate: true, fs: worldFs(w),
  chief: { uid: CHIEF, problem: null, dtachDir: CDTACH, homeRoot: CHOMES, exec: true }, ...over,
});
const WORKER = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";
const good: World = {
  sockets: [{ dir: DTACH, name: S(WORKER), owner: AGENT }, { dir: CDTACH, name: S("fleet-master"), owner: CHIEF }],
  procs: [
    { pid: 10, sock: join(DTACH, S(WORKER)), uid: AGENT },
    { pid: 11, sock: join(CDTACH, S("fleet-master")), uid: CHIEF },
    { pid: 12, sock: join(CDTACH, S("fleet-master")), uid: SELF, fd0: "/dev/pts/2" },
  ],
};

describe("the strong check per kind", () => {
  it("a worker as the workers' account, the fleet master as the second account, each in its folder: strong", () => {
    expect(check(good)).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
  });

  it("a persistent agent under the workers' uid while the second account is on is weak (its socket in the workers' folder)", () => {
    const r = check({ sockets: [{ dir: DTACH, name: S("fleet-master"), owner: AGENT }], procs: [{ pid: 20, sock: join(DTACH, S("fleet-master")), uid: AGENT }] });
    expect(r.strong).toBe(false);
    expect(r.reasons).toEqual(["agent fleet-master: a persistent agent's socket in the workers' dtach folder"]);
    expect(r.consoleUidAgents).toEqual(["fleet-master"]);
  });

  it("a persistent agent's socket or process of the workers' uid in its own folder is weak; a worker's socket there too", () => {
    expect(check({ sockets: [{ dir: CDTACH, name: S("coordinator"), owner: AGENT }] }).reasons).toEqual([`agent coordinator: socket owner uid ${AGENT}, want ${CHIEF}`]);
    expect(check({ procs: [{ pid: 30, sock: join(CDTACH, S("lead-app")), uid: AGENT }] }).reasons).toEqual([`agent lead-app: dtach pid 30 runs as uid ${AGENT}`]);
    expect(check({ sockets: [{ dir: CDTACH, name: S(WORKER), owner: CHIEF }] }).reasons).toEqual([`agent ${WORKER}: a worker's socket in the persistent agents' dtach folder`]);
  });

  it("its folders: not an agents' account's, mode 3770, not the workers' group", () => {
    expect(check({ chiefHomes: { gid: SHARED_GID } }).reasons).toEqual([`persistent homes ${CHOMES} has the workers' group (gid ${SHARED_GID})`]);
    expect(check({ chiefHomes: { mode: 0o42775 } }).reasons).toEqual([`persistent homes ${CHOMES} mode 2775, want 3770`]);
    expect(check({ chiefHomes: { owner: CHIEF } }).reasons).toEqual([`persistent homes ${CHOMES} owner uid ${CHIEF} is an agents' account`]);
    expect(check({ chiefDtach: { owner: AGENT } }).reasons).toEqual([`persistent dtach dir ${CDTACH} owner uid ${AGENT} is an agents' account`]);
    expect(check({ chiefDtach: { gid: SHARED_GID } }).reasons).toEqual([`persistent dtach dir ${CDTACH} has the workers' group (gid ${SHARED_GID})`]);
  });

  it("set but broken, or its helper probe failed: weak, with the reason", () => {
    expect(check(good, { chief: { uid: null, problem: "CHIEF_PERSISTENT_UID is not a uid", dtachDir: null, homeRoot: null, exec: false } }).reasons)
      .toEqual(["the persistent agents' account: CHIEF_PERSISTENT_UID is not a uid"]);
    expect(check(good, { chief: { uid: CHIEF, problem: null, dtachDir: CDTACH, homeRoot: CHOMES, exec: false } }).reasons).toEqual(["the persistent agents' exec unavailable"]);
  });

  it("without the second account (no chief facts): the fleet master as the workers' uid in their folder is strong, as before", () => {
    const r = check({ sockets: [{ dir: DTACH, name: S("fleet-master"), owner: AGENT }], procs: [{ pid: 20, sock: join(DTACH, S("fleet-master")), uid: AGENT }] }, { chief: undefined });
    expect(r).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
  });
});

// The test switch of the real proof (the lead's way B): only on a test instance, reported by the
// strong check, and read in one place.
describe("the test switch CHIEF_TEST_START_UNSIGNED", () => {
  it("on only with CHIEF_TEST=1; set without it: ignored; else off", () => {
    expect(chiefTestSwitch({ ...ON, CHIEF_TEST_START_UNSIGNED: "1", CHIEF_TEST: "1" })).toBe("on");
    expect(chiefTestSwitch({ ...ON, CHIEF_TEST_START_UNSIGNED: "1" })).toBe("ignored");
    expect(chiefTestSwitch({ ...ON, CHIEF_TEST_START_UNSIGNED: "1", CHIEF_TEST: "true" })).toBe("ignored");
    for (const v of [undefined, "", "0", "yes"]) expect(chiefTestSwitch({ ...ON, CHIEF_TEST: "1", CHIEF_TEST_START_UNSIGNED: v })).toBe("off");
  });

  it("the strong check says \"test switch on\": a server with it never shows as clean", () => {
    expect(chiefFacts(true, { ...ON, CHIEF_TEST_START_UNSIGNED: "1", CHIEF_TEST: "1" }).testSwitch).toBe(true);
    expect(chiefFacts(true, { ...ON, CHIEF_TEST_START_UNSIGNED: "1" })).not.toHaveProperty("testSwitch");
    const clean = check(good);
    expect(clean.reasons).toEqual([]);
    const on = check(good, { chief: { uid: CHIEF, problem: null, dtachDir: CDTACH, homeRoot: CHOMES, exec: true, testSwitch: true } });
    expect(on.strong).toBe(false);
    expect(on.reasons).toEqual(["test switch on (CHIEF_TEST_START_UNSIGNED): the persistent agents start without the second sign-in"]);
  });

  it("read in one place: no other file of the server or the CLI reads the setting", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const out = execFileSync("grep", ["-rln", "--include=*.ts", "--exclude=*.test.ts", "env.CHIEF_TEST_START_UNSIGNED\\|env\\[\"CHIEF_TEST_START_UNSIGNED\"\\]", join(root, "server"), join(root, "bin")], { encoding: "utf8" });
    expect(out.trim().split("\n").map((p) => p.slice(root.length))).toEqual(["server/chief/chiefaccount.ts"]);
  });
});
