// Flag-off golden tests: with CHIEF_ENABLED off, prompts and argv must stay
// byte-identical to the fixtures captured by scripts/chief-golden.ts.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeRuntime } from "../agents/runtimes/claude.js";
import { spawnAgent, type SpawnDeps } from "../agents/spawn.js";
import { resumeAgent, type RecoveryCtx } from "../agents/recovery.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { EventHub } from "../events.js";
import { resolveWidgetsDataDir } from "../widgets/paths.js";
import { agentPrompt, buildClaudeArgs } from "../agents/argv.js";
import { fleetMasterSystemPrompt } from "../master/prompt.js";
import { chiefPromptFor } from "./brain/prompt.js";
import { chiefCronArgs } from "../../bin/lib/chief-cron.mjs";
import Fastify from "fastify";
import { runRemind } from "../../bin/lib/remind.js";
import { fetchReminders, remindersEnabled } from "../../src/lib/reminders.js";
import { makeChiefCore } from "./boot.js";
import { chiefFlag } from "./paths.js";
import { ReminderDeliverer } from "./remind/deliver.js";
import { setupReminders, type SetupRemindersDeps } from "./remind/setup.js";

const golden = (name: string) => readFileSync(join(__dirname, "testdata", "golden", name), "utf8");
const REC = { id: "11111111-2222-3333-4444-555555555555", repo: "/ws/app-shop" };
const FLEET = { repoDir: "/repo", masterDataDir: "/data/master", claudeBin: "/bin/claude", cronDataDir: "/data/cron", timeZone: "UTC" };

describe("flag-off golden fixtures", () => {
  it("worker agent prompt", () => {
    expect(agentPrompt(REC, "/widgets")).toBe(golden("agent-prompt-worker.txt"));
  });
  it("worker agent prompt with chief undefined", () => {
    expect(agentPrompt(REC, "/widgets", undefined)).toBe(golden("agent-prompt-worker.txt"));
  });
  it("issue agent prompt", () => {
    expect(agentPrompt({ ...REC, kind: "issue" }, "/widgets")).toBe(golden("agent-prompt-issue.txt"));
  });
  it("workspace agent prompt", () => {
    expect(agentPrompt({ ...REC, repo: "" }, "/widgets")).toBe(golden("agent-prompt-workspace.txt"));
  });
  it("fleet master prompt", () => {
    expect(fleetMasterSystemPrompt(FLEET)).toBe(golden("fleet-master-prompt.txt"));
  });
  it("fleet master prompt with chief undefined", () => {
    expect(fleetMasterSystemPrompt({ ...FLEET, chief: undefined })).toBe(golden("fleet-master-prompt.txt"));
  });
  // Review Focus 4 (Task 2c-7): AGENT_HOME_ROOT alone, or a rollback that
  // removed CHIEF_AGENT_UID, leaves the master prompt golden.
  it("master prompt with AGENT_HOME_ROOT set but not hardened", () => {
    const chief = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
    for (const env of [{ AGENT_HOME_ROOT: "/h" }, { ...chief, AGENT_HOME_ROOT: "/h" }, { ...chief, AGENT_HOME_ROOT: "/h", CHIEF_AGENT_UID: "0" }]) {
      expect(fleetMasterSystemPrompt({ ...FLEET, env })).toBe(golden("fleet-master-prompt.txt"));
    }
  });
  it("claude argv", () => {
    expect({
      full: buildClaudeArgs({ systemPrompt: "SP" }, { settingsPath: "/s.json", resume: "sid-1", prompt: "go" }),
      bare: buildClaudeArgs({}, {}),
    }).toEqual(JSON.parse(golden("claude-args.json")));
  });
});

// Flag off through the real launch paths: the prompt is today's agentPrompt,
// no --system-prompt-snapshot, and the env is the adapter env unchanged.
describe("flag-off spawn and resume", () => {
  type Spawned = { id: string; cwd: string; args: string[]; env?: Record<string, string> };
  const flagValue = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

  it("spawn and resume: argv prompt is agentPrompt(rec, root), no snapshot flag, env undefined", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "flagoff-ws-"));
    const storeDir = await mkdtemp(join(tmpdir(), "flagoff-store-"));
    try {
      const store = new SessionStore(storeDir);
      const spawned: Spawned[] = [];
      const deps: SpawnDeps = {
        terminals: { spawn: (o: Spawned) => { spawned.push(o); }, kill: () => {} } as unknown as SpawnDeps["terminals"],
        store, hub: new EventHub(), workspaceDir, worktreeRoot: join(workspaceDir, ".wt"), port: 3100,
      };
      const r = await spawnAgent(deps, { prompt: "look around" });
      if (!r.ok) throw new Error(r.error);
      const rec = (await store.load(r.id)) as AgentRecord;
      const want = agentPrompt(rec, resolveWidgetsDataDir());
      expect(flagValue(spawned[0].args, "--append-system-prompt")).toBe(want);
      expect(spawned[0].args).not.toContain("--system-prompt-snapshot");
      expect(spawned[0].env).toBeUndefined();

      const resumed: Spawned[] = [];
      const ctx = {
        port: 3100, workspaceDir,
        claudeHooksPathFor: () => join(storeDir, "h.json"),
        writeClaudeHookSettings: async () => {},
        store: { list: async () => [rec], patch: async () => {} },
        terminals: { has: () => false, reattach: async () => null, spawn: (o: Spawned) => { resumed.push(o); } },
      } as unknown as RecoveryCtx;
      await resumeAgent(rec, ctx);
      expect(flagValue(resumed[0].args, "--append-system-prompt")).toBe(want);
      expect(resumed[0].args).not.toContain("--system-prompt-snapshot");
      expect(resumed[0].env).toBeUndefined();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("chiefPromptFor is undefined, so both prompts stay golden", async () => {
    for (const kind of [undefined, "fleet-master"]) {
      expect(await chiefPromptFor(kind, { env: {}, repoDir: "/repo" })).toBeUndefined();
    }
  });

  it("cron runner adds no chief args", () => {
    expect(chiefCronArgs({})).toEqual([]);
  });
});

// Task 3-6: the resumed master goes through the async masterPreset(rec, chief).
// Flag off they stay golden; flag on they equal the direct prompt builders.
describe("resumed master presets (async masterPreset)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const resumePrompt = async (id: "fleet-master"): Promise<string> => {
    const rec = { id, label: id, repo: "", worktree: `/d/${id}`, cwd: `/d/${id}`, kind: id, createdAt: 1, hookToken: "t" } as AgentRecord;
    const spawned: { args: string[] }[] = [];
    const ctx = {
      port: 3100, workspaceDir: "/ws",
      claudeHooksPathFor: () => "/tmp/h.json", writeClaudeHookSettings: async () => {},
      store: { list: async () => [rec], patch: async () => {} },
      terminals: { has: () => false, reattach: async () => null, spawn: (o: { args: string[] }) => { spawned.push(o); } },
    } as unknown as RecoveryCtx;
    await resumeAgent(rec, ctx);
    const a = spawned[0].args;
    return a[a.indexOf("--append-system-prompt") + 1];
  };
  const pin = () => {
    vi.spyOn(process, "cwd").mockReturnValue("/repo");
    vi.stubEnv("MASTER_DATA_DIR", "/data/master");
    vi.stubEnv("CRON_DATA_DIR", "/data/cron");
    vi.stubEnv("TZ", "UTC");
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/bin/claude");
  };
  it("flag off: equals the golden file", async () => {
    pin();
    expect(await resumePrompt("fleet-master")).toBe(golden("fleet-master-prompt.txt"));
  });
  it("flag on: equals the direct builder with the chief options", async () => {
    pin();
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
    vi.stubEnv("CHIEF_DATA_DIR", "/nonexistent-chief");
    const chief = (await chiefPromptFor("fleet-master", { repoDir: "/repo" }))!;
    expect(await resumePrompt("fleet-master")).toBe(fleetMasterSystemPrompt({ ...FLEET, claudeBin: claudeRuntime.bin(), chief }));
  });
});

// Reminders exist only with the chief on: server/index.ts calls
// registerRemindApi and starts the reminder timers inside its `if (chief)`
// block, so flag off the routes are Next's 404, the CLI says the feature is
// off, and the Agents list never asks (the Queue fetch said "off").
describe("flag-off reminders", () => {
  // index.ts's own wiring: `chief` is chiefFlag ? makeChiefCore(...) : undefined,
  // then one setupReminders(app, chief, …) call for the routes and the deliverer.
  const unused = (): never => { throw new Error("not called"); };
  const deps: SetupRemindersDeps = {
    agents: { load: async () => null, exists: async () => false },
    deliverer: {
      composer: { inputInternal: unused }, inboxFor: () => undefined, isLive: unused, resume: unused,
      resumeClosed: unused, reopen: unused,
      io: { lastInputAt: () => undefined, lastOutputAt: () => undefined }, hub: new EventHub(),
    },
  };
  const ROUTES = [["GET", "/api/reminders"], ["POST", "/api/reminders"], ["POST", "/api/reminders/r_aaaaaaaa/cancel"]] as const;
  it("setupReminders with the flag-off core (none) registers no route and makes no deliverer", async () => {
    const env = {};
    const chief = chiefFlag(env) ? makeChiefCore(env, { agents: deps.agents }) : undefined;
    const app = Fastify();
    try {
      expect(setupReminders(app, chief, deps)).toBeUndefined();
      for (const [method, url] of ROUTES) expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("control: the same call with the flag on registers the routes and makes the deliverer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flagoff-remind-"));
    const env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_DATA_DIR: dir };
    const chief = chiefFlag(env) ? makeChiefCore(env, { agents: deps.agents }) : undefined;
    const app = Fastify();
    try {
      expect(setupReminders(app, chief, deps)).toBeInstanceOf(ReminderDeliverer);
      expect((await app.inject({ method: "GET", url: "/api/reminders" })).statusCode).toBe(200);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("the CLI says reminders are off", async () => {
    const err: string[] = [];
    const fetch = vi.fn(async () => new Response("<!DOCTYPE html>", { status: 404 })) as unknown as typeof globalThis.fetch;
    const code = await runRemind("add", [], {
      fetch, out: () => {}, err: (s) => err.push(s), flags: { in: "1h", text: "t" }, stderrIsTTY: false, readFile: () => null,
      env: { PORT: "4321", CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p" },
    });
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/reminders are off/);
  });
  it("the Agents list asks only while the queue is on (flag off: no request, no badge)", async () => {
    expect(remindersEnabled("off")).toBe(false);
    expect(remindersEnabled("loading")).toBe(false);
    const fetch = vi.fn(async () => new Response("<!DOCTYPE html>", { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await fetchReminders({ fetch, storage: null })).toEqual({ state: "off" });
  });
});
