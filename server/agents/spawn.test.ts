import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgent, type SpawnDeps } from "./spawn.js";
import { SessionStore } from "./store.js";
import { EventHub, type ConsoleEvent } from "../events.js";
import { agentPrompt, widgetsPrompt } from "./argv.js";
import { resolveWidgetsDataDir } from "../widgets/paths.js";
import { codexRuntime } from "./runtimes/codex.js";
import { NO_MERGE_RULE, BRAIN_PROMPT_HEAD } from "../chief/brain/prompt.js";
import { queueAgentPrompt } from "../chief/queue/prompt.js";
import { remindAgentPrompt } from "../chief/remind/prompt.js";
import { RuleStore } from "../chief/brain/store.js";
import { CHIEF_PROMPT_REV, chiefCli, chiefPaths } from "../chief/paths.js";
import { mkdirSync, writeFileSync } from "node:fs";

const run = promisify(execFile);

async function setup() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "spawn-ws-"));
  const repo = join(workspaceDir, "myrepo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  const storeDir = await mkdtemp(join(tmpdir(), "spawn-store-"));
  const store = new SessionStore(storeDir);
  const hub = new EventHub();
  const events: ConsoleEvent[] = [];
  hub.subscribe((e) => events.push(e));
  type Spawned = { id: string; cwd: string; args: string[]; env?: Record<string, string> };
  const spawned: Spawned[] = [];
  const terminals = { spawn: (o: Spawned) => { spawned.push(o); }, kill: () => {} };
  const deps: SpawnDeps = {
    terminals: terminals as unknown as SpawnDeps["terminals"], store, hub,
    workspaceDir, worktreeRoot: join(workspaceDir, ".wt"), port: 3100,
  };
  return {
    deps, repo, store, storeDir, events, spawned,
    cleanup: async () => {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    },
  };
}

describe("spawnAgent", () => {
  it("records spawnedBy only when the request carries it", async () => {
    const t = await setup();
    try {
      const withBy = await spawnAgent(t.deps, { prompt: "x", spawnedBy: "lead-app-shop" });
      const without = await spawnAgent(t.deps, { prompt: "x" });
      if (!withBy.ok || !without.ok) throw new Error("spawn failed");
      expect((await t.store.load(withBy.id))!.spawnedBy).toBe("lead-app-shop");
      expect("spawnedBy" in (await t.store.load(without.id))!).toBe(false);
    } finally { await t.cleanup(); }
  });

  it("launches an issue agent: kind, issueId, label, and the issue system prompt", async () => {
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, {
        repo: t.repo, prompt: "Fix this issue", runtime: "claude",
        kind: "issue", issueId: "t42", label: "issue: login broken",
      });
      expect(r).toMatchObject({ ok: true, status: "running" });
      if (!r.ok) throw new Error("unreachable");
      const rec = await t.store.load(r.id);
      expect(rec).toMatchObject({ kind: "issue", issueId: "t42", label: "issue: login broken", runtime: "claude", repo: t.repo, baseBranch: "main" });
      const args = t.spawned[0].args;
      expect(args[args.indexOf("--append-system-prompt") + 1])
        .toBe(agentPrompt({ id: r.id, repo: t.repo, kind: "issue" }, resolveWidgetsDataDir()));
      expect(args[args.length - 1]).toBe("Fix this issue");
      expect(t.events).toContainEqual({ type: "agent-status", agentId: r.id, status: "running" });
    } finally { await t.cleanup(); }
  });

  it("keeps a normal agent free of kind/issueId and on the plain shared-docs prompt", async () => {
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      const rec = await t.store.load(r.id);
      expect(rec?.kind).toBeUndefined();
      expect(rec?.issueId).toBeUndefined();
      expect(rec?.label).toBe("do it");
      const args = t.spawned[0].args;
      expect(args[args.indexOf("--append-system-prompt") + 1])
        .toBe(agentPrompt({ id: r.id, repo: t.repo }, resolveWidgetsDataDir()));
    } finally { await t.cleanup(); }
  });

  it("gives a workspace agent the widgets prompt only", async () => {
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { prompt: "look around" });
      if (!r.ok) throw new Error(r.error);
      const args = t.spawned[0].args;
      expect(args[args.indexOf("--append-system-prompt") + 1])
        .toBe(widgetsPrompt(`${resolveWidgetsDataDir()}/${r.id}`));
    } finally { await t.cleanup(); }
  });

  it("gives a codex agent the same prompt through its AGENTS.md", async () => {
    const t = await setup();
    const prev = process.env.CODEX_EXECUTABLE;
    // Fail plugin registration fast instead of shelling out to the real CLI.
    process.env.CODEX_EXECUTABLE = `${t.deps.workspaceDir}/no-such-codex`;
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "x", runtime: "codex" });
      if (!r.ok) throw new Error(r.error);
      const home = t.spawned[0].env?.CODEX_HOME;
      expect(home).toBeTruthy();
      const md = await readFile(`${home}/AGENTS.md`, "utf8");
      expect(md).toContain(agentPrompt({ id: r.id, repo: t.repo }, resolveWidgetsDataDir()));
    } finally {
      if (prev === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = prev;
      await t.cleanup();
    }
  });

  it("model: one alias is stored and passed as --model; none: the setting (opus when not set); a bad one or a codex agent: 400 and no record", async () => {
    const t = await setup();
    try {
      const withModel = await spawnAgent(t.deps, { prompt: "x", model: " sonnet " });
      const without = await spawnAgent(t.deps, { prompt: "x", model: "" });
      vi.stubEnv("AGENT_MODEL", "haiku");
      const onSetting = await spawnAgent(t.deps, { prompt: "x" });
      vi.unstubAllEnvs();
      if (!withModel.ok || !without.ok || !onSetting.ok) throw new Error("spawn failed");
      expect((await t.store.load(withModel.id))!.model).toBe("sonnet");
      expect("model" in (await t.store.load(without.id))!).toBe(false);
      const args = (id: string) => t.spawned.find((x) => x.id === id)!.args;
      expect(args(withModel.id).slice(0, 2)).toEqual(["--model", "sonnet"]);
      expect(args(without.id).slice(0, 2)).toEqual(["--model", "opus"]);
      expect(args(onSetting.id).slice(0, 2)).toEqual(["--model", "haiku"]);
      for (const model of ["gpt-5", "claude-opus-5-5", 3]) {
        expect(await spawnAgent(t.deps, { prompt: "x", model })).toEqual({ ok: false, code: 400, error: "model must be one of fable, opus, sonnet, haiku" });
      }
      expect(await spawnAgent(t.deps, { prompt: "x", model: "haiku", runtime: "codex" })).toEqual({ ok: false, code: 400, error: "model is for a Claude agent only" });
      expect(await t.store.list()).toHaveLength(3);
    } finally { await t.cleanup(); }
  });
  it("rejects an unknown repo with 400 and leaves no record", async () => {
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: "/nope", prompt: "x" });
      expect(r).toEqual({ ok: false, code: 400, error: "unknown repo" });
      expect(await t.store.list()).toEqual([]);
    } finally { await t.cleanup(); }
  });
});

// Spec §5.2: with chiefActive() the agent env carries its identity and the
// record its prompt revision; flag off (or misconfigured) both stay as today.
describe("spawnAgent chief identity", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  function chiefOn() {
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
  }

  async function recordKeys(storeDir: string, id: string): Promise<string[]> {
    return Object.keys(JSON.parse(await readFile(join(storeDir, `${id}.json`), "utf8")));
  }

  it("flag off: no env for a default-account claude agent and no chiefRev key on the record", async () => {
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      expect(t.spawned[0].env).toBeUndefined();
      expect(await recordKeys(t.storeDir, r.id)).not.toContain("chiefRev");
    } finally { await t.cleanup(); }
  });

  it("flag on: env carries CHOIBOT_AGENT_ID/CHOIBOT_AGENT_PASS and the record chiefRev", async () => {
    chiefOn();
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      const rec = await t.store.load(r.id);
      if (!rec) throw new Error("no record");
      expect(t.spawned[0].env).toEqual({ CHOIBOT_AGENT_ID: r.id, CHOIBOT_AGENT_PASS: rec.hookToken });
      expect(rec.chiefRev).toBe(CHIEF_PROMPT_REV);
    } finally { await t.cleanup(); }
  });

  it("flag on: claude argv carries --system-prompt-snapshot off; flag off: it does not", async () => {
    const off = await setup();
    try {
      const r = await spawnAgent(off.deps, { repo: off.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      expect(off.spawned[0].args).not.toContain("--system-prompt-snapshot");
    } finally { await off.cleanup(); }
    chiefOn();
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      const a = t.spawned[0].args;
      expect(a).toContain("--system-prompt-snapshot");
      expect(a[a.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
      expect(a.indexOf("--system-prompt-snapshot")).toBe(a.indexOf("--dangerously-skip-permissions") + 1);
    } finally { await t.cleanup(); }
  });

  it("--append-system-prompt: flag on carries NO_MERGE_RULE; flag off equals agentPrompt(rec, root)", async () => {
    const promptOf = (a: string[]) => a[a.indexOf("--append-system-prompt") + 1];
    const off = await setup();
    try {
      const r = await spawnAgent(off.deps, { repo: off.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      const rec = await off.store.load(r.id);
      if (!rec) throw new Error("no record");
      expect(promptOf(off.spawned[0].args)).toBe(agentPrompt(rec, resolveWidgetsDataDir()));
    } finally { await off.cleanup(); }
    chiefOn();
    const on = await setup();
    try {
      const r = await spawnAgent(on.deps, { repo: on.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      expect(promptOf(on.spawned[0].args)).toContain(NO_MERGE_RULE);
    } finally { await on.cleanup(); }
  });

  async function brainDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "spawn-chief-"));
    vi.stubEnv("CHIEF_DATA_DIR", dir);
    const p = chiefPaths(dir);
    mkdirSync(p.brainDir, { recursive: true });
    const s = new RuleStore(p.rules);
    for (const [text, audience] of [["WORKERLINE", "workers"], ["MASTERLINE", "master"]] as const) {
      await s.add({ text, scope: { area: "*", audience }, kind: "preference", source: { origin: "panel" }, state: "active" });
    }
    return dir;
  }

  it("flag on: worker --append-system-prompt carries the brain (workers audience) after the merge rule", async () => {
    chiefOn();
    const dir = await brainDir();
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      const a = t.spawned[0].args;
      const sp = a[a.indexOf("--append-system-prompt") + 1];
      expect(sp).toContain(BRAIN_PROMPT_HEAD);
      expect(sp).toContain("WORKERLINE");
      expect(sp).not.toContain("MASTERLINE");
      expect(sp.indexOf(BRAIN_PROMPT_HEAD)).toBeGreaterThan(sp.indexOf(NO_MERGE_RULE));
    } finally { await t.cleanup(); await rm(dir, { recursive: true, force: true }); }
  });

  it("flag on: an unreadable rules file (a directory) still spawns, with no brain text", async () => {
    chiefOn();
    const dir = await mkdtemp(join(tmpdir(), "spawn-chief-"));
    vi.stubEnv("CHIEF_DATA_DIR", dir);
    mkdirSync(chiefPaths(dir).rules, { recursive: true });
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "do it" });
      if (!r.ok) throw new Error(r.error);
      const a = t.spawned[0].args;
      const sp = a[a.indexOf("--append-system-prompt") + 1];
      expect(sp).toContain(NO_MERGE_RULE);
      expect(sp).not.toContain(BRAIN_PROMPT_HEAD);
    } finally { await t.cleanup(); await rm(dir, { recursive: true, force: true }); }
  });

  it("flag on: a codex agent's AGENTS.md has the queue and reminder paragraphs, then the brain, after the merge rule", async () => {
    chiefOn();
    const dir = await brainDir();
    const t = await setup();
    const prev = process.env.CODEX_EXECUTABLE;
    process.env.CODEX_EXECUTABLE = `${t.deps.workspaceDir}/no-such-codex`;
    try {
      const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "x", runtime: "codex" });
      if (!r.ok) throw new Error(r.error);
      const md = await readFile(`${t.spawned[0].env?.CODEX_HOME}/AGENTS.md`, "utf8");
      expect(md).toContain(`${NO_MERGE_RULE}\n\n${queueAgentPrompt(chiefCli(process.cwd()))}\n\n${remindAgentPrompt(chiefCli(process.cwd()))}\n\n${BRAIN_PROMPT_HEAD}`);
      expect(md).toContain("WORKERLINE");
    } finally {
      if (prev === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = prev;
      await t.cleanup(); await rm(dir, { recursive: true, force: true });
    }
  });

  it("flag on but misconfigured (no CHIEF_CONSOLE_URL): as flag off", async () => {
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    const t = await setup();
    try {
      const r = await spawnAgent(t.deps, { prompt: "look around" });
      if (!r.ok) throw new Error(r.error);
      expect(t.spawned[0].env).toBeUndefined();
      expect(await recordKeys(t.storeDir, r.id)).not.toContain("chiefRev");
    } finally { await t.cleanup(); }
  });

  // CODEX_EXECUTABLE as in api.test.ts: prepare() writes the whole CODEX_HOME,
  // but its `codex plugin add` calls fail fast instead of running the real CLI.
  describe("codex", () => {
    it("flag on: the identity is merged into the CODEX_HOME env, not replacing it", async () => {
      vi.stubEnv("CODEX_EXECUTABLE", "/nonexistent/bin/codex");
      chiefOn();
      const t = await setup();
      try {
        const r = await spawnAgent(t.deps, { repo: t.repo, prompt: "x", runtime: "codex" });
        if (!r.ok) throw new Error(r.error);
        const rec = await t.store.load(r.id);
        const env = t.spawned[0].env;
        expect(env?.CODEX_HOME).toBeTruthy();
        expect(env?.CHOIBOT_AGENT_ID).toBe(r.id);
        expect(env?.CHOIBOT_AGENT_PASS).toBe(rec?.hookToken);
        expect(t.spawned[0].args).not.toContain("--system-prompt-snapshot");
      } finally { await t.cleanup(); }
    });

    it("config.toml is byte-identical with the flag off and on (identity travels only in the env)", async () => {
      vi.stubEnv("CODEX_EXECUTABLE", "/nonexistent/bin/codex");
      const dir = await mkdtemp(join(tmpdir(), "spawn-codex-toml-"));
      try {
        const rec = {
          id: "cx1", label: "cx", repo: "/r", worktree: dir, branch: "b", baseBranch: "main",
          sessionId: null, hookToken: "tok-cx1", status: "idle" as const, createdAt: 1, cwd: dir,
          runtime: "codex" as const,
        };
        const ctx = { port: 3100, workspaceDir: dir, systemPrompt: "SP" };
        const off = await codexRuntime.prepare(rec, ctx);
        const offToml = await readFile(join(off.env!.CODEX_HOME, "config.toml"));
        chiefOn();
        const on = await codexRuntime.prepare(rec, ctx);
        expect(on.env!.CODEX_HOME).toBe(off.env!.CODEX_HOME);
        const onToml = await readFile(join(on.env!.CODEX_HOME, "config.toml"));
        expect(onToml.equals(offToml)).toBe(true);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  });
});
