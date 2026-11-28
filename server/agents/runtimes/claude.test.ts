import { afterEach, describe, it, expect, vi } from "vitest";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeHooksPath, claudeRuntime, claudeTranscriptPath, ensureTranscriptAt } from "./claude.js";
import { onboardedLaunch } from "./claude-trust.js";
import { setAgentHelper } from "../../chief/hardened.js";
import { setTranscriptReaders } from "../sessionread.js";
import type { AccountPaths } from "../accounts.js";
import { buildHookSettings } from "../hooks.js";
import type { AgentRecord } from "../store.js";

const rec = (over: Partial<AgentRecord>) => ({
  id: "x", label: "", repo: "", worktree: "/home/m/agent", branch: "", baseBranch: "",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...over,
}) as AgentRecord;

describe("claudeHooksPath", () => {
  it("keeps the fleet master's settings in its own home dir", () => {
    expect(claudeHooksPath(rec({ id: "fleet-master", kind: "fleet-master" }), "/ws")).toBe("/home/m/agent/.choibot-hooks.json");
  });
  it("keeps a lead's settings in its own home dir", () => {
    expect(claudeHooksPath(rec({ id: "lead-app-shop", kind: "lead" }), "/ws")).toBe("/home/m/agent/.choibot-hooks.json");
  });
  it("gives a workspace agent a private per-id file", () => {
    expect(claudeHooksPath(rec({ id: "w1" }), "/ws")).toBe("/ws/.choibot-agents/w1/.choibot-hooks.json");
  });
});

// Ruling 2c-7-a: in a hardened deployment the hook-settings write into an
// agent-writable worktree or home never follows a planted symlink.
describe("claude prepare: the hook settings write", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
    AGENT_CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude",
  };
  const tmps: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    setAgentHelper(false);
    while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
  });
  async function tmp(prefix: string): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    tmps.push(d);
    return d;
  }
  // Hardened deployment with the helper probe passed (agent uid spawns).
  const hardened = () => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); setAgentHelper(true); };
  // The hooks, the compact window of the kind (compact.ts): a master 300000, a worker 200000,
  // and the key that skips the bypass dialog of --dangerously-skip-permissions.
  const want = (r: AgentRecord) => JSON.stringify({
    ...buildHookSettings({ agentId: r.id, token: r.hookToken, port: 3999 }),
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: r.kind === "fleet-master" ? "300000" : "200000" },
    skipDangerousModePermissionPrompt: true,
  });
  const ctx = { port: 3999, workspaceDir: "/ws-unused" };

  for (const [what, make] of [
    ["a master home", (dir: string) => rec({ id: "fleet-master", kind: "fleet-master", worktree: dir, cwd: dir })],
    ["a worker worktree", (dir: string) => rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir })],
  ] as const) {
    it(`hardened, ${what}: a planted symlink is refused and its target is unchanged`, async () => {
      const dir = await tmp("agent-dir-");
      const victim = join(await tmp("console-"), ".env");
      await writeFile(victim, "SECRET=1\n");
      await symlink(victim, join(dir, ".choibot-hooks.json"));
      hardened();
      await expect(claudeRuntime.prepare(make(dir), ctx)).rejects.toThrow(/symlink/);
      expect(await readFile(victim, "utf8")).toBe("SECRET=1\n");
    });

    it(`hardened, ${what}: a hard link to a console file is refused and the file is unchanged`, async () => {
      const dir = await tmp("agent-dir-");
      const victim = join(await tmp("console-"), "record.json");
      await writeFile(victim, "{}\n");
      await link(victim, join(dir, ".choibot-hooks.json"));
      hardened();
      await expect(claudeRuntime.prepare(make(dir), ctx)).rejects.toThrow(/link/);
      expect(await readFile(victim, "utf8")).toBe("{}\n");
    });

    it(`hardened, ${what}: writes (and rewrites) the settings file`, async () => {
      const dir = await tmp("agent-dir-");
      await writeFile(join(dir, ".choibot-hooks.json"), "x".repeat(4096));
      hardened();
      const r = make(dir);
      expect(await claudeRuntime.prepare(r, ctx)).toEqual({
        settingsPath: join(dir, ".choibot-hooks.json"), env: { CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude" },
      });
      expect(await readFile(join(dir, ".choibot-hooks.json"), "utf8")).toBe(want(r));
    });
  }

  it("AGENT_COMPACT_WINDOW=off: no compact window", async () => {
    const dir = await tmp("agent-dir-");
    vi.stubEnv("AGENT_COMPACT_WINDOW", "off");
    const r = rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir });
    await claudeRuntime.prepare(r, ctx);
    expect(await readFile(join(dir, ".choibot-hooks.json"), "utf8"))
      .toBe(JSON.stringify({ ...buildHookSettings({ agentId: r.id, token: r.hookToken, port: 3999 }), skipDangerousModePermissionPrompt: true }));
  });

  it("not hardened: the hooks and the compact window", async () => {
    const dir = await tmp("agent-dir-");
    await mkdir(dir, { recursive: true });
    const r = rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir });
    expect(await claudeRuntime.prepare(r, ctx)).toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
    expect(await readFile(join(dir, ".choibot-hooks.json"), "utf8")).toBe(want(r));
  });
});

// Ruling F1: in a hardened deployment agents get ONE agent-side Claude config
// dir (AGENT_CLAUDE_CONFIG_DIR), never the console's own or a named account,
// and the console never links, copies or makes files in agent Claude dirs.
describe("hardened Claude dirs (ruling F1)", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  const tmps: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setAgentHelper(false);
    while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
  });
  async function tmp(prefix: string): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    tmps.push(d);
    return d;
  }
  // Hardened deployment with the helper probe passed (agent uid spawns).
  const hardened = () => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); setAgentHelper(true); };
  // Hardened deployment whose helper probe failed (weak mode, console uid).
  const weak = () => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); setAgentHelper(false); };
  const ctx = (accounts?: AccountPaths) => ({ port: 3999, workspaceDir: "/ws-unused", ...(accounts ? { accounts } : {}) });
  async function accountsFx(): Promise<AccountPaths> {
    const base = await tmp("accts-");
    const p = { root: join(base, "accounts"), defaultDir: join(base, "claude"), defaultClaudeJson: join(base, ".claude.json") };
    await mkdir(join(p.defaultDir, "projects"), { recursive: true });
    await writeFile(join(p.defaultDir, "settings.json"), "{}");
    return p;
  }

  // The launch of a spawn through the helper names the folder whose trust key the agent writes
  // (claude-trust.ts ONBOARD_JS): only the agent's own clone, AGENT_HOME_ROOT/clones/<its id>, from
  // the id and the console's setting, never from a path of the record.
  it("helperLaunch: an agent with its own clone names AGENT_HOME_ROOT/clones/<id>; any other agent names no folder", () => {
    hardened();
    vi.stubEnv("AGENT_HOME_ROOT", "/srv/choibot/agent-homes");
    const r = (over: Partial<AgentRecord>) => ({ id: "a1", repo: "/ws/app", worktree: "/elsewhere", cwd: "/elsewhere", ...over }) as AgentRecord;
    expect(claudeRuntime.helperLaunch!("/bin/claude", ["--x"], r({ clone: true }))).toEqual(onboardedLaunch("/bin/claude", ["--x"], "/srv/choibot/agent-homes/clones/a1"));
    for (const other of [r({}), r({ kind: "lead", repo: "" })]) {
      expect(claudeRuntime.helperLaunch!("/bin/claude", ["--x"], other)).toEqual(onboardedLaunch("/bin/claude", ["--x"]));
    }
    vi.stubEnv("AGENT_HOME_ROOT", "");
    expect(claudeRuntime.helperLaunch!("/bin/claude", ["--x"], r({ clone: true }))).toEqual(onboardedLaunch("/bin/claude", ["--x"]));
  });

  it("the agent env's CLAUDE_CONFIG_DIR is AGENT_CLAUDE_CONFIG_DIR, also for a named account (never synced, one log line)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await tmp("agent-dir-");
    const accounts = await accountsFx();
    hardened();
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", "/home/choibot-agent/.claude");
    const plain = rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir });
    expect(await claudeRuntime.prepare(plain, ctx(accounts))).toEqual({
      settingsPath: join(dir, ".choibot-hooks.json"), env: { CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude" },
    });
    expect(warn).not.toHaveBeenCalled();
    const named = rec({ id: "w2", repo: "/ws/app", worktree: dir, cwd: dir, account: "office" });
    expect(await claudeRuntime.prepare(named, ctx(accounts))).toEqual({
      settingsPath: join(dir, ".choibot-hooks.json"), env: { CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude" },
    });
    expect(existsSync(join(accounts.root, "office"))).toBe(false); // no shadow dir made
    expect(warn.mock.calls).toEqual([[
      "[chief] w2: account office is not used in a hardened deployment; the agent runs with AGENT_CLAUDE_CONFIG_DIR",
    ]]);
  });

  it("without AGENT_CLAUDE_CONFIG_DIR a hardened claude spawn is refused with a [chief] error, before any write", async () => {
    const dir = await tmp("agent-dir-");
    hardened();
    expect(process.env.AGENT_CLAUDE_CONFIG_DIR).toBeUndefined();
    for (const v of [null, "", "relative/.claude"]) {
      if (v !== null) vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", v);
      await expect(claudeRuntime.prepare(rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir }), ctx()))
        .rejects.toThrow(/^\[chief\] w1: AGENT_CLAUDE_CONFIG_DIR/);
      expect(existsSync(join(dir, ".choibot-hooks.json"))).toBe(false);
    }
  });

  it("not hardened: AGENT_CLAUDE_CONFIG_DIR changes nothing; a named account still gets its own synced dir", async () => {
    const dir = await tmp("agent-dir-");
    const accounts = await accountsFx();
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", "/home/choibot-agent/.claude");
    vi.stubEnv("CHIEF_AGENT_UID", "1001"); // a uid alone (flag off) is not hardened
    const plain = rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir });
    expect(await claudeRuntime.prepare(plain, ctx(accounts))).toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
    const named = rec({ id: "w2", repo: "/ws/app", worktree: dir, cwd: dir, account: "office" });
    expect(await claudeRuntime.prepare(named, ctx(accounts))).toEqual({
      settingsPath: join(dir, ".choibot-hooks.json"), env: { CLAUDE_CONFIG_DIR: join(accounts.root, "office") },
    });
    expect((await lstat(join(accounts.root, "office", "settings.json"))).isSymbolicLink()).toBe(true);
  });

  // A transcript to link: <root>/<other project>/<sid>.jsonl, and the agent
  // planted a dangling symlink where ensureTranscriptAt would put it.
  async function plantedFx() {
    const root = join(await tmp("projects-"), "projects");
    const victimDir = await tmp("console-checkout-");
    const victim = join(victimDir, "post-merge");
    const cwd = "/ws/app/.agent-worktrees/agent-1";
    await mkdir(join(root, "-elsewhere"), { recursive: true });
    await writeFile(join(root, "-elsewhere", "sid-1.jsonl"), "#!/bin/sh\necho owned\n");
    const want = claudeTranscriptPath(cwd, "sid-1", root);
    await mkdir(dirname(want), { recursive: true });
    await symlink(victim, want);
    return { root, victim, cwd, want };
  }

  it("hardened: ensureTranscriptAt never links or copies (a planted dangling symlink makes no file); the helper does it as the agent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await plantedFx();
    hardened();
    expect(await ensureTranscriptAt(f.cwd, "sid-1", f.root)).toBe(false);
    expect(existsSync(f.victim)).toBe(false);
    // No misleading "not linked" line: canResume goes through the helper (canResumeAsAgent).
    expect(warn.mock.calls).toEqual([]);
    // A transcript already in place is found as is.
    await rm(f.want);
    await writeFile(f.want, "{}\n");
    expect(await ensureTranscriptAt(f.cwd, "sid-1", f.root)).toBe(true);
  });

  it("not hardened: ensureTranscriptAt hard-links the transcript into place, as before", async () => {
    const f = await plantedFx();
    await rm(f.want);
    expect(await ensureTranscriptAt(f.cwd, "sid-1", f.root)).toBe(true);
    expect(await readFile(f.want, "utf8")).toBe("#!/bin/sh\necho owned\n");
  });

  it("hardened: canResume asks the helper (session-ensure, as the agent) for the session file of the cwd's project folder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agentDir = await tmp("agent-claude-");
    hardened();
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", agentDir);
    const sid = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";
    const cwd = "/srv/homes/clones/agent-1";
    const r = rec({ id: "w1", repo: "/ws/app", worktree: cwd, cwd, sessionId: sid });
    const answers: (string | Error)[] = [];
    const argvs: string[][] = [];
    setTranscriptReaders({
      agent: { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 }, chief: null,
      run: (_b, args, o, cb) => {
        argvs.push([...args.slice(args.indexOf("session-ensure")), o.env.CLAUDE_CONFIG_DIR ?? ""]);
        const a = answers.shift() ?? "absent\n";
        if (a instanceof Error) cb(a, Buffer.alloc(0), Buffer.from(`choibot-agent-exec: ${a.message}\n`));
        else cb(null, Buffer.from(a), Buffer.alloc(0));
      },
    });
    try {
      answers.push("present\n");
      expect(await claudeRuntime.canResume(r, cwd)).toBe(true);
      expect(argvs).toEqual([["session-ensure", sid, "-srv-homes-clones-agent-1", agentDir]]);
      answers.push("linked -old\n");
      expect(await claudeRuntime.canResume(r, cwd)).toBe(true);
      // absent: a new session, quietly.
      answers.push("absent\n");
      expect(await claudeRuntime.canResume(r, cwd)).toBe(false);
      expect(warn.mock.calls).toEqual([]);
      // An error is not "absent": one more try, which answers.
      answers.push(new Error("session-ensure: busy"), "present\n");
      expect(await claudeRuntime.canResume(r, cwd)).toBe(true);
      expect(warn.mock.calls).toEqual([]);
      // Two errors: a new session, with the helper's own line.
      answers.push(new Error("session-ensure: the project folder is a link"), new Error("session-ensure: the project folder is a link"));
      expect(await claudeRuntime.canResume(r, cwd)).toBe(false);
      expect(warn.mock.calls).toEqual([[`[chief] w1: the session ${sid} could not be checked through the helper (choibot-agent-exec: session-ensure: the project folder is a link); it starts a new session`]]);
      // No session id: no call.
      argvs.length = 0;
      expect(await claudeRuntime.canResume(rec({ id: "w1", cwd, sessionId: null }), cwd)).toBe(false);
      expect(argvs).toEqual([]);
    } finally {
      setTranscriptReaders({ agent: null, chief: null });
    }
  });
  it("failed probe (no helper): no AGENT_CLAUDE_CONFIG_DIR in the env; default account has no env, a named account its own", async () => {
    const dir = await tmp("agent-dir-");
    const accounts = await accountsFx();
    weak();
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", "/home/choibot-agent/.claude");
    const plain = rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir });
    expect(await claudeRuntime.prepare(plain, ctx(accounts))).toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
    const named = rec({ id: "w2", repo: "/ws/app", worktree: dir, cwd: dir, account: "office" });
    const out = await claudeRuntime.prepare(named, ctx(accounts));
    expect(out.env).toEqual({ CLAUDE_CONFIG_DIR: join(accounts.root, "office") });
    expect(out.env?.CLAUDE_CONFIG_DIR).not.toBe("/home/choibot-agent/.claude");
  });

  it("failed probe (no helper): an unset AGENT_CLAUDE_CONFIG_DIR is no refusal", async () => {
    const dir = await tmp("agent-dir-");
    weak();
    expect(process.env.AGENT_CLAUDE_CONFIG_DIR).toBeUndefined();
    await expect(claudeRuntime.prepare(rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir }), ctx()))
      .resolves.toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
  });

  it("failed probe (no helper): the hook settings still go through the no-follow write", async () => {
    const dir = await tmp("agent-dir-");
    weak();
    await symlink("/etc/passwd", join(dir, ".choibot-hooks.json"));
    await expect(claudeRuntime.prepare(rec({ id: "w1", repo: "/ws/app", worktree: dir, cwd: dir }), ctx()))
      .rejects.toThrow(/symlink/);
  });

  it("failed probe (no helper): canResume uses the default transcript root, not AGENT_CLAUDE_CONFIG_DIR", async () => {
    const agentDir = await tmp("agent-claude-");
    weak();
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", agentDir);
    const cwd = "/ws/app/.agent-worktrees/agent-1";
    const r = rec({ id: "w1", repo: "/ws/app", worktree: cwd, cwd, sessionId: "sid-3" });
    const want = claudeTranscriptPath(cwd, "sid-3", join(agentDir, "projects"));
    await mkdir(dirname(want), { recursive: true });
    await writeFile(want, "{}\n");
    // Only the agent dir has the transcript: the default root is searched, so no resume.
    expect(await claudeRuntime.canResume(r, cwd)).toBe(false);
  });
  it("failed probe (no helper): ensureTranscriptAt links the transcript in the console's own root, as before", async () => {
    weak();
    const f = await plantedFx();
    await rm(f.want);
    expect(await ensureTranscriptAt(f.cwd, "sid-1", f.root)).toBe(true);
    expect(existsSync(f.want)).toBe(true);
  });
});

// A lead's home is outside the trusted workspace dir, so Claude Code would stop
// at its folder-trust dialog. prepare marks the lead's cwd trusted in the
// .claude.json of the config dir the lead runs with; never for other kinds,
// never in a hardened deployment (ruling 2c-7-a).
describe("claude prepare: a lead's folder trust", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  const tmps: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setAgentHelper(false);
    while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
  });
  async function tmp(prefix: string): Promise<string> {
    const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    tmps.push(d);
    return d;
  }
  const hardened = () => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); };
  // Onboarded already: only the trust mark can change it.
  const BASE = JSON.stringify({ numStartups: 7, hasCompletedOnboarding: true, projects: { "/ws": { hasTrustDialogAccepted: true } } }, null, 2);
  // The default account's .claude.json holds BASE; a named account "office" has its own.
  async function accountsFx(): Promise<AccountPaths> {
    const base = await tmp("accts-");
    const p = { root: join(base, "accounts"), defaultDir: join(base, "claude"), defaultClaudeJson: join(base, ".claude.json") };
    await mkdir(join(p.defaultDir, "projects"), { recursive: true });
    await mkdir(join(p.root, "office"), { recursive: true });
    await writeFile(p.defaultClaudeJson, BASE);
    await writeFile(join(p.root, "office", ".claude.json"), BASE);
    return p;
  }
  const ctx = (accounts: AccountPaths) => ({ port: 3999, workspaceDir: "/ws-unused", accounts });
  const lead = (dir: string, over: Partial<AgentRecord> = {}) =>
    rec({ id: "lead-app-shop", kind: "lead", area: "app-shop", worktree: dir, cwd: dir, ...over });
  const trusted = async (file: string, dir: string) =>
    JSON.parse(await readFile(file, "utf8")).projects?.[dir]?.hasTrustDialogAccepted;

  it("a lead's spawn marks its cwd trusted; a worker's spawn leaves the config untouched", async () => {
    const accounts = await accountsFx();
    const dir = await tmp("lead-home-");
    expect(await claudeRuntime.prepare(lead(dir), ctx(accounts))).toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
    expect(await trusted(accounts.defaultClaudeJson, dir)).toBe(true);
    expect(JSON.parse(await readFile(accounts.defaultClaudeJson, "utf8")).numStartups).toBe(7);

    await writeFile(accounts.defaultClaudeJson, BASE);
    const wt = await tmp("worker-wt-");
    await claudeRuntime.prepare(rec({ id: "w1", repo: "/ws/app", worktree: wt, cwd: wt }), ctx(accounts));
    expect(await readFile(accounts.defaultClaudeJson, "utf8")).toBe(BASE);
  });

  it("the fleet master's home (a new install) is marked trusted too", async () => {
    const accounts = await accountsFx();
    const dir = await tmp("master-home-");
    await claudeRuntime.prepare(rec({ id: "fleet-master", kind: "fleet-master", repo: "", worktree: dir, cwd: dir }), ctx(accounts));
    expect(await trusted(accounts.defaultClaudeJson, dir)).toBe(true);
  });

  it("the Coordinator's spawn marks its cwd trusted, in the config of its login", async () => {
    const accounts = await accountsFx();
    const dir = await tmp("coordinator-home-");
    const coordinator = (over: Partial<AgentRecord> = {}) => rec({ id: "coordinator", kind: "coordinator", repo: "", worktree: dir, cwd: dir, ...over });
    await claudeRuntime.prepare(coordinator(), ctx(accounts));
    expect(await trusted(accounts.defaultClaudeJson, dir)).toBe(true);
    await claudeRuntime.prepare(coordinator({ account: "office" }), ctx(accounts));
    expect(await trusted(join(accounts.root, "office", ".claude.json"), dir)).toBe(true);
  });

  it("a lead on a named account: the account dir's .claude.json, the one its CLAUDE_CONFIG_DIR points at", async () => {
    const accounts = await accountsFx();
    const dir = await tmp("lead-home-");
    const out = await claudeRuntime.prepare(lead(dir, { account: "office" }), ctx(accounts));
    expect(out.env).toEqual({ CLAUDE_CONFIG_DIR: join(accounts.root, "office") });
    expect(await trusted(join(accounts.root, "office", ".claude.json"), dir)).toBe(true);
    expect(await readFile(accounts.defaultClaudeJson, "utf8")).toBe(BASE);
  });

  it("a config that cannot be updated never blocks the spawn ([chief] warnings: onboarding and trust)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const accounts = await accountsFx();
    await writeFile(accounts.defaultClaudeJson, "{ not json");
    const dir = await tmp("lead-home-");
    expect(await claudeRuntime.prepare(lead(dir), ctx(accounts))).toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
    expect(await readFile(accounts.defaultClaudeJson, "utf8")).toBe("{ not json");
    expect(warn).toHaveBeenCalledTimes(2);
    for (const c of warn.mock.calls) expect(String(c[0])).toMatch(/^\[chief\] /);
  });

  it("hardened: no write, with the helper (agent-owned AGENT_CLAUDE_CONFIG_DIR) or without it", async () => {
    const accounts = await accountsFx();
    const agentCfg = await tmp("agent-claude-");
    await writeFile(join(agentCfg, ".claude.json"), BASE);
    const dir = await tmp("lead-home-");
    hardened();
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", agentCfg);
    setAgentHelper(true);
    expect(await claudeRuntime.prepare(lead(dir), ctx(accounts))).toEqual({
      settingsPath: join(dir, ".choibot-hooks.json"), env: { CLAUDE_CONFIG_DIR: agentCfg },
    });
    setAgentHelper(false);
    expect(await claudeRuntime.prepare(lead(dir), ctx(accounts))).toEqual({ settingsPath: join(dir, ".choibot-hooks.json") });
    expect(await readFile(join(agentCfg, ".claude.json"), "utf8")).toBe(BASE);
    expect(await readFile(accounts.defaultClaudeJson, "utf8")).toBe(BASE);
  });
});
