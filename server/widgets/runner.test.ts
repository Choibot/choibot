// server/widgets/runner.test.ts — tests for the widget script runner.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SUDO_ENV_KEEP, helperArgv, type AgentExec } from "../agents/terminal.js";
import { readStatus } from "./history.js";
import { resolveRunnable, runScript, scriptEnv, type RunOpts } from "./runner.js";
import { WidgetStore } from "./store.js";

let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), "widget-run-")); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

let n = 0;
async function script(body: string, mode = 0o755, rel = "refresh"): Promise<{ dir: string; file: string }> {
  const dir = join(base, `w${++n}`);
  const file = join(dir, rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return { dir, file };
}
const run = (s: { dir: string; file: string }, over: Partial<RunOpts> = {}) =>
  runScript({ file: s.file, cwd: s.dir, args: {}, env: scriptEnv(s.dir, "a1"), maxOut: 256 * 1024, ...over });

// A zombie still answers kill(pid, 0): read /proc instead (Linux).
async function alive(pid: number): Promise<boolean> {
  try { return !/^\d+ \(.*\) Z/.test(await readFile(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

describe("resolveRunnable", () => {
  it("returns the real path of an executable file inside the folder", async () => {
    const s = await script("echo '{}'");
    expect(await resolveRunnable(s.dir, "refresh")).toBe(await realpath(s.file));
  });
  it("accepts actions/<name> inside the folder", async () => {
    const s = await script("echo '{}'", 0o755, "actions/ping");
    expect(await resolveRunnable(s.dir, "actions/ping")).toBe(await realpath(s.file));
  });
  it("refuses a file with no exec bit", async () => {
    const s = await script("echo '{}'", 0o644);
    expect(await resolveRunnable(s.dir, "refresh")).toBeNull();
  });
  it("refuses a symlink to a script outside the folder", async () => {
    const outside = await script("echo '{}'");
    const dir = join(base, `w${++n}`);
    await mkdir(dir, { recursive: true });
    await symlink(outside.file, join(dir, "refresh"));
    expect(await resolveRunnable(dir, "refresh")).toBeNull();
  });
  it("refuses a missing file and a folder", async () => {
    const dir = join(base, `w${++n}`);
    await mkdir(join(dir, "refresh"), { recursive: true });
    expect(await resolveRunnable(dir, "refresh")).toBeNull();
    expect(await resolveRunnable(dir, "nope")).toBeNull();
  });
});

describe("scriptEnv", () => {
  it("passes only PATH, HOME, USER, LANG, TZ plus the widget vars", () => {
    const env = scriptEnv("/d", "a1", { PATH: "/bin", HOME: "/h", USER: "u", LANG: "C", TZ: "UTC", CONSOLE_COOKIE_SECRET: "s" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", USER: "u", LANG: "C", TZ: "UTC", CHOIBOT_WIDGET_DIR: "/d", CHOIBOT_AGENT_ID: "a1" });
  });
});

describe("runScript", () => {
  it("passes args on stdin and parses JSON stdout", async () => {
    const s = await script("cat");
    expect(await run(s, { args: { a: 1 } })).toEqual({ ok: true, value: { a: 1 } });
  });
  it("sends {} on stdin when the widget passed no args", async () => {
    const s = await script("cat");
    expect(await run(s, { args: undefined })).toEqual({ ok: true, value: {} });
  });
  it("runs in the given cwd", async () => {
    const s = await script("printf '{\"cwd\":\"%s\"}' \"$(pwd -P)\"");
    expect(await run(s)).toEqual({ ok: true, value: { cwd: await realpath(s.dir) } });
  });
  it("non-zero exit: error with the exit code and the stderr tail", async () => {
    const s = await script("echo boom >&2\nexit 3");
    const r = await run(s);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("exit 3"); expect(r.error).toContain("boom"); }
  });
  it("stdout that is not JSON is an error", async () => {
    const s = await script("echo hello");
    expect(await run(s)).toEqual({ ok: false, error: "stdout is not valid JSON" });
  });
  it("keeps only the last 4 KB of stderr", async () => {
    const s = await script("head -c 10000 /dev/zero | tr '\\0' e >&2\nexit 1");
    const r = await run(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThanOrEqual(4096 + 20);
  });
  it("kills the whole process group on timeout, a grandchild holding stdout included", async () => {
    const s = await script("sleep 30 &\necho $! > \"$CHOIBOT_WIDGET_DIR/pid\"\nsleep 30");
    const t0 = Date.now();
    const r = await run(s, { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toEqual({ ok: false, error: "timed out after 0.3 s" });
    const pid = Number(await readFile(join(s.dir, "pid"), "utf8"));
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = !(await alive(pid));
      if (!gone) await new Promise((res) => setTimeout(res, 50));
    }
    expect(gone).toBe(true);
  });
  it("does not wait on a pipe that a stray process keeps open after exit", async () => {
    const s = await script("echo '{\"v\":1}'\nsleep 3 &\nexit 0");
    const t0 = Date.now();
    expect(await run(s, { drainMs: 200 })).toEqual({ ok: true, value: { v: 1 } });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("after a clean exit, kills what the script left in the background", async () => {
    for (const bg of ["sleep 30 >/dev/null 2>&1 &", "sleep 30 &"]) {
      const s = await script(`${bg}\necho $! > "$CHOIBOT_WIDGET_DIR/pid"\necho '{"v":1}'\nexit 0`);
      expect(await run(s, { drainMs: 200 })).toEqual({ ok: true, value: { v: 1 } });
      const pid = Number(await readFile(join(s.dir, "pid"), "utf8"));
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = !(await alive(pid));
        if (!gone) await new Promise((res) => setTimeout(res, 50));
      }
      expect(gone).toBe(true);
    }
  });
  it("stdout over the cap: kills the group and reports output too large", async () => {
    const s = await script("head -c 300000 /dev/zero | tr '\\0' a\nsleep 5");
    const t0 = Date.now();
    expect(await run(s)).toEqual({ ok: false, error: "output too large" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("keeps console secrets out of the script env", async () => {
    const s = await script("printf '{\"secret\":\"%s\",\"dir\":\"%s\",\"agent\":\"%s\"}' \"$CONSOLE_COOKIE_SECRET\" \"$CHOIBOT_WIDGET_DIR\" \"$CHOIBOT_AGENT_ID\"");
    const env = scriptEnv(s.dir, "a1", { PATH: process.env.PATH, CONSOLE_COOKIE_SECRET: "s3cret", TELEGRAM_BOT_TOKEN: "t" });
    expect(await run(s, { env })).toEqual({ ok: true, value: { secret: "", dir: s.dir, agent: "a1" } });
  });
  it("a missing file is an error result, not a throw", async () => {
    const r = await runScript({ file: join(base, "nope"), cwd: base, args: {}, env: scriptEnv(base, "a1"), maxOut: 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^spawn failed/);
  });
});

// ---- Phase 2c: widget scripts as the agent uid (spec §3, Appendix B step 3)
// No test runs the real sudo (rule 7). `sudo` is a fake script: it logs its
// argv and the env it got (/proc/<pid>/environ), checks the option prefix,
// then does what `sudo -n -u #<uid> --preserve-env=<list>` would, as the
// current user: a fresh env with only the listed keys, plus
// CHOIBOT_AGENT_EXEC_CONF (the test conf; real sudo's env_reset strips it), and
// execs the rest. The helper is the real deploy/choibot-agent-exec with a temp
// conf, except where a test names a fake one.

const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));

type SudoCall = { argv: string[]; env: Record<string, string> };

function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of raw.split("\0")) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function fakeSudo(logDir: string, conf: string): string {
  return `#!/bin/bash
f=${logDir}/$(/bin/date +%s%N)-$$
/bin/cat /proc/$$/environ > "$f.env"
printf '%s\\0' "$@" > "$f.tmp" && /bin/mv "$f.tmp" "$f.argv"
# As the real sudo with our sudoers line: env_reset, then the env_keep keys the caller has.
if [[ $1 != -n || $2 != -u || $3 != '#'* || $4 == --preserve-env=* ]]; then echo "fake sudo: bad argv" >&2; exit 64; fi
shift 3
keep=(${SUDO_ENV_KEEP.join(" ")} CHOIBOT_AGENT_ID CHOIBOT_AGENT_PASS CHOIBOT_WIDGET_DIR CHOIBOT_CRON_SPOOL)
kept=()
for k in "\${keep[@]}"; do if [[ -n \${!k+x} ]]; then kept+=("$k=\${!k}"); fi; done
exec /usr/bin/env -i CHOIBOT_AGENT_EXEC_CONF=${conf} "\${kept[@]}" "$@"
`;
}

describe("runScript through choibot-agent-exec run (hardened deployment)", () => {
  let root: string;
  let ws: string;
  let conf: string;
  let logDir: string;
  let x: AgentExec;
  let k = 0;

  async function exe(path: string, body: string): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
    await chmod(path, 0o755);
    return path;
  }
  async function writeConf(extra: string[] = []): Promise<void> {
    await writeFile(conf, [
      `DTACH_DIR=${root}/dtach`, "DTACH_BIN=/usr/local/bin/dtach", `WORKTREE_ROOT=${root}/wt`,
      `WORKSPACE_DIR=${ws}`, `AGENT_HOME_ROOT=${root}/homes`, ...extra, "",
    ].join("\n"));
  }
  // A widget folder with a refresh script, outside the allowed cwds (like
  // WIDGETS_DATA_DIR); the script runs in `ws`.
  async function widgetScript(body: string): Promise<{ dir: string; file: string }> {
    const dir = join(root, "widgets", "a1", `w${++k}`);
    return { dir, file: await exe(join(dir, "refresh"), `#!/bin/sh\n${body}\n`) };
  }
  async function sudoCalls(): Promise<SudoCall[]> {
    const names = (await readdir(logDir)).filter((n) => n.endsWith(".argv")).sort();
    return Promise.all(names.map(async (n) => ({
      argv: (await readFile(join(logDir, n), "utf8")).split("\0").slice(0, -1),
      env: parseEnviron(await readFile(join(logDir, n.replace(/\.argv$/, ".env")), "utf8")),
    })));
  }
  const hrun = (s: { dir: string; file: string }, over: Partial<RunOpts> = {}) =>
    runScript({ file: s.file, cwd: ws, args: {}, env: scriptEnv(s.dir, "a1"), maxOut: 256 * 1024, agentExec: x, ...over });
  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 80; i++) {
      if (!(await alive(pid))) return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return false;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "widget-exec-"));
    ws = join(root, "ws");
    logDir = join(root, "log");
    conf = join(root, "exec.conf");
    for (const d of [ws, logDir, join(root, "wt"), join(root, "homes"), join(root, "dtach")]) await mkdir(d, { recursive: true });
    await writeConf();
    x = { sudo: await exe(join(root, "sudo"), fakeSudo(logDir, conf)), helper: HELPER, uid: process.getuid!() };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("runs sudo with the helper prefix and run <file> <cwd>: no env value on argv, only PATH, LANG, TZ and the widget vars in sudo's env", async () => {
    vi.stubEnv("CONSOLE_COOKIE_SECRET", "cookie-s3cret");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-s3cret");
    const s = await widgetScript(
      "printf '{\"cwd\":\"%s\",\"dir\":\"%s\",\"agent\":\"%s\",\"home\":\"%s\",\"user\":\"%s\",\"lang\":\"%s\",\"tz\":\"%s\",\"secret\":\"%s\",\"stdin\":%s}' " +
      "\"$(pwd -P)\" \"$CHOIBOT_WIDGET_DIR\" \"$CHOIBOT_AGENT_ID\" \"$HOME\" \"$USER\" \"$LANG\" \"$TZ\" \"$CONSOLE_COOKIE_SECRET$TELEGRAM_BOT_TOKEN\" \"$(cat)\"",
    );
    const env = scriptEnv(s.dir, "a1", {
      PATH: "/usr/bin:/bin", HOME: "/home/console", USER: "console", LANG: "C.UTF-8", TZ: "UTC",
      CONSOLE_COOKIE_SECRET: "cookie-s3cret",
    });
    const r = await hrun(s, { env, args: { q: 1 } });
    const me = userInfo();
    expect(r).toEqual({ ok: true, value: {
      cwd: await realpath(ws), dir: s.dir, agent: "a1", home: me.homedir, user: me.username, lang: "C.UTF-8",
      tz: "UTC", secret: "", stdin: { q: 1 },
    } });
    const calls = await sudoCalls();
    expect(calls).toHaveLength(1);
    expect([x.sudo, ...calls[0].argv]).toEqual(helperArgv(x, "run", [s.file, ws]));
    expect(calls[0].argv).toEqual([
      "-n", "-u", `#${x.uid}`, HELPER, "run", s.file, ws,
    ]);
    expect(calls[0].argv.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))).toEqual([]);
    expect(calls[0].argv.join("\0")).not.toMatch(/s3cret|C\.UTF-8|UTC/);
    expect(calls[0].env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC", CHOIBOT_WIDGET_DIR: s.dir, CHOIBOT_AGENT_ID: "a1" });
  });

  it("gives the helper an absolute cwd", async () => {
    const s = await widgetScript("echo '{}'");
    expect(await hrun(s, { cwd: relative(process.cwd(), ws) })).toEqual({ ok: true, value: {} });
    expect((await sudoCalls())[0].argv.at(-1)).toBe(ws);
  });

  it("a helper refusal is the widget's error: exit 2 and the helper's reason line", async () => {
    const s = await widgetScript("echo '{}'");
    const r = await hrun(s, { cwd: root });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^exit 2: choibot-agent-exec: cwd outside WORKTREE_ROOT/);
  });

  it("a hanging script: SIGTERM through sudo at the timeout, the timeout error, its background job gone", async () => {
    const s = await widgetScript("sleep 30 &\necho $! > \"$CHOIBOT_WIDGET_DIR/pid\"\nsleep 30");
    const t0 = Date.now();
    const r = await hrun(s, { timeoutMs: 300, killGraceMs: 5_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r).toEqual({ ok: false, error: "timed out after 0.3 s" });
    expect(await gone(Number(await readFile(join(s.dir, "pid"), "utf8")))).toBe(true);
  });

  it("a script that ignores SIGTERM: SIGKILL to sudo's group after the grace ends the run; the helper's RUN_TIMEOUT ends the script", async () => {
    // The console's SIGKILL reaches only sudo's group (here the helper); the
    // script's group is the agent uid's, so the helper's RUN_TIMEOUT is the backstop.
    await writeConf(["RUN_TIMEOUT=2"]);
    const s = await widgetScript("trap '' TERM\necho $$ > \"$CHOIBOT_WIDGET_DIR/pid\"\nwhile :; do sleep 0.1; done");
    const t0 = Date.now();
    const r = await hrun(s, { timeoutMs: 300, killGraceMs: 300, drainMs: 200 });
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(550);
    expect(ms).toBeLessThan(1_800);
    expect(r).toEqual({ ok: false, error: "timed out after 0.3 s" });
    expect(await gone(Number(await readFile(join(s.dir, "pid"), "utf8")))).toBe(true);
  });

  it("stdout over the cap through the helper: stopped, output too large", async () => {
    const s = await widgetScript("head -c 300000 /dev/zero | tr '\\0' a\nsleep 30");
    const t0 = Date.now();
    expect(await hrun(s, { killGraceMs: 5_000 })).toEqual({ ok: false, error: "output too large" });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("the helper's own RUN_TIMEOUT ends the run by SIGKILL (not exit 124): the timeout error", async () => {
    await writeConf(["RUN_TIMEOUT=1"]);
    const s = await widgetScript("sleep 30");
    const t0 = Date.now();
    const r = await hrun(s, { timeoutMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toEqual({ ok: false, error: "timed out after 10 s" });
  }, 15_000);

  it("exit 124 is the script's own code, never a timeout (the helper's timeout is -s KILL)", async () => {
    const s = await widgetScript("echo late >&2\nexit 124");
    expect(await hrun(s)).toEqual({ ok: false, error: "exit 124: late" });
  });

  it("after a clean exit through the helper, nothing the script left in the background lives on", async () => {
    for (const bg of ["sleep 30 >/dev/null 2>&1 &", "sleep 30 &"]) {
      const s = await widgetScript(`${bg}\necho $! > "$CHOIBOT_WIDGET_DIR/pid"\necho '{"v":1}'\nexit 0`);
      const t0 = Date.now();
      expect(await hrun(s, { drainMs: 5_000 })).toEqual({ ok: true, value: { v: 1 } });
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(await gone(Number(await readFile(join(s.dir, "pid"), "utf8")))).toBe(true);
    }
  });

  it("a hanging refresh through the store: the widget gets its timeout error state", async () => {
    const store = new WidgetStore(join(root, "widgets"), { timeoutMs: 300, agentExec: x });
    const dir = store.dir("a1", "hang");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "widget.html"), "<p>x</p>");
    await exe(join(dir, "refresh"), "#!/bin/sh\nsleep 30\n");
    const r = await store.refreshScript("a1", "hang", ws, undefined);
    expect(r.status).toMatchObject({ ok: false, mode: "script", error: "timed out after 0.3 s" });
    expect((await readStatus(dir)).last).toMatchObject({ ok: false, mode: "script", error: "timed out after 0.3 s" });
    expect((await sudoCalls()).map((c) => c.argv.slice(3, 5))).toEqual([[HELPER, "run"]]);
  });

  it("not hardened (no agentExec): the script itself with no args, exactly scriptEnv as its env, no sudo", async () => {
    vi.stubEnv("CONSOLE_COOKIE_SECRET", "cookie-s3cret");
    const s = await widgetScript("printf '{\"argv0\":\"%s\",\"argc\":%s,\"cwd\":\"%s\"}' \"$0\" \"$#\" \"$(pwd -P)\"\ncat /proc/$$/environ > \"$CHOIBOT_WIDGET_DIR/environ\"");
    const env = scriptEnv(s.dir, "a1", { PATH: "/usr/bin:/bin", HOME: "/h", USER: "u", LANG: "C", TZ: "UTC" });
    const r = await runScript({ file: s.file, cwd: ws, args: {}, env, maxOut: 1024 });
    expect(r).toEqual({ ok: true, value: { argv0: s.file, argc: 0, cwd: await realpath(ws) } });
    expect(parseEnviron(await readFile(join(s.dir, "environ"), "utf8"))).toEqual(env);
    expect(await sudoCalls()).toEqual([]);
  });
});
