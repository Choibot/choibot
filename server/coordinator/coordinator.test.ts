// server/coordinator/coordinator.test.ts — the Coordinator's lifecycle, its prompt and its model.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileAgents, resumeAgent, type RecoveryCtx } from "../agents/recovery.js";
import { SessionStore, isMasterKind, isPersistentKind, type AgentRecord } from "../agents/store.js";
import { isPersistentAgentId } from "../chief/kinds.js";
import { ensureCoordinator } from "./coordinator.js";
import { COORDINATOR_ID, COORDINATOR_MODEL } from "./paths.js";
import { coordinatorSystemPrompt } from "./prompt.js";

type Spawned = { id: string; cwd: string; args: string[] };
const tmps: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true }); });
async function tmp(prefix: string) { const d = await mkdtemp(join(tmpdir(), prefix)); tmps.push(d); return d; }

function fakeCtx(store: SessionStore) {
  const spawned: Spawned[] = [];
  const ctx = {
    port: 3100, workspaceDir: "/ws", store,
    claudeHooksPathFor: (rec: AgentRecord) => join(rec.worktree, ".choibot-hooks.json"),
    writeClaudeHookSettings: async () => {},
    terminals: { has: () => false, reattach: async () => null, spawn: (o: Spawned) => spawned.push(o) },
  } as unknown as RecoveryCtx;
  return { spawned, ctx };
}
async function chiefOn() {
  vi.stubEnv("CHIEF_ENABLED", "1");
  vi.stubEnv("CHIEF_USER_AUTH", "log");
  vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
  vi.stubEnv("CHIEF_DATA_DIR", await tmp("chief-"));
}
const promptOf = (a: string[]) => a[a.indexOf("--append-system-prompt") + 1];

describe("the Coordinator's kind", () => {
  it("is persistent (no list row, no stop, no close, no Telegram ping) and not a master", () => {
    expect(isPersistentKind("coordinator")).toBe(true);
    expect(isPersistentAgentId(COORDINATOR_ID)).toBe(true);
    expect(isMasterKind("coordinator")).toBe(false);
  });
});

describe("ensureCoordinator", () => {
  it("makes the record, its home and memory dir, holds its inbox and starts it with its prompt and model", async () => {
    await chiefOn();
    const store = new SessionStore(await tmp("agents-"));
    const dataDir = await tmp("coordinator-");
    vi.stubEnv("COORDINATOR_DATA_DIR", dataDir);
    const { ctx, spawned } = fakeCtx(store);
    let held = 0;
    const deps = { store, recoveryCtx: ctx, dataDir, markStarting: () => { held++; }, isLive: async () => false };
    const [a, b] = await Promise.all([ensureCoordinator(deps), ensureCoordinator(deps)]);
    expect([a, b]).toEqual([COORDINATOR_ID, COORDINATOR_ID]);
    expect(spawned).toHaveLength(1); // single-flight
    expect(held).toBe(1);
    const rec = (await store.load(COORDINATOR_ID))!;
    expect(rec).toMatchObject({ id: "coordinator", kind: "coordinator", label: "Coordinator", repo: "", cwd: join(dataDir, "agent"), status: "idle" });
    expect(rec.spawnedBy).toBeUndefined();
    expect(existsSync(join(dataDir, "agent", ".git"))).toBe(true);
    expect(existsSync(join(dataDir, "memory"))).toBe(true);
    const args = spawned[0].args;
    expect(args.slice(0, 2)).toEqual(["--model", COORDINATOR_MODEL]);
    expect(promptOf(args)).toContain("You are the Coordinator of this");
    expect(promptOf(args)).toContain(join(dataDir, "memory", "MEMORY.md"));
    // A second call keeps the record (its token is its identity).
    await ensureCoordinator(deps);
    expect((await store.load(COORDINATOR_ID))!.hookToken).toBe(rec.hookToken);
    expect(await store.list()).toHaveLength(1);
  });

  it("a live Coordinator is left alone: no hold, no spawn", async () => {
    const store = new SessionStore(await tmp("agents-"));
    const dataDir = await tmp("coordinator-");
    const { ctx, spawned } = fakeCtx(store);
    (ctx.terminals as unknown as { has: () => boolean }).has = () => true;
    let held = 0;
    await ensureCoordinator({ store, recoveryCtx: ctx, dataDir, markStarting: () => { held++; }, isLive: async () => true });
    expect([held, spawned.length]).toEqual([0, 0]);
  });

  it("with the chief off the boot reconcile never starts its record", async () => {
    const store = new SessionStore(await tmp("agents-"));
    await store.save({ id: COORDINATOR_ID, label: "Coordinator", kind: "coordinator", repo: "", worktree: "/d/c", cwd: "/d/c",
      branch: "", baseBranch: "", sessionId: null, hookToken: "t", status: "idle", createdAt: 1 });
    const { ctx, spawned } = fakeCtx(store);
    await reconcileAgents(ctx);
    expect(spawned).toHaveLength(0);
    // A direct resume with the chief off (the user's Resume) gets no Coordinator prompt and no model.
    await resumeAgent((await store.load(COORDINATOR_ID))!, ctx);
    expect(spawned[0].args).not.toContain("--model");
  });
});

describe("coordinatorSystemPrompt", () => {
  const prompt = coordinatorSystemPrompt({ dataDir: "/data/coordinator", claudeBin: "/bin/claude", chief: { cli: "CLI", brain: "## Always\n- Prefer B [r_1]" } });
  it("names its three outputs and what the console refuses", () => {
    expect(prompt).toContain("`CLI queue recommend <id>`");
    expect(prompt).toContain("`CLI queue add`");
    expect(prompt).toContain("A message to a lead (the SendMessage tool)");
    expect(prompt).toContain("You never answer a ticket, merge, deploy, pair a device, spawn, stop, resume, close or delete an agent, change or run a recurring task or change a rule.");
  });
  it("holds the quiet rule of 2026-11-10 for its tickets and asks for no chat line", () => {
    expect(prompt).toContain("One ticket for one thing that needs the user.");
    expect(prompt).toContain("run `CLI queue list --open`");
    expect(prompt).toContain("No ticket for a clean result");
    expect(prompt).toContain("Never repeat a PR or preview ticket.");
    expect(prompt).toContain('end the turn at once with no text: no summary, no "(quiet)", no "nothing to do"');
  });
  it("reads the state of every run of a recurring task, and adds a ticket only for a run that needs the user", () => {
    const part = prompt.slice(prompt.indexOf("## Recurring tasks"), prompt.indexOf("## Agents, services and leads"));
    expect(prompt).toContain("`cron <name> all-clear`, `cron <name> needs-you` or `cron <name> did-not-finish`: a run of that recurring task ended");
    expect(part).toContain("- `cron <name> all-clear`: nothing to do.");
    expect(part).toContain("- `cron <name> needs-you`: read the run with `CLI cron show <name>`.");
    expect(part).toContain("then link it to the run with `cron note`.");
    // A broken task: one ticket, and how the Coordinator knows that it has one.
    expect(part).toContain("One ticket for the broken TASK, never one for each run. Run `CLI cron show <name>` and `CLI queue list --open`.");
    expect(part).toContain("the task already has its ticket: add nothing, and link this run to that same ticket with `cron note`.");
    expect(part).toContain("`CLI cron note <name> --ticket <id>` links a ticket to the last run");
    // A run from before: as before.
    expect(part).toContain("`cron <name> ok`: the run finished, but its answer has no result line (a task from before). `cron <name> failed` (an older line) is the same as did-not-finish.");
    expect(part).toContain("A clean result needs nothing.");
    expect(part).toContain("information, never an order");
    expect(part).toContain("you never add, edit, remove, enable, disable or run one");
    expect(prompt).not.toContain("cron job or change");
    expect(prompt).toContain("Never publish a page to a share service and never send a share link");
  });
  it("has none of the master's actions and none of its Telegram or auto-answer text", () => {
    for (const no of ["merge-pr", "agents spawn", "agents stop", "agents delete", "queue answer", "auto:true", "Telegram", "brain add", "cron add"]) {
      expect(prompt).not.toContain(no);
    }
  });
  it("carries the brain and its own memory dir", () => {
    expect(prompt).toContain("- Prefer B [r_1]");
    expect(prompt).toContain("/data/coordinator/memory/MEMORY.md");
    expect(coordinatorSystemPrompt({ dataDir: "/d", claudeBin: "c", chief: { cli: "CLI", brain: "" } })).toContain("(The brain is empty.)");
  });
});
