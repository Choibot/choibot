// Design B of strong protection at spawn: with the helper, a new agent of a repo gets its own clone
// (cloneForAgent, faked here: it needs root), at the start commit of the console's repo, and its
// hook settings file goes to AGENT_HOME_ROOT/settings; the console's repo gets no branch and no
// worktree. Basic mode, and strong mode with no helper, make a worktree as before.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloned: { repo: string; id: string; branch: string; sha: string }[] = [];
const removed: string[] = [];
vi.mock("./agentclone.js", async (orig) => {
  const real = await orig<typeof import("./agentclone.js")>();
  return {
    ...real,
    cloneForAgent: vi.fn(async (_x: unknown, f: { clones: string }, repo: string, id: string, branch: string, sha: string) => {
      cloned.push({ repo, id, branch, sha });
      const dest = join(f.clones, id);
      mkdirSync(dest);
      return dest;
    }),
    removeClone: vi.fn(async (_x: unknown, id: string) => { removed.push(id); }),
  };
});

const { setCloneExec } = await import("./agentclone.js");
const { setAgentHelper } = await import("../chief/hardened.js");
const { spawnAgent } = await import("./spawn.js");
const { SessionStore } = await import("./store.js");
const { EventHub } = await import("../events.js");

const X = { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 };
let dir = "";
let repo = "";
let homes = "";
const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-C", repo, ...a], { encoding: "utf8" }).trim();

beforeEach(() => {
  cloned.length = 0;
  removed.length = 0;
  dir = mkdtempSync(join(tmpdir(), "spawn-clone-"));
  repo = join(dir, "ws", "myrepo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("commit", "-q", "--allow-empty", "-m", "init");
  homes = join(dir, "homes");
  for (const d of ["clones", "uploads", "settings"]) mkdirSync(join(homes, d), { recursive: true, mode: 0o750 });
});
afterEach(() => { setCloneExec(null); setAgentHelper(false); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function deps() {
  const spawned: { id: string; cwd: string; args: string[] }[] = [];
  const store = new SessionStore(join(dir, "store"));
  return {
    spawned, store,
    d: { terminals: { spawn: (o: { id: string; cwd: string; args: string[] }) => { spawned.push(o); }, kill: () => {} } as never, store, hub: new EventHub(), workspaceDir: join(dir, "ws"), worktreeRoot: join(dir, "wt"), port: 3100 },
  };
}

describe("spawn with design B", () => {
  it("strong protection with the helper: the agent's own clone at the console's start commit; settings outside the clone; nothing new in the console's repo", async () => {
    vi.stubEnv("AGENT_HOME_ROOT", homes);
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    vi.stubEnv("CHIEF_CONSOLE_URL", "https://c.example");
    vi.stubEnv("CHIEF_AGENT_UID", "4242");
    setCloneExec(X);
    setAgentHelper(true); // the probe passed (index.ts)
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", join(homes, "agent", ".claude"));
    const t = deps();
    const r = await spawnAgent(t.d, { repo, prompt: "hi", runtime: "claude" });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("unreachable");
    const rec = (await t.store.load(r.id))!;
    expect(cloned).toEqual([{ repo, id: r.id, branch: `agent/${r.id.slice(0, 8)}`, sha: g("rev-parse", "main") }]);
    expect(rec).toMatchObject({ worktree: join(homes, "clones", r.id), cwd: join(homes, "clones", r.id), branch: `agent/${r.id.slice(0, 8)}`, baseBranch: "main", clone: true });
    expect(t.spawned[0].cwd).toBe(join(homes, "clones", r.id));
    const settings = t.spawned[0].args[t.spawned[0].args.indexOf("--settings") + 1];
    expect(settings).toBe(join(homes, "settings", `${r.id}.json`));
    expect(JSON.parse(readFileSync(settings, "utf8"))).toHaveProperty("hooks");
    expect(existsSync(join(homes, "clones", r.id, ".choibot-hooks.json"))).toBe(false);
    expect(existsSync(join(homes, "clones", r.id, ".choibot-hooks.json"))).toBe(false);
    expect(g("branch", "--format=%(refname:short)")).toBe("main");
    expect(g("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    // Discard: the console's files of the agent go, then the clone, through the helper (faked).
    mkdirSync(join(homes, "uploads", r.id), { mode: 0o750 });
    writeFileSync(join(homes, "uploads", r.id, "shot.png"), "png");
    const { discard } = await import("./reconcile.js");
    await discard(rec);
    expect(removed).toEqual([r.id]);
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(join(homes, "uploads", r.id))).toBe(false);
  });

  it("strong protection: a Codex agent of a repo is refused before any clone", async () => {
    vi.stubEnv("AGENT_HOME_ROOT", homes);
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    vi.stubEnv("CHIEF_CONSOLE_URL", "https://c.example");
    vi.stubEnv("CHIEF_AGENT_UID", "4242");
    setCloneExec(X);
    setAgentHelper(true); // the probe passed (index.ts)
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", join(homes, "agent", ".claude"));
    const t = deps();
    const r = await spawnAgent(t.d, { repo, prompt: "hi", runtime: "codex" });
    expect(r).toEqual({ ok: false, code: 400, error: "With strong protection, only a Claude agent can work on a repo in this version." });
    expect(cloned).toEqual([]);
  });

  it("strong protection: a settings folder that is not the console's stops the spawn", async () => {
    vi.stubEnv("AGENT_HOME_ROOT", homes);
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    vi.stubEnv("CHIEF_CONSOLE_URL", "https://c.example");
    vi.stubEnv("CHIEF_AGENT_UID", "4242");
    setCloneExec(X);
    setAgentHelper(true); // the probe passed (index.ts)
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", join(homes, "agent", ".claude"));
    rmSync(join(homes, "settings"), { recursive: true });
    mkdirSync(join(homes, "settings"), { mode: 0o770 });
    const t = deps();
    const r = await spawnAgent(t.d, { repo, prompt: "hi", runtime: "claude" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/hook settings folder is refused/) });
    expect(t.spawned).toEqual([]);
    // The clean-up of the failed launch removes the clone, as the agent.
    expect(removed).toEqual([cloned[0].id]);
  });

  it("basic mode (and strong with no helper): a worktree in the worktree root, as before; no clone", async () => {
    setCloneExec(X); // even when set, basic mode has no AGENT_HOME_ROOT: never a clone
    const t = deps();
    const r = await spawnAgent(t.d, { repo, prompt: "hi", runtime: "claude" });
    if (!r.ok) throw new Error(r.error);
    const rec = (await t.store.load(r.id))!;
    expect(cloned).toEqual([]);
    expect(rec.clone).toBeUndefined();
    expect(rec.worktree.startsWith(join(dir, "wt") + "/")).toBe(true);
    expect(existsSync(join(rec.worktree, ".git"))).toBe(true);
    expect(g("branch", "--format=%(refname:short)").split("\n").sort()).toEqual([`agent/${r.id.slice(0, 8)}`, "main"]);
  });
});
