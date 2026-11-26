import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFleetMaster, ensureFleetMasterAtBoot } from "./master.js";
import { FLEET_MASTER_ID } from "./paths.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import type { RecoveryCtx } from "../agents/recovery.js";

type Spawned = { id: string; cwd: string; args: string[] };
const tmps: string[] = [];
afterEach(async () => { while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true }); });
async function tmp(prefix: string) { const d = await mkdtemp(join(tmpdir(), prefix)); tmps.push(d); return d; }

// Same fake as server/cron/master.test.ts, with a REAL SessionStore.
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

describe("ensureFleetMaster", () => {
  it("creates the record, the agent git repo and the memory dir, then resumes it in its cwd", async () => {
    const store = new SessionStore(await tmp("agents-"));
    const masterDataDir = await tmp("master-");
    const { ctx, spawned } = fakeCtx(store);
    expect(await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir })).toBe(FLEET_MASTER_ID);
    const rec = await store.load(FLEET_MASTER_ID);
    expect(rec).toMatchObject({
      id: "fleet-master", kind: "fleet-master", label: "Master", repo: "",
      cwd: join(masterDataDir, "agent"), worktree: join(masterDataDir, "agent"), status: "idle",
    });
    expect(rec!.hookToken).toBeTruthy();
    expect(existsSync(join(masterDataDir, "agent", ".git"))).toBe(true);
    expect(existsSync(join(masterDataDir, "memory"))).toBe(true);
    expect(spawned.map((s) => [s.id, s.cwd])).toEqual([["fleet-master", join(masterDataDir, "agent")]]);
  });

  it("is idempotent and single-flights concurrent calls", async () => {
    const store = new SessionStore(await tmp("agents-"));
    const masterDataDir = await tmp("master-");
    const { ctx, spawned } = fakeCtx(store);
    const [a, b] = await Promise.all([
      ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir }),
      ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir }),
    ]);
    expect([a, b]).toEqual([FLEET_MASTER_ID, FLEET_MASTER_ID]);
    expect(spawned).toHaveLength(1);
    const first = await store.load(FLEET_MASTER_ID);
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir });
    expect(await store.list()).toHaveLength(1);
    expect((await store.load(FLEET_MASTER_ID))!.hookToken).toBe(first!.hookToken);
  });
});

describe("ensureFleetMasterAtBoot", () => {
  it("never creates the master", async () => {
    const store = new SessionStore(await tmp("agents-"));
    const { ctx, spawned } = fakeCtx(store);
    expect(await ensureFleetMasterAtBoot({ store, recoveryCtx: ctx, masterDataDir: await tmp("master-") })).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(spawned).toEqual([]);
  });
  it("repairs an existing master's home", async () => {
    const store = new SessionStore(await tmp("agents-"));
    const masterDataDir = await tmp("master-");
    const { ctx } = fakeCtx(store);
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir });
    await rm(join(masterDataDir, "memory"), { recursive: true });
    expect(await ensureFleetMasterAtBoot({ store, recoveryCtx: ctx, masterDataDir })).toBe(FLEET_MASTER_ID);
    expect(existsSync(join(masterDataDir, "memory"))).toBe(true);
  });
});

// Task 2c-7: the fleet master's home in AGENT_HOME_ROOT (hardened only).
describe("ensureFleetMaster homes", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  const mode = async (p: string) => (await stat(p)).mode & 0o7777;
  async function setup() {
    const store = new SessionStore(await tmp("agents-"));
    const masterDataDir = await tmp("master-");
    await mkdir(join(masterDataDir, "memory"));
    await writeFile(join(masterDataDir, "memory", "MEMORY.md"), "- [pref](pref.md)\n");
    const root = await tmp("homes-");
    return { store, masterDataDir, root, ...fakeCtx(store) };
  }

  it("hardened: creates the record in <root>/fleet-master/agent, copies the memory, modes 2770/0660 under umask 022", async () => {
    const { store, masterDataDir, root, ctx, spawned } = await setup();
    const env = { ...HARDENED, AGENT_HOME_ROOT: root };
    const old = process.umask(0o022);
    try {
      await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env });
    } finally { process.umask(old); }
    const agentDir = join(root, "fleet-master", "agent");
    expect(await store.load(FLEET_MASTER_ID)).toMatchObject({ cwd: agentDir, worktree: agentDir });
    expect(spawned.map((s) => s.cwd)).toEqual([agentDir]);
    expect(await readFile(join(root, "fleet-master", "memory", "MEMORY.md"), "utf8")).toBe("- [pref](pref.md)\n");
    // Ruling 2c-7-c: the home dir 2750 (no rename of agent/ or memory/), those two 2770.
    expect(await mode(join(root, "fleet-master"))).toBe(0o2750);
    // S1: agent/ is also sticky (3770): no rename of the console's .git or .choibot-hooks.json.
    expect(await mode(join(root, "fleet-master/agent"))).toBe(0o3770);
    expect(await mode(join(root, "fleet-master/memory"))).toBe(0o2770);
    expect(await mode(join(root, "fleet-master", "memory", "MEMORY.md"))).toBe(0o660);
    // Ruling 2c-7-b: the .git the console made stays console-owned, not group-writable.
    expect((await mode(join(root, "fleet-master", "agent", ".git"))) & 0o777).toBe(0o755);
    expect(await mode(join(root, "fleet-master", "agent", ".git", "config"))).toBe(0o644);
    // No legacy agent dir is made in a hardened deployment.
    expect(existsSync(join(masterDataDir, "agent"))).toBe(false);
  });

  it("moves an existing legacy record into the home before its resume, and back on rollback", async () => {
    const { store, masterDataDir, root, ctx, spawned } = await setup();
    const legacyDir = join(masterDataDir, "agent");
    const homeDir = join(root, "fleet-master", "agent");
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: {} });
    expect((await store.load(FLEET_MASTER_ID))!.cwd).toBe(legacyDir);

    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: { ...HARDENED, AGENT_HOME_ROOT: root } });
    expect(await store.load(FLEET_MASTER_ID)).toMatchObject({ cwd: homeDir, worktree: homeDir });

    // Checklist C10: CHIEF_AGENT_UID removed, AGENT_HOME_ROOT kept.
    const rolledBack = { ...HARDENED, CHIEF_AGENT_UID: undefined, AGENT_HOME_ROOT: root };
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: rolledBack });
    expect(await store.load(FLEET_MASTER_ID)).toMatchObject({ cwd: legacyDir, worktree: legacyDir });
    expect(spawned.map((s) => s.cwd)).toEqual([legacyDir, homeDir, legacyDir]);
  });

  it("hardened with an AGENT_HOME_ROOT that does not exist: refused, nothing made (checklist C3)", async () => {
    const { store, masterDataDir, root, ctx, spawned } = await setup();
    const missing = join(root, "homes");
    await expect(ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: { ...HARDENED, AGENT_HOME_ROOT: missing } }))
      .rejects.toThrow(`[chief] ${missing} does not exist`);
    expect(await readdir(root)).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("hardened deployment without AGENT_HOME_ROOT: the legacy home and one [chief] warning", async () => {
    const { store, masterDataDir, ctx, spawned } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: HARDENED });
      expect(warn.mock.calls.filter(([l]) => String(l).startsWith("[chief] fleet-master: CHIEF_AGENT_UID is set but AGENT_HOME_ROOT"))).toHaveLength(1);
    } finally { warn.mockRestore(); }
    expect(spawned.map((s) => s.cwd)).toEqual([join(masterDataDir, "agent")]);
  });

  it("flag off with a legacy record: no store.patch call from the ensure and nothing made under AGENT_HOME_ROOT", async () => {
    const { store, masterDataDir, root, ctx } = await setup();
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: {} });
    const patch = vi.spyOn(store, "patch");
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir, env: { AGENT_HOME_ROOT: root } });
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir });
    // resumeAgent's own status patch only: the ensure itself writes no field.
    expect(patch.mock.calls.length).toBeGreaterThan(0);
    expect(patch.mock.calls.map(([, f]) => Object.keys(f).sort())).toEqual(patch.mock.calls.map(() => ["chiefRev", "status"]));
    expect(await readdir(root)).toEqual([]);
  });
});
