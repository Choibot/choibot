// The first-run screens of the REAL Claude Code (when it is installed; else skipped), in a fresh
// config dir and a fresh HOME with NO credentials: no sign-in, no credentials file, no auth
// command. After the console's marks, no first-run screen comes before the login hint or the
// prompt. The screens and their texts (Claude Code 2.1.332):
//   no hasCompletedOnboarding        -> theme picker ("Choose the text style"), then the login method
//   cwd not trusted (also no parent) -> folder question ("Is this a project you created or one you trust")
//   no skipDangerousModePermissionPrompt with --dangerously-skip-permissions -> bypass dialog
//   all set                           -> the input box, "Not logged in · run /login"
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as pty from "node-pty";
import xterm from "@xterm/headless";
import { claudeRuntime } from "./claude.js";
import { onboardedLaunch } from "./claude-trust.js";
import type { AgentRecord } from "../store.js";
import type { AccountPaths } from "../accounts.js";

const { Terminal } = xterm;

// The installed claude, by PATH, as an agent's PATH finds it. Null: the suite is skipped.
function installedClaude(): string | null {
  try {
    const p = execFileSync("bash", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
    return p ? realpathSync(p) : null;
  } catch { return null; }
}
const CLAUDE = installedClaude();

const SCREENS = {
  theme: /Choose the text style/,
  loginMethod: /Select login method/,
  trust: /Is this a project you created or one you trust/,
  bypass: /Bypass Permissions mode/,
};
const READY = /run \/login|Please run \/login/;
// Never a console port: the hooks of the settings point here, where nothing listens.
const DEAD_PORT = 9;

const tmps: string[] = [];
afterEach(async () => {
  while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
});
async function tmp(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tmps.push(d);
  return d;
}

type Run = { screen: () => string; kill: () => void };

// Claude in a PTY of the console's size, with only the env given (no key of this process).
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: no update check, telemetry or error report from a test.
function start(command: string, args: string[], cwd: string, env: Record<string, string>): Run {
  const term = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  const p = pty.spawn(command, args, {
    name: "xterm-256color", cols: 120, rows: 30, cwd,
    env: { TERM: "xterm-256color", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...env },
  });
  p.onData((d) => term.write(d));
  return {
    screen: () => {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
      return out.join("\n");
    },
    kill: () => { try { p.kill("SIGKILL"); } catch { /* gone */ } },
  };
}

// The first screen that shows a known state, then a short time more: a dialog that would come
// after it is seen too. Returns the names of every first-run screen seen, and the last screen.
async function firstScreens(run: Run): Promise<{ seen: string[]; ready: boolean; text: string }> {
  const seen = new Set<string>();
  const look = (): boolean => {
    const s = run.screen();
    for (const [name, re] of Object.entries(SCREENS)) if (re.test(s)) seen.add(name);
    return seen.size > 0 || READY.test(s);
  };
  const until = Date.now() + 25_000;
  while (!look() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  const more = Date.now() + 2_000;
  while (Date.now() < more) { look(); await new Promise((r) => setTimeout(r, 200)); }
  const text = run.screen();
  run.kill();
  return { seen: [...seen], ready: READY.test(text), text };
}

const rec = (over: Partial<AgentRecord>): AgentRecord => ({
  id: "first-1", repo: "", baseBranch: "", branch: "", worktree: "", status: "starting",
  sessionId: null, hookToken: "tok", createdAt: 1, runtime: "claude", ...over,
} as AgentRecord);

describe.skipIf(!CLAUDE)("real Claude Code: no first-run screen before the login or the prompt", () => {
  it("control: a fresh config with no marks stops at the theme picker (the test sees the screens)", async () => {
    const home = await tmp("firstrun-home-");
    const cwd = await tmp("firstrun-cwd-");
    const r = await firstScreens(start(CLAUDE!, ["--dangerously-skip-permissions", "the task"], cwd, { HOME: home, PATH: "/usr/bin:/bin" }));
    expect(r.seen, r.text).toEqual(["theme"]);
  }, 40_000);

  it("own install with a fresh Claude config: a lead's start, after prepare, shows the login hint", async () => {
    const home = await tmp("firstrun-home-");
    const leadHome = await tmp("firstrun-lead-");
    const accounts: AccountPaths = { root: join(home, "accounts"), defaultDir: join(home, ".claude"), defaultClaudeJson: join(home, ".claude.json") };
    const r0 = rec({ id: "lead-app", kind: "lead", area: "app", worktree: leadHome, cwd: leadHome });
    const prepared = await claudeRuntime.prepare(r0, { port: DEAD_PORT, workspaceDir: leadHome, accounts });
    const args = claudeRuntime.buildArgs({}, { prompt: "the task", settingsPath: prepared.settingsPath, cwd: leadHome });
    const r = await firstScreens(start(CLAUDE!, args, leadHome, { HOME: home, PATH: "/usr/bin:/bin", ...(prepared.env ?? {}) }));
    expect(r.seen, r.text).toEqual([]);
    expect(r.ready, r.text).toBe(true);
    // The task went in as the first message (here it gets the login hint as its answer).
    expect(r.text).toMatch(/❯ the task/);
    const cfg = JSON.parse(await readFile(accounts.defaultClaudeJson, "utf8"));
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.projects[leadHome].hasTrustDialogAccepted).toBe(true);
  }, 40_000);

  it("strong protection: a fresh agent config (only the clones' trust of repo-clone), the helper's launcher shows the login hint", async () => {
    const base = await tmp("firstrun-hard-");
    const agentHome = join(base, "agent-home");
    const cfgDir = join(base, "agent-claude");
    const clone = join(base, "clones", "first-1");
    for (const d of [agentHome, cfgDir, clone]) await mkdir(d, { recursive: true });
    // The helper's repo-clone runs its TRUST_JS (deploy/choibot-agent-exec) on the clones folder:
    // the same script, read from the helper, run as it runs it.
    const helper = await readFile(join(process.cwd(), "deploy", "choibot-agent-exec"), "utf8");
    const trustJs = /readonly TRUST_JS='([^']*)'/.exec(helper)?.[1];
    expect(trustJs).toBeTruthy();
    execFileSync(process.execPath, ["-e", trustJs!, join(cfgDir, ".claude.json"), join(base, "clones")]);
    // The hook settings of prepare (the skip key); its own config marks go to another login.
    const other = join(base, "console-login");
    await mkdir(other);
    const accounts: AccountPaths = { root: join(other, "accounts"), defaultDir: join(other, ".claude"), defaultClaudeJson: join(other, ".claude.json") };
    const r0 = rec({ id: "first-1", repo: "/srv/ws/app", worktree: clone, cwd: clone });
    const prepared = await claudeRuntime.prepare(r0, { port: DEAD_PORT, workspaceDir: base, accounts });
    const args = claudeRuntime.buildArgs({}, { prompt: "the task", settingsPath: prepared.settingsPath, cwd: clone });
    const l = claudeRuntime.helperLaunch!(CLAUDE!, args);
    expect(l).toEqual(onboardedLaunch(CLAUDE!, args));
    // The env of the helper's spawn: env -i, HOME, PATH (with Node, as AGENT_PATH), CLAUDE_CONFIG_DIR.
    const r = await firstScreens(start(l.command, l.args, clone, {
      HOME: agentHome, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: cfgDir,
    }));
    expect(r.seen, r.text).toEqual([]);
    expect(r.ready, r.text).toBe(true);
    // The task went in as the first message (here it gets the login hint as its answer).
    expect(r.text).toMatch(/❯ the task/);
    expect(JSON.parse(await readFile(join(cfgDir, ".claude.json"), "utf8")).hasCompletedOnboarding).toBe(true);
    expect(existsSync(join(agentHome, ".claude.json"))).toBe(false);
  }, 40_000);

  it("own install: a worker in a folder that nobody trusted gets only the folder question (the user's answer)", async () => {
    const home = await tmp("firstrun-home-");
    const wt = await tmp("firstrun-wt-");
    const accounts: AccountPaths = { root: join(home, "accounts"), defaultDir: join(home, ".claude"), defaultClaudeJson: join(home, ".claude.json") };
    const r0 = rec({ id: "w-1", repo: "/srv/ws/app", worktree: wt, cwd: wt });
    const prepared = await claudeRuntime.prepare(r0, { port: DEAD_PORT, workspaceDir: dirname(wt), accounts });
    const args = claudeRuntime.buildArgs({}, { prompt: "the task", settingsPath: prepared.settingsPath, cwd: wt });
    const r = await firstScreens(start(CLAUDE!, args, wt, { HOME: home, PATH: "/usr/bin:/bin", ...(prepared.env ?? {}) }));
    expect(r.seen, r.text).toEqual(["trust"]);
  }, 40_000);
});
