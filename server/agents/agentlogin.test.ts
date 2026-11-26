// server/agents/agentlogin.test.ts — the one Claude login of strong protection: the helper call
// through sudo (argv and env), the settings that turn it on, the status read, and one login from
// the page through the REAL helper (deploy/choibot-agent-exec, run directly as this user: no sudo)
// with a fake `claude`. No test reaches Claude or a login of this server.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoginStatus, agentAuthCommand, agentAuthOf, agentLoginStatus, type AgentAuth } from "./agentlogin.js";
import { ClaudeLogin } from "./claudelogin.js";
import { SUDO_ENV_KEEP } from "./terminal.js";

const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));
const STRONG = {
  CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "1001",
  AGENT_CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude",
};
const X = { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 1001 };

describe("the helper call", () => {
  it("is sudo as the agent uid, with the env_keep list, the helper, claude-auth and the subcommand", () => {
    const a = agentAuthOf(STRONG, X)!;
    for (const sub of ["login", "status"] as const) {
      const c = agentAuthCommand(a, sub);
      expect([c.bin, ...c.args]).toEqual(["/usr/bin/sudo", "-n", "-u", "#1001", "/usr/local/bin/choibot-agent-exec", "claude-auth", sub]);
    }
  });

  it("its env: the agents' Claude folder in place of the console's own, and no secret of the console", () => {
    const a = agentAuthOf({ ...STRONG, CLAUDE_CONFIG_DIR: "/home/choibot/.claude", TELEGRAM_BOT_TOKEN: "x", CONSOLE_COOKIE_SECRET: "y", LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000" }, X)!;
    const env = agentAuthCommand(a, "status").env;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/choibot-agent/.claude");
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CONFIG_DIR", "LANG", "NO_COLOR", "TERM", "XDG_RUNTIME_DIR"]);
  });

  it("is on only in a strong deployment with an absolute agents' Claude folder; defaults as the server's", () => {
    expect(agentAuthOf({ ...STRONG, CHIEF_AGENT_UID: undefined })).toBeNull();
    expect(agentAuthOf({ ...STRONG, CHIEF_ENABLED: undefined })).toBeNull();
    expect(agentAuthOf({ ...STRONG, AGENT_CLAUDE_CONFIG_DIR: "" })).toBeNull();
    expect(agentAuthOf({ ...STRONG, AGENT_CLAUDE_CONFIG_DIR: ".claude" })).toBeNull();
    expect(agentAuthOf(STRONG)?.exec).toEqual(X);
    expect(agentAuthOf({ ...STRONG, AGENT_SUDO_BIN: "/x/sudo", AGENT_EXEC_HELPER: "/x/helper" })?.exec).toEqual({ sudo: "/x/sudo", helper: "/x/helper", uid: 1001 });
  });

  it("the status: Claude's answer; a helper that fails reads as no login", async () => {
    const a = agentAuthOf(STRONG, X)!;
    const fake = (stdout: string, err: Error | null = null) => ((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => { cb(err, stdout); }) as never;
    expect(await agentLoginStatus(a, fake('{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"max"}'))).toEqual({ loggedIn: true, email: "ada@example.invalid", plan: "Max" });
    expect(await agentLoginStatus(a, fake("", new Error("sudo: a password is required")))).toEqual({ loggedIn: false, email: null, plan: null });
  });
});

describe("the kept status read", () => {
  const YES = { loggedIn: true, email: "ada@example.invalid", plan: "Max" };
  it("N reads in a row and N at the same time: one run; a new run after the keep time", async () => {
    let now = 0;
    let runs = 0;
    const s = new AgentLoginStatus(async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return YES; }, { now: () => now });
    expect(await Promise.all([s.read(), s.read(), s.read(), s.read(), s.read()])).toEqual(Array(5).fill(YES));
    for (let i = 0; i < 10; i++) await s.read();
    expect(runs).toBe(1);
    now = 59_999;
    await s.read();
    expect(runs).toBe(1);
    now = 60_000;
    await s.read();
    expect(runs).toBe(2);
  });
  it("forget: the next read runs again; an answer that ran across a forget is not kept", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const s = new AgentLoginStatus(() => { runs++; return new Promise((r) => { release = () => r(YES); }); });
    const first = s.read();
    s.forget();
    release();
    await first;
    const second = s.read();
    release();
    await second;
    expect(runs).toBe(2);
    await s.read();
    expect(runs).toBe(2);
    s.forget();
    const third = s.read();
    release();
    await third;
    expect(runs).toBe(3);
  });
});

describe("a login from the page through the real helper (no sudo) and a fake claude", () => {
  let root = "";
  let home = "";
  let viaHelper: (sub: "login" | "status") => { bin: string; args: string[]; env: NodeJS.ProcessEnv } = () => { throw new Error("set in beforeEach"); };
  const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
  const GOOD = "good-code_123#state-456";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentlogin-"));
    // Inside the home of the passwd file: the helper takes the agent's home from there.
    home = mkdtempSync(join(userInfo().homedir, ".agentlogin-test-"));
    const bin = join(root, "bin");
    for (const d of [bin, join(root, "dtach"), join(root, "wt"), join(root, "ws"), join(root, "homes")]) mkdirSync(d);
    writeFileSync(join(root, "conf"), [
      `DTACH_DIR=${join(root, "dtach")}`, "DTACH_BIN=/bin/true", `WORKTREE_ROOT=${join(root, "wt")}`, `WORKSPACE_DIR=${join(root, "ws")}`,
      `AGENT_HOME_ROOT=${join(root, "homes")}`, `AGENT_PATH=${bin}:/usr/bin:/bin`, "",
    ].join("\n"));
    // As Claude Code with no terminal: the link, then one line; the login goes into ITS config dir.
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
if [ "$2" = status ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then echo '{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"max"}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
echo "If the browser didn't open, visit: ${LINK}"
printf 'Paste code here if prompted > '
IFS= read -r code || exit 1
if [ "$code" = "${GOOD}" ]; then mkdir -p "$CLAUDE_CONFIG_DIR"; echo '{}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; echo "Login successful."; exit 0; fi
echo "Couldn't log in: That code wasn't accepted."; exit 1
`);
    chmodSync(join(bin, "claude"), 0o755);
    const a: AgentAuth = { exec: X, configDir: join(home, ".claude"), env: { PATH: process.env.PATH } };
    // The real helper in place of sudo: the same argv after the sudo part, and the conf of the test.
    viaHelper = (sub) => {
      const c = agentAuthCommand(a, sub);
      return { bin: HELPER, args: c.args.slice(c.args.indexOf(X.helper) + 1), env: { ...c.env, CHOIBOT_AGENT_EXEC_CONF: join(root, "conf") } as NodeJS.ProcessEnv };
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (home.includes(".agentlogin-test-")) rmSync(home, { recursive: true, force: true });
  });

  it("a stop (the form closed, a new link, the console stops) closes the command's stdin and sends it SIGTERM", async () => {
    // As the real Claude Code: a closed stdin does NOT end it; SIGTERM does.
    writeFileSync(join(root, "bin", "claude"), `#!/usr/bin/env bash
on_term() { IFS= read -r -t 2 x; rc=$?; if [ $rc -eq 1 ]; then echo "term, stdin closed" >> "${root}/stop.log"; else echo "term, stdin open ($rc)" >> "${root}/stop.log"; fi; exit 143; }
trap on_term TERM
echo "If the browser didn't open, visit: ${LINK}"
while :; do sleep 0.1; done
`);
    const l = new ClaudeLogin({ paths: { root: "/none", defaultDir: "/none", defaultClaudeJson: "/none" }, command: viaHelper, log: () => {} });
    expect(await l.start("default")).toMatchObject({ state: "waiting" });
    l.stop();
    for (let i = 0; i < 100 && !readFileSync(join(root, "stop.log"), { flag: "a+" }).toString().includes("term"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(readFileSync(join(root, "stop.log"), "utf8").trim()).toBe("term, stdin closed");
    expect(l.state()).toEqual({ state: "idle" });
  });

  it("the link goes to the page, the code to the command, the login lands in the agents' folder, and the status reads it", async () => {
    const done: string[] = [];
    const logs: string[] = [];
    const l = new ClaudeLogin({ paths: { root: "/none", defaultDir: "/none", defaultClaudeJson: "/none" }, command: viaHelper, log: (x) => logs.push(x), onDone: (x) => done.push(x) });
    try {
      const st = await l.start("default");
      expect(st, logs.join("\n")).toMatchObject({ state: "waiting", account: "default", url: LINK });
      expect(l.submit(GOOD)).toMatchObject({ state: "checking" });
      for (let i = 0; i < 200 && l.state().state === "checking"; i++) await new Promise((r) => setTimeout(r, 25));
      expect(l.state()).toEqual({ state: "done", account: "default", email: "ada@example.invalid", plan: "Max" });
      expect(done).toEqual(["default"]);
      expect(readFileSync(join(home, ".claude", ".credentials.json"), "utf8")).toBe("{}\n");
    } finally {
      l.stop();
    }
  });
});

// The step "Log in to Claude" and `choibot login` in strong protection: both read the agents'
// login through the helper (here a fake sudo that runs a fake claude), never the console's own.
describe("the step and the command line in strong protection", () => {
  let root = "";
  let env: Record<string, string> = {};
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentlogin-step-"));
    const claude = join(root, "claude");
    writeFileSync(claude, `#!/usr/bin/env bash\necho "$*" >> "${root}/claude.log"\nif [ "$2" = status ]; then [ -f "${root}/in" ] && { echo '{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"max"}'; exit 0; }; echo '{"loggedIn":false}'; exit 1; fi\nexit 1\n`);
    chmodSync(claude, 0o755);
    const sudo = join(root, "sudo");
    writeFileSync(sudo, `#!/usr/bin/env bash\necho "$*" >> "${root}/sudo.log"\nexec "${claude}" auth "\${@: -1}"\n`);
    chmodSync(sudo, 0o755);
    env = { ...STRONG, AGENT_SUDO_BIN: sudo, CLAUDE_CODE_EXECUTABLE: claude, PATH: process.env.PATH ?? "/usr/bin:/bin" };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const log = (f: string) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } };

  it("the step reads the agents' login; a server whose helper is not ready gives null, and the console's own login is read", async () => {
    const { boxProbes } = await import("../setup/probes.js");
    const probe = (agentStatus?: null) => boxProbes({ env, box: () => Promise.reject(new Error("not used")), ...(agentStatus !== undefined ? { agentStatus } : {}) }).claude!();
    expect(await probe()).toEqual({ installed: true, loggedIn: false });
    writeFileSync(join(root, "in"), "");
    expect(await probe()).toEqual({ installed: true, loggedIn: true });
    expect(log("sudo.log")).toMatch(/choibot-agent-exec claude-auth status/);
    // The server with no helper: no sudo at all.
    const before = log("sudo.log");
    expect((await probe(null)).loggedIn).toBe(false);
    expect(log("sudo.log")).toBe(before);
  });

  it("`choibot login` never logs in in a terminal: it names the page, or says who is logged in for the agents", async () => {
    const { runLogin } = await import("../../bin/lib/login.js");
    const out: string[] = [];
    expect(await runLogin({ repoDir: root, env, isTTY: true, out: (s) => out.push(s) })).toBe(1);
    expect(out.join("\n")).toMatch(/On this server the login is made on the page: open ChoiBot, Set-up, “Log in to Claude”\./);
    expect(log("claude.log")).not.toMatch(/auth login/);
    writeFileSync(join(root, "in"), "");
    out.length = 0;
    expect(await runLogin({ repoDir: root, env, isTTY: true, out: (s) => out.push(s) })).toBe(0);
    expect(out.join("\n")).toBe("  ✔ Logged in as ada@example.invalid. Plan: Max. (the login of your agents)");
  });
});

// The console's own model calls in strong protection (the guide, Fill in, the clean-up words, the
// Brain review): through the helper's claude-print, on the agents' login.
describe("the console's model calls through the helper", () => {
  it("the fixed flags are the same in the guide, the Brain review and the helper", async () => {
    const { GUIDE_ARGV } = await import("../guide/model.js");
    const { DISTILL_ARGV } = await import("../chief/brain/distill.js");
    const { PRINT_FLAGS } = await import("./agentlogin.js");
    const noModel = (a: readonly string[]) => a.filter((x, i) => x !== "--model" && a[i - 1] !== "--model");
    expect(noModel(GUIDE_ARGV)).toEqual([...PRINT_FLAGS]);
    expect(noModel(DISTILL_ARGV)).toEqual([...PRINT_FLAGS]);
    const helper = readFileSync(HELPER, "utf8");
    expect(/^readonly CLAUDE_PRINT_FLAGS=\((.*)\)$/m.exec(helper)?.[1]).toBe('-p --output-format json --tools "" --restricted --strict-mcp-config --no-session-persistence');
  });

  it("printCall: the model and the system prompt of today's argv; any other shape is refused", async () => {
    const { guideArgs } = await import("../guide/model.js");
    const { DISTILL_ARGV } = await import("../chief/brain/distill.js");
    const { printCall } = await import("./agentlogin.js");
    expect(printCall(guideArgs("SYSTEM\nwith lines", "haiku"))).toEqual({ model: "haiku", system: "SYSTEM\nwith lines" });
    expect(printCall([...DISTILL_ARGV])).toEqual({ model: "sonnet" });
    for (const bad of [
      [...guideArgs("S"), "--allowedTools", "Bash"], guideArgs("S").filter((a) => a !== "--restricted"), guideArgs("S").map((a) => (a === "" ? "Bash" : a)),
      ["-p", "--model", "sonnet"], [...DISTILL_ARGV, "--dangerously-skip-permissions"], DISTILL_ARGV.map((a) => (a === "sonnet" ? "Son net" : a)),
    ]) expect([bad, printCall(bad)]).toEqual([bad, null]);
  });

  it("the sudo call: claude-print, the model and the system prompt; the agents' Claude folder; a refused shape never runs", async () => {
    const { guideArgs } = await import("../guide/model.js");
    const { agentClaudeRun } = await import("./agentlogin.js");
    const seen: { bin: string; args: string[]; env: Record<string, string> }[] = [];
    const run = agentClaudeRun(agentAuthOf({ ...STRONG, CLAUDE_CONFIG_DIR: "/home/choibot/.claude", TELEGRAM_BOT_TOKEN: "x" }, X)!, {
      run: (bin) => async (args, o) => { seen.push({ bin, args, env: o.env }); return { code: 0, stdout: "", stderr: "" }; },
    });
    await run(guideArgs("SYSTEM", "haiku"), { stdin: "in", cwd: "/x", env: { HOME: "/home/choibot" }, timeoutMs: 1000 });
    expect(seen[0].bin).toBe("/usr/bin/sudo");
    expect(seen[0].args).toEqual(["-n", "-u", "#1001", "/usr/local/bin/choibot-agent-exec", "claude-print", "haiku", "SYSTEM"]);
    expect(seen[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude" });
    await expect(run([...guideArgs("S"), "--allowedTools", "Bash"], { stdin: "", cwd: "/x", env: {}, timeoutMs: 1000 })).rejects.toThrow(/another shape/);
    expect(seen).toHaveLength(1);
  });

  it("a stop of a call through sudo is a SIGTERM to sudo only (it relays it); the group kill stays for a direct call", async () => {
    const { makeClaudeRun } = await import("../chief/brain/distill.js");
    const dir = mkdtempSync(join(tmpdir(), "agentlogin-stop-"));
    try {
      const f = join(dir, "slow");
      writeFileSync(f, `#!/usr/bin/env bash\ntrap 'echo term >> "${dir}/log"; exit 143' TERM\nwhile :; do sleep 0.05; done\n`);
      chmodSync(f, 0o755);
      await expect(makeClaudeRun(f, { stop: "term" })([], { stdin: "", cwd: dir, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 300 })).rejects.toThrow(/timed out/);
      for (let i = 0; i < 40 && !readFileSync(join(dir, "log"), { flag: "a+" }).toString(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(readFileSync(join(dir, "log"), "utf8")).toBe("term\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a guide answer through the real helper (no sudo) and a fake claude", () => {
  let root = "";
  let home = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentlogin-print-"));
    home = mkdtempSync(join(userInfo().homedir, ".agentlogin-test-"));
    const bin = join(root, "bin");
    for (const d of [bin, join(root, "dtach"), join(root, "wt"), join(root, "ws"), join(root, "homes"), join(root, "run")]) mkdirSync(d);
    writeFileSync(join(root, "conf"), [
      `DTACH_DIR=${join(root, "dtach")}`, "DTACH_BIN=/bin/true", `WORKTREE_ROOT=${join(root, "wt")}`, `WORKSPACE_DIR=${join(root, "ws")}`,
      `AGENT_HOME_ROOT=${join(root, "homes")}`, `AGENT_PATH=${bin}:/usr/bin:/bin`, "",
    ].join("\n"));
    // As `claude -p --output-format json`: one JSON envelope with the answer; it echoes what it got.
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
input=$(cat)
sys=""; while [ $# -gt 0 ]; do [ "$1" = --system-prompt ] && sys=$2; shift; done
python3 -c 'import json,sys; print(json.dumps({"type":"result","is_error":False,"result":"answer to "+sys.argv[1]+" / "+sys.argv[2]+" / "+sys.argv[3]}))' "$sys" "$input" "$CLAUDE_CONFIG_DIR"
`);
    chmodSync(join(bin, "claude"), 0o755);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (home.includes(".agentlogin-test-")) rmSync(home, { recursive: true, force: true });
  });

  it("the guide's model answers on the agents' login, with no check of the console's own Claude folder", async () => {
    const { makeGuideModel } = await import("../guide/model.js");
    const { makeClaudeRun } = await import("../chief/brain/distill.js");
    const { agentClaudeRun } = await import("./agentlogin.js");
    const a: AgentAuth = { exec: X, configDir: join(home, ".claude"), env: {} };
    // The real helper in place of sudo, with the conf of the test.
    const run = agentClaudeRun(a, {
      run: () => (args, o) => makeClaudeRun(HELPER, { stop: "term" })(args.slice(args.indexOf(X.helper) + 1), { ...o, env: { ...o.env, CHOIBOT_AGENT_EXEC_CONF: join(root, "conf") } }),
    });
    // A strong deployment whose console's own Claude folder would be refused (group-writable).
    const own = join(root, "console-claude");
    mkdirSync(own);
    chmodSync(own, 0o775);
    const env = { ...STRONG, CLAUDE_CONFIG_DIR: own, HOME: root, PATH: process.env.PATH };
    const refused = makeGuideModel({ run, runDir: join(root, "run"), env, log: () => {} });
    expect(await refused({ system: "S", input: "I" })).toEqual({ ok: false, why: "down" });
    const model = makeGuideModel({ run, runDir: join(root, "run"), env, agentLogin: true, log: () => {} });
    expect(await model({ system: "You are the guide.", input: "What comes next?" })).toEqual({ ok: true, text: `answer to You are the guide. / What comes next? / ${home}/.claude` });
  });
});

describe("the commit name of the agents' account", () => {
  it("is the sudo call of git-identity with the name and the e-mail, and no console secret in the env; a failure reads as false", async () => {
    const { agentGitIdentity } = await import("./agentlogin.js");
    const seen: { bin: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const ok = ((bin: string, args: string[], o: { env: Record<string, string> }, cb: (e: Error | null) => void) => { seen.push({ bin, args, env: o.env }); cb(null); }) as never;
    const a = { exec: X, env: { TELEGRAM_BOT_TOKEN: "t", LANG: "C.UTF-8" } };
    expect(await agentGitIdentity(a, "Ada", "1+ada@users.noreply.github.com", ok)).toBe(true);
    expect([seen[0].bin, ...seen[0].args]).toEqual(["/usr/bin/sudo", "-n", "-u", "#1001", "/usr/local/bin/choibot-agent-exec", "git-identity", "Ada", "1+ada@users.noreply.github.com"]);
    expect(seen[0].env).toEqual({ LANG: "C.UTF-8" });
    const no = ((_b: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(new Error("exit 2"))) as never;
    expect(await agentGitIdentity(a, "Ada", "a@b.c", no)).toBe(false);
  });
});
