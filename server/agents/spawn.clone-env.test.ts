// The helper's repo-clone verb needs the agent's CLAUDE_CONFIG_DIR (agent_claude in
// deploy/choibot-agent-exec: "repo-clone: CLAUDE_CONFIG_DIR is not set" when it is missing; it writes
// the clone folder's trust key into that config). Here the real cloneForAgent runs and only the
// sudo call is faked, so the env the helper gets is the one the console really sends: the agent's
// config dir, the same value the spawn verb of that agent gets, never the console's own.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCloneExec, type Run } from "./agentclone.js";
import { setAgentHelper } from "../chief/hardened.js";
import { spawnAgent } from "./spawn.js";
import { SessionStore } from "./store.js";
import { EventHub } from "../events.js";

const X = { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 };
let dir = "";
let repo = "";
let homes = "";
const calls: { verb: string; rest: string[]; env: NodeJS.ProcessEnv }[] = [];

// The sudo call of a helper verb: argv is [-n, -u, #uid, helper, verb, ...rest]. repo-clone makes
// the clone folder as the helper does; the other verbs answer with nothing.
const fakeRun: Run = (_bin, args, o, cb) => {
  const verb = args[4];
  const rest = args.slice(5);
  calls.push({ verb, rest, env: o.env });
  if (verb === "repo-clone") mkdirSync(join(homes, "clones", rest[1]));
  cb(null, Buffer.alloc(0), Buffer.alloc(0));
  return undefined;
};

beforeEach(() => {
  calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "spawn-clone-env-"));
  repo = join(dir, "ws", "myrepo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  homes = join(dir, "homes");
  for (const d of ["clones", "uploads", "settings"]) mkdirSync(join(homes, d), { recursive: true, mode: 0o750 });
  vi.stubEnv("AGENT_HOME_ROOT", homes);
  vi.stubEnv("CHIEF_ENABLED", "1");
  vi.stubEnv("CHIEF_USER_AUTH", "log");
  vi.stubEnv("CHIEF_CONSOLE_URL", "https://c.example");
  vi.stubEnv("CHIEF_AGENT_UID", "4242");
  // The console's own config dir: never the agent's.
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "console", ".claude"));
  setCloneExec(X, fakeRun);
  setAgentHelper(true); // the probe passed (index.ts)
});
afterEach(() => { setCloneExec(null); setAgentHelper(false); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function deps() {
  const spawned: { id: string; env?: Record<string, string> }[] = [];
  return {
    spawned,
    d: { terminals: { spawn: (o: { id: string; env?: Record<string, string> }) => { spawned.push(o); }, kill: () => {} } as never, store: new SessionStore(join(dir, "store")), hub: new EventHub(), workspaceDir: join(dir, "ws"), worktreeRoot: join(dir, "wt"), port: 3100 },
  };
}

describe("spawn of an agent on a repo with strong protection: the env of repo-clone", () => {
  it("repo-clone gets the agent's CLAUDE_CONFIG_DIR, the same value as the agent's spawn", async () => {
    const agentDir = join(homes, "agent", ".claude");
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", agentDir);
    const t = deps();
    const r = await spawnAgent(t.d, { repo, prompt: "hi", runtime: "claude" });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("unreachable");
    const clone = calls.filter((c) => c.verb === "repo-clone");
    expect(clone).toHaveLength(1);
    expect(clone[0].rest.slice(0, 2)).toEqual([repo, r.id]);
    expect(clone[0].env.CLAUDE_CONFIG_DIR).toBe(agentDir);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].env?.CLAUDE_CONFIG_DIR).toBe(agentDir);
  });

  it("no agent config dir: the spawn stops before any helper call, with the reason", async () => {
    vi.stubEnv("AGENT_CLAUDE_CONFIG_DIR", "");
    const t = deps();
    const r = await spawnAgent(t.d, { repo, prompt: "hi", runtime: "claude" });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/AGENT_CLAUDE_CONFIG_DIR/);
    expect(calls.filter((c) => c.verb === "repo-clone")).toEqual([]);
    expect(t.spawned).toEqual([]);
  });
});
