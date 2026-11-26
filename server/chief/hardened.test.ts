// server/chief/hardened.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../events.js";
import {
  HardenedMonitor, agentSessionUids, checkHardened, claudeConfigProblem, codeRouteGate, hardenedDeployment, parseAgentUid,
  privateDirReasons, setCodeRouteGate, type HardenedFacts, type HardenedFs,
} from "./hardened.js";

// Fixture paths only: no test reads the real /proc or the live dtach dir.
const SELF = 1000;
const AGENT = 1001;
const DATA = "/fx/chief";
const CRON = "/fx/cron";
const ENVFILE = "/fx/console/.env";
const HOMES = "/srv/homes";
const DTACH = "/fx/dtach";
const PROC = "/fx/proc";
const DTACH_BIN = "/home/dev/.local/bin/dtach";

type Fd0 = string | { error: string };
type Proc = { pid: number; argv: string[]; uid: number | string; fd0?: Fd0; state?: string };
type World = {
  dataOwner?: number; dataMode?: number;
  // Check (1)'s other dirs (ruling F6). envMode null: no .env file.
  cronOwner?: number; cronMode?: number; envMode?: number | null; homesOwner?: number; homesMode?: number;
  sockets?: { name: string; owner: number }[];
  procs?: Proc[];
};

const fsError = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });

// The argv TerminalManager gives both the dtach client and its forked master.
const dtachArgv = (sock: string) => [DTACH_BIN, "-A", join(DTACH, sock), "-E", "-z", "-r", "winch", "claude"];

function fakeFs(w: World): HardenedFs {
  const owners = new Map<string, number>([
    [DATA, w.dataOwner ?? SELF], [CRON, w.cronOwner ?? SELF], [HOMES, w.homesOwner ?? 0],
  ]);
  const modes = new Map<string, number>([
    [DATA, w.dataMode ?? 0o40700], [CRON, w.cronMode ?? 0o40700], [HOMES, w.homesMode ?? 0o43770],
  ]);
  if (w.envMode !== null) {
    owners.set(ENVFILE, SELF);
    modes.set(ENVFILE, w.envMode ?? 0o100600);
  }
  const dirs = new Map<string, string[]>();
  const files = new Map<string, string>();
  const links = new Map<string, Fd0>();
  const sockets = w.sockets ?? [];
  dirs.set(DTACH, [...sockets.map((s) => s.name), "choibot-a1.scrollback"]);
  for (const s of sockets) owners.set(join(DTACH, s.name), s.owner);
  const procs = w.procs ?? [];
  dirs.set(PROC, ["1", "self", "sys", ...procs.map((p) => String(p.pid))]);
  files.set(join(PROC, "1", "cmdline"), "/sbin/init\0splash\0");
  files.set(join(PROC, "1", "status"), "Name:\tsystemd\nUid:\t0\t0\t0\t0\n");
  for (const p of procs) {
    files.set(join(PROC, String(p.pid), "cmdline"), p.argv.join("\0") + "\0");
    const uid = typeof p.uid === "number" ? `${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}` : p.uid;
    files.set(join(PROC, String(p.pid), "status"), `Name:\tdtach\nState:\t${p.state ?? "S (sleeping)"}\nUid:\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`);
    if (p.fd0 !== undefined) links.set(join(PROC, String(p.pid), "fd", "0"), p.fd0);
  }
  const get = <T>(m: Map<string, T>, p: string): T => {
    const v = m.get(p);
    if (v === undefined) throw fsError("ENOENT", p);
    return v;
  };
  return {
    ownerUid: (p) => get(owners, p),
    linkOwnerUid: (p) => get(owners, p),
    mode: (p) => get(modes, p),
    readdir: (p) => get(dirs, p),
    readFile: (p) => get(files, p),
    readlink: (p) => {
      const v = get(links, p);
      if (typeof v !== "string") throw fsError(v.error, p);
      return v;
    },
  };
}

const facts = (w: World = {}, over: Partial<HardenedFacts> = {}): HardenedFacts => ({
  dataDir: DATA, cronDir: CRON, envFile: ENVFILE, homeRoot: HOMES, selfUid: SELF, agentUid: AGENT, dtachDir: DTACH,
  procRoot: PROC, agentExec: true, codeRouteGate: true, fs: fakeFs(w), ...over,
});

// A hardened agent session: an agent-uid socket, the agent-uid master (whose
// fd/0 the console cannot read) and the console's own client on a pts.
const goodSession = (id: string, pid: number): World => ({
  sockets: [{ name: `choibot-${id}.sock`, owner: AGENT }],
  procs: [
    { pid, argv: dtachArgv(`choibot-${id}.sock`), uid: AGENT, fd0: { error: "EACCES" } },
    { pid: pid + 1, argv: dtachArgv(`choibot-${id}.sock`), uid: SELF, fd0: "/dev/pts/3" },
  ],
});

afterEach(() => setCodeRouteGate(false));

describe("parseAgentUid", () => {
  it("parses a decimal uid", () => {
    expect(parseAgentUid("1001")).toBe(1001);
    expect(parseAgentUid(" 1001\n")).toBe(1001);
  });
  it("rejects unset, empty, non-numeric, negative, root and out-of-range values", () => {
    for (const raw of [undefined, "", "  ", "abc", "1001x", "-1", "1.5", "0", "01001", "4294967295", "99999999999"]) {
      expect(parseAgentUid(raw), String(raw)).toBeNull();
    }
  });
});

describe("hardenedDeployment", () => {
  const ACTIVE = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };

  it("is true with the chief active and a valid CHIEF_AGENT_UID", () => {
    expect(hardenedDeployment({ ...ACTIVE, CHIEF_AGENT_UID: "1001" })).toBe(true);
    expect(hardenedDeployment({ ...ACTIVE, CHIEF_AGENT_UID: " 1001\n" })).toBe(true);
  });

  it("is false when not hardened: flag off, misconfigured, uid unset or invalid (rollback)", () => {
    expect(hardenedDeployment({})).toBe(false);
    expect(hardenedDeployment({ CHIEF_AGENT_UID: "1001" })).toBe(false);
    expect(hardenedDeployment({ ...ACTIVE, CHIEF_ENABLED: "0", CHIEF_AGENT_UID: "1001" })).toBe(false);
    expect(hardenedDeployment({ ...ACTIVE, CHIEF_CONSOLE_URL: undefined, CHIEF_AGENT_UID: "1001" })).toBe(false);
    expect(hardenedDeployment(ACTIVE)).toBe(false);
    for (const raw of ["", "0", "abc", "-1", "1001x"]) {
      expect(hardenedDeployment({ ...ACTIVE, CHIEF_AGENT_UID: raw }), raw).toBe(false);
    }
  });

  it("reads process.env by default (CHIEF_* scrubbed by vitest.setup.ts)", () => {
    expect(hardenedDeployment()).toBe(false);
  });
});

describe("codeRouteGate", () => {
  it("is false until set", () => {
    expect(codeRouteGate()).toBe(false);
    setCodeRouteGate(true);
    expect(codeRouteGate()).toBe(true);
    setCodeRouteGate(false);
    expect(codeRouteGate()).toBe(false);
  });
});

describe("checkHardened", () => {
  it("all facts good and the code-route gate on → strong", () => {
    const r = checkHardened(facts(goodSession("a1", 200)));
    expect(r).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
  });

  // Ruling F3: check (4) is armed only with the agent exec helper; a failed
  // probe is its own reason.
  it("no agent exec (the helper probe failed) → weak: agent exec unavailable", () => {
    expect(checkHardened(facts(goodSession("a1", 200), { agentExec: false, codeRouteGate: false }))).toEqual({
      strong: false, reasons: ["agent exec unavailable", "code-route gate off"], consoleUidAgents: [],
    });
    expect(checkHardened(facts(goodSession("a1", 200), { agentExec: false })).reasons).toEqual(["agent exec unavailable"]);
  });

  // Ruling F6: check (1) also requires CRON_DATA_DIR console-owned 0700, the
  // console checkout's .env 0600 (when it exists) and AGENT_HOME_ROOT (when
  // set) not owned by CHIEF_AGENT_UID and mode 3770. One named reason each.
  it("check (1): the cron dir, .env and AGENT_HOME_ROOT, each a named reason", () => {
    expect(checkHardened(facts({ cronMode: 0o40755 })).reasons).toEqual([`cron dir ${CRON} mode 0755, want 0700`]);
    expect(checkHardened(facts({ cronOwner: AGENT })).reasons).toEqual([`cron dir ${CRON} owner uid ${AGENT}, want ${SELF}`]);
    expect(checkHardened(facts({ envMode: 0o100644 })).reasons).toEqual([`.env ${ENVFILE} mode 0644, want 0600`]);
    expect(checkHardened(facts({ homesOwner: AGENT })).reasons).toEqual([`homes ${HOMES} owner uid ${AGENT} is CHIEF_AGENT_UID`]);
    expect(checkHardened(facts({ homesMode: 0o42770 })).reasons).toEqual([`homes ${HOMES} mode 2770, want 3770`]);
    expect(checkHardened(facts({}, { cronDir: "/fx/none" })).reasons).toEqual(["cron dir /fx/none unreadable (ENOENT)"]);
    expect(checkHardened(facts({}, { homeRoot: "/fx/none" })).reasons).toEqual(["homes /fx/none unreadable (ENOENT)"]);
  });

  it("check (1): no .env and no AGENT_HOME_ROOT are fine; the console uid may own the homes root", () => {
    expect(checkHardened(facts({ envMode: null }, { homeRoot: null })).strong).toBe(true);
    expect(checkHardened(facts({ homesOwner: SELF })).strong).toBe(true);
  });

  it("an agent-uid master with an unreadable fd/0 (EACCES) is ok by uid alone", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 200, argv: dtachArgv("choibot-a1.sock"), uid: AGENT, fd0: { error: "EACCES" } }],
    }));
    expect(r.strong).toBe(true);
  });

  it("a console-uid client with fd/0 → /dev/pts/3 is ok", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 201, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/pts/3" }],
    }));
    expect(r.strong).toBe(true);
  });

  it("a console-uid process with an unreadable fd/0 → weak, agent listed", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 202, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: { error: "EACCES" } }],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
    expect(r.reasons).toEqual(["agent a1: console-uid dtach pid 202 fd/0 unreadable (EACCES)"]);
  });

  it("a console-uid process whose fd/0 is missing (fd 0 closed) → weak", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 202, argv: dtachArgv("choibot-a1.sock"), uid: SELF }],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
  });

  it("a console-uid master with fd/0 → /dev/null → weak, agent listed", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [
        { pid: 203, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/null" },
        { pid: 204, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/pts/3" },
      ],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
    expect(r.reasons).toEqual(["agent a1: console-uid dtach pid 203 fd/0 is /dev/null"]);
  });

  it("a socket owned by the console uid → weak, agent listed", () => {
    const r = checkHardened(facts({ sockets: [{ name: "choibot-a1.sock", owner: SELF }] }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
    expect(r.reasons).toEqual([`agent a1: socket owner uid ${SELF}, want ${AGENT}`]);
  });

  it("a choibot-svc-* socket owned by the console uid is skipped", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-svc-x.sock", owner: SELF }],
      procs: [
        { pid: 210, argv: dtachArgv("choibot-svc-x.sock"), uid: SELF, fd0: "/dev/null" },
        { pid: 211, argv: dtachArgv("choibot-svc-x.sock"), uid: SELF, fd0: "/dev/pts/4" },
      ],
    }));
    expect(r).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
  });

  it("a dtach process under a third uid → weak", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 205, argv: dtachArgv("choibot-a1.sock"), uid: 0, fd0: "/dev/null" }],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
    expect(r.reasons).toEqual(["agent a1: dtach pid 205 runs as uid 0"]);
  });

  it("uses the first (real) field of the Uid: line", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 206, argv: dtachArgv("choibot-a1.sock"), uid: `${SELF}\t${AGENT}\t${AGENT}\t${AGENT}`, fd0: "/dev/null" }],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
  });

  it("ignores non-dtach processes and dtach processes of other sockets", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [
        // sudo's argv names the socket too, but it is not dtach.
        { pid: 220, argv: ["/usr/bin/sudo", "-n", "-u", `#${AGENT}`, "choibot-agent-exec", "spawn", join(DTACH, "choibot-a1.sock")], uid: SELF, fd0: "/dev/null" },
        { pid: 221, argv: dtachArgv("choibot-svc-x.sock"), uid: SELF, fd0: "/dev/null" },
        // The user's own dtach session outside the dtach dir.
        { pid: 222, argv: [DTACH_BIN, "-A", "/tmp/mine.sock", "bash"], uid: SELF, fd0: "/dev/null" },
      ],
    }));
    expect(r.strong).toBe(true);
  });

  it("a live console-uid master whose socket was unlinked or renamed → weak, agent listed", () => {
    const master = { pid: 203, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/null" };
    const want = { strong: false, reasons: ["agent a1: console-uid dtach pid 203 fd/0 is /dev/null"], consoleUidAgents: ["a1"] };
    expect(checkHardened(facts({ procs: [master] }))).toEqual(want); // unlinked
    expect(checkHardened(facts({ sockets: [{ name: "choibot-a1.gone", owner: SELF }], procs: [master] }))).toEqual(want);
  });

  it("a socket renamed to choibot-svc-x.sock while its master's argv names choibot-a1.sock → weak", () => {
    const r = checkHardened(facts({
      sockets: [{ name: "choibot-svc-x.sock", owner: SELF }],
      procs: [{ pid: 203, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/null" }],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
  });

  it("a console-uid process that is a zombie (State Z or X) is gone, not weak", () => {
    for (const state of ["Z (zombie)", "X (dead)"]) {
      const r = checkHardened(facts({
        sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
        procs: [{ pid: 230, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: { error: "EACCES" }, state }],
      }));
      expect(r, state).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
    }
  });

  it("a cmdline read error other than ENOENT/ESRCH → weak; ENOENT/ESRCH → gone", () => {
    const fs = fakeFs({});
    const cmdline = (code: string): HardenedFs => ({
      ...fs,
      readdir: (p) => (p === PROC ? ["1", "240"] : fs.readdir(p)),
      readFile: (p) => { if (p === join(PROC, "240", "cmdline")) throw fsError(code, p); return fs.readFile(p); },
    });
    expect(checkHardened(facts({}, { fs: cmdline("ENOENT") })).strong).toBe(true);
    expect(checkHardened(facts({}, { fs: cmdline("ESRCH") })).strong).toBe(true);
    expect(checkHardened(facts({}, { fs: cmdline("EACCES") }))).toEqual({
      strong: false, reasons: [`${PROC}: cmdline unreadable (EACCES) for pid 240`], consoleUidAgents: [],
    });
  });

  it("checks every agent socket and lists each weak one once", () => {
    const a1 = goodSession("a1", 200);
    const r = checkHardened(facts({
      sockets: [...a1.sockets!, { name: "choibot-b2.sock", owner: AGENT }, { name: "choibot-c3.sock", owner: SELF }],
      procs: [
        ...a1.procs!,
        { pid: 300, argv: dtachArgv("choibot-b2.sock"), uid: SELF, fd0: "/dev/null" },
        { pid: 301, argv: dtachArgv("choibot-b2.sock"), uid: SELF, fd0: { error: "EACCES" } },
      ],
    }));
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["b2", "c3"]);
  });

  it("a process that exits between the scan and its status read is skipped", () => {
    const w: World = { sockets: [{ name: "choibot-a1.sock", owner: AGENT }] };
    const fs = fakeFs(w);
    const gone: HardenedFs = {
      ...fs,
      readdir: (p) => (p === PROC ? ["1", "207"] : fs.readdir(p)),
      readFile: (p) => {
        if (p === join(PROC, "207", "cmdline")) return dtachArgv("choibot-a1.sock").join("\0");
        return fs.readFile(p); // status of 207: ENOENT
      },
    };
    expect(checkHardened(facts(w, { fs: gone })).strong).toBe(true);
  });

  it("a console-uid process that exits after its fd/0 read failed is skipped", () => {
    const w: World = {
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 208, argv: dtachArgv("choibot-a1.sock"), uid: SELF }], // no fd/0 link
    };
    const fs = fakeFs(w);
    let statusReads = 0;
    const exiting: HardenedFs = {
      ...fs,
      readFile: (p) => {
        if (p === join(PROC, "208", "status") && ++statusReads > 1) throw fsError("ENOENT", p);
        return fs.readFile(p);
      },
    };
    expect(checkHardened(facts(w, { fs: exiting })).strong).toBe(true);
    expect(statusReads).toBe(2);
  });

  it("an unreadable status or one with no Uid: line → weak", () => {
    const w: World = {
      sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
      procs: [{ pid: 209, argv: dtachArgv("choibot-a1.sock"), uid: AGENT }],
    };
    const fs = fakeFs(w);
    const status = join(PROC, "209", "status");
    const denied: HardenedFs = { ...fs, readFile: (p) => { if (p === status) throw fsError("EACCES", p); return fs.readFile(p); } };
    expect(checkHardened(facts(w, { fs: denied }))).toEqual({
      strong: false, reasons: ["agent a1: dtach pid 209 status unreadable (EACCES)"], consoleUidAgents: ["a1"],
    });
    const noUid: HardenedFs = { ...fs, readFile: (p) => (p === status ? "Name:\tdtach\n" : fs.readFile(p)) };
    expect(checkHardened(facts(w, { fs: noUid })).reasons).toEqual(["agent a1: dtach pid 209 status has no Uid line"]);
  });

  it("a socket that vanished since the listing is skipped; an unreadable one → weak", () => {
    const w: World = { sockets: [{ name: "choibot-a1.sock", owner: AGENT }] };
    const fs = fakeFs(w);
    const sock = join(DTACH, "choibot-a1.sock");
    const owner = (code: string): HardenedFs => ({ ...fs, linkOwnerUid: (p) => { if (p === sock) throw fsError(code, p); return fs.linkOwnerUid(p); } });
    expect(checkHardened(facts(w, { fs: owner("ENOENT") })).strong).toBe(true);
    expect(checkHardened(facts(w, { fs: owner("EACCES") }))).toEqual({
      strong: false, reasons: ["agent a1: socket unreadable (EACCES)"], consoleUidAgents: ["a1"],
    });
  });

  it("no dtach dir (no live sessions) → strong; an unreadable dtach dir → weak", () => {
    const fs = fakeFs({});
    const missing: HardenedFs = { ...fs, readdir: (p) => { if (p === DTACH) throw fsError("ENOENT", p); return fs.readdir(p); } };
    expect(checkHardened(facts({}, { fs: missing })).strong).toBe(true);
    const denied: HardenedFs = { ...fs, readdir: (p) => { if (p === DTACH) throw fsError("EACCES", p); return fs.readdir(p); } };
    const r = checkHardened(facts({}, { fs: denied }));
    expect(r.strong).toBe(false);
    expect(r.reasons).toEqual([`dtach dir ${DTACH} unreadable (EACCES)`]);
  });

  it("an unreadable /proc with a live agent socket → weak", () => {
    const w: World = { sockets: [{ name: "choibot-a1.sock", owner: AGENT }] };
    const fs = fakeFs(w);
    const denied: HardenedFs = { ...fs, readdir: (p) => { if (p === PROC) throw fsError("EACCES", p); return fs.readdir(p); } };
    const r = checkHardened(facts(w, { fs: denied }));
    expect(r.strong).toBe(false);
    expect(r.reasons).toEqual([`${PROC} unreadable (EACCES)`]);
  });

  it("codeRouteGate: false → weak with a reason", () => {
    const r = checkHardened(facts(goodSession("a1", 200), { codeRouteGate: false }));
    expect(r).toEqual({ strong: false, reasons: ["code-route gate off"], consoleUidAgents: [] });
  });

  it("agentUid: null → weak; env var alone never flips strong (agentUid === selfUid → weak)", () => {
    const unset = checkHardened(facts({}, { agentUid: null }));
    expect(unset.strong).toBe(false);
    expect(unset.reasons).toEqual(["CHIEF_AGENT_UID not set or invalid"]);
    const same = checkHardened(facts({ sockets: [{ name: "choibot-a1.sock", owner: SELF }] }, { agentUid: SELF }));
    expect(same.strong).toBe(false);
    expect(same.reasons).toEqual([`CHIEF_AGENT_UID equals the console uid ${SELF}`]);
  });

  it("data dir mode 0750 → weak", () => {
    const r = checkHardened(facts({ dataMode: 0o40750 }));
    expect(r.strong).toBe(false);
    expect(r.reasons).toEqual([`data dir ${DATA} mode 0750, want 0700`]);
  });

  it("data dir owned by another uid or missing → weak", () => {
    expect(checkHardened(facts({ dataOwner: AGENT })).reasons).toEqual([`data dir ${DATA} owner uid ${AGENT}, want ${SELF}`]);
    const fs = fakeFs({});
    const missing: HardenedFs = { ...fs, ownerUid: (p) => { if (p === DATA) throw fsError("ENOENT", p); return fs.ownerUid(p); } };
    expect(checkHardened(facts({}, { fs: missing })).reasons).toEqual([`data dir ${DATA} unreadable (ENOENT)`]);
  });

  it("collects every failing check's reason", () => {
    const r = checkHardened(facts({ dataMode: 0o755, sockets: [{ name: "choibot-a1.sock", owner: SELF }] }, { codeRouteGate: false }));
    expect(r.reasons).toEqual([
      `data dir ${DATA} mode 0755, want 0700`,
      `agent a1: socket owner uid ${SELF}, want ${AGENT}`,
      "code-route gate off",
    ]);
  });
});

describe("privateDirReasons", () => {
  it("none for a console-owned 0700 dir; owner, mode and read errors otherwise, labelled", () => {
    expect(privateDirReasons("cron dir", DATA, SELF, fakeFs({}))).toEqual([]);
    expect(privateDirReasons("cron dir", DATA, SELF, fakeFs({ dataOwner: AGENT, dataMode: 0o40755 }))).toEqual([
      `cron dir ${DATA} owner uid ${AGENT}, want ${SELF}`, `cron dir ${DATA} mode 0755, want 0700`,
    ]);
    expect(privateDirReasons("cron dir", "/fx/none", SELF, fakeFs({}))).toEqual(["cron dir /fx/none unreadable (ENOENT)"]);
  });
});

// Ruling F1: a console-uid claude (distill, cron runner) loads only a Claude
// config dir and settings.json that are its own and that no group can write.
describe("claudeConfigProblem", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "claude-cfg-"));
    dirs.push(d);
    return d;
  };
  const self = process.getuid!();

  it("null for an own dir and settings.json no group can write, and for a missing dir or settings.json", () => {
    const d = tmp();
    chmodSync(d, 0o700);
    expect(claudeConfigProblem(d, self)).toBeNull();
    writeFileSync(join(d, "settings.json"), "{}", { mode: 0o600 });
    chmodSync(join(d, "settings.json"), 0o644);
    expect(claudeConfigProblem(d, self)).toBeNull();
    expect(claudeConfigProblem(join(d, "none"), self)).toBeNull();
  });

  it("a group- or other-writable dir or settings.json, or another owner: one reason", () => {
    const d = tmp();
    chmodSync(d, 0o770);
    expect(claudeConfigProblem(d, self)).toBe(`${d} mode 0770 is group- or other-writable`);
    chmodSync(d, 0o700);
    writeFileSync(join(d, "settings.json"), "{}");
    chmodSync(join(d, "settings.json"), 0o666);
    expect(claudeConfigProblem(d, self)).toBe(`${join(d, "settings.json")} mode 0666 is group- or other-writable`);
    chmodSync(join(d, "settings.json"), 0o600);
    expect(claudeConfigProblem(d, self + 1)).toBe(`${d} owner uid ${self}, want ${self + 1}`);
  });

  it("follows a symlinked settings.json to its target (a named account's shadow dir)", () => {
    const d = tmp();
    chmodSync(d, 0o700);
    const target = join(tmp(), "settings.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o664);
    symlinkSync(target, join(d, "settings.json"));
    expect(claudeConfigProblem(d, self)).toBe(`${join(d, "settings.json")} mode 0664 is group- or other-writable`);
  });
});

describe("agentSessionUids", () => {
  it("per agent id the uids of its dtach processes, the console's own pts clients left out", () => {
    const w = goodSession("a1", 300);
    expect(agentSessionUids(facts(w))).toEqual([{ id: "a1", uids: [AGENT] }]);
  });
  it("a console-uid master (fd/0 /dev/null or unreadable) is listed; several uids ascending; ids sorted", () => {
    const w: World = { procs: [
      { pid: 501, argv: dtachArgv("choibot-b2.sock"), uid: SELF, fd0: "/dev/null" },
      { pid: 502, argv: dtachArgv("choibot-b2.sock"), uid: AGENT, fd0: { error: "EACCES" } },
      { pid: 401, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: { error: "EACCES" } },
    ] };
    expect(agentSessionUids(facts(w))).toEqual([{ id: "a1", uids: [SELF] }, { id: "b2", uids: [SELF, AGENT] }]);
  });
  it("skips service sockets, sockets outside the dtach dir, zombies and unreadable status; never throws", () => {
    const w: World = { procs: [
      { pid: 601, argv: dtachArgv("choibot-svc-web.sock"), uid: SELF, fd0: "/dev/null" },
      { pid: 602, argv: [DTACH_BIN, "-A", "/elsewhere/choibot-a1.sock", "claude"], uid: AGENT },
      { pid: 603, argv: dtachArgv("choibot-c3.sock"), uid: AGENT, state: "Z (zombie)" },
      { pid: 604, argv: dtachArgv("choibot-d4.sock"), uid: "x" },
    ] };
    expect(agentSessionUids(facts(w))).toEqual([]);
    expect(agentSessionUids(facts({}, { procRoot: "/fx/no-proc" }))).toEqual([]);
  });
});

// The default HardenedFs (node:fs) on a fixture tree in a temp dir: a fake
// /proc and dtach dir built from real files and symlinks. The agent uid is
// the owner of "/" (a uid the test does not run as); a test cannot create a
// file owned by it, so the process checks run with no socket file, which the
// argv-driven pass covers.
describe("checkHardened with the node:fs default", () => {
  const self = process.getuid!();
  const rootOwner = statSync("/").uid;
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

  function tree() {
    root = mkdtempSync(join(tmpdir(), "chief-hardened-"));
    const data = join(root, "chief");
    const dtach = join(root, "dtach");
    const proc = join(root, "proc");
    const cron = join(root, "cron");
    mkdirSync(data, { mode: 0o700 });
    chmodSync(data, 0o700);
    mkdirSync(cron, { mode: 0o700 });
    chmodSync(cron, 0o700);
    mkdirSync(dtach);
    mkdirSync(proc);
    const sock = join(dtach, "choibot-a1.sock");
    const proc1 = (pid: number, uid: number, fd0: string) => {
      mkdirSync(join(proc, String(pid), "fd"), { recursive: true });
      writeFileSync(join(proc, String(pid), "cmdline"), ["/usr/bin/dtach", "-A", sock, "claude"].join("\0") + "\0");
      writeFileSync(join(proc, String(pid), "status"), `Name:\tdtach\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      symlinkSync(fd0, join(proc, String(pid), "fd", "0"));
    };
    const f = (over: Partial<HardenedFacts> = {}): HardenedFacts => ({
      dataDir: data, cronDir: cron, envFile: join(root, ".env"), homeRoot: null,
      selfUid: self, agentUid: rootOwner, dtachDir: dtach, procRoot: proc, agentExec: true, codeRouteGate: true, ...over,
    });
    return { data, dtach, sock, proc1, f };
  }

  it.runIf(rootOwner !== self)("reads owners, modes, dirs, files and links from disk", () => {
    const t = tree();
    expect(checkHardened(t.f())).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });

    chmodSync(t.data, 0o750);
    expect(checkHardened(t.f()).reasons).toEqual([`data dir ${t.data} mode 0750, want 0700`]);
    chmodSync(t.data, 0o700);

    // Ruling F6: the console's .env, when there is one, is 0600.
    writeFileSync(join(root, ".env"), "X=1\n");
    chmodSync(join(root, ".env"), 0o644);
    expect(checkHardened(t.f()).reasons).toEqual([`.env ${join(root, ".env")} mode 0644, want 0600`]);
    chmodSync(join(root, ".env"), 0o600);
    expect(checkHardened(t.f()).strong).toBe(true);

    // A plain socket file the test wrote is owned by the console uid.
    const ownerReason = `agent a1: socket owner uid ${self}, want ${rootOwner}`;
    writeFileSync(t.sock, "");
    expect(checkHardened(t.f()).reasons).toEqual([ownerReason]);
    rmSync(t.sock);
    // A symlink to the agent-owned "/" is still ours: the owner check does
    // not follow it.
    symlinkSync("/", t.sock);
    expect(checkHardened(t.f()).reasons).toEqual([ownerReason]);
    rmSync(t.sock);

    // No socket file: the agent-uid master and the console's own client on a
    // pts pass; a console-uid master on /dev/null fails.
    t.proc1(500, rootOwner, "/dev/null");
    t.proc1(501, self, "/dev/pts/9");
    expect(checkHardened(t.f()).strong).toBe(true);
    t.proc1(502, self, "/dev/null");
    expect(checkHardened(t.f())).toEqual({
      strong: false, reasons: ["agent a1: console-uid dtach pid 502 fd/0 is /dev/null"], consoleUidAgents: ["a1"],
    });
  });

  it("a missing dtach dir means no live sessions", () => {
    const t = tree();
    rmSync(t.dtach, { recursive: true });
    expect(checkHardened(t.f({ agentUid: self + 1 }))).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
  });
});

describe("HardenedMonitor", () => {
  function fakeTimers() {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const setTimer = (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => { t.cleared = true; } };
    };
    const live = () => timers.filter((t) => !t.cleared);
    const tick = () => {
      const t = live().at(-1)!;
      t.cleared = true;
      t.fn();
    };
    return { timers, setTimer, live, tick };
  }

  function monitor(initial: HardenedFacts) {
    const hub = new EventHub();
    const timers = fakeTimers();
    const logs: string[] = [];
    let current = initial;
    let calls = 0;
    const m = new HardenedMonitor({
      facts: () => { calls++; return current; },
      hub, log: (s) => logs.push(s), setTimer: timers.setTimer,
    });
    return {
      m, hub, timers, logs,
      calls: () => calls,
      set: (f: HardenedFacts) => { current = f; },
      sessionStart: (agentId: string) => hub.emitEvent({ type: "agent-hook", agentId, event: "SessionStart", source: "startup" }),
    };
  }

  const weakA1 = (): World => ({
    sockets: [{ name: "choibot-a1.sock", owner: AGENT }],
    procs: [{ pid: 203, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/null" }],
  });

  it("is not strong before its first check; start checks once", () => {
    const t = monitor(facts(goodSession("a1", 200)));
    expect(t.m.strong()).toBe(false);
    expect(t.m.report().strong).toBe(false);
    const stop = t.m.start();
    expect(t.calls()).toBe(1);
    expect(t.m.strong()).toBe(true);
    expect(t.m.report()).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
    stop();
  });

  it("a weak agent found once keeps strong() false after the facts turn good", () => {
    const t = monitor(facts(weakA1()));
    const stop = t.m.start();
    expect(t.m.strong()).toBe(false);
    t.set(facts(goodSession("a1", 200)));
    t.timers.tick();
    expect(t.calls()).toBe(2);
    expect(t.m.strong()).toBe(false);
    const r = t.m.report();
    expect(r.strong).toBe(false);
    expect(r.consoleUidAgents).toEqual(["a1"]);
    expect(r.reasons).toEqual(["weak until restart: a1 ran outside CHIEF_AGENT_UID"]);
    // A new monitor (next boot) starts clean.
    const next = monitor(facts(goodSession("a1", 200)));
    next.m.start()();
    expect(next.m.strong()).toBe(true);
    stop();
  });

  it("logs each weak agent id once", () => {
    const t = monitor(facts(weakA1()));
    const stop = t.m.start();
    t.timers.tick();
    t.timers.tick();
    expect(t.calls()).toBe(3);
    expect(t.logs).toEqual(["[chief] user auth weak until restart: agent a1 does not run as CHIEF_AGENT_UID"]);
    stop();
  });

  it("a weakness that is not an agent (gate off) clears when the facts turn good", () => {
    const t = monitor(facts(goodSession("a1", 200), { codeRouteGate: false }));
    const stop = t.m.start();
    expect(t.m.strong()).toBe(false);
    t.set(facts(goodSession("a1", 200)));
    t.timers.tick();
    expect(t.m.strong()).toBe(true);
    expect(t.logs).toEqual([]);
    stop();
  });

  it("the first SessionStart of agent a1 runs a check, a second one does not", () => {
    const t = monitor(facts(goodSession("a1", 200)));
    const stop = t.m.start();
    expect(t.calls()).toBe(1);
    t.sessionStart("a1");
    expect(t.calls()).toBe(2);
    t.sessionStart("a1");
    expect(t.calls()).toBe(2);
    t.sessionStart("a2");
    expect(t.calls()).toBe(3);
    stop();
  });

  it("other hooks and events run no check", () => {
    const t = monitor(facts(goodSession("a1", 200)));
    const stop = t.m.start();
    t.hub.emitEvent({ type: "agent-hook", agentId: "a1", event: "Stop" });
    t.hub.emitEvent({ type: "agent-hook", agentId: "a1", event: "UserPromptSubmit" });
    t.hub.emitEvent({ type: "agent-status", agentId: "a1", status: "idle" });
    expect(t.calls()).toBe(1);
    // A Stop before the first SessionStart does not use up the trigger.
    t.sessionStart("a1");
    expect(t.calls()).toBe(2);
    stop();
  });

  it("a SessionStart check picks up a newly weak agent", () => {
    const t = monitor(facts(goodSession("a1", 200)));
    const stop = t.m.start();
    expect(t.m.strong()).toBe(true);
    t.set(facts(weakA1()));
    t.sessionStart("a1");
    expect(t.m.strong()).toBe(false);
    expect(t.m.report().consoleUidAgents).toEqual(["a1"]);
    stop();
  });

  it("a timer tick runs a check and re-arms the 5-minute timer", () => {
    const t = monitor(facts(goodSession("a1", 200)));
    const stop = t.m.start();
    expect(t.timers.live().map((x) => x.ms)).toEqual([300_000]);
    t.timers.tick();
    expect(t.calls()).toBe(2);
    expect(t.timers.live().map((x) => x.ms)).toEqual([300_000]);
    t.timers.tick();
    expect(t.calls()).toBe(3);
    stop();
  });

  it("honours intervalMs", () => {
    const timers = fakeTimers();
    const m = new HardenedMonitor({ facts: () => facts(), hub: new EventHub(), intervalMs: 1_000, setTimer: timers.setTimer, log: () => {} });
    const stop = m.start();
    expect(timers.live().map((x) => x.ms)).toEqual([1_000]);
    stop();
  });

  it("stop unsubscribes and clears the timer", () => {
    const t = monitor(facts(goodSession("a1", 200)));
    const stop = t.m.start();
    stop();
    expect(t.timers.live()).toEqual([]);
    t.sessionStart("a1");
    expect(t.calls()).toBe(1);
  });

  it("a facts() that throws logs and reads as weak, never throws", () => {
    const logs: string[] = [];
    const timers = fakeTimers();
    const m = new HardenedMonitor({
      facts: () => { throw new Error("no getuid"); },
      hub: new EventHub(), log: (s) => logs.push(s), setTimer: timers.setTimer,
    });
    const stop = m.start();
    expect(m.strong()).toBe(false);
    expect(m.report()).toEqual({ strong: false, reasons: ["check failed: no getuid"], consoleUidAgents: [] });
    expect(logs).toEqual(["[chief] hardened check failed: no getuid"]);
    expect(timers.live()).toHaveLength(1);
    stop();
  });
});
