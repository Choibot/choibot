import { claudeRuntime } from "./runtimes/claude.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_DOCS_PROMPT, agentPrompt, widgetsPrompt } from "./argv.js";
import { resolveWidgetsDataDir } from "../widgets/paths.js";
import {
  claudeTranscriptPath,
  ensureTranscriptAt,
  shouldResume,
  resumeAgent,
  reconcileAgents,
  switchAccount,
  type RecoveryCtx,
} from "./recovery.js";
import { SessionStore, type AgentRecord } from "./store.js";
import type { AccountPaths } from "./accounts.js";
import { NO_MERGE_RULE } from "../chief/brain/prompt.js";
import { queueAgentPrompt } from "../chief/queue/prompt.js";
import { chiefCli } from "../chief/paths.js";
import { CHIEF_PROMPT_REV } from "../chief/paths.js";

describe("claudeTranscriptPath", () => {
  it("maps a worktree cwd + session id to the claude jsonl path", () => {
    expect(
      claudeTranscriptPath(
        "/home/dev/workspace/infra/.agent-worktrees/agent-a719bb16",
        "c50a3784-b588-4d53-8c3d-7da316415a7a",
      ),
    ).toBe(
      "/home/dev/.claude/projects/-home-dev-workspace-infra--agent-worktrees-agent-a719bb16/c50a3784-b588-4d53-8c3d-7da316415a7a.jsonl",
    );
  });
});

describe("ensureTranscriptAt", () => {
  const CWD = "/ws/repo/.agent-worktrees/agent-x";
  const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  async function projectsRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "projects-"));
  }

  it("true when the transcript already sits in the cwd's project dir", async () => {
    const root = await projectsRoot();
    const want = claudeTranscriptPath(CWD, SID, root);
    await mkdir(join(want, ".."), { recursive: true });
    await writeFile(want, "{}\n");
    expect(await ensureTranscriptAt(CWD, SID, root)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("finds a transcript relocated to another project dir (EnterWorktree) and links it into place", async () => {
    const root = await projectsRoot();
    // EnterWorktree filed the transcript under the WORKTREE's project dir.
    const elsewhere = join(root, "-ws-repo--claude-worktrees-some-feature");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, `${SID}.jsonl`), '{"line":1}\n');

    expect(await ensureTranscriptAt(CWD, SID, root)).toBe(true);
    const want = claudeTranscriptPath(CWD, SID, root);
    expect(await readFile(want, "utf8")).toBe('{"line":1}\n');
    // Same inode: appends from the resumed session stay visible at both paths.
    await appendFile(want, '{"line":2}\n');
    expect(await readFile(join(elsewhere, `${SID}.jsonl`), "utf8")).toContain('{"line":2}');
    await rm(root, { recursive: true, force: true });
  });

  it("brings the session's sidecar dir along (symlink) when present", async () => {
    const root = await projectsRoot();
    const elsewhere = join(root, "-ws-repo--claude-worktrees-some-feature");
    await mkdir(join(elsewhere, SID, "subagents"), { recursive: true });
    await writeFile(join(elsewhere, `${SID}.jsonl`), "{}\n");

    expect(await ensureTranscriptAt(CWD, SID, root)).toBe(true);
    const side = join(claudeTranscriptPath(CWD, SID, root), "..", SID);
    expect((await lstat(side)).isSymbolicLink()).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("false when the transcript exists nowhere", async () => {
    const root = await projectsRoot();
    expect(await ensureTranscriptAt(CWD, SID, root)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("false when the projects root itself is missing", async () => {
    expect(await ensureTranscriptAt(CWD, SID, "/nonexistent-root-xyz")).toBe(false);
  });
});

const base = {
  id: "x", label: "", repo: "r", worktree: "/w", branch: "b",
  baseBranch: "m", hookToken: "t", status: "idle", createdAt: 0,
} satisfies Omit<AgentRecord, "sessionId">;

describe("shouldResume", () => {
  it("resumes when a session id and transcript both exist", () =>
    expect(shouldResume({ ...base, sessionId: "s" }, true)).toBe(true));
  it("cold-starts when transcript is missing", () =>
    expect(shouldResume({ ...base, sessionId: "s" }, false)).toBe(false));
  it("cold-starts when there is no session id", () =>
    expect(shouldResume({ ...base, sessionId: null }, true)).toBe(false));
});

type Spawned = { id: string; cwd: string; args: string[]; env?: Record<string, string> };

function fakeCtx(recs: AgentRecord[], aliveIds = new Set<string>()) {
  const spawned: Spawned[] = [];
  const ctx = {
    port: 3100,
    workspaceDir: "/ws",
    claudeHooksPathFor: () => "/tmp/h.json",
    writeClaudeHookSettings: async () => {},
    store: {
      list: async () => recs,
      patch: async () => {},
    },
    terminals: {
      has: () => false,
      reattach: async (id: string) => (aliveIds.has(id) ? {} : null),
      spawn: (o: Spawned) => spawned.push(o),
    },
  } as unknown as RecoveryCtx;
  return { spawned, ctx };
}

function rec(over: Partial<AgentRecord>): AgentRecord {
  return { ...base, sessionId: null, ...over } as AgentRecord;
}

describe("resumeAgent", () => {
  it("re-applies the fleet master prompt at the master's own cwd", async () => {
    const fleet = rec({
      id: "fleet-master", label: "Master", repo: "", worktree: "/data/master/agent",
      cwd: "/data/master/agent", kind: "fleet-master", createdAt: 1,
    });
    const { ctx, spawned } = fakeCtx([fleet]);
    await resumeAgent(fleet, ctx);
    expect(spawned[0].cwd).toBe("/data/master/agent");
    const i = spawned[0].args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spawned[0].args[i + 1]).toMatch(/^You are the fleet master/);
    expect(spawned[0].args[i + 1]).toContain(`${claudeRuntime.bin()} agents --json`);
    // The recurring tasks (cron jobs) it took over from the retired cron master, in the host time zone.
    expect(spawned[0].args[i + 1]).toContain(`## Recurring tasks`);
    expect(spawned[0].args[i + 1]).toContain(`host time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`);
    expect(spawned[0].args[i + 1]).not.toContain("Console widgets:");
  });

  it("gives repo agents docs + widgets text and workspace agents the widgets text only", async () => {
    const repoAgent = rec({ id: "r1" }); // base: repo "r", worktree "/w"
    const wsAgent = rec({ id: "w1", repo: "" });
    const { ctx, spawned } = fakeCtx([repoAgent, wsAgent]);
    await reconcileAgents(ctx);
    const byId = Object.fromEntries(spawned.map((s) => [s.id, s.args]));
    const i = byId.r1.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(byId.r1[i + 1]).toBe(agentPrompt({ id: "r1", repo: "r" }, resolveWidgetsDataDir()));
    const j = byId.w1.indexOf("--append-system-prompt");
    expect(j).toBeGreaterThanOrEqual(0);
    expect(byId.w1[j + 1]).toBe(widgetsPrompt(join(resolveWidgetsDataDir(), "w1")));
  });

  it("re-applies the issue prompt after the shared-docs prompt when resuming an issue agent", async () => {
    const issueAgent = rec({ id: "i1", kind: "issue", issueId: "t42" });
    const { ctx, spawned } = fakeCtx([issueAgent]);
    await resumeAgent(issueAgent, ctx);
    const args = spawned[0].args;
    const i = args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(agentPrompt({ id: "i1", repo: "r", kind: "issue" }, resolveWidgetsDataDir()));
  });

  // The hook seam writes a settings FILE, which is a Claude-only shape. A Codex
  // agent that took it would launch with no CODEX_HOME — against the user's real
  // ~/.codex, with no hook plugin and so no status reporting at all. Production
  // never sets the seam, but the type must not make that reachable.
  it("ignores the claude hook seam for a codex agent and still runs its prepare()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recovery-codex-"));
    const prev = process.env.CODEX_EXECUTABLE;
    // Fail plugin registration fast instead of shelling out to the real CLI.
    process.env.CODEX_EXECUTABLE = join(dir, "no-such-codex");
    try {
      // repo set, so the generated CODEX_HOME lands under the temp worktree.
      const cx = rec({ id: "cx", repo: "/r", worktree: dir, cwd: dir, runtime: "codex" });
      const { ctx, spawned } = fakeCtx([cx]);
      await resumeAgent(cx, ctx);
      // prepare() ran: CODEX_HOME is set, and no claude settings path reached argv.
      expect(spawned[0].env?.CODEX_HOME).toBeTruthy();
      expect(spawned[0].args).not.toContain("/tmp/h.json");
      expect(spawned[0].args).not.toContain("--settings");
    } finally {
      if (prev === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writes the docs + widgets text into a codex agent's AGENTS.md on relaunch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recovery-codex-w-"));
    const prev = process.env.CODEX_EXECUTABLE;
    process.env.CODEX_EXECUTABLE = join(dir, "no-such-codex");
    try {
      const cx = rec({ id: "cxw", repo: "/r", worktree: dir, cwd: dir, runtime: "codex" });
      const { ctx, spawned } = fakeCtx([cx]);
      await resumeAgent(cx, ctx);
      const md = await readFile(join(spawned[0].env!.CODEX_HOME, "AGENTS.md"), "utf8");
      expect(md).toContain(SHARED_DOCS_PROMPT);
      expect(md).toContain(widgetsPrompt(join(resolveWidgetsDataDir(), "cxw")));
    } finally {
      if (prev === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

});

describe("reconcileAgents", () => {
  it("resumes dead non-done agents and skips done + live ones", async () => {
    const recs = [
      rec({ id: "dead1", repo: "r", worktree: "/w1", sessionId: null, status: "idle", createdAt: 1 }),
      rec({ id: "done1", repo: "r", worktree: "/w2", sessionId: "s", status: "done", createdAt: 2 }),
      rec({ id: "live1", repo: "r", worktree: "/w3", sessionId: "s", status: "running", createdAt: 3 }),
    ];
    const { ctx, spawned } = fakeCtx(recs, new Set(["live1"]));
    const res = await reconcileAgents(ctx);
    expect(spawned.map((s) => s.id)).toEqual(["dead1"]); // only the dead, non-done one
    expect(res.alive).toContain("live1");
    expect(res.cold).toContain("dead1"); // null session id → cold start
    expect(res.resumed).toEqual([]);
  });

  it("flag off: a dead lead record is skipped (no spawn) while a dead worker is resumed", async () => {
    const recs = [
      rec({ id: "lead-app-shop", kind: "lead", area: "app-shop", repo: "", worktree: "/h/lead", cwd: "/h/lead", status: "idle", createdAt: 1 }),
      rec({ id: "dead1", repo: "r", worktree: "/w1", status: "idle", createdAt: 2 }),
    ];
    const { ctx, spawned } = fakeCtx(recs);
    const res = await reconcileAgents(ctx);
    expect(spawned.map((s) => s.id)).toEqual(["dead1"]);
    expect([...res.resumed, ...res.cold, ...res.alive, ...res.failed]).toEqual(["dead1"]);
  });

  it("never restarts a closed agent at boot, whatever its recorded status", async () => {
    const recs = [
      rec({ id: "closedIdle", repo: "r", worktree: "/w1", sessionId: "s1", status: "idle", closedAt: 5, createdAt: 1 }),
      rec({ id: "closedErr", repo: "r", worktree: "/w2", sessionId: "s2", status: "error", closedAt: 5, createdAt: 2 }),
      rec({ id: "closedRun", repo: "r", worktree: "/w3", sessionId: "s3", status: "running", closedAt: 5, createdAt: 3 }),
      rec({ id: "open", repo: "r", worktree: "/w4", sessionId: null, status: "idle", createdAt: 4 }),
    ];
    const { ctx, spawned } = fakeCtx(recs);
    const res = await reconcileAgents(ctx);
    expect(spawned.map((s) => s.id)).toEqual(["open"]);
    expect([...res.resumed, ...res.cold, ...res.alive, ...res.failed]).toEqual(["open"]);
  });

  it("buckets a throwing agent as failed without aborting the loop", async () => {
    const recs = [
      rec({ id: "boom", repo: "r", worktree: "/w1", status: "idle", createdAt: 1 }),
      rec({ id: "ok", repo: "r", worktree: "/w2", status: "idle", createdAt: 2 }),
    ];
    const { ctx, spawned } = fakeCtx(recs);
    (ctx.terminals as unknown as { spawn: (o: Spawned) => void }).spawn = (o: Spawned) => {
      if (o.id === "boom") throw new Error("spawn failed");
      spawned.push(o);
    };
    const res = await reconcileAgents(ctx);
    expect(res.failed).toEqual(["boom"]);
    expect(res.cold).toEqual(["ok"]);
    expect(spawned.map((s) => s.id)).toEqual(["ok"]);
  });
});

// Accounts reach the child as CLAUDE_CONFIG_DIR. The seam path skips the shadow
// dir sync but must still pin the login, or a resumed agent would silently run
// under the default account.
describe("resumeAgent accounts", () => {
  const paths: AccountPaths = { root: "/acc", defaultDir: "/home/u/.claude", defaultClaudeJson: "/home/u/.claude.json" };

  it("sets CLAUDE_CONFIG_DIR for a named account and nothing for the default", async () => {
    const named = rec({ id: "n1", account: "work" });
    const plain = rec({ id: "p1" });
    const { ctx, spawned } = fakeCtx([named, plain]);
    (ctx as { accounts?: AccountPaths }).accounts = paths;
    await reconcileAgents(ctx);
    const byId = Object.fromEntries(spawned.map((s) => [s.id, s.env]));
    expect(byId.n1).toEqual({ CLAUDE_CONFIG_DIR: "/acc/work" });
    expect(byId.p1).toBeUndefined();
  });
});

// Spec §5.2: with chiefActive() a resume puts the agent's identity in its env
// (merged into what the launch path already sets) and writes chiefRev in the
// same store write as the launch status; a flag-off resume clears it.
describe("resumeAgent chief identity", () => {
  const paths: AccountPaths = { root: "/acc", defaultDir: "/home/u/.claude", defaultClaudeJson: "/home/u/.claude.json" };
  afterEach(() => { vi.unstubAllEnvs(); });

  function chiefOn() {
    vi.stubEnv("CHIEF_ENABLED", "1");
    vi.stubEnv("CHIEF_USER_AUTH", "log");
    vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
  }

  async function withStore(fn: (store: SessionStore, dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "recovery-rev-"));
    try { await fn(new SessionStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const rawRecord = async (dir: string, id: string) =>
    JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Record<string, unknown>;

  it("flag on, claude seam, named account: env holds CLAUDE_CONFIG_DIR and both CHOIBOT_* keys", async () => {
    chiefOn();
    const named = rec({ id: "n1", account: "work", hookToken: "tok-n1" });
    const { ctx, spawned } = fakeCtx([named]);
    (ctx as { accounts?: AccountPaths }).accounts = paths;
    await resumeAgent(named, ctx);
    expect(spawned[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/acc/work", CHOIBOT_AGENT_ID: "n1", CHOIBOT_AGENT_PASS: "tok-n1" });
  });

  it("flag on: workers get NO_MERGE_RULE, the fleet master does not", async () => {
    chiefOn();
    const promptOf = (a: string[]) => a[a.indexOf("--append-system-prompt") + 1];
    const mk = (id: string, kind: AgentRecord["kind"]) =>
      rec({ id, label: id, repo: "", worktree: `/d/${id}`, cwd: `/d/${id}`, kind, createdAt: 1 });
    const fleet = mk("fleet-master", "fleet-master");
    const worker = rec({ id: "w1" });
    const got: Record<string, string> = {};
    for (const r of [fleet, worker]) {
      const { ctx, spawned } = fakeCtx([r]);
      await resumeAgent(r, ctx);
      got[r.id] = promptOf(spawned[0].args);
    }
    expect(got["fleet-master"]).not.toContain(NO_MERGE_RULE);
    expect(got.w1).toContain(`${NO_MERGE_RULE}\n\n${queueAgentPrompt(chiefCli(process.cwd()))}`);
  });

  it("flag on: a resumed lead gets leadSystemPrompt with its area's repos and charter", async () => {
    chiefOn();
    const data = await mkdtemp(join(tmpdir(), "chief-leadp-"));
    vi.stubEnv("CHIEF_DATA_DIR", data);
    try {
      await mkdir(join(data, "leads", "app-shop"), { recursive: true });
      await writeFile(join(data, "leads", "app-shop", "charter.md"), "CHARTER-X\n");
      await writeFile(join(data, "areas.json"), JSON.stringify({ "app-shop": { repos: ["app-shop", "ui-kit"], leadId: "lead-app-shop" } }));
      const lead = rec({ id: "lead-app-shop", kind: "lead", area: "app-shop", repo: "", worktree: "/d/l", cwd: "/d/l", createdAt: 1 });
      const { ctx, spawned } = fakeCtx([lead]);
      await resumeAgent(lead, ctx);
      const a = spawned[0].args;
      const prompt = a[a.indexOf("--append-system-prompt") + 1];
      expect(prompt).toContain("You are the lead for the app-shop area");
      expect(prompt).toContain("CHARTER-X");
      expect(prompt).toContain("Spawn only in: app-shop, ui-kit.");
      expect(prompt).toContain(`Your memory lives in ${join(data, "leads", "app-shop", "memory")}.`);
      // A missing charter and areas.json never throw.
      await rm(join(data, "leads"), { recursive: true });
      await rm(join(data, "areas.json"));
      const again = fakeCtx([lead]);
      await resumeAgent(lead, again.ctx);
      expect(again.spawned[0].args.join(" ")).toContain("You are the lead for the app-shop area");
    } finally { await rm(data, { recursive: true, force: true }); }
  });

  it("flag on: a lead whose area fails AREA_RE gets the worker prompt, with one log line", async () => {
    chiefOn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lead = rec({ id: "lead-x", kind: "lead", area: "../etc", repo: "", worktree: "/d/l", cwd: "/d/l", createdAt: 1 });
      const { ctx, spawned } = fakeCtx([lead]);
      await resumeAgent(lead, ctx);
      const a = spawned[0].args;
      expect(a[a.indexOf("--append-system-prompt") + 1]).not.toContain("You are the lead");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it("resume argv: --system-prompt-snapshot off right after the autonomy flag when on, absent when off", async () => {
    const r = rec({ id: "s1" });
    const off = fakeCtx([r]);
    await resumeAgent(r, off.ctx);
    expect(off.spawned[0].args).not.toContain("--system-prompt-snapshot");
    chiefOn();
    const on = fakeCtx([r]);
    await resumeAgent(r, on.ctx);
    const a = on.spawned[0].args;
    expect(a).toContain("--system-prompt-snapshot");
    const i = a.indexOf("--dangerously-skip-permissions");
    expect(a[i + 1]).toBe("--system-prompt-snapshot");
    expect(a[i + 2]).toBe("off");
  });

  it("flag off, default account: no env at all, so no CHOIBOT_* key", async () => {
    const plain = rec({ id: "p1" });
    const { ctx, spawned } = fakeCtx([plain]);
    await resumeAgent(plain, ctx);
    expect(spawned[0].env).toBeUndefined();
  });

  it("flag on: writes status idle and chiefRev in one store write", async () => {
    chiefOn();
    await withStore(async (store, dir) => {
      const r = rec({ id: "rv-on" });
      await store.save(r);
      const patch = vi.spyOn(store, "patch");
      const { ctx } = fakeCtx([r]);
      (ctx as { store: SessionStore }).store = store;
      await resumeAgent(r, ctx);
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith("rv-on", { status: "idle", chiefRev: CHIEF_PROMPT_REV });
      expect((await rawRecord(dir, "rv-on")).chiefRev).toBe(CHIEF_PROMPT_REV);
    });
  });

  it("flag off: clears a chiefRev left by an earlier flag-on launch from the record file", async () => {
    await withStore(async (store, dir) => {
      const r = rec({ id: "rv-off", status: "error", chiefRev: 1 });
      await store.save(r);
      expect(Object.keys(await rawRecord(dir, "rv-off"))).toContain("chiefRev");
      const { ctx } = fakeCtx([r]);
      (ctx as { store: SessionStore }).store = store;
      await resumeAgent(r, ctx);
      const raw = await rawRecord(dir, "rv-off");
      expect(Object.keys(raw)).not.toContain("chiefRev");
      expect(raw.status).toBe("idle");
    });
  });
});

describe("switchAccount", () => {
  const paths: AccountPaths = { root: "/acc", defaultDir: "/home/u/.claude", defaultClaudeJson: "/home/u/.claude.json" };

  // A fake terminal manager whose kill() ends the session a tick later, the
  // way the real one does (PTY exit + dtach socket removal are asynchronous).
  function liveTerminals(liveIds: Set<string>, socketIds = new Set<string>()) {
    const spawned: Spawned[] = [];
    const killed: string[] = [];
    return {
      spawned, killed,
      has: (id: string) => liveIds.has(id),
      hasSession: async (id: string) => socketIds.has(id),
      reattach: async () => null,
      kill: (id: string) => { killed.push(id); setTimeout(() => { liveIds.delete(id); socketIds.delete(id); }, 20); },
      spawn: (o: Spawned) => { liveIds.add(o.id); spawned.push(o); },
    };
  }

  function ctxWith(terminals: ReturnType<typeof liveTerminals>, patches: Array<Partial<AgentRecord>>) {
    return {
      port: 3100, workspaceDir: "/ws", accounts: paths,
      claudeHooksPathFor: () => "/tmp/h.json",
      writeClaudeHookSettings: async () => {},
      store: { list: async () => [], patch: async (_id: string, f: Partial<AgentRecord>) => { patches.push(f); } },
      terminals,
    } as unknown as RecoveryCtx;
  }

  it("records the account first, ends the live session, and relaunches under the new login", async () => {
    const r = rec({ id: "a1" });
    const t = liveTerminals(new Set(["a1"]));
    const patches: Array<Partial<AgentRecord>> = [];
    const outcome = await switchAccount(r, "work", ctxWith(t, patches));
    expect(outcome).toBe("cold"); // no session id → cold relaunch
    expect(t.killed).toEqual(["a1"]);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].env).toEqual({ CLAUDE_CONFIG_DIR: "/acc/work" });
    expect(patches[0]).toEqual({ account: "work" });
  });

  it("treats a persisted-but-unattached session as live", async () => {
    const r = rec({ id: "a2", account: "work" });
    const t = liveTerminals(new Set(), new Set(["a2"]));
    const patches: Array<Partial<AgentRecord>> = [];
    await switchAccount(r, undefined, ctxWith(t, patches));
    expect(t.killed).toEqual(["a2"]);
    expect(t.spawned[0].env).toBeUndefined(); // back to the default login
    expect(patches[0]).toEqual({ account: undefined });
  });

  it("only patches a dead agent — no kill, no spawn", async () => {
    const r = rec({ id: "a3" });
    const t = liveTerminals(new Set());
    const patches: Array<Partial<AgentRecord>> = [];
    expect(await switchAccount(r, "work", ctxWith(t, patches))).toBe("patched");
    expect(t.killed).toEqual([]);
    expect(t.spawned).toEqual([]);
    expect(patches).toEqual([{ account: "work" }]);
  });
});

// The model of a start (agents/model.ts startModel): a worker moves to the setting at its next
// resume; a lead that resumes its session keeps the model it was saved on.
describe("resumeAgent model", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const modelOf = (a: string[]): string | null => (a.includes("--model") ? a[a.indexOf("--model") + 1] : null);
  const SID = "11111111-1111-4111-8111-111111111111";

  it("a worker: its own model, else the setting, fresh or on a resume of its session", async () => {
    vi.stubEnv("AGENT_MODEL", "sonnet");
    for (const resumes of [false, true]) {
      vi.spyOn(claudeRuntime, "canResume").mockResolvedValue(resumes);
      const own = rec({ id: "m1", model: "fable", sessionId: SID });
      const none = rec({ id: "m2", sessionId: SID });
      const t = fakeCtx([own, none]);
      await resumeAgent(own, t.ctx);
      await resumeAgent(none, t.ctx);
      expect(t.spawned.map((x) => modelOf(x.args))).toEqual(["fable", "sonnet"]);
      expect(t.spawned[1].args.includes("--resume")).toBe(resumes);
    }
  });

  it("a lead: no flag when it resumes its session (it keeps its model); the setting on a fresh start", async () => {
    vi.stubEnv("AGENT_MODEL", "haiku");
    for (const [resumes, want] of [[true, null], [false, "haiku"]] as const) {
      vi.spyOn(claudeRuntime, "canResume").mockResolvedValue(resumes);
      const lead = rec({ id: "lead-app", kind: "lead", sessionId: SID });
      const t = fakeCtx([lead]);
      await resumeAgent(lead, t.ctx);
      expect(modelOf(t.spawned[0].args)).toBe(want);
    }
  });
});
