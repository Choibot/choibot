import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueActions } from "./actions.js";
import { IssueStore, type Issue } from "./store.js";
import { SessionStore } from "../agents/store.js";
import { fakeBotApi, clientFor, makeIssue, USER_ID } from "./testkit.js";

async function setup(opts: {
  dispatch?: (i: Issue) => Promise<string>; telegram?: boolean; listRepoNames?: () => Promise<string[]>;
} = {}) {
  const store = new IssueStore(await mkdtemp(join(tmpdir(), "issues-act-")));
  const bot = fakeBotApi();
  const dispatched: Issue[] = [];
  const actions = new IssueActions({
    store,
    ...(opts.telegram === false ? {} : { tg: clientFor(bot), chatId: USER_ID }),
    dispatch: async (i) => { dispatched.push(i); return opts.dispatch ? opts.dispatch(i) : "agent-1"; },
    ...(opts.listRepoNames ? { listRepoNames: opts.listRepoNames } : {}),
  });
  return { store, bot, actions, dispatched };
}
const cq = (data: string) => ({ id: "cq", from: { id: USER_ID }, data });
const texts = (kb: any) => kb.inline_keyboard.flat().map((b: any) => b.text);

describe("IssueActions", () => {
  it("sendCard posts the card as a reply to the source message and records it", async () => {
    const t = await setup();
    await t.store.create(makeIssue());
    await t.actions.sendCard("t100");
    const body = t.bot.sent()[0];
    expect(body).toMatchObject({ chat_id: USER_ID, text: expect.stringMatching(/^Repo: choibot · Login button broken\n/), reply_parameters: { message_id: 100 } });
    expect(texts(body.reply_markup)).toEqual(["Fix", "Repo ▾", "Drop"]);
    expect(await t.store.get("t100")).toMatchObject({ cardMessageId: 1000, chatMessageIds: [100, 1000] });
  });

  it("post replies to the card and records the bot message", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ cardMessageId: 900, chatMessageIds: [100, 900] }));
    await t.actions.post("t100", "hello");
    expect(t.bot.sent()[0]).toMatchObject({ text: "hello", reply_parameters: { message_id: 900 } });
    expect((await t.store.get("t100"))?.chatMessageIds).toEqual([100, 900, 1000]);
  });

  it("fix is compare-and-set: two taps start one agent", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ cardMessageId: 1000, chatMessageIds: [100, 1000] }));
    const [a, b] = await Promise.all([t.actions.fix("t100"), t.actions.fix("t100")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(t.dispatched).toHaveLength(1);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", agentId: "agent-1" });
    expect(t.bot.sent("editMessageText")[0]).toEqual({ chat_id: USER_ID, message_id: 1000, text: "Fixing… · choibot" });
  });

  it("fix refuses an issue with no repo, and an unknown id", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ repo: null }));
    expect(await t.actions.fix("t100")).toEqual({ ok: false, code: 409, error: "pick a repo first" });
    expect(await t.actions.fix("t999")).toEqual({ ok: false, code: 404, error: "not found" });
    expect(t.dispatched).toEqual([]);
  });

  it("a failed start becomes error with the reason, and Fix retries it", async () => {
    let fail = true;
    const t = await setup({ dispatch: async () => { if (fail) throw new Error("worktree busy"); return "agent-2"; } });
    await t.store.create(makeIssue({ cardMessageId: 1000, chatMessageIds: [100, 1000] }));
    expect(await t.actions.fix("t100")).toEqual({ ok: false, code: 500, error: "worktree busy" });
    expect(await t.store.get("t100")).toMatchObject({ status: "error", error: "worktree busy" });
    const lastEdit = t.bot.sent("editMessageText").at(-1)!;
    expect(lastEdit.text).toContain("Start failed: worktree busy");
    expect(texts(lastEdit.reply_markup)[0]).toBe("Fix");
    expect(t.bot.sent().at(-1)).toMatchObject({ text: "Start failed: worktree busy", reply_parameters: { message_id: 1000 } });
    fail = false;
    expect((await t.actions.fix("t100")).ok).toBe(true);
    const done = await t.store.get("t100");
    expect(done).toMatchObject({ status: "running", agentId: "agent-2" });
    expect(done?.error).toBeUndefined();
  });

  it("setRepo accepts only a listed repo on an actionable issue", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ repo: null, repoConfidence: 0.3 }));
    expect(await t.actions.setRepo("t100", "nope")).toEqual({ ok: false, code: 400, error: "unknown repo" });
    expect((await t.actions.setRepo("t100", "app-shop")).ok).toBe(true);
    expect(await t.store.get("t100")).toMatchObject({ repo: "app-shop", repoConfidence: 1 });
    await t.store.update("t100", (c) => ({ ...c, status: "running", agentId: "a" }));
    expect(await t.actions.setRepo("t100", "choibot")).toEqual({ ok: false, code: 409, error: "issue is running" });
  });

  it("setRepo refreshes empty repoChoices (repo list failed at intake) before it validates", async () => {
    let calls = 0;
    const t = await setup({ listRepoNames: async () => { calls++; return ["app-shop", "choibot"]; } });
    await t.store.create(makeIssue({ repo: null, repoConfidence: 0, repoChoices: [] }));
    expect(await t.actions.setRepo("t100", "nope")).toEqual({ ok: false, code: 400, error: "unknown repo" });
    expect((await t.actions.setRepo("t100", "app-shop")).ok).toBe(true);
    expect(await t.store.get("t100")).toMatchObject({
      repo: "app-shop", repoConfidence: 1, repoChoices: ["app-shop", "choibot"],
    });
    expect(calls).toBe(1); // stored after the first refresh, then reused
  });

  it("setRepo with empty repoChoices and a failing lister refuses as unknown repo", async () => {
    const t = await setup({ listRepoNames: async () => { throw new Error("ls failed"); } });
    await t.store.create(makeIssue({ repo: null, repoChoices: [] }));
    expect(await t.actions.setRepo("t100", "app-shop")).toEqual({ ok: false, code: 400, error: "unknown repo" });
  });

  it("drop closes pending/starting/error issues only", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ cardMessageId: 1000 }));
    expect((await t.actions.drop("t100")).ok).toBe(true);
    expect(t.bot.sent("editMessageText").at(-1)).toEqual({ chat_id: USER_ID, message_id: 1000, text: "Dropped" });
    await t.store.create(makeIssue({ id: "t200", status: "running", agentId: "a" }));
    expect(await t.actions.drop("t200")).toEqual({ ok: false, code: 409, error: "issue is running" });
  });

  it("Repo ▾ opens the picker, Back restores the card, a pick sets the repo, Drop drops", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ repo: null, repoConfidence: 0.4, cardMessageId: 1000 }));
    await t.actions.handleCallback(cq("p:t100"));
    expect(texts(t.bot.sent("editMessageText")[0].reply_markup)).toEqual(["app-shop", "choibot", "Back"]);
    await t.actions.handleCallback(cq("b:t100"));
    expect(texts(t.bot.sent("editMessageText")[1].reply_markup)).toEqual(["Repo ▾", "Drop"]);
    await t.actions.handleCallback(cq("r:t100:0"));
    expect(await t.store.get("t100")).toMatchObject({ repo: "app-shop", repoConfidence: 1 });
    const card = t.bot.sent("editMessageText")[2];
    expect(card.text).toMatch(/^Repo: app-shop · Login button broken\n/);
    expect(texts(card.reply_markup)).toEqual(["Fix", "Repo ▾", "Drop"]);
    await t.actions.handleCallback(cq("d:t100"));
    expect((await t.store.get("t100"))?.status).toBe("dropped");
    expect(t.bot.sent("answerCallbackQuery")).toHaveLength(4);
  });

  it("Repo ▾ on an issue with empty repoChoices refreshes them, so a pick works", async () => {
    const t = await setup({ listRepoNames: async () => ["app-shop", "choibot"] });
    await t.store.create(makeIssue({ repo: null, repoConfidence: 0, repoChoices: [], cardMessageId: 1000 }));
    await t.actions.handleCallback(cq("p:t100"));
    expect(texts(t.bot.sent("editMessageText")[0].reply_markup)).toEqual(["app-shop", "choibot", "Back"]);
    await t.actions.handleCallback(cq("r:t100:1"));
    expect(await t.store.get("t100")).toMatchObject({ repo: "choibot", repoConfidence: 1 });
  });

  it("answers every tap and ignores stale or forged ones", async () => {
    const t = await setup();
    await t.store.create(makeIssue({ status: "running", agentId: "agent-0", cardMessageId: 1000 }));
    await t.actions.handleCallback(cq("f:t100"));
    await t.actions.handleCallback(cq("r:t100:42"));
    await t.actions.handleCallback(cq("p:t100"));
    await t.actions.handleCallback(cq("garbage"));
    await t.actions.handleCallback(cq("f:t999"));
    expect(t.bot.sent("answerCallbackQuery")).toHaveLength(5);
    expect(t.dispatched).toEqual([]);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", repo: "choibot" });
    expect(t.bot.sent("editMessageText")).toEqual([]);
  });

  it("boot recovery links a started agent, or resets to pending and resends the card", async () => {
    const t = await setup();
    const agents = new SessionStore(await mkdtemp(join(tmpdir(), "issues-agents-")));
    await agents.save({
      id: "agent-7", label: "", repo: "/ws/r", worktree: "/w", branch: "b", baseBranch: "main",
      sessionId: null, hookToken: "t", status: "running", createdAt: 1, kind: "issue", issueId: "t1",
    });
    await t.store.create(makeIssue({ id: "t1", status: "starting", chatMessageIds: [1], cardMessageId: 900 }));
    await t.store.create(makeIssue({ id: "t2", status: "starting", chatMessageIds: [2], cardMessageId: 901 }));
    await t.store.create(makeIssue({ id: "t3", status: "pending", chatMessageIds: [3] })); // crashed before its card
    await t.actions.recoverStarting(agents);
    expect(await t.store.get("t1")).toMatchObject({ status: "running", agentId: "agent-7" });
    expect(await t.store.get("t2")).toMatchObject({ status: "pending" });
    expect((await t.store.get("t2"))?.cardMessageId).not.toBe(901);
    expect(t.bot.sent().map((b) => b.reply_parameters?.message_id).sort()).toEqual([2, 3]);
  });

  it("boot recovery leaves an in-flight fix alone: one agent, one card, status running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = await setup({ dispatch: async () => { await gate; return "agent-1"; } });
    const agents = new SessionStore(await mkdtemp(join(tmpdir(), "issues-agents-")));
    await t.store.create(makeIssue({ cardMessageId: 1000, chatMessageIds: [100, 1000] }));
    const fixing = t.actions.fix("t100");
    await vi.waitFor(() => expect(t.dispatched).toHaveLength(1)); // CAS won, spawn blocked
    expect((await t.store.get("t100"))?.status).toBe("starting");
    await t.actions.recoverStarting(agents); // no agent record exists yet
    expect((await t.store.get("t100"))?.status).toBe("starting");
    release();
    expect((await fixing).ok).toBe(true);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", agentId: "agent-1", cardMessageId: 1000 });
    expect(t.bot.sent()).toEqual([]); // no second card
    expect(t.dispatched).toHaveLength(1);
  });

  it("a losing concurrent fix never clears the winner's in-flight mark", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = await setup({ dispatch: async () => { await gate; return "agent-1"; } });
    const agents = new SessionStore(await mkdtemp(join(tmpdir(), "issues-agents-")));
    await t.store.create(makeIssue({ repo: null, cardMessageId: 1000, chatMessageIds: [100, 1000] }));
    const losing = t.actions.fix("t100"); // CAS queued first, loses: no repo yet
    void t.actions.setRepo("t100", "app-shop");
    const winning = t.actions.fix("t100"); // CAS queued after the repo is set
    expect(await losing).toEqual({ ok: false, code: 409, error: "pick a repo first" });
    await vi.waitFor(() => expect(t.dispatched).toHaveLength(1));
    await t.actions.recoverStarting(agents);
    expect((await t.store.get("t100"))?.status).toBe("starting");
    release();
    expect((await winning).ok).toBe(true);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", agentId: "agent-1", cardMessageId: 1000 });
    expect(t.bot.sent()).toEqual([]);
  });

  it("works with Telegram off: fix runs, nothing is sent", async () => {
    const t = await setup({ telegram: false });
    await t.store.create(makeIssue({ source: "ui", id: "uabcdefgh", chatMessageIds: [] }));
    expect((await t.actions.fix("uabcdefgh")).ok).toBe(true);
    await t.actions.post("uabcdefgh", "x");
    expect(t.bot.calls).toEqual([]);
  });
});
