import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueRelay, closeOrphans, WAITING_TEXT, type RelayDeps } from "./relay.js";
import { IssueActions } from "./actions.js";
import { IssueStore, type Issue } from "./store.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { EventHub } from "../events.js";
import type { AgentPr } from "../gh/status.js";
import { fakeBotApi, clientFor, makeIssue, USER_ID } from "./testkit.js";

const PR: AgentPr = { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", slug: "o/r" };

async function setup(issue: Partial<Issue>, o: { pr?: AgentPr | null; agent?: Partial<AgentRecord> | null; queueAdd?: RelayDeps["queueAdd"] } = {}) {
  const store = new IssueStore(await mkdtemp(join(tmpdir(), "issues-relay-")));
  const bot = fakeBotApi();
  const actions = new IssueActions({ store, tg: clientFor(bot), chatId: USER_ID, dispatch: async () => "x" });
  const agents = new SessionStore(await mkdtemp(join(tmpdir(), "issues-relay-agents-")));
  if (o.agent !== null) {
    await agents.save({
      id: "agent-1", label: "issue: x", repo: "/ws/choibot", worktree: "/wt/a1", branch: "agent/a1",
      baseBranch: "main", sessionId: null, hookToken: "t", status: "running", createdAt: 1,
      kind: "issue", issueId: "t100", ...o.agent,
    });
  }
  await store.create(makeIssue({ status: "running", agentId: "agent-1", cardMessageId: 1000, chatMessageIds: [100, 1000], ...issue }));
  const prCalls: Array<{ repo: string; branch: string }> = [];
  const hub = new EventHub();
  const relay = new IssueRelay({
    hub, store, actions, agents,
    findPr: async (rec) => { prCalls.push({ repo: rec.repo, branch: rec.branch }); return o.pr ?? null; },
    headBranch: async () => "agent/live",
    ...(o.queueAdd ? { queueAdd: o.queueAdd } : {}),
  });
  return { store, bot, agents, relay, prCalls, hub };
}
const posts = (bot: ReturnType<typeof fakeBotApi>) => bot.sent().map((b) => b.text);

describe("IssueRelay.onTurnEnd", () => {
  it("first PR: records it on agent and issue, posts the link, and no question", async () => {
    const t = await setup({}, { pr: PR });
    await t.relay.onTurnEnd("agent-1", "Opened the PR.");
    expect(t.prCalls).toEqual([{ repo: "/ws/choibot", branch: "agent/live" }]);
    expect(await t.store.get("t100")).toMatchObject({ status: "pr-open", prUrl: PR.url, prNumber: 7 });
    expect(await t.agents.load("agent-1")).toMatchObject({ prUrl: PR.url, prNumber: 7 });
    expect(posts(t.bot)).toEqual([`PR opened: ${PR.url}`]);
    expect(t.bot.sent()[0].reply_parameters.message_id).toBe(1000);
  });

  it("first PR: queueAdd runs after the post, with the record and the PR", async () => {
    const t0: { bot?: ReturnType<typeof fakeBotApi> } = {};
    const calls: Array<{ id: string; pr: { url: string; number: number }; posted: number }> = [];
    const t = await setup({}, { pr: PR, queueAdd: async (rec, pr) => { calls.push({ id: rec.id, pr, posted: t0.bot!.sent().length }); } });
    t0.bot = t.bot;
    await t.relay.onTurnEnd("agent-1", "Opened the PR.");
    expect(calls).toEqual([{ id: "agent-1", pr: { url: PR.url, number: 7 }, posted: 1 }]);
  });

  it("a throwing or rejecting queueAdd changes nothing: pr-open and the post stay", async () => {
    for (const fn of [() => { throw new Error("boom"); }, async () => { throw new Error("boom"); }]) {
      const t = await setup({}, { pr: PR, queueAdd: fn as RelayDeps["queueAdd"] });
      await t.relay.onTurnEnd("agent-1", "Opened the PR.");
      expect((await t.store.get("t100"))?.status).toBe("pr-open");
      expect(posts(t.bot)).toEqual([`PR opened: ${PR.url}`]);
    }
  });

  it("queueAdd is not called on follow-up turns", async () => {
    const queueAdd = vi.fn(async () => {});
    const t = await setup({ status: "pr-open", prUrl: PR.url, prNumber: 7 }, { pr: PR, queueAdd });
    await t.relay.onTurnEnd("agent-1", "More.");
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("follow-up turn after the PR: posts the message, stays pr-open", async () => {
    const t = await setup({ status: "pr-open", prUrl: PR.url, prNumber: 7 }, { pr: PR });
    await t.relay.onTurnEnd("agent-1", "Footer fixed too.");
    expect(posts(t.bot)).toEqual(["Footer fixed too."]);
    expect((await t.store.get("t100"))?.status).toBe("pr-open");
  });

  it("follow-up turn when gh cannot answer: still posts (the PR is already known)", async () => {
    const t = await setup({ status: "pr-open", prUrl: PR.url, prNumber: 7 }, { pr: null });
    await t.relay.onTurnEnd("agent-1", "Done.");
    expect(posts(t.bot)).toEqual(["Done."]);
  });

  it("no PR: posts the question and moves to needs-input", async () => {
    const t = await setup({});
    await t.relay.onTurnEnd("agent-1", "Which browser?");
    expect(posts(t.bot)).toEqual(["Which browser?"]);
    expect((await t.store.get("t100"))?.status).toBe("needs-input");
  });

  it("an empty last message posts the waiting notice", async () => {
    const t = await setup({ status: "needs-input" });
    await t.relay.onTurnEnd("agent-1", "   ");
    expect(posts(t.bot)).toEqual([WAITING_TEXT]);
  });

  it("reopens a done or errored issue whose agent came back", async () => {
    const t = await setup({ status: "done" });
    await t.relay.onTurnEnd("agent-1", "Back. Which page?");
    expect((await t.store.get("t100"))?.status).toBe("needs-input");
    const p = await setup({ status: "error", prUrl: PR.url, prNumber: 7 }, { pr: PR });
    await p.relay.onTurnEnd("agent-1", "Pushed.");
    expect((await p.store.get("t100"))?.status).toBe("pr-open");
    expect(posts(p.bot)).toEqual(["Pushed."]);
  });

  it("does nothing for a dropped issue or a non-issue agent", async () => {
    const t = await setup({ status: "dropped" });
    await t.relay.onTurnEnd("agent-1", "x");
    const n = await setup({}, { agent: { kind: undefined, issueId: undefined } });
    await n.relay.onTurnEnd("agent-1", "x");
    expect(t.bot.calls).toEqual([]);
    expect(n.bot.calls).toEqual([]);
    expect((await n.store.get("t100"))?.status).toBe("running");
  });

  it("a UI issue (no card) changes status but posts nothing", async () => {
    const t = await setup({ cardMessageId: undefined, chatMessageIds: [] });
    await t.relay.onTurnEnd("agent-1", "Which browser?");
    expect((await t.store.get("t100"))?.status).toBe("needs-input");
    expect(t.bot.calls).toEqual([]);
  });
});

describe("IssueRelay.onStatus", () => {
  it("error → error with one message, however often it repeats", async () => {
    const t = await setup({});
    await t.relay.onStatus("agent-1", "error");
    await t.relay.onStatus("agent-1", "error");
    expect((await t.store.get("t100"))?.status).toBe("error");
    expect(posts(t.bot)).toEqual(["Agent errored — resume it in the console."]);
  });

  it("done → done, unless pr-open", async () => {
    const t = await setup({ status: "needs-input" });
    await t.relay.onStatus("agent-1", "done");
    expect((await t.store.get("t100"))?.status).toBe("done");
    const p = await setup({ status: "pr-open", prUrl: PR.url });
    await p.relay.onStatus("agent-1", "done");
    expect((await p.store.get("t100"))?.status).toBe("pr-open");
  });

  it("running or idle after done/error reopens the issue", async () => {
    const t = await setup({ status: "done" });
    await t.relay.onStatus("agent-1", "idle");
    expect((await t.store.get("t100"))?.status).toBe("running");
    const p = await setup({ status: "error", prUrl: PR.url });
    await p.relay.onStatus("agent-1", "running");
    expect((await p.store.get("t100"))?.status).toBe("pr-open");
  });

  it("reopening after an agent error clears the error", async () => {
    const t = await setup({});
    await t.relay.onStatus("agent-1", "error");
    expect((await t.store.get("t100"))?.error).toBe("agent errored");
    await t.relay.onStatus("agent-1", "running");
    expect((await t.store.get("t100"))?.status).toBe("running");
    expect((await t.store.get("t100"))?.error).toBeUndefined();
    const u = await setup({ status: "error", error: "agent errored" });
    await u.relay.onTurnEnd("agent-1", "Back.");
    expect((await u.store.get("t100"))?.status).toBe("needs-input");
    expect((await u.store.get("t100"))?.error).toBeUndefined();
  });

  it("a quiet done (a sign-out of its login ended the agent) is not the end of the issue's work", async () => {
    const t = await setup({ status: "needs-input" });
    const stop = t.relay.start();
    t.hub.emitEvent({ type: "agent-status", agentId: "agent-1", status: "done", quiet: true });
    await new Promise((r) => setTimeout(r, 30));
    expect((await t.store.get("t100"))?.status).toBe("needs-input");
    t.hub.emitEvent({ type: "agent-status", agentId: "agent-1", status: "done" });
    await vi.waitFor(async () => expect((await t.store.get("t100"))?.status).toBe("done"));
    stop();
  });

  it("start() wires both events from the hub", async () => {
    const t = await setup({});
    const stop = t.relay.start();
    t.hub.emitEvent({ type: "agent-turn-end", agentId: "agent-1", lastMessage: "Which browser?" });
    await vi.waitFor(async () => expect((await t.store.get("t100"))?.status).toBe("needs-input"));
    stop();
  });
});

describe("closeOrphans", () => {
  it("closes live issues whose agent record is gone, leaves the rest", async () => {
    const t = await setup({}, { agent: null });
    await t.store.create(makeIssue({ id: "t200", status: "pending", chatMessageIds: [200] }));
    await closeOrphans(t.store, t.agents);
    expect((await t.store.get("t100"))?.status).toBe("done");
    expect((await t.store.get("t200"))?.status).toBe("pending");
  });
});
