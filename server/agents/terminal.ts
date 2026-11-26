import * as pty from "node-pty";
import { execFile } from "node:child_process";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Scrollback } from "./scrollback.js";
import { Transcript } from "./transcript.js";
import { chiefAccount, chiefMisconfigured, runsAsChief } from "../chief/chiefaccount.js";
import { hardenedDeployment } from "../chief/hardened.js";
import { resolveChiefDataDir } from "../chief/paths.js";
import { envKey, envKeys, names } from "../names.mjs";
import { resolveClaudeBin, resolveDtachBin } from "../defaults.js";
import { agentEnv, NEVER_PASS } from "../../bin/lib/agent-env.mjs";

type SpawnOpts = {
  id: string; cwd: string; args: string[]; command?: string;
  env?: Record<string, string>;
  // When true the command is hosted inside a detached dtach session so it
  // outlives this server process; a restart reattaches via reattach(id).
  persist?: boolean;
};
export type Attachment = {
  // What to write first: all retained history, or only the part after `resume`.
  snapshot: string;
  // Identifies this output stream: offsets from another epoch mean nothing here.
  epoch: string;
  // Stream offset of the first char of `snapshot`.
  offset: number;
  // True when `snapshot` continues the client's stream (no reset needed).
  resumed: boolean;
  subscribe: (cb: (chunk: string) => void) => () => void;
  // Runs when the terminal ends, so a kept-open socket doesn't sit on a dead stream.
  onEnd: (cb: () => void) => () => void;
};
export type ResumePoint = { epoch: string; offset: number };

// Sees every PTY the manager runs: its start (with the PTY size), each chunk
// of output (the same bytes the browser gets, the history replay of a
// reattach included), each resize and its end. The prompt watcher
// (agents/prompt-watch.ts) builds an agent's screen from it. A throwing
// observer never breaks a terminal.
export type TerminalObserver = {
  open(id: string, size: { cols: number; rows: number }): void;
  data(id: string, chunk: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  // Whether a dialog of the TUI is on the screen of `id` now (the prompt watcher).
  dialogOn?(id: string): Promise<boolean>;
};

// The size of every PTY at spawn and at reattach, until a browser fits it.
export const PTY_COLS = 120;
export const PTY_ROWS = 30;

// A TUI turns on bracketed paste once it reads input in raw mode: from then on
// a pasted prompt arrives whole (agents/composer.ts waits for it).
const PASTE_ON = "\x1b[?2004h";
// If a freshly spawned TUI never announces it, count it ready after this.
export const PASTE_READY_BOUND_MS = 3 * 60_000;

type Term = {
  proc: pty.IPty;
  // Bracketed paste seen since spawn; true from the start for a reattach (the
  // TUI was already running). `pasteTail` holds the last bytes of the previous
  // chunk, so a marker split across chunks still counts.
  pasteReady: boolean;
  pasteTail: string;
  startedAt: number;
  buffer: Scrollback;
  subs: Set<(chunk: string) => void>;
  ends: Set<() => void>;
  epoch: string;
  // When persisted: the dtach socket path. Null for ephemeral shells.
  session: string | null;
  // Durable on-disk mirror of output for persisted sessions (null otherwise).
  // The in-memory buffer dies with the server; this is what lets a restarted
  // server replay an idle agent's history. See reattach().
  transcript: Transcript | null;
  // dtach unconditionally clears the client screen (ESC[H ESC[J) on every
  // attach — regardless of its redraw method. On reattach that clear would
  // arrive right after we replay history and blank it. When true, strip a
  // leading clear from the first chunk so the replay survives.
  stripClear: boolean;
};

// Matches a leading run of cursor-home / erase-display sequences — exactly what
// dtach emits on attach (ESC[H ESC[J).
const LEADING_CLEAR = /^(?:\x1b\[[0-9;]*[HJ])+/;

const DEFAULT_COMMAND = resolveClaudeBin();

// dtach hosts each agent so the process outlives the server — but unlike a
// terminal multiplexer it passes the PTY through byte-for-byte (no redraw,
// copy-mode, or line re-wrap), so selection/copy/resize behave exactly like a
// raw terminal wired straight to the child. That transparency is the point.
const DTACH = resolveDtachBin();
const DTACH_DIR = process.env.AGENT_DTACH_DIR ?? join(tmpdir(), names().dtachDir);
// The dtach dir in use, for the chief hardened check (server/chief/hardened.ts):
// the same value the manager uses, also when AGENT_DTACH_DIR is unset.
export const AGENT_DTACH_DIR_RESOLVED = DTACH_DIR;
// Shared by create (-A) and attach (-a): disable the detach char and suspend
// key (nothing intercepts the child's input), and redraw via SIGWINCH so the
// TUI repaints itself on every (re)attach.
const DTACH_OPTS = ["-E", "-z", "-r", "winch"];

// dtach daemonizes its master, but daemonizing doesn't leave the systemd
// cgroup — so when the console runs as a service, a `systemctl restart`
// cgroup-kills every agent the service ever spawned (the "agents stay alive"
// detach can't protect them). Wrapping the persisted spawn in
// `systemd-run --user --scope` moves it into its own transient scope: the
// client still runs on our PTY (a scope relocates the process, it doesn't
// detach it), but the daemonized master now lives outside the service cgroup
// and survives restarts. `--collect` garbage-collects the scope on exit.
const SYSTEMD_RUN = process.env.AGENT_SYSTEMD_RUN_BIN ?? "/usr/bin/systemd-run";

// The scope wrapper needs a reachable user manager: systemd-run itself, plus
// the user runtime dir it talks to. AGENT_SCOPE=0 opts out entirely.
function scopeRunner(): string | null {
  if (process.env.AGENT_SCOPE === "0") return null;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !existsSync(join(runtime, "systemd"))) return null;
  return existsSync(SYSTEMD_RUN) ? SYSTEMD_RUN : null;
}

// argv for a persisted (dtach-hosted) spawn, scope-wrapped when available.
// Exported for tests.
export function persistCommand(
  deps: { dtach: string; systemdRun: string | null },
  socket: string, inner: string, args: string[],
): { command: string; args: string[] } {
  const dtachArgv = ["-A", socket, ...DTACH_OPTS, inner, ...args];
  if (!deps.systemdRun) return { command: deps.dtach, args: dtachArgv };
  return {
    command: deps.systemdRun,
    args: ["--user", "--scope", "--quiet", "--collect", "--", deps.dtach, ...dtachArgv],
  };
}

// ---- Phase 2c: agent sessions through choibot-agent-exec (spec Appendix B step 3)
// In a hardened deployment the dtach session of an agent (master, socket, CLI)
// belongs to the agent uid. The console cannot attach to that socket (dtach
// makes it 0600) nor signal those processes, so it drives them through the
// helper deploy/choibot-agent-exec, run as the agent uid by sudo. index.ts sets
// TerminalManager's `agentExec` only in a hardened deployment and after the
// probe passed; without it every path below stays as before.
export type AgentExec = { sudo: string; helper: string; uid: number };

// The keys of this install in the sudoers env_keep list (deploy/choibot-agent-exec.sudoers.example;
// CHOIBOT_* on an install with the old names): the keys that reach the helper. Secrets travel in the env, never on argv.
export const SUDO_ENV_KEEP: readonly string[] = [
  envKey("AGENT_ID"), envKey("AGENT_PASS"), "PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TERM", "LANG",
  envKey("WIDGET_DIR"), envKey("CRON_SPOOL"), "CRON_DATA_DIR", "TZ",
];
// What `systemd-run --user` needs to reach the user manager. sudo's env_reset
// strips them, so they never reach the helper or the agent.
const USER_MANAGER_ENV = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

export type HelperVerb = "spawn" | "attach" | "kill" | "kill-clients" | "pids" | "probe" | "run" | "claude-auth" | "claude-print" | "repo-clone" | "repo-remove" | "repo-read" | "read-file" | "git-identity" | "claude-task" | "upload-pack" | "read-thread" | "session-ensure" | "read-tasks" | "git-safe" | "alive" | "env-check";

// The full argv (argv[0] is sudo) of one helper call as the agent uid. The keys of SUDO_ENV_KEEP
// reach the helper through the sudoers line's env_keep (bin/lib/strong.ts), never through
// `--preserve-env=<list>`: sudo logs each variable of that list WITH its value (ENV=, in the
// journal and auth.log), and the agent's pass is one of them. Its own check (sudo 1.9.15p5,
// plugins/sudoers/sudoers.c validate_env_vars) took that list only for keys that env_keep
// allows, and env_reset keeps exactly those (env.c env_should_keep), so no key is lost.
export function helperArgv(x: AgentExec, verb: HelperVerb, rest: string[]): string[] {
  return [x.sudo, "-n", "-u", `#${x.uid}`, x.helper, verb, ...rest];
}

// A spawn through the helper, scope-wrapped like persistCommand so the dtach
// master stays outside the console's service cgroup and survives restarts.
export function helperSpawnCommand(
  x: AgentExec, deps: { systemdRun: string | null },
  socket: string, cwd: string, inner: string, args: string[],
): { command: string; args: string[] } {
  const argv = helperArgv(x, "spawn", [socket, cwd, "--", inner, ...args]);
  if (!deps.systemdRun) return { command: argv[0], args: argv.slice(1) };
  return { command: deps.systemdRun, args: ["--user", "--scope", "--quiet", "--collect", "--", ...argv] };
}

// The env of a process that runs sudo: the env_keep keys and the user manager
// keys, nothing else (no PATH or HOME: the helper sets the agent user's).
export function helperEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...USER_MANAGER_ENV, ...SUDO_ENV_KEEP]) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// The extra agent env of a spawn through the helper (overview decision 42):
// the cron spool under AGENT_HOME_ROOT, and the console's cron data dir, so
// `choibot cron list` in the agent reads the real specs.
export function helperAgentEnv(homeRoot: string | null, cronDataDir: string): Record<string, string> {
  return {
    ...(homeRoot ? { [envKey("CRON_SPOOL")]: join(homeRoot, "cron-spool") } : {}),
    CRON_DATA_DIR: resolve(cronDataDir),
  };
}

type HelperResult = { code: number; stdout: string; stderr: string };
// extraEnv: more keys for this one call (the env check's marker), on top of the helper env.
export type HelperRun = (cmd: string, args: string[], extraEnv?: Record<string, string>) => Promise<HelperResult>;

const firstLine = (s: string): string | undefined => s.split("\n").map((l) => l.trim()).find(Boolean);
// The reason a helper call failed: its first stderr line, else its first
// stdout line, else the exit code.
const reasonLine = (r: HelperResult): string => firstLine(r.stderr) ?? firstLine(r.stdout) ?? `exit ${r.code}`;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Run one helper call to its end with the helper env. Never rejects: execFile
// can also throw at once (e.g. ERR_INVALID_ARG_VALUE), which is a failed run.
function execHelper(timeoutMs: number): HelperRun {
  return (cmd, args, extraEnv) => new Promise((done) => {
    const env = { ...helperEnv(process.env), ...(extraEnv ?? {}) } as NodeJS.ProcessEnv;
    try {
      execFile(cmd, args, { env, timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr });
        const code = typeof err.code === "number" ? err.code : -1;
        const why = err.killed ? `timed out after ${timeoutMs / 1000} s` : typeof err.code === "number" ? "" : err.message;
        done({ code, stdout: stdout ?? "", stderr: stderr || why });
      });
    } catch (e) {
      done({ code: -1, stdout: "", stderr: errText(e) });
    }
  });
}

const PROBE_TIMEOUT_MS = 10_000;

// Whether sudo runs the helper and its config is sound: null when ok, else
// the reason line (sudo's own, the helper's, or the exit code).
export async function probeAgentExec(
  x: AgentExec, run: HelperRun = execHelper(PROBE_TIMEOUT_MS), note: (s: string) => void = (s) => console.warn(s),
): Promise<string | null> {
  const r = await helperWithin(run, helperArgv(x, "probe", []), "probe");
  if (r.code !== 0 || r.stdout.trim() !== "ok") return reasonLine(r);
  return envCheckReason(x, run, note);
}

// One helper call, ended at PROBE_TIMEOUT_MS. Never rejects.
async function helperWithin(run: HelperRun, argv: string[], what: string, extraEnv?: Record<string, string>): Promise<HelperResult> {
  const [cmd, ...args] = argv;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HelperResult>((done) => {
    timer = setTimeout(() => done({ code: -1, stdout: "", stderr: `${what} timed out after ${PROBE_TIMEOUT_MS / 1000} s` }), PROBE_TIMEOUT_MS);
  });
  const r = await Promise.race([
    run(cmd, args, extraEnv).catch((e: unknown) => ({ code: -1, stdout: "", stderr: errText(e) })),
    timeout,
  ]);
  clearTimeout(timer);
  return r;
}

// The env check after the probe: the agents' keys reach the helper through the sudoers line's
// env_keep only (helperArgv), so the console checks that they arrive. A harmless marker goes in
// the agent id key, and the helper names the keys of its list that reached it (names only, never
// a value). An older helper has no env-check: allowed, with one line (strong-setup updates it).
// A helper that runs it and lacks the key: agent exec is unavailable, and no agent starts through
// it (its CLI would have no id and no pass).
export const ENV_CHECK_MARKER = "env-check";
async function envCheckReason(x: AgentExec, run: HelperRun, note: (s: string) => void): Promise<string | null> {
  const key = envKey("AGENT_ID");
  const r = await helperWithin(run, helperArgv(x, "env-check", []), "env-check", { [key]: ENV_CHECK_MARKER });
  if (r.code === 0) {
    if (r.stdout.split("\n").map((l) => l.trim()).includes(key)) return null;
    return `the sudoers line of the helper keeps no agent keys (env_keep): ${key} did not reach it, so the agents' id and pass would not`;
  }
  if (/unknown verb: env-check\b/.test(r.stderr)) {
    note("[chief] the helper is older (it has no env-check): its env_keep was not checked; strong-setup updates it");
    return null;
  }
  return reasonLine(r);
}

// The agentExec of a hardened deployment once its probe passed. A failed probe
// logs one line and gives undefined: the console stays in weak mode with
// direct dtach, never a spawn loop that fails (Review Focus 1).
export async function probedAgentExec(
  x: AgentExec, o: { run?: HelperRun; log?: (s: string) => void } = {},
): Promise<AgentExec | undefined> {
  const reason = await probeAgentExec(x, o.run, o.log);
  if (reason === null) return x;
  (o.log ?? console.warn)(`[chief] agent exec unavailable: ${reason}`);
  return undefined;
}

// Service PTYs (svc: ids, server/services/manager.ts) run as the console uid
// by design (spec §3): never through the helper.
const SERVICE_ID_PREFIX = "svc:";

// How a persisted session is driven (TerminalManager.route).
type Route =
  | { via: "direct" }
  | { via: "helper"; x: AgentExec; exists: boolean }
  | { via: "refused"; reason: string };
const DIRECT: Route = { via: "direct" };

// The owner uid of a socket entry (not followed), null when there is none.
function socketOwner(sock: string): number | null {
  try { return lstatSync(sock).uid; } catch { return null; }
}

// kill-clients is awaited by a reattach; kill can take the helper's 5 s grace.
const HELPER_CLIENTS_TIMEOUT_MS = 10_000;
// alive: sudo and the helper's own 3 s limit of its connect.
const HELPER_ALIVE_TIMEOUT_MS = 10_000;
const CONNECT_PROOF_TIMEOUT_MS = 2_000;
const HELPER_KILL_TIMEOUT_MS = 15_000;

// Map an agent id to a stable session name, used as the dtach socket filename.
// Flatten `.` and `:` (awkward in filenames); the id stays recoverable for
// debugging.
export function agentSessionName(id: string): string {
  return names().dtachPrefix + id.replace(/[.:]/g, "-");
}

// Per-agent dtach socket path (derived from the same session name). A persistent agent of the
// second account (chiefaccount.ts) has its socket in that account's own dtach folder, where the
// workers' account can make no entry (no socket put in place of the master's).
function dtachSocket(id: string): string {
  const dir = runsAsChief(id) ? (chiefAccount()?.dtachDir ?? DTACH_DIR) : DTACH_DIR;
  return join(dir, agentSessionName(id) + ".sock");
}

// A dead session whose socket file stays: its dtach master ended without removing the file (a
// SIGKILL: a restart of the user manager, an OOM kill). A reattach to it ends at once, and boot,
// Resume and the second sign-in's wait took it for a live session (the B3 proof on a real
// server, 2026-11-25). "dead" needs positive proof, and a doubt is "live" (today's path), so a
// live session is never taken for dead: a connect to the socket that is REFUSED (ECONNREFUSED: no
// process listens on it). A connect that works says "live"; no file, another error (EACCES, a
// socket of another uid), the time limit: "unknown". Nothing is unlinked: a spawn (dtach -A)
// removes a socket that refuses a connect, and starts a new session there. Exported for tests.
export type SessionProof = "live" | "dead" | "unknown";
export function connectProof(sock: string, timeoutMs = CONNECT_PROOF_TIMEOUT_MS): Promise<SessionProof> {
  return new Promise((done) => {
    const s = new Socket();
    let ended = false;
    const end = (v: SessionProof): void => {
      if (ended) return;
      ended = true;
      s.destroy();
      done(v);
    };
    s.setTimeout(timeoutMs, () => end("unknown"));
    s.once("connect", () => end("live"));
    s.once("error", (e: NodeJS.ErrnoException) => end(e.code === "ECONNREFUSED" ? "dead" : "unknown"));
    try { s.connect(sock); } catch { end("unknown"); }
  });
}

// The `pkill -f` pattern for a socket path. pkill reads it as a POSIX ERE and
// the path carries the id, so every metacharacter is escaped: the pattern
// matches the path literally (`x|` would otherwise match every session).
// Exported for tests.
export function pkillPattern(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Per-agent durable transcript path — colocated with the socket so it shares
// the session's lifecycle (created on persisted spawn, removed on kill/exit).
// With a scrollback dir (hardened, scrollbackDirFor) it lives there instead.
function transcriptPath(id: string, dir: string = DTACH_DIR): string {
  return join(dir, agentSessionName(id) + ".scrollback");
}

// Where persisted sessions (agents and services) keep their .scrollback in a
// hardened deployment (ruling F2): <chief data dir>/scrollback, console-only.
// AGENT_DTACH_DIR is group-writable there, so a transcript written by path in
// it would follow a symlink an agent planted. Undefined (today's dtach dir)
// otherwise.
export function scrollbackDirFor(env: Record<string, string | undefined> = process.env): string | undefined {
  return hardenedDeployment(env) ? join(resolveChiefDataDir(env), "scrollback") : undefined;
}

// Whether a live dtach process of the console uid names the socket: its
// argv[0] basename is dtach, its argv holds the path (the same scan as
// dtachClientPids) and its real uid (/proc/<pid>/status) is this process's
// own, so an agent-uid process named dtach never counts. Linux-only (/proc);
// elsewhere none. Exported for tests.
export function liveConsoleDtach(sock: string, procRoot = "/proc"): boolean {
  const self = process.getuid?.();
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d)); } catch { return false; }
  for (const pid of pids) {
    try {
      const argv = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0");
      if (basename(argv[0]) !== "dtach" || !argv.includes(sock)) continue;
      const status = readFileSync(join(procRoot, pid, "status"), "utf8");
      if (/^State:\s+[ZX]\b/m.test(status)) continue;
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (m && Number(m[1]) === self) return true;
    } catch { /* gone, or not ours to read */ }
  }
  return false;
}

// Pids of the dtach CLIENTS attached to a socket: dtach processes whose argv
// names the socket and whose stdin is a terminal. The master daemonizes onto
// /dev/null, so it never matches. Linux-only (/proc); elsewhere it finds none.
// Exported for tests.
export function dtachClientPids(sock: string, procRoot = "/proc"): number[] {
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d)); } catch { return []; }
  const out: number[] = [];
  for (const pid of pids) {
    try {
      const argv = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0");
      if (basename(argv[0]) !== "dtach" || !argv.includes(sock)) continue;
      if (readlinkSync(join(procRoot, pid, "fd", "0")).startsWith("/dev/pts/")) out.push(Number(pid));
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

// Kill the clients a previous server left on a socket. A leftover client whose
// pty nobody reads blocks in write(); dtach then waits on it and stops serving
// every other client, so a reattached terminal shows nothing. SIGKILL, because
// a client stuck in write() never acts on SIGHUP/SIGTERM. A session that runs
// as the agent uid uses the helper's kill-clients instead (see reattach).
function killStaleClients(sock: string): void {
  for (const pid of dtachClientPids(sock)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

// One process from /proc: its parent and its start time (clock ticks since
// boot). The start time tells a live process from a later one that reused the
// pid, so a delayed SIGKILL never hits a stranger.
type ProcInfo = { pid: number; ppid: number; start: string };

function readProc(procRoot: string, pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    // The comm field is in parentheses and can hold spaces: parse after it.
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(f[1]), start: f[19] ?? "" };
  } catch { return null; }
}

// Every process that belongs to an agent's session, for a stop that frees all
// of its memory: the dtach master and clients on the socket, all their
// descendants (claude, and the dev servers, browsers and builds it started),
// and every process in the master's own systemd scope (`run-*.scope`, see
// persistCommand). The scope also holds children that double-forked away from
// the tree. A cgroup that holds this server itself (AGENT_SCOPE=0 puts agents
// in the service cgroup) is never used. Linux-only (/proc); elsewhere it finds
// none. Exported for tests.
export function sessionTreePids(
  sock: string,
  o: { procRoot?: string; cgroupRoot?: string; selfPid?: number } = {},
): ProcInfo[] {
  const procRoot = o.procRoot ?? "/proc";
  const cgroupRoot = o.cgroupRoot ?? "/sys/fs/cgroup";
  const selfPid = o.selfPid ?? process.pid;
  let all: number[];
  try { all = readdirSync(procRoot).filter((d) => /^\d+$/.test(d)).map(Number); } catch { return []; }

  const roots: number[] = [];
  const children = new Map<number, number[]>();
  const info = new Map<number, ProcInfo>();
  for (const pid of all) {
    const p = readProc(procRoot, pid);
    if (!p) continue;
    info.set(pid, p);
    const kids = children.get(p.ppid) ?? [];
    kids.push(pid);
    children.set(p.ppid, kids);
    try {
      const argv = readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0");
      if (basename(argv[0]) === "dtach" && argv.includes(sock)) roots.push(pid);
    } catch { /* gone, or not ours to read */ }
  }
  if (!roots.length) return [];

  const found = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.pop()!;
    if (found.has(pid)) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  for (const pid of roots) {
    let path: string;
    try {
      const line = readFileSync(join(procRoot, String(pid), "cgroup"), "utf8").split("\n").find((l) => l.startsWith("0::"));
      path = line?.slice(3).trim() ?? "";
    } catch { continue; }
    if (!/\/run-[^/]+\.scope$/.test(path)) continue;
    let members: number[];
    try {
      members = readFileSync(join(cgroupRoot, path, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
    } catch { continue; }
    if (members.includes(selfPid)) continue;
    for (const m of members) found.add(m);
  }
  found.delete(selfPid);
  return [...found].map((pid) => info.get(pid) ?? readProc(procRoot, pid)).filter((p): p is ProcInfo => p !== null);
}

// Grace between SIGTERM and SIGKILL when a session is stopped.
const KILL_GRACE_MS = 5000;

// SIGTERM the whole session tree now, then SIGKILL what is still there (same
// pid, same start time) after the grace. Best effort: a process that is gone
// or not ours is skipped.
function killSessionTree(sock: string, graceMs = KILL_GRACE_MS): void {
  const procs = sessionTreePids(sock);
  if (!procs.length) return;
  for (const p of procs) {
    try { process.kill(p.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  const t = setTimeout(() => {
    for (const p of procs) {
      const now = readProc("/proc", p.pid);
      if (!now || now.start !== p.start) continue;
      try { process.kill(p.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, graceMs);
  t.unref?.();
}

export class TerminalManager {
  private terms = new Map<string, Term>();
  private killed = new Set<string>();
  // Set during graceful shutdown so client PTYs we deliberately detach aren't
  // misread as agents exiting (which would flip their status to done/error).
  private shuttingDown = false;
  private inputAt = new Map<string, number>();
  private outputAt = new Map<string, number>();
  // Reattaches through the helper wait for kill-clients: one at a time per id,
  // and a kill meanwhile cancels the attach.
  private pendingAttach = new Map<string, Promise<Attachment | null>>();
  private cancelledAttach = new Set<string>();
  constructor(
    private opts: {
      onExit?: (id: string, code: number, killed: boolean) => void;
      scrollbackBytes?: number;
      dropUserToken?: boolean;
      now?: () => number;
      // Hardened deployment (Phase 2c): drive agent sessions through the helper.
      agentExec?: AgentExec;
      // The second account (chiefaccount.ts): the persistent agents' helper calls, once its probe
      // passed. Unset while the account is asked for: those agents are refused, never run as
      // the workers' account.
      chiefExec?: AgentExec;
      // Extra agent env for spawns through the helper only (helperAgentEnv).
      agentEnv?: Record<string, string>;
      // Owner uid of a socket entry, null when missing (tests inject it).
      ownerOf?: (sock: string) => number | null;
      // Hardened (scrollbackDirFor): the console-only dir of every
      // .scrollback. Unset: the dtach dir, as before.
      scrollbackDir?: string;
      observer?: TerminalObserver;
    } = {},
  ) {}

  // Whether Claude shows a dialog on the screen of `id` (a folder trust question, a login
  // or a limit menu). A line typed there answers the dialog: no console line goes in then
  // (issues/reply.ts typeIntoAgent). False with no observer or no live PTY here.
  async dialogOn(id: string): Promise<boolean> {
    try { return (await this.opts.observer?.dialogOn?.(id)) === true; } catch { return false; }
  }

  private observe(fn: (o: TerminalObserver) => void): void {
    const o = this.opts.observer;
    if (!o) return;
    try { fn(o); } catch (e) { console.warn(`[terminal] observer failed: ${errText(e)}`); }
  }

  private transcriptFile(id: string): string {
    return transcriptPath(id, this.opts.scrollbackDir);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  // How the persisted session of `id` is driven. Without agentExec: direct
  // dtach, as before (no owner check). With it:
  // - an agent id goes through the helper when its socket is missing
  //   (`exists` false) or owned by the agent uid. A socket another uid owns
  //   (the console's: a session from before the hardening, checklist C6)
  //   keeps direct dtach only while a live console-uid dtach names it
  //   (ruling F5); a stale one is unlinked and the helper is used, since a
  //   direct `dtach -A` on a dead socket starts a console-uid agent.
  // - a service id (console uid by design) is direct only when its socket is
  //   missing or the console's own. The agent uid can write the dtach dir: a
  //   choibot-svc-*.sock it made would read the user's keystrokes to that
  //   service, so it is refused (ruling 2c-2-a).
  private route(id: string, sock: string): Route {
    const x = this.opts.agentExec;
    if (!x) return DIRECT;
    const owner = (this.opts.ownerOf ?? socketOwner)(sock);
    if (id.startsWith(SERVICE_ID_PREFIX)) {
      if (owner === null || owner === process.getuid?.()) return DIRECT;
      return { via: "refused", reason: `[chief] service socket ${basename(sock)} is not console-owned; refused` };
    }
    // A persistent agent of the second account: only through its own helper, on a socket of its
    // own uid in its own folder. Anything else is refused (nothing is unlinked there).
    if (runsAsChief(id)) {
      const c = this.opts.chiefExec;
      if (!c) return { via: "refused", reason: `[chief] ${id}: the persistent agents' account is not ready (${chiefMisconfigured() ?? "its helper probe failed"}); refused` };
      if (owner === null) return { via: "helper", x: c, exists: false };
      if (owner === c.uid) return { via: "helper", x: c, exists: true };
      return { via: "refused", reason: `[chief] ${id}: socket ${basename(sock)} has owner uid ${owner}, not the persistent agents' account; refused` };
    }
    if (owner === null) return { via: "helper", x, exists: false };
    if (owner === x.uid) return { via: "helper", x, exists: true };
    if (liveConsoleDtach(sock)) return DIRECT;
    try { unlinkSync(sock); } catch (e) {
      if ((e as { code?: unknown }).code !== "ENOENT") {
        return { via: "refused", reason: `[chief] stale socket ${sock} could not be removed (${errText(e)}); refused` };
      }
    }
    console.warn(`[chief] stale console-owned socket ${sock} unlinked; the agent runs through the helper`);
    return { via: "helper", x, exists: false };
  }

  // One helper call on a socket to its end. Never rejects: a failure is logged.
  private async helperCall(x: AgentExec, verb: "kill" | "kill-clients", sock: string, timeoutMs: number): Promise<void> {
    const [cmd, ...args] = helperArgv(x, verb, [sock]);
    const r = await execHelper(timeoutMs)(cmd, args);
    if (r.code !== 0) console.warn(`[terminal] helper ${verb} ${sock} failed: ${reasonLine(r)}`);
  }

  // Last write() / last PTY output per id. Kept on the manager so a value
  // survives a PTY replacement.
  lastInputAt(id: string): number | undefined {
    return this.inputAt.get(id);
  }
  lastOutputAt(id: string): number | undefined {
    return this.outputAt.get(id);
  }

  // Build the child env of `id`, never leaking an API key (subscription
  // billing) and always advertising truecolor so Claude Code's rich diff style
  // survives. An agent gets the agent env (bin/lib/agent-env.mjs: never a
  // console secret; with AGENT_ENV_PASS set, only the allowlist and the listed
  // keys) plus its own spawn env; a service PTY (console uid by design) the
  // console env, as before.
  private childEnv(id: string, extra?: Record<string, string>): Record<string, string> {
    const base = id.startsWith(SERVICE_ID_PREFIX) ? process.env : agentEnv(process.env);
    const env = { ...base, ...(extra ?? {}) } as Record<string, string>;
    if (!id.startsWith(SERVICE_ID_PREFIX)) for (const k of NEVER_PASS) delete env[k];
    delete env.ANTHROPIC_API_KEY;
    if (this.opts.dropUserToken) for (const k of envKeys("USER_TOKEN")) delete env[k];
    // Never leak a tmux context into an agent. If this server was launched from
    // inside tmux (e.g. a restart run from a tmux pane), process.env carries
    // TMUX/TMUX_PANE — and a dtach-hosted agent that inherits them makes Claude
    // Code think it's inside tmux, so it routes "copy" to tmux's paste buffer
    // instead of the clipboard.
    delete env.TMUX;
    delete env.TMUX_PANE;
    if (env.TERM_PROGRAM === "tmux") delete env.TERM_PROGRAM;
    env.COLORTERM = "truecolor";
    return env;
  }

  // Wire a freshly-spawned pty into the manager: buffer output (in memory and,
  // for persisted sessions, on disk), fan out to subscribers, and clean up on
  // exit. Shared by spawn() and reattach().
  //   reattach: strip dtach's attach-time clear so the replayed history survives.
  //   freshTranscript: start the on-disk transcript clean (a brand-new session,
  //     not a reattach to existing history).
  private register(
    id: string, proc: pty.IPty, session: string | null,
    opts: { stripClear?: boolean; freshTranscript?: boolean; fresh?: boolean } = {},
  ): void {
    let transcript: Transcript | null = null;
    if (session) {
      if (this.opts.scrollbackDir) mkdirSync(this.opts.scrollbackDir, { recursive: true, mode: 0o700 });
      transcript = new Transcript(this.transcriptFile(id), this.opts.scrollbackBytes);
      if (opts.freshTranscript) transcript.remove(); // next append recreates it
    }
    const term: Term = {
      proc, pasteReady: !opts.fresh, pasteTail: "", startedAt: Date.now(), buffer: new Scrollback(this.opts.scrollbackBytes), subs: new Set(), ends: new Set(), epoch: randomUUID(),
      session, transcript, stripClear: opts.stripClear ?? false,
    };
    this.terms.set(id, term);
    this.observe((o) => o.open(id, { cols: PTY_COLS, rows: PTY_ROWS }));
    proc.onData((raw) => {
      let data = raw;
      if (term.stripClear) {
        data = data.replace(LEADING_CLEAR, "");
        term.stripClear = false; // only the very first attach chunk is dtach's clear
      }
      if (data.length === 0) return;
      this.outputAt.set(id, this.now());
      if (!term.pasteReady) {
        const seen = term.pasteTail + data;
        if (seen.includes(PASTE_ON)) term.pasteReady = true;
        else term.pasteTail = seen.slice(-(PASTE_ON.length - 1));
      }
      term.buffer.push(data);
      term.transcript?.append(data);
      for (const cb of term.subs) cb(data);
      this.observe((o) => o.data(id, data));
    });
    proc.onExit(({ exitCode }) => {
      this.terms.delete(id);
      const killed = this.killed.delete(id); // true if we intentionally killed it
      // On shutdown we detach our own client PTYs; the agent (dtach master)
      // lives on, so don't surface that as an exit — and crucially KEEP the
      // transcript so the next boot can replay its history.
      if (this.shuttingDown) return;
      term.transcript?.remove(); // history is meaningless once the agent is really gone
      this.observe((o) => o.close(id));
      for (const cb of [...term.ends]) cb();
      this.opts.onExit?.(id, exitCode, killed);
    });
  }

  spawn(o: SpawnOpts): void {
    if (this.terms.has(o.id)) throw new Error(`terminal ${o.id} already exists`);
    let env = this.childEnv(o.id, o.env);
    const inner = o.command ?? DEFAULT_COMMAND;

    let command = inner;
    let args = o.args;
    let session: string | null = null;
    if (o.persist) {
      mkdirSync(DTACH_DIR, { recursive: true });
      session = dtachSocket(o.id);
      // `-A`: attach if the socket somehow exists, else create it and run
      // `inner`. dtach execs the command directly (no shell), so the trailing
      // argv — including a prompt with spaces/quotes — passes through verbatim.
      // Scope-wrapped (see persistCommand) so the master survives service restarts.
      const route = this.route(o.id, session);
      if (route.via === "refused") {
        // Fail like a command that exits at once: onExit with code 1 (the
        // ServiceManager's crash path), never a throw, which its restart
        // timer would turn into an uncaughtException.
        console.warn(route.reason);
        setImmediate(() => {
          if (this.shuttingDown) return;
          this.opts.onExit?.(o.id, 1, this.killed.delete(o.id));
        });
        return;
      }
      if (route.via === "helper") {
        // As the agent uid: sudo passes only the env_keep keys on, the
        // helper starts the same dtach command in `cwd`.
        ({ command, args } = helperSpawnCommand(
          route.x, { systemdRun: scopeRunner() }, session, resolve(o.cwd), inner, o.args,
        ));
        env = helperEnv({ ...env, ...this.opts.agentEnv });
      } else {
        ({ command, args } = persistCommand(
          { dtach: DTACH, systemdRun: scopeRunner() }, session, inner, o.args,
        ));
      }
    }

    const proc = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: o.cwd,
      env,
    });
    // A brand-new session: start its transcript clean (don't inherit a stale
    // file should an id ever be reused).
    this.register(o.id, proc, session, { freshTranscript: true, fresh: true });
  }

  // Whether the live PTY of `id` takes a pasted prompt now: its TUI turned on
  // bracketed paste, it is a reattached running session, or the spawn is older
  // than PASTE_READY_BOUND_MS. False with no live PTY in this process.
  inputReady(id: string, now = Date.now()): boolean {
    const t = this.terms.get(id);
    if (!t) return false;
    return t.pasteReady || now - t.startedAt >= PASTE_READY_BOUND_MS;
  }

  // Reattach to a persisted session that survived a previous server. Returns an
  // Attachment if the session is live, or null if it has ended (so callers can
  // offer a cold Resume instead of silently spawning a fresh agent).
  async reattach(id: string): Promise<Attachment | null> {
    const existing = this.attach(id);
    if (existing) return existing; // already live in this process
    const route = this.route(id, dtachSocket(id));
    if (route.via === "refused") {
      console.warn(route.reason);
      return null;
    }
    if (route.via === "helper") return route.exists ? this.reattachViaHelper(id, route.x) : null;
    const env = this.childEnv(id);
    const opts = { name: "xterm-256color", cols: PTY_COLS, rows: PTY_ROWS, cwd: process.cwd(), env } as const;

    const sock = dtachSocket(id);
    if (!existsSync(sock)) return null;
    if ((await connectProof(sock)) === "dead") {
      console.warn(`[terminal] ${id}: its session is gone (its socket ${basename(sock)} refuses a connect): not attached`);
      return null;
    }
    killStaleClients(sock);
    const proc = pty.spawn(DTACH, ["-a", sock, ...DTACH_OPTS], opts);
    return this.adoptReattached(id, proc, sock);
  }

  // A reattach as the agent uid: the helper's kill-clients drops the clients
  // a previous server left (the console cannot signal them), then the helper
  // attaches. Concurrent calls for one id share one run.
  private reattachViaHelper(id: string, x: AgentExec): Promise<Attachment | null> {
    const pending = this.pendingAttach.get(id);
    if (pending) return pending;
    const sock = dtachSocket(id);
    const run = (async () => {
      // Inside the pending attach: two reattaches at once make one check, and a kill meanwhile
      // cancels the reattach.
      if (await this.helperDead(x, sock)) {
        console.warn(`[terminal] ${id}: its session is gone (its socket ${basename(sock)} refuses a connect): not attached`);
        return null;
      }
      if (this.cancelledAttach.has(id)) return null; // killed meanwhile
      await this.helperCall(x, "kill-clients", sock, HELPER_CLIENTS_TIMEOUT_MS);
      if (this.cancelledAttach.has(id)) return null; // killed meanwhile
      const live = this.attach(id);
      if (live) return live; // a spawn came first
      const [cmd, ...args] = helperArgv(x, "attach", [sock]);
      const proc = pty.spawn(cmd, args, {
        name: "xterm-256color", cols: PTY_COLS, rows: PTY_ROWS, cwd: process.cwd(), env: helperEnv(this.childEnv(id)),
      });
      return this.adoptReattached(id, proc, sock);
    })().finally(() => {
      this.pendingAttach.delete(id);
      this.cancelledAttach.delete(id);
    });
    this.pendingAttach.set(id, run);
    return run;
  }

  // Wire a reattached client PTY in and seed its history.
  private adoptReattached(id: string, proc: pty.IPty, sock: string): Attachment | null {
    // Keep the existing transcript (it holds history from the previous server)
    // and strip dtach's attach-time clear so it can't blank the replay.
    this.register(id, proc, sock, { stripClear: true });
    this.outputAt.set(id, this.now()); // reattach counts as output
    // Seed the fresh in-memory buffer with the durable transcript so attach()'s
    // snapshot replays history — the whole point of surviving a restart. Idle
    // agents emit nothing on reattach, so without this they'd show a blank
    // terminal. Runs before any async pty data, so it can't double-count live
    // output. This is what dtach's transparent passthrough can't do on its own.
    const seeded = this.terms.get(id);
    const history = seeded?.transcript?.read() ?? "";
    if (history) {
      seeded!.buffer.push(history);
      this.observe((o) => o.data(id, history));
    }
    return this.attach(id);
  }

  // Whether a persisted session for this agent is currently alive: its dtach socket is there, and
  // it is not proven dead (connectProof above; a doubt is "alive", as before).
  async hasSession(id: string): Promise<boolean> {
    const sock = dtachSocket(id);
    if (!existsSync(sock)) return false;
    if (this.terms.has(id)) return true;
    const route = this.route(id, sock);
    if (route.via === "refused") return true;
    if (route.via === "helper") return !(route.exists && (await this.helperDead(route.x, sock)));
    return (await connectProof(sock)) !== "dead";
  }

  // The helper's `alive` verb, as the session's own uid (only that uid may connect to its 0600
  // socket). True only for its answer "dead"; a failure, a time limit or another word: false.
  private async helperDead(x: AgentExec, sock: string): Promise<boolean> {
    const [cmd, ...args] = helperArgv(x, "alive", [sock]);
    const r = await execHelper(HELPER_ALIVE_TIMEOUT_MS)(cmd, args);
    if (r.code !== 0) console.warn(`[terminal] helper alive ${sock} failed: ${reasonLine(r)}`);
    return r.code === 0 && r.stdout.trim() === "dead";
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    this.inputAt.set(id, this.now());
    t.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (!t) return;
    try { t.proc.resize(cols, rows); } catch { return; /* resize race on a dying pty */ }
    this.observe((o) => o.resize(id, cols, rows));
  }

  kill(id: string): void {
    this.killed.add(id);
    if (this.pendingAttach.has(id)) this.cancelledAttach.add(id);
    // End the persisted host, not just the local client — detaching alone would
    // leave the agent running headless. dtach: kill the master holding the
    // socket (matched by its unique path in argv); closing the master's PTY
    // SIGHUPs the inner process, which then exits and removes the socket. A
    // harmless no-op for ephemeral shells or already-dead sessions, and it
    // covers an agent alive but unattached here.
    // Then the whole process tree of the session (claude and what it started:
    // dev servers, browsers, builds), so a stop really frees the memory. The
    // pkill stays as the fallback where /proc is not available.
    // A session as the agent uid: the helper kills its tree (the console uid
    // cannot signal it). Not awaited: the helper waits up to its 5 s grace.
    // An ephemeral shell (a local PTY without a session) stays direct.
    const local = this.terms.get(id);
    const route = local && !local.session ? DIRECT : this.route(id, dtachSocket(id));
    if (route.via === "helper") {
      this.helperCall(route.x, "kill", dtachSocket(id), HELPER_KILL_TIMEOUT_MS)
        .catch((e: unknown) => console.warn(`[terminal] helper kill ${dtachSocket(id)} failed: ${errText(e)}`));
    } else {
      killSessionTree(dtachSocket(id));
      execFile("pkill", ["-f", pkillPattern(dtachSocket(id))], () => { /* best effort */ });
    }
    const t = this.terms.get(id);
    if (t) { try { t.proc.kill(); } catch { /* already gone */ } }
    else {
      this.killed.delete(id); // nothing local to fire onExit; don't leak the marker
      // No local Term means onExit won't clean up — drop any orphaned transcript
      // for an agent that was alive-but-unattached in this process.
      new Transcript(this.transcriptFile(id)).remove();
    }
  }

  // Graceful server shutdown: detach every local PTY client from its dtach
  // master without ending the master, so persisted agents keep running headless
  // and reattach cleanly next boot. Critically, this stops `dtach -a` clients
  // from orphaning onto init on each restart — stacked orphan clients pin the
  // dtach window size, which defeats the reconnecting browser's resize-driven
  // redraw and leaves a reattached idle agent's terminal blank. Ephemeral
  // (non-persisted) shells just die with us, which is fine. The onExit handler
  // sees shuttingDown and keeps each transcript intact for the next boot.
  shutdown(): void {
    this.shuttingDown = true;
    for (const [, t] of this.terms) {
      // SIGKILL a persisted client: one stuck in write() ignores SIGHUP and
      // would linger as an orphan that stalls its dtach master.
      try { t.proc.kill(t.session ? "SIGKILL" : undefined); } catch { /* already gone */ }
    }
    this.terms.clear();
  }

  has(id: string): boolean {
    return this.terms.has(id);
  }

  // With `resume`, returns only the output after that point when this stream
  // still holds it; otherwise the full history (resumed: false).
  attach(id: string, resume?: ResumePoint): Attachment | null {
    const t = this.terms.get(id);
    if (!t) return null;
    const delta = resume?.epoch === t.epoch ? t.buffer.since(resume.offset) : null;
    const snapshot = delta ?? t.buffer.snapshot();
    return {
      snapshot,
      epoch: t.epoch,
      offset: t.buffer.end - snapshot.length,
      resumed: delta !== null,
      subscribe: (cb) => {
        t.subs.add(cb);
        return () => t.subs.delete(cb);
      },
      onEnd: (cb) => {
        t.ends.add(cb);
        return () => t.ends.delete(cb);
      },
    };
  }
}
