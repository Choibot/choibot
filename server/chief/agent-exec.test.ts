// server/chief/agent-exec.test.ts — deploy/choibot-agent-exec, the privilege
// helper the console calls through `sudo -u choibot-agent` (spec Appendix B
// step 3, Phase 2c Task 2c-1). No test runs sudo: each runs the helper
// directly as the current user, with a temp conf (CHOIBOT_AGENT_EXEC_CONF) and a
// temp dtach dir. `spawn` and `attach` need a terminal: they run under
// node-pty. Every process a test starts is killed by pid in afterEach.
import * as pty from "node-pty";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistCommand, sessionTreePids } from "../agents/terminal.js";
import { parseRead } from "../agents/agentclone.js";

const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));
const DTACH_BIN = existsSync("/home/dev/.local/bin/dtach")
  ? "/home/dev/.local/bin/dtach"
  : execFileSync("/bin/sh", ["-c", "command -v dtach"], { encoding: "utf8" }).trim();
// The helper's own user (from the passwd file, not $HOME).
const ME = userInfo();
const DEFAULT_AGENT_PATH = "/usr/local/bin:/usr/bin:/bin";

let root = "";
let dtachDir = "";
let conf = "";
let wt = "";
let ws = "";
let homes = "";
const sockets: string[] = [];
const tracked: { pid: number; start: string }[] = [];
const extraDirs: string[] = [];

// Start time (clock ticks since boot) of a live process, "" when gone.
function startOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return f[0] === "Z" || f[0] === "X" ? "" : (f[19] ?? "");
  } catch { return ""; }
}
const alive = (pid: number): boolean => startOf(pid) !== "";

// Remember a pid with its start time, so afterEach never kills a reused pid.
function track(pid: number | undefined): void {
  if (pid) tracked.push({ pid, start: startOf(pid) });
}

function writeConf(extra: string[] = [], omit = ""): void {
  const lines = [
    `DTACH_DIR=${dtachDir}`, `DTACH_BIN=${DTACH_BIN}`, `WORKTREE_ROOT=${wt}`,
    `WORKSPACE_DIR=${ws}`, `AGENT_HOME_ROOT=${homes}`,
  ].filter((l) => !omit || !l.startsWith(`${omit}=`));
  writeFileSync(conf, ["# choibot-agent-exec test conf", "", ...lines, ...extra, ""].join("\n"));
}

const baseEnv = (): Record<string, string> => ({ PATH: "/usr/bin:/bin", CHOIBOT_AGENT_EXEC_CONF: conf });

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number };

// Run the helper to completion (pipes, no terminal).
function run(args: string[], o: { env?: Record<string, string>; input?: string; helper?: string } = {}): Promise<Run> {
  const t0 = Date.now();
  return new Promise((res) => {
    const child = spawn(o.helper ?? HELPER, args, { env: { ...baseEnv(), ...o.env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.on("error", () => { /* the helper exited before reading */ });
    child.stdin.end(o.input ?? "");
    child.on("error", (e) => res({ code: -1, signal: null, stdout, stderr: String(e), ms: Date.now() - t0 }));
    child.on("close", (code, signal) => res({ code, signal, stdout, stderr, ms: Date.now() - t0 }));
  });
}

// Run the helper on a terminal (spawn and attach need one).
function ptyRun(args: string[], env: Record<string, string> = {}): { p: pty.IPty; out: () => string; exited: Promise<number> } {
  const p = pty.spawn(HELPER, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: "/", env: { ...baseEnv(), ...env } });
  track(p.pid);
  let out = "";
  p.onData((d) => { out += d; });
  const exited = new Promise<number>((r) => { p.onExit(({ exitCode }) => r(exitCode)); });
  return { p, out: () => out, exited };
}

function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) return res();
      if (Date.now() - t0 > ms) return rej(new Error("waitFor timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

function sock(name: string): string {
  const s = join(dtachDir, name);
  sockets.push(s);
  return s;
}

type DtachProc = { pid: number; argv: string[]; fd0: string };
// The dtach processes whose argv names the socket (test-side /proc scan).
function dtachOn(s: string): DtachProc[] {
  const out: DtachProc[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").slice(0, -1);
      if (!argv[0]?.endsWith("/dtach") || !argv.includes(s)) continue;
      out.push({ pid: Number(d), argv, fd0: readlinkSync(`/proc/${d}/fd/0`) });
    } catch { /* gone */ }
  }
  return out;
}
const masterOf = (s: string): DtachProc | undefined => dtachOn(s).find((p) => !p.fd0.startsWith("/dev/pts/"));
const clientsOf = (s: string): number[] => dtachOn(s).filter((p) => p.fd0.startsWith("/dev/pts/")).map((p) => p.pid).sort();

function childrenOf(pid: number): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid) out.push(Number(d));
    } catch { /* gone */ }
  }
  return out;
}

function script(name: string, body: string): string {
  const f = join(root, "scripts", name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(f, body);
  chmodSync(f, 0o755);
  return f;
}

// NUL-separated /proc/<pid>/environ → object.
function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const kv of raw.split("\0").filter(Boolean)) {
    const i = kv.indexOf("=");
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

// Console secrets and other keys the caller env holds; none may pass.
const SECRETS = {
  TELEGRAM_BOT_TOKEN: "tg-bot-token-secret",
  CONSOLE_COOKIE_SECRET: "cookie-secret",
  CHOIBOT_USER_TOKEN: "user-token-secret",
  OTHER_KEY: "other",
  HOME: "/caller/home",
};

beforeEach(() => {
  dtachDir = mkdtempSync("/tmp/hct-");
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-exec-")));
  wt = join(root, "worktrees");
  ws = join(root, "workspace");
  homes = join(root, "homes");
  for (const d of [wt, ws, homes]) mkdirSync(d);
  conf = join(root, "agent-exec.conf");
  writeConf();
});

afterEach(() => {
  // Each session tree by its socket (no cgroup sweep: tests share a scope).
  for (const s of sockets.splice(0)) {
    for (const p of sessionTreePids(s, { cgroupRoot: "/nonexistent" })) {
      try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  for (const t of tracked.splice(0)) {
    if (t.start && startOf(t.pid) === t.start) {
      try { process.kill(t.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  for (const d of [dtachDir, ...extraDirs.splice(0)]) {
    if (d.startsWith("/tmp/hct-")) rmSync(d, { recursive: true, force: true });
  }
  if (root.includes("agent-exec-")) rmSync(root, { recursive: true, force: true });
});

describe("choibot-agent-exec: config", () => {
  it("probe prints ok and exits 0", async () => {
    const r = await run(["probe"]);
    expect(r).toMatchObject({ code: 0, stdout: "ok\n", stderr: "" });
  });

  it("a missing required key exits 2 with one reason line", async () => {
    for (const key of ["DTACH_DIR", "DTACH_BIN", "WORKTREE_ROOT", "WORKSPACE_DIR", "AGENT_HOME_ROOT"]) {
      writeConf([], key);
      const r = await run(["probe"]);
      expect(r.code, key).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).toContain(key);
    }
  });

  it("a conf file that is missing exits 2", async () => {
    const r = await run(["probe"], { env: { CHOIBOT_AGENT_EXEC_CONF: join(root, "nope.conf") } });
    expect(r.code).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("parses the conf as KEY=VALUE lines and never runs it", async () => {
    const m = (n: string) => join(root, `marker-${n}`);
    writeConf([
      `$(touch ${m("1")})`,
      `UNKNOWN_KEY=$(touch ${m("2")})`,
      `\`touch ${m("3")}\``,
      `touch ${m("4")}`,
      `export FOO=bar; touch ${m("5")}`,
    ]);
    const r = await run(["probe"]);
    expect(r).toMatchObject({ code: 0, stdout: "ok\n" });
    for (const n of ["1", "2", "3", "4", "5"]) expect(existsSync(m(n)), n).toBe(false);
  });

  it("refuses a relative path or / as a root, and a bad RUN_TIMEOUT", async () => {
    for (const extra of ["WORKSPACE_DIR=relative/dir", "AGENT_HOME_ROOT=/", "RUN_TIMEOUT=abc", "RUN_TIMEOUT=0", "DTACH_BIN=dtach"]) {
      writeConf([extra]);
      const r = await run(["probe"]);
      expect(r.code, extra).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
    }
  });

  it("ignores BASH_ENV and exported functions from the caller env (bash -p)", async () => {
    const marker = join(root, "marker-bash-env");
    const rc = join(root, "bash-env.sh");
    writeFileSync(rc, `touch ${marker}\n`);
    const r = await run(["probe"], {
      env: { BASH_ENV: rc, ENV: rc, "BASH_FUNC_printf%%": `() { touch ${marker}; }` },
    });
    expect(r).toMatchObject({ code: 0, stdout: "ok\n" });
    expect(existsSync(marker)).toBe(false);
  });

  it("an unknown verb or no verb exits 2", async () => {
    expect((await run(["sh"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });
});

describe("choibot-agent-exec: refusals (Review Focus 2)", () => {
  async function refused(args: string[]): Promise<void> {
    const r = await run(args);
    expect(r.code, args.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    // Nothing was started: no socket in the dtach dir.
    expect(readdirSync(dtachDir).filter((n) => lstatSync(join(dtachDir, n)).isSocket())).toEqual([]);
  }

  it("refuses a socket outside DTACH_DIR, misnamed, a service socket, nested, unnormalized or a symlink", async () => {
    const other = mkdtempSync("/tmp/hct-");
    extraDirs.push(other);
    mkdirSync(join(dtachDir, "sub"));
    symlinkSync(join(other, "choibot-link.sock"), join(dtachDir, "choibot-link.sock"));
    const bad = [
      "/tmp/x.sock",
      join(other, "choibot-a.sock"),
      "choibot-a.sock",
      join(dtachDir, "other.sock"),
      join(dtachDir, "choibot-a.socket"),
      join(dtachDir, "choibot-svc-web.sock"),
      join(dtachDir, "choibot-svc-web.sock"),
      join(dtachDir, "choibotx-a.sock"),
      join(dtachDir, "choibot-a b.sock"),
      join(dtachDir, "sub", "choibot-a.sock"),
      `${dtachDir}/sub/../choibot-a.sock`,
      `${dtachDir}//choibot-a.sock`,
      `${dtachDir}/./choibot-a.sock`,
      join(dtachDir, "choibot-link.sock"),
    ];
    for (const s of bad) {
      await refused(["spawn", s, ws, "--", "/bin/cat"]);
      for (const verb of ["attach", "kill", "kill-clients", "pids"]) await refused([verb, s]);
    }
  });

  it("refuses a cwd outside WORKTREE_ROOT, WORKSPACE_DIR and AGENT_HOME_ROOT", async () => {
    const s = join(dtachDir, "choibot-cwd.sock");
    mkdirSync(`${wt}x`);
    mkdirSync(join(root, "elsewhere"));
    symlinkSync("/etc", join(ws, "etc-link"));
    for (const cwd of ["/etc", `${wt}x`, join(root, "elsewhere"), join(ws, "etc-link"), `${ws}/../elsewhere`, "workspace", join(ws, "missing")]) {
      await refused(["spawn", s, cwd, "--", "/bin/cat"]);
      await refused(["run", script("ok.sh", "#!/bin/sh\necho hi\n"), cwd]);
    }
  });

  it("refuses control characters in a cwd, a socket or a run file (a trailing newline must not escape a root)", async () => {
    const s = sock("choibot-nl.sock");
    const ok = script("ok.sh", "#!/bin/sh\necho hi\n");
    // Command substitution drops a trailing newline: "<root>/..\n" must not
    // become "<root>/..", which is inside the root's check but resolves to its parent.
    for (const cwd of [`${ws}/..\n`, `${homes}/..\n`, `${wt}/..\n`]) {
      await refused(["spawn", s, cwd, "--", "/bin/cat"]);
      await refused(["run", ok, cwd]);
    }
    const tabDir = join(ws, "tab\tdir");
    mkdirSync(tabDir);
    await refused(["spawn", s, tabDir, "--", "/bin/cat"]);
    await refused(["run", ok, tabDir]);
    for (const verb of ["attach", "kill", "kill-clients", "pids"]) await refused([verb, `${s}\n`]);
    await refused(["spawn", `${s}\n`, ws, "--", "/bin/cat"]);
    await refused(["spawn", join(dtachDir, "choibot-a\u0001.sock"), ws, "--", "/bin/cat"]);
    // An existing script whose name holds an escape character.
    await refused(["run", script("esc\u001b.sh", "#!/bin/sh\necho hi\n"), ws]);
    await refused(["run", `${ok}\n`, ws]);
  });

  it("refuses an empty or option-looking command and a spawn without --", async () => {
    const s = join(dtachDir, "choibot-cmd.sock");
    await refused(["spawn", s, ws, "--", ""]);
    await refused(["spawn", s, ws, "--", "-c"]);
    await refused(["spawn", s, ws, "--"]);
    await refused(["spawn", s, ws, "/bin/cat"]);
    await refused(["spawn", s, ws]);
  });

  it("refuses run of a relative or missing file and wrong arg counts", async () => {
    await refused(["run", "ok.sh", ws]);
    await refused(["run", join(root, "missing.sh"), ws]);
    await refused(["run", script("ok.sh", "#!/bin/sh\n"), ws, "extra"]);
    await refused(["attach"]);
    await refused(["kill", join(dtachDir, "choibot-a.sock"), "extra"]);
    await refused(["probe", "extra"]);
  });
});

describe("choibot-agent-exec: spawn, attach, pids, kill-clients, kill", () => {
  it("spawn passes on only the env allowlist plus its own PATH and HOME; a cwd under AGENT_HOME_ROOT is accepted", async () => {
    const s = sock("choibot-fleet-master.sock");
    const cwd = join(homes, "fleet-master");
    mkdirSync(cwd);
    const out = join(root, "env.out");
    const keep = {
      CHOIBOT_AGENT_ID: "fleet-master",
      CHOIBOT_AGENT_PASS: "agent-pass-123",
      PORT: "3999",
      CLAUDE_CONFIG_DIR: "/x/claude-config",
      CODEX_HOME: "/x/codex",
      LANG: "C.UTF-8",
      CHOIBOT_WIDGET_DIR: "/x/widgets",
      CHOIBOT_CRON_SPOOL: join(homes, "cron-spool"),
      CRON_DATA_DIR: "/x/cron-data",
    };
    const a = ptyRun(
      ["spawn", s, cwd, "--", "/usr/bin/env", "/bin/sh", "-c",
        'pwd -P > "$0.cwd"; cat /proc/$$/environ > "$0.tmp"; mv "$0.tmp" "$0"', out],
      { ...SECRETS, ...keep },
    );
    await waitFor(() => existsSync(out), 6000);
    const env = parseEnviron(readFileSync(out, "utf8"));
    expect(env).toEqual({ ...keep, TERM: "xterm-256color", HOME: ME.homedir, PATH: DEFAULT_AGENT_PATH });
    expect(env.CHOIBOT_AGENT_PASS).toBe("agent-pass-123");
    expect(env.CHOIBOT_CRON_SPOOL).toBe(join(homes, "cron-spool"));
    expect(env.CRON_DATA_DIR).toBe("/x/cron-data");
    expect(env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(env).not.toHaveProperty("CONSOLE_COOKIE_SECRET");
    expect(env).not.toHaveProperty("CHOIBOT_AGENT_EXEC_CONF");
    expect(readFileSync(`${out}.cwd`, "utf8").trim()).toBe(cwd);
    await within(a.exited, 6000);
  }, 20_000);

  it("spawn of /bin/cat: the master argv mirrors persistCommand, pids lists only attached clients, kill ends the session", async () => {
    const s = sock("choibot-cat1.sock");
    const a = ptyRun(["spawn", s, ws, "--", "/bin/cat"]);
    await waitFor(() => existsSync(s) && masterOf(s) !== undefined && clientsOf(s).length === 1, 6000);
    const master = masterOf(s)!;
    // Same dtach argv as today's direct path (server/agents/terminal.ts).
    expect(master.argv).toEqual([DTACH_BIN, ...persistCommand({ dtach: DTACH_BIN, systemdRun: null }, s, "/bin/cat", []).args]);
    const cat = childrenOf(master.pid);
    expect(cat).toHaveLength(1);

    expect(await run(["pids", s])).toMatchObject({ code: 0, stdout: `${a.p.pid}\n` });

    a.p.kill(); // SIGHUP: the spawn client leaves, the master stays
    await within(a.exited, 4000);
    expect(alive(master.pid)).toBe(true);
    expect(await run(["pids", s])).toMatchObject({ code: 0, stdout: "" });

    const r = await run(["kill", s]);
    expect(r.code).toBe(0);
    await waitFor(() => !existsSync(s), 6000);
    await waitFor(() => !alive(master.pid) && !alive(cat[0]), 2000);
  }, 20_000);

  it("attach relays to the session; kill-clients kills every client and never the master", async () => {
    const s = sock("choibot-kc1.sock");
    const a = ptyRun(["spawn", s, ws, "--", "/bin/cat"]);
    await waitFor(() => existsSync(s) && clientsOf(s).length === 1, 6000);
    const b = ptyRun(["attach", s], { TERM: "xterm-256color" });
    await waitFor(() => clientsOf(s).length === 2, 6000);
    const master = masterOf(s)!;
    const attachClient = dtachOn(s).find((p) => p.pid === b.p.pid)!;
    expect(attachClient.argv).toEqual([DTACH_BIN, "-a", s, "-E", "-z", "-r", "winch"]);

    b.p.write("PING_ATTACH\r");
    await waitFor(() => b.out().includes("PING_ATTACH") && a.out().includes("PING_ATTACH"));

    const listed = (await run(["pids", s])).stdout.trim().split("\n").map(Number).sort();
    expect(listed).toEqual([a.p.pid, b.p.pid].sort());

    const r = await run(["kill-clients", s]);
    expect(r).toMatchObject({ code: 0, stdout: "" });
    await within(Promise.all([a.exited, b.exited]), 4000);
    expect(alive(master.pid)).toBe(true);
    expect(existsSync(s)).toBe(true);
    expect(await run(["pids", s])).toMatchObject({ code: 0, stdout: "" });

    // The master still serves a new client.
    const c = ptyRun(["attach", s]);
    await waitFor(() => clientsOf(s).length === 1, 6000);
    c.p.write("PING_AGAIN\r");
    await waitFor(() => c.out().includes("PING_AGAIN"));
    expect((await run(["kill", s])).code).toBe(0);
    await waitFor(() => !existsSync(s), 6000);
  }, 20_000);

  it("kill ends the whole tree, SIGKILLs a TERM-proof process after the grace, and spares processes outside the session", async () => {
    const s = sock("choibot-tree1.sock");
    const pidFile = join(root, "tree.pids");
    const body = "trap '' TERM HUP; sleep 300 & echo $! > \"$0.tmp\"; echo $$ >> \"$0.tmp\"; mv \"$0.tmp\" \"$0\"; while :; do sleep 1; done";
    ptyRun(["spawn", s, ws, "--", "/bin/sh", "-c", body, pidFile]);
    await waitFor(() => existsSync(pidFile), 6000);
    const [bg, sh] = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    track(bg);
    track(sh);
    const sibling = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    track(sibling.pid);
    const master = masterOf(s)!;

    const r = await run(["kill", s]);
    expect(r.code).toBe(0);
    // The TERM-proof shell held the helper for the 5 s grace, then got SIGKILL.
    expect(r.ms).toBeGreaterThanOrEqual(4500);
    expect(r.ms).toBeLessThan(9000);
    await waitFor(() => !alive(bg) && !alive(sh) && !alive(master.pid), 2000);
    expect(existsSync(s)).toBe(false);
    expect(alive(sibling.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  }, 25_000);

  it("kill, kill-clients and pids of a socket with no session do nothing and exit 0", async () => {
    const s = sock("choibot-none.sock");
    for (const verb of ["kill", "kill-clients", "pids"]) {
      expect(await run([verb, s]), verb).toMatchObject({ code: 0, stdout: "" });
    }
  });

  // The socket name of a new install (server/names.mjs): the same checks, the other prefix.
  it("takes a choibot-<id>.sock socket like a choibot-<id>.sock one", async () => {
    const s = sock("choibot-none.sock");
    for (const verb of ["kill", "kill-clients", "pids"]) {
      expect(await run([verb, s]), verb).toMatchObject({ code: 0, stdout: "" });
    }
  });
});

// alive (server/agents/terminal.ts: the reattach and hasSession of a session that may have died):
// "dead" only on positive proof, a connect to the socket that is refused; a doubt is "unknown".
describe("choibot-agent-exec: alive", () => {
  const killTree = (s: string): void => {
    for (const p of sessionTreePids(s, { cgroupRoot: "/nonexistent" })) {
      try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ }
    }
  };

  it("a live session: live; the session goes on, and no client of the check stays", async () => {
    const s = sock("choibot-alive1.sock");
    const a = ptyRun(["spawn", s, ws, "--", "/bin/cat"]);
    await waitFor(() => existsSync(s) && masterOf(s) !== undefined && clientsOf(s).length === 1, 6000);
    const master = masterOf(s)!;
    expect(await run(["alive", s])).toMatchObject({ code: 0, stdout: "live\n" });
    a.p.write("PING_ALIVE\r");
    await waitFor(() => a.out().includes("PING_ALIVE"));
    expect(alive(master.pid)).toBe(true);
    expect(clientsOf(s)).toEqual([a.p.pid]);
  }, 20_000);

  it("its master killed with SIGKILL and the socket file left: dead, nothing unlinked; a spawn over it starts a new session", async () => {
    const s = sock("choibot-alive2.sock");
    ptyRun(["spawn", s, ws, "--", "/bin/cat"]);
    await waitFor(() => existsSync(s) && masterOf(s) !== undefined, 6000);
    const old = masterOf(s)!.pid;
    killTree(s);
    await waitFor(() => !alive(old) && masterOf(s) === undefined, 4000);
    expect(existsSync(s)).toBe(true);
    expect(await run(["alive", s])).toMatchObject({ code: 0, stdout: "dead\n" });
    expect(lstatSync(s).isSocket()).toBe(true);
    // The spawn is dtach -A: it removes a socket that refuses a connect and starts there.
    const b = ptyRun(["spawn", s, ws, "--", "/bin/cat"]);
    await waitFor(() => masterOf(s) !== undefined && masterOf(s)!.pid !== old, 6000);
    expect(await run(["alive", s])).toMatchObject({ code: 0, stdout: "live\n" });
    b.p.write("PING_NEW\r");
    await waitFor(() => b.out().includes("PING_NEW"));
  }, 20_000);

  it("unknown, never dead: no file, a file that is not a socket, a socket that refuses this uid (EACCES)", async () => {
    expect(await run(["alive", sock("choibot-none.sock")])).toMatchObject({ code: 0, stdout: "unknown\n" });
    const f = sock("choibot-file.sock");
    writeFileSync(f, "x");
    expect(await run(["alive", f])).toMatchObject({ code: 0, stdout: "unknown\n" });
    const s = sock("choibot-alive3.sock");
    ptyRun(["spawn", s, ws, "--", "/bin/cat"]);
    await waitFor(() => existsSync(s) && masterOf(s) !== undefined, 6000);
    chmodSync(s, 0o000);
    expect(await run(["alive", s])).toMatchObject({ code: 0, stdout: "unknown\n" });
    chmodSync(s, 0o600);
    expect(await run(["alive", s])).toMatchObject({ code: 0, stdout: "live\n" });
  }, 20_000);

  it("the same path checks as the other socket verbs: outside DTACH_DIR, a link, a bad name, no argument", async () => {
    const inside = sock("choibot-target.sock");
    writeFileSync(inside, "x");
    const link = sock("choibot-link.sock");
    symlinkSync(inside, link);
    for (const [args, why] of [
      [["alive", join(root, "choibot-x.sock")], /socket outside DTACH_DIR/],
      [["alive", link], /socket outside DTACH_DIR/],
      [["alive", join(dtachDir, "x.sock")], /socket name refused/],
      [["alive"], /usage: alive <socket>/],
    ] as const) {
      const r = await run([...args]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toMatch(why);
      expect(r.stdout).toBe("");
    }
  });

  it("its time limit: a connect that does not end is unknown after about 3 s", async () => {
    const s = sock("choibot-slow.sock");
    const server = createServer();
    await new Promise<void>((r) => server.listen(s, () => r()));
    try {
      writeConf([`DTACH_BIN=${script("dtach-hangs", "#!/bin/sh\nexec /bin/sleep 30\n")}`], "DTACH_BIN");
      const r = await run(["alive", s]);
      expect(r).toMatchObject({ code: 0, stdout: "unknown\n" });
      expect(r.ms).toBeGreaterThan(2500);
      expect(r.ms).toBeLessThan(8000);
    } finally {
      server.close();
    }
  }, 20_000);
});

// env-check: the console's check at its start that the sudoers line keeps the agent keys
// (env_keep), now that it gives sudo no --preserve-env list (sudo logs each of its values).
describe("choibot-agent-exec: env-check", () => {
  it("prints the NAMES of the keys of its list that arrived, one a line, never a value; no other key", async () => {
    const r = await run(["env-check"], { env: { CHOIBOT_AGENT_ID: "env-check", CHOIBOT_AGENT_PASS: "made-up-pass-of-a-test", PORT: "3999", TELEGRAM_BOT_TOKEN: "tg-x", OTHER_KEY: "o" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("CHOIBOT_AGENT_ID\nCHOIBOT_AGENT_PASS\nPORT\n");
    expect(r.stdout).not.toContain("made-up-pass");
    expect(r.stdout).not.toContain("env-check");
    expect(r.stderr).toBe("");
  });

  it("with no key of its list: nothing (the console then stops agent exec); an argument is refused", async () => {
    expect(await run(["env-check"], { env: { OTHER_KEY: "o" } })).toMatchObject({ code: 0, stdout: "" });
    const r = await run(["env-check", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: env-check/);
  });
});

describe("choibot-agent-exec: run", () => {
  it("passes stdin through and returns the script's output", async () => {
    const f = script("echo.sh", "#!/bin/sh\ncat\n");
    const r = await run(["run", f, ws], { input: "hello-stdin\n" });
    expect(r).toMatchObject({ code: 0, stdout: "hello-stdin\n" });
  });

  it("runs in the cwd with only PATH, HOME, USER, LANG, TZ, CHOIBOT_WIDGET_DIR, CHOIBOT_AGENT_ID", async () => {
    writeConf(["AGENT_PATH=/opt/agent/bin:/usr/bin:/bin"]);
    const cwd = join(wt, "agent-1");
    mkdirSync(cwd);
    const f = script("env.sh", "#!/bin/sh\npwd -P\ncat /proc/$$/environ\n");
    const keep = { LANG: "C.UTF-8", TZ: "UTC", CHOIBOT_WIDGET_DIR: "/x/widgets/w1", CHOIBOT_AGENT_ID: "agent-1" };
    const r = await run(["run", f, cwd], { env: { ...SECRETS, ...keep, CHOIBOT_AGENT_PASS: "agent-pass", PORT: "3999" } });
    expect(r.code).toBe(0);
    const nl = r.stdout.indexOf("\n");
    expect(r.stdout.slice(0, nl)).toBe(cwd);
    expect(parseEnviron(r.stdout.slice(nl + 1))).toEqual({
      ...keep, PATH: "/opt/agent/bin:/usr/bin:/bin", HOME: ME.homedir, USER: ME.username,
    });
  });

  it("kills a hanging script and its background jobs at RUN_TIMEOUT", async () => {
    writeConf(["RUN_TIMEOUT=1"]);
    const wdir = join(root, "w");
    mkdirSync(wdir);
    const f = script("hang.sh", "#!/bin/sh\nsleep 60 &\necho $! > \"$CHOIBOT_WIDGET_DIR/bg.pid\"\nsleep 60\n");
    const r = await run(["run", f, ws], { env: { CHOIBOT_WIDGET_DIR: wdir } });
    expect(r.signal).toBe("SIGKILL");
    expect(r.stderr).toBe(""); // no bash job notice in the widget's error text
    expect(r.ms).toBeLessThan(5000);
    const bg = Number(readFileSync(join(wdir, "bg.pid"), "utf8"));
    track(bg);
    await waitFor(() => !alive(bg), 2000);
  }, 15_000);
});

describe("choibot-agent-exec: run leaves nothing behind (fix round 1)", () => {
  const widgetDir = (): string => {
    const d = join(root, "w");
    mkdirSync(d, { recursive: true });
    return d;
  };
  const pidIn = (dir: string): number => {
    const pid = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
    track(pid);
    return pid;
  };

  it("a clean exit: the background job the script started is killed with its group", async () => {
    const wdir = widgetDir();
    const f = script("bg.sh", "#!/bin/sh\nsleep 30 >/dev/null 2>&1 &\necho $! > \"$CHOIBOT_WIDGET_DIR/bg.pid\"\necho done\n");
    const r = await run(["run", f, ws], { env: { CHOIBOT_WIDGET_DIR: wdir } });
    expect(r).toMatchObject({ code: 0, signal: null, stdout: "done\n" });
    const bg = pidIn(wdir);
    await waitFor(() => !alive(bg), 2000);
  });

  it("a background job that keeps stdout open does not hold the run", async () => {
    const wdir = widgetDir();
    const f = script("bg-out.sh", "#!/bin/sh\nsleep 30 &\necho $! > \"$CHOIBOT_WIDGET_DIR/bg.pid\"\necho done\n");
    try {
      const r = await within(run(["run", f, ws], { env: { CHOIBOT_WIDGET_DIR: wdir } }), 5000);
      expect(r).toMatchObject({ code: 0, signal: null, stdout: "done\n" });
      expect(r.ms).toBeLessThan(3000);
    } finally {
      if (existsSync(join(wdir, "bg.pid"))) pidIn(wdir);
    }
    const bg = pidIn(wdir);
    await waitFor(() => !alive(bg), 2000);
  });

  it("exits with the script's code; a signal death is the same signal, not 128+n", async () => {
    expect(await run(["run", script("three.sh", "#!/bin/sh\nexit 3\n"), ws])).toMatchObject({ code: 3, signal: null });
    expect(await run(["run", script("usr1.sh", "#!/bin/sh\nkill -USR1 $$\nsleep 5\n"), ws])).toMatchObject({ code: null, signal: "SIGUSR1" });
  });

  it("SIGTERM to the helper reaches the script and its background job; the helper ends by SIGTERM", async () => {
    const wdir = widgetDir();
    const f = script("hang.sh", "#!/bin/sh\nsleep 30 &\necho $! > \"$CHOIBOT_WIDGET_DIR/bg.pid\"\nsleep 30\n");
    const env: Record<string, string> = { ...baseEnv(), CHOIBOT_WIDGET_DIR: wdir };
    const child = spawn(HELPER, ["run", f, ws], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] });
    track(child.pid);
    const ended = new Promise<NodeJS.Signals | null>((res) => child.on("exit", (_c, sig) => res(sig)));
    await waitFor(() => existsSync(join(wdir, "bg.pid")) && readFileSync(join(wdir, "bg.pid"), "utf8").endsWith("\n"));
    const bg = pidIn(wdir);
    const t0 = Date.now();
    child.kill("SIGTERM");
    expect(await within(ended, 5000)).toBe("SIGTERM");
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitFor(() => !alive(bg), 2000);
  });

  it("passes TZ from the env_keep list to the script (ruling 2c-5-a)", async () => {
    const r = await run(["run", script("tz.sh", "#!/bin/sh\nprintf '%s' \"$TZ\"\n"), ws], { env: { TZ: "Europe/Paris" } });
    expect(r).toMatchObject({ code: 0, stdout: "Europe/Paris" });
  });
});

// claude-auth: the Claude login of the agent user (strong protection, one login). The config dir
// must be inside the helper's own home: the test makes a throwaway folder there and removes it.
describe("choibot-agent-exec: claude-auth", () => {
  let home = "";
  let bin = "";
  beforeEach(() => {
    home = mkdtempSync(join(ME.homedir, ".agent-exec-test-"));
    bin = join(root, "agentbin");
    mkdirSync(bin);
    // The fake prints its args, its cwd and its env, then (login) reads one line from stdin.
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"args: $*\"\npwd -P\ncat /proc/$$/environ\necho\nif [ \"$2\" = login ]; then IFS= read -r c; echo \"code: $c\"; fi\n");
    chmodSync(join(bin, "claude"), 0o755);
    writeConf([`AGENT_PATH=${bin}:/usr/bin:/bin`]);
  });
  afterEach(() => { if (home.includes(".agent-exec-test-")) rmSync(home, { recursive: true, force: true }); });

  it("status: `claude auth status` from AGENT_PATH, in the agent's home, with only HOME, PATH, the config dir, NO_COLOR, TERM, LANG, TZ", async () => {
    const r = await run(["claude-auth", "status"], { env: { ...SECRETS, CLAUDE_CONFIG_DIR: `${home}/./.claude`, LANG: "C.UTF-8", TZ: "UTC", CHOIBOT_AGENT_PASS: "pass", PORT: "3999" } });
    expect(r.code, r.stderr).toBe(0);
    const [args, cwd, ...rest] = r.stdout.split("\n");
    expect(args).toBe("args: auth status");
    expect(cwd).toBe(realpathSync(ME.homedir));
    expect(parseEnviron(rest.join("\n").trim())).toEqual({
      HOME: ME.homedir, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: `${home}/.claude`, NO_COLOR: "1", TERM: "dumb", LANG: "C.UTF-8", TZ: "UTC",
    });
  });

  it("login: stdin reaches the command (the code that the page sends)", async () => {
    const r = await run(["claude-auth", "login"], { env: { CLAUDE_CONFIG_DIR: `${home}/.claude` }, input: "the-code_123\n" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("args: auth login");
    expect(r.stdout.trim().split("\n").at(-1)).toBe("code: the-code_123");
  });

  it("logout: `claude auth logout` in the agent's home, with the same env, and stdin is /dev/null (Sign out of the page)", async () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"args: $*\"\npwd -P\nreadlink /proc/$$/fd/0\necho \"dir: $CLAUDE_CONFIG_DIR\"\n");
    const r = await run(["claude-auth", "logout"], { env: { ...SECRETS, CLAUDE_CONFIG_DIR: `${home}/.claude` }, input: "nothing is read\n" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["args: auth logout", realpathSync(ME.homedir), "/dev/null", `dir: ${home}/.claude`]);
  });

  it("refuses another subcommand, a missing, relative or control-character config dir, and a dir outside the agent's home", async () => {
    const cases: [string[], Record<string, string>, RegExp][] = [
      [["claude-auth", "setup-token"], { CLAUDE_CONFIG_DIR: `${home}/.claude` }, /unknown subcommand/],
      [["claude-auth", "logout", "x"], { CLAUDE_CONFIG_DIR: `${home}/.claude` }, /usage: claude-auth/],
      [["claude-auth", "logout"], { CLAUDE_CONFIG_DIR: join(root, ".claude") }, /outside the agent's home/],
      [["claude-auth"], { CLAUDE_CONFIG_DIR: `${home}/.claude` }, /usage: claude-auth/],
      [["claude-auth", "login", "x"], { CLAUDE_CONFIG_DIR: `${home}/.claude` }, /usage: claude-auth/],
      [["claude-auth", "status"], {}, /CLAUDE_CONFIG_DIR is not set/],
      [["claude-auth", "status"], { CLAUDE_CONFIG_DIR: ".claude" }, /must be an absolute path/],
      [["claude-auth", "status"], { CLAUDE_CONFIG_DIR: `${home}/.claude\n` }, /control character/],
      [["claude-auth", "status"], { CLAUDE_CONFIG_DIR: join(root, ".claude") }, /outside the agent's home/],
      [["claude-auth", "status"], { CLAUDE_CONFIG_DIR: `${home}/../../../etc` }, /outside the agent's home/],
      [["claude-auth", "status"], { CLAUDE_CONFIG_DIR: ME.homedir }, /outside the agent's home/],
    ];
    for (const [args, env, why] of cases) {
      const r = await run(args, { env });
      expect([args, env, r.code]).toEqual([args, env, 2]);
      expect(r.stderr).toMatch(why);
      expect(r.stdout).toBe("");
    }
  });

  it("puts a hard time limit on the command: a login or a status that hangs ends by SIGTERM (a copy of the helper with 1 s)", async () => {
    // As the real Claude Code: it does not end when stdin closes, and it ignores nothing else.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ntrap 'echo term >> "${home}/limit.log"; exit 143' TERM\nwhile :; do sleep 0.1; done\n`);
    const copy = join(root, "agent-exec-1s");
    writeFileSync(copy, readFileSync(HELPER, "utf8").replace(/^readonly CLAUDE_LOGIN_LIMIT=\d+$/m, "readonly CLAUDE_LOGIN_LIMIT=1").replace(/^readonly CLAUDE_STATUS_LIMIT=\d+$/m, "readonly CLAUDE_STATUS_LIMIT=1"));
    chmodSync(copy, 0o755);
    for (const sub of ["login", "status", "logout"]) {
      const t0 = Date.now();
      const r = await new Promise<{ code: number | null }>((res) => {
        const c = spawn(copy, ["claude-auth", sub], { env: { ...baseEnv(), CLAUDE_CONFIG_DIR: `${home}/.claude` } as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "ignore", "ignore"] });
        c.on("close", (code) => res({ code }));
      });
      expect([sub, r.code]).toEqual([sub, 124]);
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
    expect(readFileSync(join(home, "limit.log"), "utf8")).toBe("term\nterm\nterm\n");
  });

  it("the limits: a login lives a little longer than the page's link and its check; a status ends before the console stops waiting", async () => {
    const { CHECK_MS, LINK_MS, STATUS_MS } = await import("../agents/claudelogin.js");
    const text = readFileSync(HELPER, "utf8");
    const login = Number(/^readonly CLAUDE_LOGIN_LIMIT=(\d+)$/m.exec(text)?.[1]) * 1000;
    const status = Number(/^readonly CLAUDE_STATUS_LIMIT=(\d+)$/m.exec(text)?.[1]) * 1000;
    expect(login).toBeGreaterThan(LINK_MS + CHECK_MS);
    expect(login).toBeLessThanOrEqual(LINK_MS + CHECK_MS + 5 * 60_000);
    expect(status).toBeLessThan(STATUS_MS);
    expect(text).toContain('/usr/bin/timeout -s TERM -k 5 "$limit" claude auth "$1"');
    expect(text).toContain('/usr/bin/timeout -s TERM -k 5 "$limit" claude auth logout < /dev/null');
  });

  it("no claude on AGENT_PATH: exit 127 (the page says that the Claude program is not on the server)", async () => {
    writeConf(["AGENT_PATH=/nonexistent"]);
    const r = await run(["claude-auth", "status"], { env: { CLAUDE_CONFIG_DIR: `${home}/.claude` } });
    expect(r.code).toBe(127);
  });
});

// claude-print: one answer of a model with no tool, on the agents' login (the console's own calls).
describe("choibot-agent-exec: claude-print", () => {
  let home = "";
  let bin = "";
  beforeEach(() => {
    home = mkdtempSync(join(ME.homedir, ".agent-exec-test-"));
    bin = join(root, "agentbin");
    mkdirSync(bin);
    // The fake: each arg on its own line between markers, its cwd, its env, then its stdin.
    writeFileSync(join(bin, "claude"), `#!/bin/bash\nfor a in "$@"; do printf '<%s>\\n' "$a"; done\necho "cwd=$(pwd -P)"\necho "$(pwd -P)" > "${home}/cwd"\ncat /proc/$$/environ | tr '\\0' '\\n' | sort | sed 's/^/env:/'\ncat\n`);
    chmodSync(join(bin, "claude"), 0o755);
    writeConf([`AGENT_PATH=${bin}:/usr/bin:/bin`]);
  });
  afterEach(() => { if (home.includes(".agent-exec-test-")) rmSync(home, { recursive: true, force: true }); });
  const env = () => ({ CLAUDE_CONFIG_DIR: `${home}/.claude`, LANG: "C.UTF-8" });

  it("runs claude with the fixed no-tool flags, the model and the system prompt as ONE argument; the prompt on stdin; a new folder in /tmp that goes", async () => {
    const system = "-You are the guide.\nLine two: 'quotes' $(not run) ; && |";
    const r = await run(["claude-print", "sonnet", system], { env: { ...SECRETS, ...env(), CHOIBOT_AGENT_PASS: "p" }, input: "the prompt\n" });
    expect(r.code, r.stderr).toBe(0);
    const args = [...r.stdout.matchAll(/^<([\s\S]*?)>$/gm)].map((m) => m[1]);
    expect(args).toEqual(["-p", "--output-format", "json", "--tools", "", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--model", "sonnet", "--system-prompt", system]);
    const cwd = readFileSync(join(home, "cwd"), "utf8").trim();
    expect(cwd).toMatch(/^\/tmp\/choibot-print\.[A-Za-z0-9]{6}$/);
    expect(existsSync(cwd)).toBe(false);
    const envLines = r.stdout.split("\n").filter((l) => l.startsWith("env:")).map((l) => l.slice(4).split("=")[0]).sort();
    expect(envLines).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "LANG", "NO_COLOR", "PATH", "TERM"]);
    expect(r.stdout.trim().endsWith("the prompt")).toBe(true);
  });

  it("with no system prompt (the Brain review): the flags and the model only", async () => {
    const r = await run(["claude-print", "haiku"], { env: env(), input: "" });
    expect(r.code, r.stderr).toBe(0);
    expect([...r.stdout.matchAll(/^<([\s\S]*?)>$/gm)].map((m) => m[1]).slice(-2)).toEqual(["--model", "haiku"]);
  });

  it("refuses a model name of another shape, a wrong count of arguments, and a config dir outside the agent's home", async () => {
    const cases: [string[], Record<string, string>, RegExp][] = [
      [["claude-print"], env(), /usage: claude-print/],
      [["claude-print", "sonnet", "s", "x"], env(), /usage: claude-print/],
      [["claude-print", "Sonnet"], env(), /model name refused/],
      [["claude-print", "--dangerously-skip-permissions"], env(), /model name refused/],
      [["claude-print", "son net"], env(), /model name refused/],
      [["claude-print", ""], env(), /model name refused/],
      [["claude-print", "sonnet"], { CLAUDE_CONFIG_DIR: join(root, ".claude") }, /outside the agent's home/],
      [["claude-print", "sonnet"], {}, /CLAUDE_CONFIG_DIR is not set/],
    ];
    for (const [args, e, why] of cases) {
      const r = await run(args, { env: e });
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.stderr).toMatch(why);
      expect(r.stdout).toBe("");
    }
  });

  it("a TERM to the helper (sudo relays the console's stop) reaches the command, and the folder goes", async () => {
    writeFileSync(join(bin, "claude"), `#!/bin/bash\npwd -P > "${home}/cwd"\ntrap 'echo term >> "${home}/term.log"; exit 143' TERM\nwhile :; do sleep 0.1; done\n`);
    const child = spawn(HELPER, ["claude-print", "sonnet"], { env: { ...baseEnv(), ...env() } as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "ignore", "ignore"] });
    for (let i = 0; i < 100 && !existsSync(join(home, "cwd")); i++) await new Promise((r) => setTimeout(r, 25));
    const done = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
    child.kill("SIGTERM");
    await done;
    expect(readFileSync(join(home, "term.log"), "utf8")).toBe("term\n");
    expect(existsSync(readFileSync(join(home, "cwd"), "utf8").trim())).toBe(false);
  });

  it("a hard time limit (a copy of the helper with 1 s): a call that hangs ends with 124, and the folder goes", async () => {
    writeFileSync(join(bin, "claude"), `#!/bin/bash\npwd -P > "${home}/cwd"\nwhile :; do sleep 0.1; done\n`);
    const copy = join(root, "agent-exec-1s");
    writeFileSync(copy, readFileSync(HELPER, "utf8").replace(/^readonly CLAUDE_PRINT_LIMIT=\d+$/m, "readonly CLAUDE_PRINT_LIMIT=1"));
    chmodSync(copy, 0o755);
    const t0 = Date.now();
    const code = await new Promise<number | null>((res) => {
      const c = spawn(copy, ["claude-print", "sonnet"], { env: { ...baseEnv(), ...env() } as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "ignore", "ignore"] });
      c.on("close", (x) => res(x));
    });
    expect(code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(existsSync(readFileSync(join(home, "cwd"), "utf8").trim())).toBe(false);
  });

  it("the limit is a little longer than the console's longest call (the Brain review)", async () => {
    const { DISTILL_TIMEOUT_MS } = await import("./brain/distill.js");
    const limit = Number(/^readonly CLAUDE_PRINT_LIMIT=(\d+)$/m.exec(readFileSync(HELPER, "utf8"))?.[1]) * 1000;
    expect(limit).toBeGreaterThan(DISTILL_TIMEOUT_MS);
    expect(limit).toBeLessThanOrEqual(DISTILL_TIMEOUT_MS + 2 * 60_000);
  });
});

// claude-task: a Recurring task on the agents' login (bin/cron-runner.mjs in strong protection).
describe("choibot-agent-exec: claude-task", () => {
  let home = "";
  let bin = "";
  beforeEach(() => {
    home = mkdtempSync(join(ME.homedir, ".agent-exec-test-"));
    bin = join(root, "agentbin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/bash\nfor a in "$@"; do printf '<%s>\\n' "$a"; done\necho "cwd=$(pwd -P)"\ncat /proc/$$/environ | tr '\\0' '\\n' | sort | sed 's/^/env:/'\n`);
    chmodSync(join(bin, "claude"), 0o755);
    writeConf([`AGENT_PATH=${bin}:/usr/bin:/bin`]);
  });
  afterEach(() => { if (home.includes(".agent-exec-test-")) rmSync(home, { recursive: true, force: true }); });
  const taskEnv = () => ({ CLAUDE_CONFIG_DIR: `${home}/.claude`, CHOIBOT_AGENT_ID: "cron:j1", PORT: "3999", CRON_DATA_DIR: "/x/cron", TZ: "UTC" });
  const argsOf = (out: string) => [...out.matchAll(/^<([\s\S]*?)>$/gm)].map((m) => m[1]);

  it("runs claude in the task's cwd with -p, the prompt and the runner's flags, the env of spawn and the checked config dir", async () => {
    const repo = join(ws, "repo");
    mkdirSync(repo);
    const flags = ["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "high", "--append-system-prompt", "Never merge.\nRules", "--setting-sources", "user", "--strict-mcp-config"];
    const r = await run(["claude-task", repo, "30", "--", "-p", "do the task\nwith lines", ...flags], { env: { ...SECRETS, ...taskEnv() } });
    expect(r.code, r.stderr).toBe(0);
    expect(argsOf(r.stdout)).toEqual(["-p", "do the task\nwith lines", ...flags]);
    expect(r.stdout).toContain(`cwd=${repo}`);
    const env = Object.fromEntries(r.stdout.split("\n").filter((l) => l.startsWith("env:")).map((l) => { const kv = l.slice(4); const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    // TERM=dumb: bash sets it when the caller gives none, and it is in the env_keep list (as for spawn).
    expect(env).toEqual({ HOME: ME.homedir, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: `${home}/.claude`, CHOIBOT_AGENT_ID: "cron:j1", PORT: "3999", CRON_DATA_DIR: "/x/cron", TZ: "UTC", TERM: "dumb" });
  });

  it("refuses: a cwd outside the roots, minutes out of range, no -p first, any flag the runner does not use", async () => {
    const repo = join(ws, "repo2");
    mkdirSync(repo);
    const cases: [string[], RegExp][] = [
      [["claude-task", "/etc", "30", "--", "-p", "x"], /cwd outside/],
      [["claude-task", repo, "0", "--", "-p", "x"], /minutes refused/],
      [["claude-task", repo, "1441", "--", "-p", "x"], /minutes refused/],
      [["claude-task", repo, "1e3", "--", "-p", "x"], /minutes refused/],
      [["claude-task", repo, "30", "-p", "x", "y"], /usage: claude-task/],
      [["claude-task", repo, "30", "--", "--model", "sonnet"], /first argument must be -p/],
      [["claude-task", repo, "30", "--", "-p", "x", "--mcp-config", "/tmp/m.json"], /argument refused: --mcp-config/],
      [["claude-task", repo, "30", "--", "-p", "x", "--settings", "{}"], /argument refused: --settings/],
      [["claude-task", repo, "30", "--", "-p", "x", "--add-dir", "/"], /argument refused: --add-dir/],
      [["claude-task", repo, "30", "--", "-p", "x", "--model", "Son net"], /model name refused/],
      [["claude-task", repo, "30", "--", "-p", "x", "--effort", "--x"], /effort refused/],
      [["claude-task", repo, "30", "--", "-p", "x", "--setting-sources", "project"], /setting sources other than user/],
      [["claude-task", repo, "30", "--", "-p", "x", "--append-system-prompt"], /needs a text/],
    ];
    for (const [args, why] of cases) {
      const r = await run(args, { env: taskEnv() });
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.stderr).toMatch(why);
      expect(r.stdout).toBe("");
    }
    const outside = await run(["claude-task", repo, "30", "--", "-p", "x"], { env: { ...taskEnv(), CLAUDE_CONFIG_DIR: join(root, ".claude") } });
    expect([outside.code, outside.stderr]).toEqual([2, expect.stringMatching(/outside the agent's home/)]);
  });

  it("a hard limit: the task's minutes + a margin; a copy with 1 s ends a hanging task with 124", async () => {
    const text = readFileSync(HELPER, "utf8");
    expect(text).toContain('/usr/bin/timeout -s TERM -k 30 "$(( minutes * 60 + CLAUDE_TASK_MARGIN ))" claude "${args[@]}"');
    expect(Number(/^readonly CLAUDE_TASK_MARGIN=(\d+)$/m.exec(text)?.[1])).toBe(60);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nwhile :; do sleep 0.1; done\n");
    const copy = join(root, "agent-exec-1s");
    writeFileSync(copy, text.replace('"$(( minutes * 60 + CLAUDE_TASK_MARGIN ))"', "1"));
    chmodSync(copy, 0o755);
    const repo = join(ws, "repo3");
    mkdirSync(repo);
    const t0 = Date.now();
    const code = await new Promise<number | null>((res) => {
      const c = spawn(copy, ["claude-task", repo, "1", "--", "-p", "x"], { env: { ...baseEnv(), ...taskEnv() } as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "ignore", "ignore"] });
      c.on("close", (x) => res(x));
    });
    expect(code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

// git-identity: the commit name of the agent user. A fake git first on AGENT_PATH: the real
// ~/.gitconfig of this user is never touched.
describe("choibot-agent-exec: git-identity", () => {
  let bin = "";
  beforeEach(() => {
    bin = join(root, "agentbin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do printf '<%s>' "$a"; done >> "${root}/git.log"\necho " HOME=$HOME PWD=$(pwd -P)" >> "${root}/git.log"\n`);
    chmodSync(join(bin, "git"), 0o755);
    writeConf([`AGENT_PATH=${bin}:/usr/bin:/bin`]);
  });
  const log = () => (existsSync(join(root, "git.log")) ? readFileSync(join(root, "git.log"), "utf8") : "");

  it("sets user.name and user.email with git config --global, as the agent, in its home, with its own HOME", async () => {
    const r = await run(["git-identity", "Ada Lovelace (Ä)", "1+ada@users.noreply.github.com"], { env: { ...SECRETS, HOME: "/caller/home" } });
    expect(r.code, r.stderr).toBe(0);
    const home = realpathSync(ME.homedir);
    expect(log()).toBe(`<config><--global><user.name><Ada Lovelace (Ä)> HOME=${ME.homedir} PWD=${home}\n<config><--global><user.email><1+ada@users.noreply.github.com> HOME=${ME.homedir} PWD=${home}\n`);
  });

  it("refuses a name or an e-mail of another shape, and runs no git", async () => {
    for (const [args, why] of [
      [["git-identity", "Ada"], /usage: git-identity/],
      [["git-identity", "", "a@b.c"], /name refused/],
      [["git-identity", "-c core.sshCommand=x", "a@b.c"], /name refused/],
      [["git-identity", "Ada <evil@x>", "a@b.c"], /name refused/],
      [["git-identity", "Ada\nB", "a@b.c"], /control character/],
      [["git-identity", "x".repeat(401), "a@b.c"], /name refused/],
      [["git-identity", "Ada", "no-at-sign"], /e-mail refused/],
      [["git-identity", "Ada", "a@b c"], /e-mail refused/],
      [["git-identity", "Ada", "-x@b.c"], /e-mail refused/],
    ] as [string[], RegExp][]) {
      const r = await run(args);
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.stderr).toMatch(why);
    }
    expect(log()).toBe("");
  });
});

// Design B: an agent's own clone (repo-clone, repo-remove) and a read as the agent (read-file).
// Real git and Node, as this user; the Claude config dir in a throwaway folder of the home.
describe("choibot-agent-exec: repo-clone, repo-remove, read-file", () => {
  let home = "";
  let repo = "";
  let clones = "";
  let sha = "";
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();
  beforeEach(() => {
    home = mkdtempSync(join(ME.homedir, ".agent-exec-test-"));
    repo = join(ws, "repo");
    mkdirSync(repo);
    g(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "hello\n");
    g(repo, "add", "README.md");
    g(repo, "commit", "-qm", "first");
    sha = g(repo, "rev-parse", "HEAD");
    clones = join(homes, "clones");
    mkdirSync(clones);
    writeConf([`AGENT_PATH=${join(process.execPath, "..")}:/usr/bin:/bin`]);
  });
  afterEach(() => { if (home.includes(".agent-exec-test-")) rmSync(home, { recursive: true, force: true }); });
  const env = () => ({ CLAUDE_CONFIG_DIR: `${home}/.claude` });

  it("repo-clone: the agent's own clone, through the transport, with the console's objects as alternates, on its branch, with the excludes and the trust of the clones' folder", async () => {
    mkdirSync(join(home, ".claude"));
    const r = await run(["repo-clone", repo, "a1", "agent/a1", sha], { env: env() });
    expect(r.code, r.stderr).toBe(0);
    const dest = join(clones, "a1");
    expect(r.stdout).toBe(`${dest}\n`);
    expect(g(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/a1");
    expect(g(dest, "rev-parse", "HEAD")).toBe(sha);
    expect(g(dest, "remote")).toBe("console");
    expect(readFileSync(join(dest, ".git", "objects", "info", "alternates"), "utf8").trim()).toBe(join(realpathSync(repo), ".git", "objects"));
    expect(readFileSync(join(dest, ".git", "info", "exclude"), "utf8")).toContain(".choibot/\n.choibot-hooks.json\n");
    const trust = JSON.parse(readFileSync(join(home, ".claude", ".claude.json"), "utf8"));
    expect(trust.projects[realpathSync(clones)].hasTrustDialogAccepted).toBe(true);
    // The console's repo is not changed: no new branch, no new ref.
    expect(g(repo, "branch", "--format=%(refname:short)")).toBe("main");
    // The remote console (part 3): its upload-pack names the console's repo as safe on its own
    // command line, and it maps the console's copy of the GitHub branches to console/*.
    expect(g(dest, "config", "--get", "remote.console.uploadpack")).toBe(`git -c safe.directory=${realpathSync(repo)}/.git upload-pack`);
    expect(g(dest, "config", "--get-all", "remote.console.fetch")).toBe("+refs/remotes/origin/*:refs/remotes/console/*");
    // The console fetched its base from GitHub (here: a ref set by hand): the agent gets it.
    writeFileSync(join(repo, "next.txt"), "n\n");
    g(repo, "add", "next.txt");
    g(repo, "commit", "-qm", "next");
    g(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    g(dest, "fetch", "-q", "console");
    expect(g(dest, "rev-parse", "console/main")).toBe(g(repo, "rev-parse", "HEAD"));
  });

  it("repo-clone refuses a repo whose path has a character that the upload-pack command line cannot hold", async () => {
    mkdirSync(join(home, ".claude"));
    const odd = join(ws, "my repo");
    mkdirSync(odd);
    g(odd, "init", "-q");
    writeFileSync(join(odd, "f"), "x");
    g(odd, "add", "f");
    g(odd, "commit", "-qm", "one");
    const r = await run(["repo-clone", odd, "a1", "agent/a1", g(odd, "rev-parse", "HEAD")], { env: env() });
    expect([r.code, r.stderr]).toEqual([2, expect.stringMatching(/only letters, digits and \. _ - \/ in its path/)]);
    expect(existsSync(join(clones, "a1"))).toBe(false);
  });

  it("upload-pack: git-upload-pack in the agent's clone, as the console's --upload-pack (git appends the path); any other path refused", async () => {
    mkdirSync(join(home, ".claude"));
    expect((await run(["repo-clone", repo, "a1", "agent/a1", sha], { env: env() })).code).toBe(0);
    const dest = join(clones, "a1");
    const lsRemote = (verbArgs: string, path: string) => new Promise<{ code: number | null; out: string; err: string }>((res) => {
      const c = spawn("git", ["ls-remote", `--upload-pack=${HELPER} upload-pack ${verbArgs}`, path], { env: { ...baseEnv(), PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
      let out = ""; let err = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("close", (code) => res({ code, out, err }));
    });
    const ok = await lsRemote("a1", dest);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain(`${sha}\trefs/heads/agent/a1`);
    // The path that git appends must be the clone of that id itself.
    expect((await lsRemote("a1", repo)).err).toMatch(/the repo is not the clone of a1/);
    mkdirSync(join(clones, "a2"));
    expect((await lsRemote("a2", dest)).err).toMatch(/no clone of a2|the repo is not the clone of a2/);
    expect((await lsRemote("../a1", dest)).err).toMatch(/agent id refused/);
    symlinkSync(dest, join(clones, "a3"));
    expect((await lsRemote("a3", join(clones, "a3"))).err).toMatch(/no clone of a3/);
    expect((await run(["upload-pack", "a1"])).stderr).toMatch(/usage: upload-pack/);
  });

  it("repo-clone refuses: an id, a branch or a sha of another shape, a repo outside the workspace, a clone that exists, a clones' folder that is a link", async () => {
    const cases: [string[], RegExp][] = [
      [["repo-clone", repo, "../a1", "b", sha], /agent id refused/],
      [["repo-clone", repo, "-a", "b", sha], /agent id refused/],
      [["repo-clone", repo, "a1", "-b", sha], /branch name refused/],
      [["repo-clone", repo, "a1", "a..b", sha], /branch name refused/],
      [["repo-clone", repo, "a1", "a b", sha], /branch name refused/],
      [["repo-clone", repo, "a1", "b.lock", sha], /branch name refused/],
      [["repo-clone", repo, "a1", "b", "HEAD"], /start commit refused/],
      [["repo-clone", root, "a1", "b", sha], /repo refused/],
      [["repo-clone", "repo", "a1", "b", sha], /absolute path/],
    ];
    for (const [args, why] of cases) {
      const r = await run(args, { env: env() });
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.stderr).toMatch(why);
    }
    mkdirSync(join(clones, "a2"));
    expect((await run(["repo-clone", repo, "a2", "b", sha], { env: env() })).stderr).toMatch(/a clone of a2 exists/);
    // The clones' folder made by an agent as a link (before strong-setup made it): refused.
    rmSync(clones, { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), clones);
    const r = await run(["repo-clone", repo, "a3", "b", sha], { env: env() });
    expect([r.code, r.stderr]).toEqual([2, expect.stringMatching(/no clones folder/)]);
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
  });

  it("repo-remove: the clone of that id only; a link there is removed, never followed", async () => {
    mkdirSync(join(clones, "a1"));
    writeFileSync(join(clones, "a1", "f"), "x");
    expect((await run(["repo-remove", "a1"])).code).toBe(0);
    expect(existsSync(join(clones, "a1"))).toBe(false);
    const target = join(root, "keep");
    mkdirSync(target);
    writeFileSync(join(target, "f"), "x");
    symlinkSync(target, join(clones, "a2"));
    expect((await run(["repo-remove", "a2"])).code).toBe(0);
    expect(existsSync(join(target, "f"))).toBe(true);
    for (const bad of ["../x", "a/b", ""]) expect((await run(["repo-remove", bad])).stderr).toMatch(/agent id refused|usage/);
  });

  it("repo-read: state, changed and diff of the agent's clone against the console's base commit, framed; the clone's own index is not changed", async () => {
    mkdirSync(join(home, ".claude"));
    expect((await run(["repo-clone", repo, "a1", "agent/a1", sha], { env: env() })).code).toBe(0);
    const dest = join(clones, "a1");
    writeFileSync(join(dest, "README.md"), "hello\nagent\n");
    writeFileSync(join(dest, "new.txt"), "n\n");
    const read = async (what: string) => {
      const r = await run(["repo-read", "a1", what, sha]);
      expect(r.code, r.stderr).toBe(0);
      return parseRead(Buffer.from(r.stdout));
    };
    const st = await read("state");
    expect([...st.keys()]).toEqual(["head", "sha", "aheadbehind", "staged", "unstaged", "untracked", "stashes"]);
    expect(st.get("head")).toEqual({ code: 0, out: "agent/a1\n" });
    expect(st.get("unstaged")).toEqual({ code: 0, out: "README.md\n" });
    expect(st.get("untracked")).toEqual({ code: 0, out: "new.txt\n" });
    expect(st.get("aheadbehind")).toEqual({ code: 0, out: "0\t0\n" });
    const ch = await read("changed");
    expect(ch.get("namestatus")).toEqual({ code: 0, out: "M\tREADME.md\n" });
    expect(ch.get("numstat")).toEqual({ code: 0, out: "1\t0\tREADME.md\0" });
    const df = (await read("diff")).get("diff")!;
    expect(df.code).toBe(0);
    expect(df.out).toContain("+agent");
    expect(df.out).toContain("b/new.txt");
    // The intent-to-add was on a copy: the clone's index still does not know new.txt.
    expect(g(dest, "ls-files")).toBe("README.md");
  });

  it("repo-read: a step that fails gives its frame and the read goes on (a detached HEAD, a base commit the clone does not know); an output above its cap gives 98 and no bytes", async () => {
    mkdirSync(join(home, ".claude"));
    expect((await run(["repo-clone", repo, "a1", "agent/a1", sha], { env: env() })).code).toBe(0);
    const dest = join(clones, "a1");
    writeFileSync(join(dest, "README.md"), "hello\nagent\n");
    const steps = ["head", "sha", "aheadbehind", "staged", "unstaged", "untracked", "stashes"];
    // A detached HEAD: symbolic-ref exits 1, as in a worktree; the git bar says "detached".
    g(dest, "checkout", "-q", "--detach");
    let r = await run(["repo-read", "a1", "state", sha]);
    expect(r.code, r.stderr).toBe(0);
    let m = parseRead(Buffer.from(r.stdout));
    expect([...m.keys()]).toEqual(steps);
    expect(m.get("head")).toEqual({ code: 1, out: "" });
    expect(m.get("unstaged")).toEqual({ code: 0, out: "README.md\n" });
    // A base commit that the clone does not know: that step fails, the steps after it still run.
    const unknown = "1".repeat(40);
    r = await run(["repo-read", "a1", "state", unknown]);
    expect(r.code, r.stderr).toBe(0);
    m = parseRead(Buffer.from(r.stdout));
    expect([...m.keys()]).toEqual(steps);
    expect(m.get("aheadbehind")?.code).toBe(128);
    expect(m.get("stashes")).toEqual({ code: 0, out: "" });
    // No fork point for "changed" or "diff": one reason line, exit 2 (not a silent end of the script).
    for (const what of ["changed", "diff"]) {
      r = await run(["repo-read", "a1", what, unknown]);
      expect([r.code, r.stderr]).toEqual([2, expect.stringMatching(/no fork point/)]);
    }
    // A copy of the helper with small caps: a list step of 4 bytes is at its cap, one of 10 is above it.
    const copy = join(root, "agent-exec-small-caps");
    const text = readFileSync(HELPER, "utf8");
    const small = text.replace(/^readonly REPO_READ_LIST_MAX=\d+$/m, "readonly REPO_READ_LIST_MAX=4").replace(/^readonly REPO_READ_DIFF_MAX=\d+$/m, "readonly REPO_READ_DIFF_MAX=10");
    expect(small.match(/^readonly REPO_READ_(LIST|DIFF)_MAX=(4|10)$/gm)).toHaveLength(2);
    writeFileSync(copy, small);
    chmodSync(copy, 0o755);
    r = await run(["repo-read", "a1", "state", sha], { helper: copy });
    expect(r.code, r.stderr).toBe(0);
    m = parseRead(Buffer.from(r.stdout));
    expect([...m.keys()]).toEqual(steps);
    expect(m.get("aheadbehind")).toEqual({ code: 0, out: "0\t0\n" });
    expect(m.get("unstaged")).toEqual({ code: 98, out: "" });
    r = await run(["repo-read", "a1", "diff", sha], { helper: copy });
    expect(r.code, r.stderr).toBe(0);
    expect(parseRead(Buffer.from(r.stdout)).get("diff")).toEqual({ code: 98, out: "" });
  });

  it("repo-read: the diff steps take no external diff, no textconv and no colour from the agent's git config", async () => {
    mkdirSync(join(home, ".claude"));
    expect((await run(["repo-clone", repo, "a1", "agent/a1", sha], { env: env() })).code).toBe(0);
    const dest = join(clones, "a1");
    writeFileSync(join(dest, "README.md"), "hello\nagent\n");
    const ext = join(root, "ext.sh");
    writeFileSync(ext, "#!/bin/sh\necho EXTERNAL\n");
    chmodSync(ext, 0o755);
    g(dest, "config", "diff.external", ext);
    g(dest, "config", "diff.conv.textconv", ext);
    g(dest, "config", "color.ui", "always");
    writeFileSync(join(dest, ".git", "info", "attributes"), "*.md diff=conv\n");
    const read = async (what: string) => parseRead(Buffer.from((await run(["repo-read", "a1", what, sha])).stdout));
    const df = (await read("diff")).get("diff")!;
    expect(df.code).toBe(0);
    expect(df.out).toContain("+agent");
    expect(df.out).not.toContain("EXTERNAL");
    expect(df.out).not.toContain("\x1b[");
    const ch = await read("changed");
    expect(ch.get("numstat")).toEqual({ code: 0, out: "1\t0\tREADME.md\0" });
    expect(ch.get("namestatus")).toEqual({ code: 0, out: "M\tREADME.md\n" });
    expect((await read("state")).get("unstaged")).toEqual({ code: 0, out: "README.md\n" });
  });

  it("repo-read refuses: an id, a read or a sha of another shape, no clone, a clone that is a link", async () => {
    const cases: [string[], RegExp][] = [
      [["repo-read", "../a1", "state", sha], /agent id refused/],
      [["repo-read", "a1", "log", sha], /unknown read/],
      [["repo-read", "a1", "state", "HEAD"], /base commit refused/],
      [["repo-read", "a1", "state", sha], /no clone of a1/],
    ];
    for (const [args, why] of cases) {
      const r = await run(args);
      expect([args, r.code, r.stderr]).toEqual([args, 2, expect.stringMatching(why)]);
    }
    symlinkSync(repo, join(clones, "a2"));
    expect((await run(["repo-read", "a2", "state", sha])).stderr).toMatch(/no clone of a2/);
  });

  it("read-file: the bytes of a regular file inside a root, at most the asked size; else one reason line", async () => {
    const f = join(clones, "a1", "page.html");
    mkdirSync(join(clones, "a1"));
    writeFileSync(f, "<p>hi</p>");
    const r = await run(["read-file", f, "100"]);
    expect([r.code, r.stdout]).toEqual([0, "<p>hi</p>"]);
    expect((await run(["read-file", f, "5"])).stderr).toMatch(/larger than 5 bytes/);
    expect((await run(["read-file", f, "0"])).stderr).toMatch(/max refused/);
    expect((await run(["read-file", f, "999999999"])).stderr).toMatch(/max refused/);
    expect((await run(["read-file", join(clones, "a1"), "100"])).stderr).toMatch(/not a regular file/);
    expect((await run(["read-file", "page.html", "100"])).stderr).toMatch(/must be absolute/);
    // A link in the middle of the path to a folder outside the roots: refused by its real path.
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "s");
    symlinkSync(outside, join(clones, "a1", "mid"));
    const r2 = await run(["read-file", join(clones, "a1", "mid", "secret"), "100"]);
    expect([r2.code, r2.stdout]).toEqual([2, ""]);
    expect(r2.stderr).toMatch(/outside WORKTREE_ROOT, WORKSPACE_DIR and AGENT_HOME_ROOT/);
  });
});

describe("not hardened (flag off)", () => {
  it("TerminalManager's dtach argv stays the direct one: no sudo, no helper", () => {
    const { command, args } = persistCommand({ dtach: DTACH_BIN, systemdRun: null }, "/tmp/hct-x/choibot-a.sock", "claude", ["--x"]);
    expect(command).toBe(DTACH_BIN);
    expect(args).toEqual(["-A", "/tmp/hct-x/choibot-a.sock", "-E", "-z", "-r", "winch", "claude", "--x"]);
    expect([command, ...args].join(" ")).not.toMatch(/sudo|choibot-agent-exec/);
  });
});

// The second account of strong protection (server/chief/chiefaccount.ts): with CHIEF_UID and
// CHIEF_DTACH_DIR in the conf, the helper that runs as CHIEF_UID (here: the test's own uid) takes
// sockets only in CHIEF_DTACH_DIR, a cwd only in AGENT_HOME_ROOT/chief, and ten verbs; the
// helper of another uid never starts in AGENT_HOME_ROOT/chief.
describe("choibot-agent-exec: the persistent agents' account", () => {
  let chiefDtach = "";
  const chiefConf = (uid = ME.uid): void => writeConf([`CHIEF_UID=${uid}`, `CHIEF_DTACH_DIR=${chiefDtach}`]);
  beforeEach(() => {
    chiefDtach = mkdtempSync("/tmp/hct-");
    extraDirs.push(chiefDtach);
    mkdirSync(join(homes, "chief", "fleet-master"), { recursive: true });
  });

  it("the conf takes both keys or none, a uid that is not 0, and a folder that is not DTACH_DIR", async () => {
    for (const extra of [[`CHIEF_UID=${ME.uid}`], [`CHIEF_DTACH_DIR=/tmp/x`], ["CHIEF_UID=0", `CHIEF_DTACH_DIR=${chiefDtach}`], [`CHIEF_UID=${ME.uid}`, `CHIEF_DTACH_DIR=${dtachDir}`], [`CHIEF_UID=${ME.uid}`, "CHIEF_DTACH_DIR=rel/dir"]]) {
      writeConf(extra);
      const r = await run(["probe"]);
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.stderr, extra.join(" ")).toMatch(/CHIEF_UID|CHIEF_DTACH_DIR/);
    }
  });

  it("probe as that account checks its own dtach folder and its homes", async () => {
    chiefConf();
    expect(await run(["probe"])).toMatchObject({ code: 0, stdout: "ok\n" });
    rmSync(join(homes, "chief"), { recursive: true });
    const r = await run(["probe"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/the persistent agents' homes are not a directory/);
  });

  it("as that account: a socket only in CHIEF_DTACH_DIR, a cwd only in its homes", async () => {
    chiefConf();
    const cwd = join(homes, "chief", "fleet-master");
    // The workers' dtach folder is not its own.
    const inWorkers = await run(["spawn", join(dtachDir, "choibot-fleet-master.sock"), cwd, "--", "/bin/cat"]);
    expect(inWorkers.code).toBe(2);
    expect(inWorkers.stderr).toMatch(/socket outside DTACH_DIR/);
    // A cwd outside its homes (a worker's worktree, the workspace) is refused.
    for (const other of [wt, ws, homes]) {
      const r = await run(["spawn", join(chiefDtach, "choibot-fleet-master.sock"), other, "--", "/bin/cat"]);
      expect(r.code, other).toBe(2);
      expect(r.stderr, other).toMatch(/cwd outside the persistent agents' homes/);
    }
    // Its own folder and home: the session starts.
    const s = join(chiefDtach, "choibot-fleet-master.sock");
    sockets.push(s);
    const out = join(root, "chief-cwd.out");
    const a = ptyRun(["spawn", s, cwd, "--", "/bin/sh", "-c", 'pwd -P > "$0"; exec /bin/cat', out]);
    await waitFor(() => existsSync(out), 6000);
    expect(readFileSync(out, "utf8").trim()).toBe(cwd);
    expect(existsSync(s)).toBe(true);
    a.p.kill();
  }, 20_000);

  it("as that account: alive, on its own dtach folder only", async () => {
    chiefConf();
    expect(await run(["alive", join(chiefDtach, "choibot-fleet-master.sock")])).toMatchObject({ code: 0, stdout: "unknown\n" });
    const r = await run(["alive", join(dtachDir, "choibot-fleet-master.sock")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/socket outside DTACH_DIR/);
  });

  it("as that account: only probe, spawn, attach, kill, kill-clients, pids, alive, claude-auth, read-thread, session-ensure and git-safe", async () => {
    chiefConf();
    const f = join(homes, "chief", "fleet-master", "x.txt");
    writeFileSync(f, "x");
    for (const args of [["run", ws, "--", "/bin/true"], ["read-file", f, "10"], ["claude-print", "haiku"], ["git-identity", "a", "b@c.d"], ["repo-remove", "w1"]]) {
      const r = await run(args);
      expect(r.code, args[0]).toBe(2);
      expect(r.stderr, args[0]).toMatch(new RegExp(`verb refused for the persistent agents' account: ${args[0]}`));
    }
  });

  it("as that account: env-check is taken", async () => {
    chiefConf();
    expect(await run(["env-check"], { env: { CHOIBOT_AGENT_ID: "env-check" } })).toMatchObject({ code: 0, stdout: "CHOIBOT_AGENT_ID\n" });
  });

  it("as that account: claude-auth (its own sign-in), read-thread and session-ensure (its own session files) and git-safe are taken", async () => {
    chiefConf();
    for (const args of [["claude-auth", "status"], ["read-thread", "/x/projects/a.jsonl", "0", "0"], ["session-ensure", "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e", "-x"], ["git-safe", "/x"]]) {
      const r = await run(args);
      expect(r.stderr, args[0]).not.toMatch(/verb refused/);
    }
  });

  it("as that account: read-tasks (its own task files) is taken", async () => {
    chiefConf();
    const cfg = realpathSync(mkdtempSync(join(ME.homedir, ".hct-claude-")));
    try {
      mkdirSync(join(cfg, "tasks", "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e"), { recursive: true });
      writeFileSync(join(cfg, "tasks", "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e", "1.json"), "{}");
      const r = await run(["read-tasks", "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e"], { env: { CLAUDE_CONFIG_DIR: cfg } });
      expect([r.code, r.stdout, r.stderr]).toEqual([0, "tasks 1\n1.json 2\n{}\n", ""]);
    } finally { rmSync(cfg, { recursive: true, force: true }); }
  });

  it("the helper of another uid never starts in the persistent agents' homes", async () => {
    chiefConf(ME.uid + 1);
    const r = await run(["spawn", join(dtachDir, "choibot-w1.sock"), join(homes, "chief", "fleet-master"), "--", "/bin/cat"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cwd in the persistent agents' homes refused for this account/);
    // Its own sockets stay in DTACH_DIR, as before.
    const inChief = await run(["spawn", join(chiefDtach, "choibot-w1.sock"), ws, "--", "/bin/cat"]);
    expect(inChief.code).toBe(2);
    expect(inChief.stderr).toMatch(/socket outside DTACH_DIR/);
    expect(await run(["probe"])).toMatchObject({ code: 0, stdout: "ok\n" });
  });
});

// read-thread (strong protection): the console cannot open an agent's session files (its home is
// 0700; Claude makes the files 0600), so the thread view, the stop reason and the subagent list
// read them through the helper, AS the agent: one line of facts, then one byte range. Only a
// regular file whose real path is in the projects folder of this account's own Claude folder;
// the last part is never a link.
describe("read-thread", () => {
  let cfg = "";
  let file = "";
  beforeEach(() => {
    // The Claude folder must be inside this account's home (the helper's rule for CLAUDE_CONFIG_DIR).
    cfg = realpathSync(mkdtempSync(join(ME.homedir, ".hct-claude-")));
    mkdirSync(join(cfg, "projects", "p"), { recursive: true, mode: 0o700 });
    file = join(cfg, "projects", "p", "s.jsonl");
    writeFileSync(file, "line one\nline two\n", { mode: 0o600 });
  });
  afterEach(() => { rmSync(cfg, { recursive: true, force: true }); });
  const rt = (args: string[], env: Record<string, string> = {}) => run(["read-thread", ...args], { env: { CLAUDE_CONFIG_DIR: cfg, ...env } });
  const factsOf = (p: string) => {
    const st = lstatSync(p, { bigint: true });
    return `${st.size} ${(Number(st.mtimeNs / 1000000n) / 1000).toFixed(3)} ${st.dev} ${st.ino}`;
  };

  it("the facts line (size, mtime with ms, device, inode), then the bytes from the offset; fewer at the end; none past it", async () => {
    const r = await rt([file, "9", "100"]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toBe(`${factsOf(file)}\nline two\n`);
    expect((await rt([file, "0", "4"])).stdout).toBe(`${factsOf(file)}\nline`);
    expect((await rt([file, "18", "100"])).stdout).toBe(`${factsOf(file)}\n`);
    expect((await rt([file, "500", "100"])).stdout).toBe(`${factsOf(file)}\n`);
    // max 0: the probe alone.
    expect((await rt([file, "0", "0"])).stdout).toBe(`${factsOf(file)}\n`);
  });

  it("a file that is not there: \"absent\", not an error", async () => {
    for (const p of [join(cfg, "projects", "p", "none.jsonl"), join(cfg, "projects", "nodir", "s.jsonl")]) {
      const r = await rt([p, "0", "10"]);
      expect([p, r.code, r.stdout]).toEqual([p, 0, "absent\n"]);
    }
  });

  it("refuses a folder, a fifo, a device, a link as the last part, a link out of its projects folder, and every path outside it", async () => {
    const proj = join(cfg, "projects");
    symlinkSync(file, join(proj, "p", "link.jsonl"));
    symlinkSync(cfg, join(proj, "out"));
    writeFileSync(join(cfg, ".credentials.json"), "not a real login", { mode: 0o600 });
    symlinkSync(join(proj, "p", "gone.jsonl"), join(proj, "p", "dangling.jsonl"));
    execFileSync("mkfifo", [join(proj, "p", "fifo.jsonl")]);
    const other = mkdtempSync("/tmp/hct-other-");
    extraDirs.push(other);
    mkdirSync(join(other, "projects", "p"), { recursive: true });
    writeFileSync(join(other, "projects", "p", "s.jsonl"), "x\n");
    const cases: [string, RegExp][] = [
      [join(proj, "p"), /not a regular file/],
      [join(proj, "p", "fifo.jsonl"), /not a regular file/],
      [join(proj, "p", "link.jsonl"), /read-thread: a link$/m],
      // A folder link out of projects/: to the account's own Claude folder (its login is there),
      // to a file there and to one that is not there (no answer says which).
      [join(proj, "out", ".credentials.json"), /its real path is outside the projects folder/],
      [join(proj, "out", "settings.json"), /its real path is outside the projects folder/],
      [join(proj, "p", "dangling.jsonl"), /read-thread: a link$/m],
      ["/dev/null", /outside the projects folder/],
      [join(cfg, "settings.json"), /outside the projects folder/],
      [join(other, "projects", "p", "s.jsonl"), /outside the projects folder/],
      [`${proj}/p/../p/s.jsonl`, /not normalized/],
      [`${proj}//p/s.jsonl`, /not normalized/],
      ["projects/p/s.jsonl", /must be absolute/],
    ];
    for (const [p, why] of cases) {
      const r = await rt([p, "0", "10"]);
      expect([p, r.code, r.stdout]).toEqual([p, 2, ""]);
      expect(r.stderr).toMatch(why);
    }
    // The device by a path in its projects folder: a character device is not a regular file.
    symlinkSync("/dev/zero", join(proj, "p", "zero.jsonl"));
    const zero = await rt([join(proj, "p", "zero.jsonl"), "0", "10"]);
    expect([zero.code, zero.stdout]).toEqual([2, ""]);
    expect(zero.stderr).toMatch(/its real path is outside the projects folder/);
  });

  it("a folder link inside its projects folder is followed (the side folder of a linked session): the real path is read", async () => {
    mkdirSync(join(cfg, "projects", "p", "s", "subagents"), { recursive: true });
    const sub = join(cfg, "projects", "p", "s", "subagents", "agent-a.jsonl");
    writeFileSync(sub, "sub line\n");
    mkdirSync(join(cfg, "projects", "q"));
    symlinkSync(join(cfg, "projects", "p", "s"), join(cfg, "projects", "q", "s"));
    const r = await rt([join(cfg, "projects", "q", "s", "subagents", "agent-a.jsonl"), "0", "100"]);
    expect([r.code, r.stdout]).toEqual([0, `${factsOf(sub)}\nsub line\n`]);
  });

  it("numbers only, and at most 4 MiB per call", async () => {
    for (const [off, max] of [["-1", "10"], ["1e3", "10"], [" 1", "10"], ["01", "10"], ["0", "4194305"], ["0", "x"], ["0", "-1"], ["0", "1.5"]]) {
      const r = await rt([file, off, max]);
      expect([off, max, r.code]).toEqual([off, max, 2]);
      expect(r.stderr).toMatch(/offset refused|max refused/);
    }
    expect((await rt([file, "0", "4194304"])).code).toBe(0);
    expect((await rt([file, "0"])).stderr).toMatch(/usage: read-thread/);
  });

  it("the Claude folder must be inside this account's home: another account's folder is refused", async () => {
    const r = await rt([file, "0", "10"], { CLAUDE_CONFIG_DIR: "/tmp" });
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/CLAUDE_CONFIG_DIR is outside the agent's home/);
  });
});

// session-ensure (strong protection): the session file of a resume in the cwd's project folder, as
// the agent. "present"; "linked <from>" (a hard link of the file from another project folder of its
// own, and a link of its side folder); "absent". Nothing outside its projects folder changes.
describe("session-ensure", () => {
  const SID = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";
  let cfg = "";
  let proj = "";
  beforeEach(() => {
    cfg = realpathSync(mkdtempSync(join(ME.homedir, ".hct-claude-")));
    proj = join(cfg, "projects");
    mkdirSync(join(proj, "-old"), { recursive: true, mode: 0o700 });
    writeFileSync(join(cfg, "settings.json"), "{}");
  });
  afterEach(() => { rmSync(cfg, { recursive: true, force: true }); });
  const se = (args: string[], env: Record<string, string> = {}) => run(["session-ensure", ...args], { env: { CLAUDE_CONFIG_DIR: cfg, ...env } });
  const tree = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).map((e) => `${join(e.parentPath, e.name).slice(d.length)}${e.isSymbolicLink() ? " -> " + readlinkSync(join(e.parentPath, e.name)) : ""}`).sort();

  it("present: the file is there; nothing changes", async () => {
    mkdirSync(join(proj, "-new"));
    writeFileSync(join(proj, "-new", `${SID}.jsonl`), "x\n");
    const before = tree(cfg);
    expect((await se([SID, "-new"])).stdout).toBe("present\n");
    expect(tree(cfg)).toEqual(before);
  });

  it("linked: a hard link of the file from the other project folder, its side folder linked, the new folder 0700; a second call says present", async () => {
    writeFileSync(join(proj, "-old", `${SID}.jsonl`), "line\n");
    mkdirSync(join(proj, "-old", SID, "subagents"), { recursive: true });
    writeFileSync(join(proj, "-old", SID, "subagents", "agent-a.jsonl"), "sub\n");
    const outside = tree(cfg).filter((p) => !p.startsWith("/projects"));
    const r = await se([SID, "-new"]);
    expect([r.code, r.stdout, r.stderr]).toEqual([0, "linked -old\n", ""]);
    const made = join(proj, "-new", `${SID}.jsonl`);
    expect(lstatSync(made).ino).toBe(lstatSync(join(proj, "-old", `${SID}.jsonl`)).ino);
    expect(lstatSync(join(proj, "-new")).mode & 0o7777).toBe(0o700);
    expect(readlinkSync(join(proj, "-new", SID))).toBe(join(proj, "-old", SID));
    expect((await se([SID, "-new"])).stdout).toBe("present\n");
    // Nothing outside its projects folder changed.
    expect(tree(cfg).filter((p) => !p.startsWith("/projects"))).toEqual(outside);
  });

  it("absent: no such session anywhere; nothing is made", async () => {
    const before = tree(cfg);
    expect((await se([SID, "-new"])).stdout).toBe("absent\n");
    expect(tree(cfg)).toEqual(before);
    rmSync(proj, { recursive: true });
    expect((await se([SID, "-new"])).stdout).toBe("absent\n");
  });

  it("never replaces an entry that is there, never goes through a link, skips a session in a linked or odd place", async () => {
    writeFileSync(join(proj, "-old", `${SID}.jsonl`), "line\n");
    // The target is a link, a dangling link or a folder: refused, left as it is.
    mkdirSync(join(proj, "-a"));
    symlinkSync(join(cfg, "settings.json"), join(proj, "-a", `${SID}.jsonl`));
    mkdirSync(join(proj, "-b"));
    symlinkSync(join(cfg, "gone"), join(proj, "-b", `${SID}.jsonl`));
    mkdirSync(join(proj, "-c", `${SID}.jsonl`), { recursive: true });
    for (const p of ["-a", "-b", "-c"]) {
      const r = await se([SID, p]);
      expect([p, r.code, r.stdout]).toEqual([p, 2, ""]);
      expect(r.stderr).toMatch(/the entry there is not a session file of this account/);
    }
    expect(readlinkSync(join(proj, "-a", `${SID}.jsonl`))).toBe(join(cfg, "settings.json"));
    // The project folder is a link (to the Claude folder itself): refused, nothing made through it.
    symlinkSync(cfg, join(proj, "-l"));
    const r = await se([SID, "-l"]);
    expect([r.code, r.stderr.trim()]).toEqual([2, expect.stringMatching(/the project folder is a link/)]);
    expect(existsSync(join(cfg, `${SID}.jsonl`))).toBe(false);
    // A session file only in a linked project folder, or one that is a fifo: not taken.
    rmSync(join(proj, "-old", `${SID}.jsonl`));
    const elsewhere = realpathSync(mkdtempSync("/tmp/hct-sess-"));
    extraDirs.push(elsewhere);
    writeFileSync(join(elsewhere, `${SID}.jsonl`), "x\n");
    symlinkSync(elsewhere, join(proj, "-linked"));
    execFileSync("mkfifo", [join(proj, "-old", `${SID}.jsonl`)]);
    expect((await se([SID, "-new"])).stdout).toBe("absent\n");
    expect(existsSync(join(proj, "-new"))).toBe(false);
  });

  it("a session id and a project of one plain shape only; the Claude folder in its home", async () => {
    for (const [args, why] of [
      [["../etc/passwd", "-new"], /session id refused/], [["0B9C5A4E-7F1D-4C2A-9E3B-1D2C3B4A5F6E", "-new"], /session id refused/], [[`${SID}x`, "-new"], /session id refused/],
      [[SID, ".."], /project refused/], [[SID, "."], /project refused/], [[SID, "a/b"], /project refused/], [[SID, "a b"], /project refused/], [[SID, ""], /project refused/],
      [[SID], /usage: session-ensure/],
    ] as const) {
      const r = await se([...args]);
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.stderr).toMatch(why);
    }
    const r = await se([SID, "-new"], { CLAUDE_CONFIG_DIR: "/tmp" });
    expect(r.stderr).toMatch(/CLAUDE_CONFIG_DIR is outside the agent's home/);
  });
});

// read-tasks (strong protection): the Plan rail. Claude Code keeps one JSON file per task in
// <its Claude folder>/tasks/<session id>/ (0600 in the agent's 0700 home), so the console reads
// them through the helper, AS the agent: "tasks <n>", then one frame per task file ("<name>
// <bytes>", the bytes, a newline); "absent" when the folder is not there. Over a cap, or a link
// anywhere: refused, nothing printed. Its temp folder (in /tmp) never stays.
describe("read-tasks", () => {
  const SID = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";
  let cfg = "";
  let dir = "";
  beforeEach(() => {
    cfg = realpathSync(mkdtempSync(join(ME.homedir, ".hct-claude-")));
    dir = join(cfg, "tasks", SID);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(cfg, ".credentials.json"), "not a real login", { mode: 0o600 });
  });
  afterEach(() => { rmSync(cfg, { recursive: true, force: true }); });
  const rk = (args: string[], env: Record<string, string> = {}) => run(["read-tasks", ...args], { env: { CLAUDE_CONFIG_DIR: cfg, ...env } });
  // The helper's temp folders: none may stay after a call (a pass, a refusal, the time limit).
  const temps = () => readdirSync("/tmp").filter((n) => n.startsWith("choibot-read-tasks.")).sort();
  const fresh = () => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { mode: 0o700 }); };
  const many = (n: number, body: string) => { for (let i = 1; i <= n; i++) writeFileSync(join(dir, `${i}.json`), body); };

  it("the task files in frames (name, length, the bytes); .lock, .highwatermark and other names are skipped", async () => {
    const one = JSON.stringify({ id: "1", subject: "First", status: "completed" }, null, 2);
    const two = '{"id":"2","subject":"Zweite — ü","status":"in_progress"}\n';
    writeFileSync(join(dir, "1.json"), one, { mode: 0o600 });
    writeFileSync(join(dir, "2.json"), two, { mode: 0o600 });
    // What Claude keeps there too (its lock, its id counter), and names Claude never makes.
    writeFileSync(join(dir, ".lock"), "");
    mkdirSync(join(dir, ".lock.lock"));
    writeFileSync(join(dir, ".highwatermark"), "2");
    for (const n of ["0.json", "a.json", "01.json", "notes.txt"]) writeFileSync(join(dir, n), "{}");
    const before = temps();
    const r = await rk([SID]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toBe(`tasks 2\n1.json ${Buffer.byteLength(one)}\n${one}\n2.json ${Buffer.byteLength(two)}\n${two}\n`);
    expect(temps()).toEqual(before);
  });

  it("absent: no tasks folder, or no folder of this session; an empty folder is \"tasks 0\"", async () => {
    expect(await rk([SID])).toMatchObject({ code: 0, stdout: "tasks 0\n" });
    rmSync(dir, { recursive: true });
    expect(await rk([SID])).toMatchObject({ code: 0, stdout: "absent\n" });
    rmSync(join(cfg, "tasks"), { recursive: true });
    expect(await rk([SID])).toMatchObject({ code: 0, stdout: "absent\n" });
  });

  it("refuses a session id of another shape", async () => {
    for (const id of ["../etc/passwd", SID.toUpperCase(), `${SID}x`, `${SID}/..`, "1", ""]) {
      const r = await rk([id]);
      expect([id, r.code, r.stdout]).toEqual([id, 2, ""]);
      expect(r.stderr).toMatch(/read-tasks: session id refused/);
    }
    expect((await rk([])).stderr).toMatch(/usage: read-tasks/);
    expect((await rk([SID, "x"])).stderr).toMatch(/usage: read-tasks/);
  });

  it("refuses a folder that is a link: the tasks folder, the session folder (a live link or a dead one)", async () => {
    const other = join(cfg, "elsewhere");
    mkdirSync(join(other, SID), { recursive: true });
    writeFileSync(join(other, SID, "1.json"), '{"id":"1","subject":"x"}');
    rmSync(dir, { recursive: true });
    symlinkSync(join(other, SID), dir);
    let r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: the session folder is a link/);
    rmSync(dir);
    symlinkSync(join(cfg, "gone"), dir);
    r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: the session folder is a link/);
    rmSync(join(cfg, "tasks"), { recursive: true });
    symlinkSync(other, join(cfg, "tasks"));
    r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: the tasks folder is a link/);
    rmSync(join(cfg, "tasks"));
    symlinkSync(join(cfg, "gone"), join(cfg, "tasks"));
    r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: the tasks folder is a link/);
  });

  it("refuses a task file that is a link (to its login, to a task file, a dead one), a folder, a fifo, or a file with a second name", async () => {
    const cases: [string, () => void, RegExp][] = [
      ["a link to its login", () => symlinkSync(join(cfg, ".credentials.json"), join(dir, "1.json")), /read-tasks: a link: 1\.json/],
      ["a link to a task file", () => { writeFileSync(join(dir, "2.json"), "{}"); symlinkSync(join(dir, "2.json"), join(dir, "1.json")); }, /read-tasks: a link: 1\.json/],
      ["a dead link", () => symlinkSync(join(cfg, "gone.json"), join(dir, "1.json")), /read-tasks: a link: 1\.json/],
      ["a folder", () => mkdirSync(join(dir, "1.json")), /read-tasks: not a regular file of this account: 1\.json/],
      ["a fifo", () => execFileSync("mkfifo", [join(dir, "1.json")]), /read-tasks: not a regular file of this account: 1\.json/],
      ["a hard link of its login", () => linkSync(join(cfg, ".credentials.json"), join(dir, "1.json")), /read-tasks: a file with more than one name: 1\.json/],
    ];
    const before = temps();
    for (const [what, make, why] of cases) {
      fresh();
      make();
      const r = await rk([SID]);
      expect([what, r.code, r.stdout]).toEqual([what, 2, ""]);
      expect(r.stderr, what).toMatch(why);
    }
    expect(temps()).toEqual(before);
  });

  it("the Claude folder must be inside this account's home: another account's folder is refused", async () => {
    const r = await rk([SID], { CLAUDE_CONFIG_DIR: "/tmp" });
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: CLAUDE_CONFIG_DIR is outside the agent's home/);
  });

  it("caps: 256 KiB a file, 1000 files, 4 MiB in all; over a cap nothing is printed and no temp folder stays", async () => {
    const before = temps();
    writeFileSync(join(dir, "1.json"), "x".repeat(256 * 1024));
    expect((await rk([SID])).code).toBe(0);
    writeFileSync(join(dir, "1.json"), "x".repeat(256 * 1024 + 1));
    let r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: 1\.json is larger than 262144 bytes/);
    fresh();
    many(1001, "{}");
    r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: more than 1000 task files/);
    fresh();
    many(17, "x".repeat(256 * 1024));
    r = await rk([SID]);
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: more than 4194304 bytes in all/);
    expect(temps()).toEqual(before);
  }, 30_000);

  it("ends at its time limit (READ_TASKS_LIMIT of the conf): refused, nothing printed, no temp folder stays", async () => {
    writeConf(["READ_TASKS_LIMIT=1"]);
    many(1000, '{"id":"1","subject":"x"}');
    const before = temps();
    // Its temp folder is there while it runs (0700, this account's), and gone after the limit.
    const seen = new Map<string, number>();
    let done = false;
    const call = rk([SID]).finally(() => { done = true; });
    while (!done) {
      for (const n of temps()) {
        if (before.includes(n) || seen.has(n)) continue;
        try { const st = lstatSync(join("/tmp", n)); if (st.uid === ME.uid) seen.set(n, st.mode & 0o7777); } catch { /* gone meanwhile */ }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const r = await call;
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr).toMatch(/read-tasks: time limit \(1 s\)/);
    expect(r.ms).toBeLessThan(8000);
    expect([...seen.values()]).toEqual([0o700]);
    expect(temps()).toEqual(before);
    // A limit of another shape stops every verb, as RUN_TIMEOUT does.
    for (const bad of ["0", "61", "x", "1.5"]) {
      writeConf([`READ_TASKS_LIMIT=${bad}`]);
      expect((await run(["probe"])).stderr, bad).toMatch(/READ_TASKS_LIMIT/);
    }
  }, 30_000);
});

// git-safe (the second account only): its own git config names one agent folder of its homes as
// safe, by its exact path (git refuses a repository of another account; git 2.43 takes no
// pattern). A fake git first on AGENT_PATH keeps the entries in a file: the real one would write
// this test user's own ~/.gitconfig.
describe("git-safe", () => {
  let chiefDtach = "";
  let store = "";
  let log = "";
  const agent = () => join(homes, "chief", "fleet-master", "agent");
  const conf = (o: { chief?: number; agentUid?: number | null } = {}) => writeConf([
    `CHIEF_UID=${o.chief ?? ME.uid}`, `CHIEF_DTACH_DIR=${chiefDtach}`, `AGENT_PATH=${join(root, "gitbin")}:/usr/bin:/bin`,
    ...(o.agentUid === null ? [] : [`AGENT_UID=${o.agentUid ?? ME.uid + 1}`]),
  ]);
  beforeEach(() => {
    chiefDtach = mkdtempSync("/tmp/hct-");
    extraDirs.push(chiefDtach);
    store = join(root, "gitsafe.store");
    log = join(root, "gitsafe.log");
    mkdirSync(join(root, "gitbin"));
    writeFileSync(join(root, "gitbin", "git"), [
      "#!/bin/sh",
      `echo "HOME=$HOME PWD=$(pwd -P) $*" >> '${log}'`,
      `if [ "$1 $2 $3 $4" = "config --global --get-all safe.directory" ]; then [ -f '${store}' ] && cat '${store}'; exit 0; fi`,
      `if [ "$1 $2 $3 $4" = "config --global --add safe.directory" ] && [ $# -eq 5 ]; then printf '%s\\n' "$5" >> '${store}'; exit 0; fi`,
      "exit 9", "",
    ].join("\n"), { mode: 0o755 });
    mkdirSync(join(agent(), ".git"), { recursive: true });
  });
  const entries = () => (existsSync(store) ? readFileSync(store, "utf8").split("\n").filter(Boolean) : []);

  it("adds the exact path once, with the one fixed command, in a fresh env with this account's HOME; a second call adds nothing", async () => {
    conf();
    const r = await run(["git-safe", agent()], { env: { HOME: "/caller/home", GIT_CONFIG_GLOBAL: "/tmp/x" } });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(entries()).toEqual([agent()]);
    expect((await run(["git-safe", agent()])).code).toBe(0);
    expect(entries()).toEqual([agent()]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.every((l) => l.startsWith(`HOME=${ME.homedir} PWD=/ config --global `))).toBe(true);
    expect(lines.filter((l) => l.includes("--add"))).toEqual([`HOME=${ME.homedir} PWD=/ config --global --add safe.directory ${agent()}`]);
    // The leads and the Coordinator: their own exact paths.
    for (const p of [join(homes, "chief", "coordinator", "agent"), join(homes, "chief", "leads", "app-shop", "agent")]) {
      mkdirSync(join(p, ".git"), { recursive: true });
      expect((await run(["git-safe", p])).code, p).toBe(0);
    }
    expect(entries()).toHaveLength(3);
  });

  it("only as the second account: the workers' helper and a helper with no second account refuse it", async () => {
    for (const c of [() => conf({ chief: ME.uid + 7 }), () => writeConf([`AGENT_PATH=${join(root, "gitbin")}:/usr/bin:/bin`])]) {
      c();
      const r = await run(["git-safe", agent()]);
      expect([r.code, r.stdout]).toEqual([2, ""]);
      expect(r.stderr).toMatch(/git-safe: only for the persistent agents' account/);
    }
    expect(entries()).toEqual([]);
  });

  it("refuses every other path: a link in it, not normal, outside the homes, another shape, not a folder, no real .git, a folder of the workers' account, and no AGENT_UID", async () => {
    conf();
    const elsewhere = mkdtempSync("/tmp/hct-gs-");
    extraDirs.push(elsewhere);
    mkdirSync(join(elsewhere, "agent", ".git"), { recursive: true });
    mkdirSync(join(homes, "chief", "leads"), { recursive: true });
    symlinkSync(elsewhere, join(homes, "chief", "leads", "linked"));
    mkdirSync(join(homes, "clones", "w1", ".git"), { recursive: true });
    mkdirSync(join(homes, "chief", "leads", "nogit", "agent"), { recursive: true });
    mkdirSync(join(homes, "chief", "leads", "gitlink", "agent"), { recursive: true });
    symlinkSync(join(elsewhere, "agent", ".git"), join(homes, "chief", "leads", "gitlink", "agent", ".git"));
    mkdirSync(join(homes, "chief", "leads", "file"), { recursive: true });
    writeFileSync(join(homes, "chief", "leads", "file", "agent"), "x");
    const cases: [string, RegExp][] = [
      [join(homes, "chief", "leads", "linked", "agent"), /not its own real path/],
      [`${agent()}/../agent`, /not its own real path/],
      [join(homes, "clones", "w1"), /outside the persistent homes|not the agent folder/],
      [join(elsewhere, "agent"), /outside the persistent homes/],
      [join(homes, "chief", "fleet-master"), /not the agent folder of a persistent home/],
      [join(agent(), ".git"), /not the agent folder of a persistent home/],
      [join(homes, "chief", "leads", "file", "agent"), /not a folder/],
      [join(homes, "chief", "leads", "nogit", "agent"), /no \.git folder/],
      [join(homes, "chief", "leads", "gitlink", "agent"), /no \.git folder/],
      [join(homes, "chief", "leads", "none", "agent"), /not found/],
      ["relative/agent", /must be absolute/],
    ];
    for (const [p, why] of cases) {
      const r = await run(["git-safe", p]);
      expect([p, r.code, r.stdout]).toEqual([p, 2, ""]);
      expect(r.stderr, p).toMatch(why);
    }
    // A lead's area of another shape than the console's (AREA_RE).
    mkdirSync(join(homes, "chief", "leads", "Bad_Area", "agent", ".git"), { recursive: true });
    expect((await run(["git-safe", join(homes, "chief", "leads", "Bad_Area", "agent")])).stderr).toMatch(/not the agent folder of a persistent home/);
    // The folder of the workers' account (here AGENT_UID is this test's own uid).
    conf({ agentUid: ME.uid });
    expect((await run(["git-safe", agent()])).stderr).toMatch(/git-safe: a folder of the workers' account/);
    conf({ agentUid: null });
    expect((await run(["git-safe", agent()])).stderr).toMatch(/git-safe: AGENT_UID is not in/);
    expect(entries()).toEqual([]);
  });
});
