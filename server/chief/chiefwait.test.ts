// The wait of the persistent agents for the second sign-in (chiefwait.ts): no session starts
// before it, by any path; a waiting agent keeps its status (never "error"); one log line per agent;
// after the sign-in, what waits starts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileAgents, resumeAgent, type RecoveryCtx } from "../agents/recovery.js";
import type { AgentRecord } from "../agents/store.js";
import { ChiefWait, startWaited } from "./chiefwait.js";

const SELF = process.getuid?.() ?? 1000;
const ON = {
  CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: String(SELF + 1),
  CHIEF_PERSISTENT_UID: String(SELF + 2), AGENT_CLAUDE_CONFIG_DIR: "/home/agent/.claude", AGENT_CHIEF_CLAUDE_CONFIG_DIR: "/home/chief/.claude",
  AGENT_CHIEF_DTACH_DIR: "/run/dtach-chief", AGENT_DTACH_DIR: "/run/dtach",
};
afterEach(() => vi.unstubAllEnvs());
const stub = (env: Record<string, string>) => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };
const WORKER = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";

describe("ChiefWait", () => {
  it("a worker always starts; a persistent agent only after the second sign-in; one log line per agent", async () => {
    stub(ON);
    let signed = false;
    const log: string[] = [];
    const w = new ChiefWait({ signedIn: async () => signed, log: (s) => log.push(s), now: () => 5 });
    expect(await w.mayStart(WORKER)).toBe(true);
    for (let i = 0; i < 3; i++) expect(await w.mayStart("fleet-master")).toBe(false);
    expect(await w.mayStart("lead-app")).toBe(false);
    expect(w.waits()).toEqual(["fleet-master", "lead-app"]);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/fleet-master waits for the second sign-in/);
    signed = true;
    expect(await w.mayStart("fleet-master")).toBe(true);
    expect(w.waits()).toEqual(["lead-app"]);
    expect(w.hasWaited("fleet-master")).toBe(true);
    w.forgetWaited("fleet-master");
    expect(w.hasWaited("fleet-master")).toBe(false);
  });

  it("a status read that fails counts as no sign-in", async () => {
    stub(ON);
    const w = new ChiefWait({ signedIn: async () => { throw new Error("helper"); }, log: () => {} });
    expect(await w.mayStart("coordinator")).toBe(false);
  });

  it("with no second account asked for, nothing waits", async () => {
    stub({ ...ON, CHIEF_PERSISTENT_UID: "" });
    const w = new ChiefWait({ signedIn: async () => false, log: () => {} });
    expect(await w.mayStart("fleet-master")).toBe(true);
  });

  it("after the sign-in: each listener gets what waited; the list is empty again", async () => {
    stub(ON);
    const w = new ChiefWait({ signedIn: async () => false, log: () => {} });
    await w.mayStart("coordinator");
    await w.mayStart("fleet-master");
    const got: string[][] = [];
    w.onSignedIn((ids) => { got.push(ids); });
    w.onSignedIn(() => { throw new Error("one start failed"); });
    w.onSignedIn((ids) => { got.push([...ids, "second"]); });
    await w.signedInNow();
    expect(got).toEqual([["coordinator", "fleet-master"], ["coordinator", "fleet-master", "second"]]);
    expect(w.waits()).toEqual([]);
  });
});

// Every path that can start a persistent agent goes through resumeAgent (the boot through each
// ensure, a relaunch, reconcile, the user's resume): a fake context shows that it starts no
// session while the sign-in is missing, and that the record keeps its status.
function fakeCtx(recs: AgentRecord[], wait: ChiefWait) {
  const spawned: string[] = [];
  const patched: Array<[string, Partial<AgentRecord>]> = [];
  const ctx = {
    port: 3100, workspaceDir: "/ws", chiefWait: wait,
    claudeHooksPathFor: () => "/tmp/h.json", writeClaudeHookSettings: async () => {},
    store: { list: async () => recs, patch: async (id: string, f: Partial<AgentRecord>) => { patched.push([id, f]); } },
    terminals: { has: () => false, reattach: async () => null, spawn: (o: { id: string }) => spawned.push(o.id) },
  } as unknown as RecoveryCtx;
  return { ctx, spawned, patched };
}
const rec = (id: string, kind?: AgentRecord["kind"], status: AgentRecord["status"] = "idle"): AgentRecord =>
  ({ id, label: id, repo: "", worktree: "/w", cwd: "/w", branch: "", baseBranch: "", sessionId: null, hookToken: "t", status, createdAt: 1, ...(kind ? { kind } : {}) }) as AgentRecord;

describe("the start paths of a persistent agent", () => {
  it("resumeAgent starts no persistent session without the second sign-in, and changes no status", async () => {
    stub(ON);
    const w = new ChiefWait({ signedIn: async () => false, log: () => {} });
    const master = rec("fleet-master", "fleet-master", "error");
    const { ctx, spawned, patched } = fakeCtx([master], w);
    expect(await resumeAgent(master, ctx)).toBe("waits");
    expect(spawned).toEqual([]);
    expect(patched).toEqual([]);
  });

  it("reconcile at boot: the persistent agents wait (not failed), a worker starts", async () => {
    stub(ON);
    const w = new ChiefWait({ signedIn: async () => false, log: () => {} });
    const recs = [rec("fleet-master", "fleet-master"), rec("coordinator", "coordinator"), rec("lead-app", "lead"), rec(WORKER)];
    const { ctx, spawned } = fakeCtx(recs, w);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await reconcileAgents(ctx);
    log.mockRestore();
    expect(r.waits.sort()).toEqual(["coordinator", "fleet-master", "lead-app"]);
    expect(r.failed).toEqual([]);
    expect(spawned).toEqual([WORKER]);
  });

  it("with the sign-in, the same path starts them", async () => {
    stub(ON);
    const w = new ChiefWait({ signedIn: async () => true, log: () => {} });
    const master = rec("fleet-master", "fleet-master");
    const { ctx, spawned } = fakeCtx([master], w);
    expect(await resumeAgent(master, ctx)).not.toBe("waits");
    expect(spawned).toEqual(["fleet-master"]);
  });

  it("the scan: a session starts only in resumeAgent, the worker spawn and a service; the worker spawn makes no persistent agent", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && readFileSync(p, "utf8").includes("terminals.spawn(")) files.push(p.slice(root.length));
      }
    };
    walk(root);
    expect(files.sort()).toEqual(["agents/recovery.ts", "agents/spawn.ts", "services/manager.ts"]);
    // The worker spawn never makes a record of a persistent kind.
    expect(readFileSync(join(root, "agents/spawn.ts"), "utf8")).not.toMatch(/kind:\s*"(fleet-master|lead|coordinator)"/);
  });
});

describe("the log line of the wait and the starts after the sign-in", () => {
  it("names why the server is not ready for the sign-in, when it is not", async () => {
    stub(ON);
    const log: string[] = [];
    const w = new ChiefWait({ signedIn: async () => false, cause: () => "the helper of the second account did not answer its probe", log: (s) => log.push(s) });
    await w.mayStart("fleet-master");
    expect(log[0]).toMatch(/fleet-master waits for the second sign-in .*: the server is not ready for it: the helper of the second account did not answer its probe; it starts after it/);
    const ok: string[] = [];
    await new ChiefWait({ signedIn: async () => false, cause: () => null, log: (s) => ok.push(s) }).mayStart("coordinator");
    expect(ok[0]).toMatch(/it is not signed in yet; it starts after it/);
  });

  it("one failed start stops no other: the master fails, the Coordinator and the lead that waited still start", async () => {
    const started: string[] = [];
    const log: string[] = [];
    await startWaited(["fleet-master", "coordinator", "lead-app"], {
      master: async () => { throw new Error("no home"); }, masterKnown: async () => true,
      coordinator: async () => { started.push("coordinator"); }, coordinatorKnown: async () => true,
      lead: async (area) => { started.push(`lead ${area}`); },
      log: (s) => log.push(s),
    });
    expect(started).toEqual(["coordinator", "lead app"]);
    expect(log).toEqual(["[chief] fleet-master did not start after the second sign-in: no home"]);
  });

  it("starts the master and the Coordinator also when they have a record but did not wait; nothing else", async () => {
    const started: string[] = [];
    await startWaited([], {
      master: async () => { started.push("master"); }, masterKnown: async () => true,
      coordinator: async () => { started.push("coordinator"); }, coordinatorKnown: async () => false,
      lead: async () => { started.push("lead"); },
    });
    expect(started).toEqual(["master"]);
  });
});
