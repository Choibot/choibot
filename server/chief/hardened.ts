// server/chief/hardened.ts — chiefHardened (spec §3): decides from live facts,
// never an env var alone, whether USER level is an identity ("strong": agents
// run under their own uid and cannot forge the user) or only a mistake guard
// ("weak"). Kept out of paths.ts, which must stay import-light (plan
// decision 1).
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EventHub } from "../events.js";
import type { ChiefFacts } from "./chiefaccount.js";
import { isChiefId } from "./chiefids.js";
import { chiefActive } from "./paths.js";
import { names } from "../names.mjs";

// Every method throws on error, as node:fs does (`code` on the error).
// ownerUid and mode follow a symlink (the data dir); linkOwnerUid does not
// (a socket entry: a symlink to an agent-owned file must not pass).
export type HardenedFs = {
  ownerUid(p: string): number; linkOwnerUid(p: string): number; mode(p: string): number;
  // The group of a folder (followed). Optional: a test fs without it skips the group compares.
  gid?(p: string): number;
  readdir(p: string): string[]; readFile(p: string): string; readlink(p: string): string;
};
// cronDir, envFile (the console checkout's .env) and homeRoot (AGENT_HOME_ROOT,
// null when unset) join the data dir in check (1) (ruling F6); agentExec: the
// helper probe passed (ruling F3). The server and `choibot doctor` both give them.
export type HardenedFacts = {
  dataDir: string; cronDir: string; envFile: string; homeRoot: string | null;
  selfUid: number; agentUid: number | null; dtachDir: string;
  procRoot?: string; agentExec: boolean; codeRouteGate: boolean; fs?: HardenedFs;
  // The second account of the persistent agents (chiefaccount.ts), only when it is asked for.
  chief?: ChiefFacts;
};
export type HardenedReport = { strong: boolean; reasons: string[]; consoleUidAgents: string[] };

const nodeFs: HardenedFs = {
  ownerUid: (p) => statSync(p).uid,
  linkOwnerUid: (p) => lstatSync(p).uid,
  mode: (p) => statSync(p).mode,
  gid: (p) => statSync(p).gid,
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  readlink: (p) => readlinkSync(p),
};

// Service PTYs (svc: ids) run as the console uid by design (spec §3).
const AGENT_SOCKET_PREFIX = names().dtachPrefix;
const SERVICE_SOCKET_PREFIX = `${AGENT_SOCKET_PREFIX}svc-`;
const SOCKET_SUFFIX = ".sock";
const MAX_UID = 4294967294; // (uid_t)-1 is "no uid"

const errCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.message : String(e);
};
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const octal = (mode: number): string => "0" + (mode & 0o777).toString(8).padStart(3, "0");
// A /proc read error that means the process exited since the scan.
const isGone = (code: string): boolean => code === "ENOENT" || code === "ESRCH";

// CHIEF_AGENT_UID: a decimal uid. Root (0) never counts: a root agent can
// read and write everything the console can.
export function parseAgentUid(raw: string | undefined): number | null {
  const s = raw?.trim() ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_UID ? n : null;
}

// A hardened deployment (Phase 2c, ruling P4): the chief is active and
// CHIEF_AGENT_UID is a valid uid. The one predicate every hardened-mode path
// checks (agent exec helper, homes, gates); otherwise nothing changes. It only
// says the deployment asks for hardening: strong mode is checkHardened's call.
export function hardenedDeployment(env: Record<string, string | undefined> = process.env): boolean {
  return chiefActive(env) && parseAgentUid(env.CHIEF_AGENT_UID) !== null;
}

// Check (4): set by the server once the code-route gate is registered
// (Phase 2c). Until then chiefHardened is never true.
let gateOn = false;
export function setCodeRouteGate(on: boolean): void { gateOn = on; }
export function codeRouteGate(): boolean { return gateOn; }

// Set by the server once the agent exec helper probe passed (the same fact as
// TerminalManager's agentExec). A failed probe leaves it off: agents then run
// as the console uid, so they must not get the agent-side Claude dir.
let helperOn = false;
export function setAgentHelper(on: boolean): void { helperOn = on; }
// True when claude launches go through the helper (agent uid): hardened
// deployment and probe passed. The one predicate for the agent Claude dir.
export function helperSpawn(env: Record<string, string | undefined> = process.env): boolean {
  return helperOn && hardenedDeployment(env);
}

type DtachProc = { pid: string; argv: string[] };

// Every dtach process (argv[0] basename "dtach"), the same scan as
// dtachClientPids (server/agents/terminal.ts), plus the pids whose cmdline
// could not be read for a reason other than having exited.
function dtachProcs(fs: HardenedFs, procRoot: string): { procs: DtachProc[]; unreadable: { pid: string; code: string }[] } {
  const procs: DtachProc[] = [];
  const unreadable: { pid: string; code: string }[] = [];
  for (const pid of fs.readdir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try { argv = fs.readFile(join(procRoot, pid, "cmdline")).split("\0"); } catch (e) {
      const code = errCode(e);
      if (!isGone(code)) unreadable.push({ pid, code });
      continue;
    }
    if (basename(argv[0] ?? "") === "dtach") procs.push({ pid, argv });
  }
  return { procs, unreadable };
}

// Real uid (first of the four Uid: fields) of a pid, "gone" when the process
// exited since the scan (a zombie, State Z or X, included), or an error text.
function procUid(fs: HardenedFs, procRoot: string, pid: string): number | "gone" | { error: string } {
  let status: string;
  try { status = fs.readFile(join(procRoot, pid, "status")); } catch (e) {
    const code = errCode(e);
    return isGone(code) ? "gone" : { error: `status unreadable (${code})` };
  }
  if (/^State:\s+[ZX]\b/m.test(status)) return "gone";
  const m = /^Uid:\s+(\d+)/m.exec(status);
  return m ? Number(m[1]) : { error: "status has no Uid line" };
}

const agentIdOf = (socketName: string): string => {
  const stem = socketName.slice(0, -SOCKET_SUFFIX.length);
  return stem.startsWith(AGENT_SOCKET_PREFIX) ? stem.slice(AGENT_SOCKET_PREFIX.length) : stem;
};
const isAgentSocketName = (n: string): boolean => n.endsWith(SOCKET_SUFFIX) && !n.startsWith(SERVICE_SOCKET_PREFIX);

// The agent ids a dtach argv names: every argument that is an agent socket
// path in the dtach dir. argv keeps the path dtach started with, so a socket
// unlinked or renamed since is still found.
function argvAgentIds(argv: string[], dtachDir: string): string[] {
  const ids = new Set<string>();
  for (const a of argv.slice(1)) {
    if (dirname(a) === dtachDir && isAgentSocketName(basename(a))) ids.add(agentIdOf(basename(a)));
  }
  return [...ids];
}

// The owner of a listed socket entry (not followed): null when ok, else why.
function socketProblem(fs: HardenedFs, sock: string, agentUid: number): string | null {
  let owner: number;
  try { owner = fs.linkOwnerUid(sock); } catch (e) {
    if (errCode(e) === "ENOENT") return null; // the session ended since readdir
    return `socket unreadable (${errCode(e)})`;
  }
  return owner === agentUid ? null : `socket owner uid ${owner}, want ${agentUid}`;
}

// The fd/0 link of a pid and whether it is a pts (the console's own dtach
// client), or the read error code.
function fd0Of(fs: HardenedFs, procRoot: string, pid: string): { link: string; pts: boolean } | { code: string } {
  try {
    const link = fs.readlink(join(procRoot, pid, "fd", "0"));
    return { link, pts: link.startsWith("/dev/pts/") };
  } catch (e) {
    return { code: errCode(e) };
  }
}

// One dtach process on an agent socket: null when ok, else why.
function procProblem(fs: HardenedFs, procRoot: string, pid: string, uids: { self: number; agent: number }): string | null {
  const uid = procUid(fs, procRoot, pid);
  if (uid === "gone") return null;
  if (typeof uid !== "number") return `dtach pid ${pid} ${uid.error}`;
  if (uid === uids.agent) return null; // the master or an agent-side client
  if (uid !== uids.self) return `dtach pid ${pid} runs as uid ${uid}`;
  // A console-uid process is ok only as the console's own client on a pts.
  // An unreadable fd/0 is weak, unless the process is gone by now.
  const fd0 = fd0Of(fs, procRoot, pid);
  if ("code" in fd0) {
    if (procUid(fs, procRoot, pid) === "gone") return null;
    return `console-uid dtach pid ${pid} fd/0 unreadable (${fd0.code})`;
  }
  return fd0.pts ? null : `console-uid dtach pid ${pid} fd/0 is ${fd0.link}`;
}

// Why `dir` (followed) is not the console's own with mode 0700: check (1) for
// the data dir, and `choibot doctor` for CRON_DATA_DIR (checklist C2). Empty
// when it is; one reason when it cannot be read.
export function privateDirReasons(label: string, dir: string, selfUid: number, fs: HardenedFs = nodeFs): string[] {
  const reasons: string[] = [];
  try {
    const owner = fs.ownerUid(dir);
    const mode = fs.mode(dir);
    if (owner !== selfUid) reasons.push(`${label} ${dir} owner uid ${owner}, want ${selfUid}`);
    if ((mode & 0o777) !== 0o700) reasons.push(`${label} ${dir} mode ${octal(mode)}, want 0700`);
  } catch (e) {
    reasons.push(`${label} ${dir} unreadable (${errCode(e)})`);
  }
  return reasons;
}

// Why a console-uid claude (the distill; bin/lib/chief-cron.mjs has the cron
// runner's port) must not load the Claude config dir `dir` in a hardened
// deployment (ruling F1), or null: the dir or its settings.json (hooks,
// apiKeyHelper) is owned by another uid or is group- or other-writable, so an
// agent could put code there. Both followed, as claude reads them; a missing
// one is fine (claude makes the dir at the console's umask). One reason.
export function claudeConfigProblem(dir: string, selfUid: number, fs: HardenedFs = nodeFs): string | null {
  for (const p of [dir, join(dir, "settings.json")]) {
    let owner: number;
    let mode: number;
    try {
      owner = fs.ownerUid(p);
      mode = fs.mode(p);
    } catch (e) {
      if (errCode(e) === "ENOENT") return null;
      return `${p} unreadable (${errCode(e)})`;
    }
    if (owner !== selfUid) return `${p} owner uid ${owner}, want ${selfUid}`;
    if ((mode & 0o022) !== 0) return `${p} mode ${octal(mode)} is group- or other-writable`;
  }
  return null;
}

export type AgentSessionUids = { id: string; uids: number[] };

// The uids the live agent sessions run as, for `choibot doctor` (spec Appendix
// B step 5), from the same facts and /proc scan as check (3): per agent id,
// the uid of every dtach process whose argv names its socket in the dtach
// dir, less the console's own clients on a pts. Ids sorted, uids ascending.
// A process that exited since the scan or whose uid is unreadable is left
// out (check 3 reports those). Never throws.
export function agentSessionUids(f: HardenedFacts): AgentSessionUids[] {
  const fs = f.fs ?? nodeFs;
  const procRoot = f.procRoot ?? "/proc";
  const dir = dirname(join(f.dtachDir, SOCKET_SUFFIX));
  const byId = new Map<string, Set<number>>();
  let procs: DtachProc[];
  try { procs = dtachProcs(fs, procRoot).procs; } catch { return []; }
  for (const p of procs) {
    const ids = argvAgentIds(p.argv, dir);
    if (ids.length === 0) continue;
    const uid = procUid(fs, procRoot, p.pid);
    if (typeof uid !== "number") continue;
    // The console's own client on a pts; an unreadable fd/0 is listed.
    if (uid === f.selfUid) {
      const fd0 = fd0Of(fs, procRoot, p.pid);
      if ("pts" in fd0 && fd0.pts) continue;
    }
    for (const id of ids) {
      const set = byId.get(id) ?? new Set<number>();
      set.add(uid);
      byId.set(id, set);
    }
  }
  return [...byId.keys()].sort().map((id) => ({ id, uids: [...byId.get(id)!].sort((a, b) => a - b) }));
}

// Check (1) for the console checkout's .env (checklist C2): mode 0600 when
// it exists (followed). Empty when it is or there is none.
function envFileReasons(file: string, fs: HardenedFs): string[] {
  try {
    const mode = fs.mode(file);
    return (mode & 0o777) === 0o600 ? [] : [`.env ${file} mode ${octal(mode)}, want 0600`];
  } catch (e) {
    return errCode(e) === "ENOENT" ? [] : [`.env ${file} unreadable (${errCode(e)})`];
  }
}

// Check (1) for AGENT_HOME_ROOT (ruling 2c-7-e, checklist C3): not owned by
// the agent uid (an owner may rename entries in a sticky dir) and mode 3770
// (setgid + sticky, group-writable). Followed.
function homeRootReasons(root: string, agentUid: number | null, fs: HardenedFs): string[] {
  const reasons: string[] = [];
  try {
    const owner = fs.ownerUid(root);
    const mode = fs.mode(root) & 0o7777;
    if (agentUid !== null && owner === agentUid) reasons.push(`homes ${root} owner uid ${owner} is CHIEF_AGENT_UID`);
    if (mode !== 0o3770) reasons.push(`homes ${root} mode ${mode.toString(8).padStart(4, "0")}, want 3770`);
  } catch (e) {
    reasons.push(`homes ${root} unreadable (${errCode(e)})`);
  }
  return reasons;
}

// The second account's folders (chiefaccount.ts): its homes folder and its dtach folder are not
// owned by either agent account (an owner may rename entries in a sticky dir), have mode 3770
// (no access for others), and their group is not the workers' group (the group of the folder
// that the workers share: AGENT_HOME_ROOT, AGENT_DTACH_DIR). Followed.
function chiefDirReasons(label: string, dir: string, sharedDir: string | null, uids: { agent: number | null; chief: number | null }, fs: HardenedFs): string[] {
  const reasons: string[] = [];
  try {
    const owner = fs.ownerUid(dir);
    const mode = fs.mode(dir) & 0o7777;
    if (owner === uids.agent || owner === uids.chief) reasons.push(`${label} ${dir} owner uid ${owner} is an agents' account`);
    if (mode !== 0o3770) reasons.push(`${label} ${dir} mode ${mode.toString(8).padStart(4, "0")}, want 3770`);
    if (fs.gid && sharedDir !== null) {
      let shared: number | null = null;
      try { shared = fs.gid(sharedDir); } catch { /* the shared folder's own check says why */ }
      if (shared !== null && fs.gid(dir) === shared) reasons.push(`${label} ${dir} has the workers' group (gid ${shared})`);
    }
  } catch (e) {
    reasons.push(`${label} ${dir} unreadable (${errCode(e)})`);
  }
  return reasons;
}

// Checks (1)–(4) of spec §3. Never throws; every failure is a reason.
export function checkHardened(f: HardenedFacts): HardenedReport {
  const fs = f.fs ?? nodeFs;
  const procRoot = f.procRoot ?? "/proc";
  const reasons: string[] = [];
  const consoleUidAgents: string[] = [];

  // (1) the data dir and the cron dir are the console's own, 0700; the
  // console's .env is 0600; AGENT_HOME_ROOT, when set, is not the agent's
  // and is 3770 (ruling F6: the same facts as `choibot doctor`).
  reasons.push(...privateDirReasons("data dir", f.dataDir, f.selfUid, fs));
  reasons.push(...privateDirReasons("cron dir", f.cronDir, f.selfUid, fs));
  reasons.push(...envFileReasons(f.envFile, fs));
  if (f.homeRoot !== null) reasons.push(...homeRootReasons(f.homeRoot, f.agentUid, fs));
  // The second account, when it is asked for: set right, its helper ready, its folders closed.
  const chief = f.chief;
  if (chief) {
    if (chief.problem !== null) reasons.push(`the persistent agents' account: ${chief.problem}`);
    else if (!chief.exec) reasons.push("the persistent agents' exec unavailable");
    if (chief.testSwitch) reasons.push("test switch on (CHIEF_TEST_START_UNSIGNED): the persistent agents start without the second sign-in");
    const uids = { agent: f.agentUid, chief: chief.uid };
    if (chief.homeRoot !== null) reasons.push(...chiefDirReasons("persistent homes", chief.homeRoot, f.homeRoot, uids, fs));
    if (chief.dtachDir !== null) reasons.push(...chiefDirReasons("persistent dtach dir", chief.dtachDir, f.dtachDir, uids, fs));
  }

  // (2) a separate agent uid. (3) needs it: without one there is no uid to
  // check the sessions against, and (2) already makes the mode weak.
  const agentUid = f.agentUid;
  if (agentUid === null) reasons.push("CHIEF_AGENT_UID not set or invalid");
  else if (agentUid === f.selfUid) reasons.push(`CHIEF_AGENT_UID equals the console uid ${f.selfUid}`);

  // (3) every live agent session runs as the agent uid. First the owner of
  // each agent socket in the dtach dir; then every dtach process whose argv
  // names an agent socket there, whether or not the socket file still exists
  // (fd/0 only for console-uid ones, since /proc/<pid>/fd of an agent-uid
  // process is unreadable to us). One reason per agent id, ids sorted.
  if (agentUid !== null) {
    const weak = new Map<string, string>();
    const flag = (id: string, why: string) => { if (!weak.has(id)) weak.set(id, `agent ${id}: ${why}`); };
    // The dtach folders: the workers', and the second account's when it is asked for. join
    // normalizes each the way terminal.ts builds socket paths.
    const dirs = [{ raw: f.dtachDir, dir: dirname(join(f.dtachDir, SOCKET_SUFFIX)), chief: false }];
    if (chief?.dtachDir) dirs.push({ raw: chief.dtachDir, dir: dirname(join(chief.dtachDir, SOCKET_SUFFIX)), chief: true });
    // The uid that the session of `id` in that folder must run as, or why it may not be there.
    // With the second account asked for, a persistent agent runs only as that account, in its
    // own folder: a persistent agent under the workers' uid is weak.
    const want = (id: string, inChief: boolean): number | string => {
      if (inChief) return isChiefId(id) && chief?.uid != null ? chief.uid : "a worker's socket in the persistent agents' dtach folder";
      if (chief && isChiefId(id)) return "a persistent agent's socket in the workers' dtach folder";
      return agentUid;
    };

    for (const d of dirs) {
      let names: string[] = [];
      try { names = fs.readdir(d.raw); } catch (e) {
        if (errCode(e) !== "ENOENT") reasons.push(`dtach dir ${d.raw} unreadable (${errCode(e)})`);
      }
      for (const name of names.filter(isAgentSocketName)) {
        const id = agentIdOf(name);
        const w = want(id, d.chief);
        const why = typeof w === "string" ? w : socketProblem(fs, join(d.dir, name), w);
        if (why !== null) flag(id, why);
      }
    }

    try {
      const scan = dtachProcs(fs, procRoot);
      const [first] = scan.unreadable;
      if (first) {
        const more = scan.unreadable.length - 1;
        reasons.push(`${procRoot}: cmdline unreadable (${first.code}) for pid ${first.pid}${more > 0 ? ` and ${more} more` : ""}`);
      }
      for (const p of scan.procs) {
        for (const d of dirs) {
          for (const id of argvAgentIds(p.argv, d.dir).filter((x) => !weak.has(x))) {
            const w = want(id, d.chief);
            const why = typeof w === "string" ? w : procProblem(fs, procRoot, p.pid, { self: f.selfUid, agent: w });
            if (why !== null) flag(id, why);
          }
        }
      }
    } catch (e) {
      reasons.push(`${procRoot} unreadable (${errCode(e)})`);
    }

    for (const id of [...weak.keys()].sort()) {
      reasons.push(weak.get(id)!);
      consoleUidAgents.push(id);
    }
  }

  // (4) the code-route gate is active. It is armed only once the agent exec
  // helper's probe passed (ruling F3): without it widget scripts and new
  // agents would run as the console uid.
  if (!f.agentExec) reasons.push("agent exec unavailable");
  if (!f.codeRouteGate) reasons.push("code-route gate off");

  return { strong: reasons.length === 0, reasons, consoleUidAgents };
}

type SetTimer = (fn: () => void, ms: number) => { clear(): void };

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};

const INTERVAL_MS = 300_000;
const NOT_CHECKED: HardenedReport = { strong: false, reasons: ["not checked yet"], consoleUidAgents: [] };

// Runs checkHardened at start, on each agent's first SessionStart hook (its
// socket may not exist right after pty.spawn) and every 5 minutes. An agent
// found outside the agent uid keeps the mode weak until the next boot (a new
// monitor).
export class HardenedMonitor {
  private last: HardenedReport | null = null;
  private readonly weakAgents = new Set<string>();
  private readonly started = new Set<string>();
  private readonly intervalMs: number;
  private readonly log: (s: string) => void;
  private readonly setTimer: SetTimer;

  constructor(private readonly d: {
    facts: () => HardenedFacts; hub: Pick<EventHub, "subscribe">; intervalMs?: number;
    log?: (s: string) => void; setTimer?: SetTimer;
  }) {
    this.intervalMs = d.intervalMs ?? INTERVAL_MS;
    this.log = d.log ?? ((s) => console.warn(s));
    this.setTimer = d.setTimer ?? defaultSetTimer;
  }

  start(): () => void {
    let stopped = false;
    const unsubscribe = this.d.hub.subscribe((e) => {
      if (stopped || e.type !== "agent-hook" || e.event !== "SessionStart" || this.started.has(e.agentId)) return;
      this.started.add(e.agentId);
      this.check();
    });
    let timer: { clear(): void };
    const schedule = () => {
      timer = this.setTimer(() => {
        if (stopped) return;
        this.check();
        schedule();
      }, this.intervalMs);
    };
    this.check();
    schedule();
    return () => {
      stopped = true;
      unsubscribe();
      timer.clear();
    };
  }

  strong(): boolean {
    return this.last?.strong === true && this.weakAgents.size === 0;
  }

  report(): HardenedReport {
    const last = this.last ?? NOT_CHECKED;
    const reasons = [...last.reasons];
    const earlier = [...this.weakAgents].filter((id) => !last.consoleUidAgents.includes(id));
    if (earlier.length > 0) reasons.push(`weak until restart: ${earlier.join(", ")} ran outside CHIEF_AGENT_UID`);
    return { strong: this.strong(), reasons, consoleUidAgents: [...this.weakAgents] };
  }

  private check(): void {
    let r: HardenedReport;
    try {
      r = checkHardened(this.d.facts());
    } catch (e) {
      r = { strong: false, reasons: [`check failed: ${errText(e)}`], consoleUidAgents: [] };
      this.log(`[chief] hardened check failed: ${errText(e)}`);
    }
    this.last = r;
    for (const id of r.consoleUidAgents) {
      if (this.weakAgents.has(id)) continue;
      this.weakAgents.add(id);
      this.log(`[chief] user auth weak until restart: agent ${id} does not run as CHIEF_AGENT_UID`);
    }
  }
}
