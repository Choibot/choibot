import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendToAgent, typeIntoAgent, typeIntoAgentWhy, withTypingLock, handleReply, REATTACH_SETTLE_MS, REPLY_TEXT, type ReplyDeps } from "./reply.js";
import { IssueActions } from "./actions.js";
import { IssueIntake } from "./intake.js";
import { IssueStore, type Issue } from "./store.js";
import { SessionStore } from "../agents/store.js";
import { fakeBotApi, clientFor, makeIssue, tgMessage, USER_ID } from "./testkit.js";
import { captureUserLine, type CaptureLine } from "../chief/brain/capture.js";
import { DecisionLog, RuleStore, type Rule } from "../chief/brain/store.js";

function fakeTerms(o: { attached?: boolean; session?: boolean; ready?: boolean } = {}) {
  const live = new Set<string>(o.attached ? ["agent-1"] : []);
  const writes: string[] = [];
  const state = { reattached: 0, ready: o.ready ?? true };
  return {
    writes, state,
    has: (id: string) => live.has(id),
    hasSession: async (id: string) => live.has(id) || !!o.session,
    inputReady: (id: string) => live.has(id) && state.ready,
    reattach: async (id: string) => {
      if (!o.session) return null;
      state.reattached++;
      live.add(id);
      return { snapshot: "", subscribe: () => () => {} };
    },
    write: (_id: string, d: string) => { writes.push(d); },
  };
}

async function setup(
  issue: Partial<Issue>,
  o: { terms?: ReturnType<typeof fakeTerms>; agent?: boolean; files?: Record<string, Buffer> } = {},
) {
  const store = new IssueStore(await mkdtemp(join(tmpdir(), "issues-reply-")));
  const bot = fakeBotApi({ files: o.files });
  const tg = clientFor(bot);
  const actions = new IssueActions({ store, tg, chatId: USER_ID, dispatch: async () => "x" });
  const intake = new IssueIntake({ store, actions, tg, listRepoNames: async () => [], guess: async () => ({ repo: null, confidence: 0 }) });
  const agents = new SessionStore(await mkdtemp(join(tmpdir(), "issues-reply-agents-")));
  if (o.agent !== false) {
    await agents.save({
      id: "agent-1", label: "issue: x", repo: "/ws/r", worktree: "/w", branch: "agent/a1", baseBranch: "main",
      sessionId: null, hookToken: "t", status: "idle", createdAt: 1, kind: "issue", issueId: "t100",
    });
  }
  await store.create(makeIssue({ cardMessageId: 1000, chatMessageIds: [100, 1000], ...issue }));
  const terms = o.terms ?? fakeTerms({ attached: true });
  const deps: ReplyDeps = { store, actions, intake, agents, terminals: terms, sleep: async () => {} };
  return { store, bot, terms, deps };
}
const reply = (id: number, text: string) => tgMessage(id, { text, reply_to_message: { message_id: 1000 } });
const lastPost = (bot: ReturnType<typeof fakeBotApi>) => bot.sent().at(-1)?.text;

// The incident of 2026-11-20: a console line typed into Claude's folder trust dialog picked
// "No, exit". Every console line goes through typeIntoAgent, so the rule is tested here.
describe("no line while a dialog is on the agent's screen", () => {
  const withDialog = (o: Parameters<typeof fakeTerms>[0], dialog: { on: boolean }) => {
    const asked: string[] = [];
    const terms = { ...fakeTerms(o), dialogOn: async (id: string) => { asked.push(id); return dialog.on; } };
    return { terms, asked };
  };

  it("writes nothing and says why; when the dialog is gone the line goes", async () => {
    const dialog = { on: true };
    const { terms } = withDialog({ attached: true }, dialog);
    expect(await typeIntoAgentWhy(terms, "agent-1", "[events] cron nightly failed", async () => {})).toBe("dialog");
    expect(await typeIntoAgent(terms, "agent-1", "[events] cron nightly failed", async () => {})).toBe(false);
    expect(terms.writes).toEqual([]);
    dialog.on = false;
    expect(await typeIntoAgentWhy(terms, "agent-1", "[events] cron nightly failed", async () => {})).toBe("sent");
    expect(terms.writes).toEqual(["\x1b[200~[events] cron nightly failed\x1b[201~", "\r"]);
  });

  it("a session that outlived a restart is reattached and its screen has time to come back before the check", async () => {
    const dialog = { on: true };
    const { terms, asked } = withDialog({ session: true }, dialog);
    const sleeps: number[] = [];
    expect(await typeIntoAgentWhy(terms, "agent-1", "hello", async (ms) => { sleeps.push(ms); expect(asked).toEqual([]); })).toBe("dialog");
    expect(terms.state.reattached).toBe(1);
    expect(sleeps).toEqual([REATTACH_SETTLE_MS]);
    expect(terms.writes).toEqual([]);
  });

  it("sendToAgent (Telegram replies, widget asks, the go-on line) answers `starting`: the line can go later", async () => {
    const { terms } = withDialog({ attached: true }, { on: true });
    expect(await sendToAgent(terms, "agent-1", "go on", async () => {})).toBe("starting");
    expect(terms.writes).toEqual([]);
  });

  it("a check that throws does not hold the line, and a terminal set with no check types as before", async () => {
    const terms = { ...fakeTerms({ attached: true }), dialogOn: async () => { throw new Error("no screen"); } };
    expect(await typeIntoAgentWhy(terms, "agent-1", "x", async () => {})).toBe("sent");
    expect(await typeIntoAgentWhy(fakeTerms({}), "agent-1", "x", async () => {})).toBe("not-live");
  });
});

describe("sendToAgent", () => {
  it("pastes as one bracketed paste and sends Enter as a separate write ~100 ms later", async () => {
    const terms = fakeTerms({ attached: true });
    const sleeps: number[] = [];
    expect(await sendToAgent(terms, "agent-1", "line one\nline two", async (ms) => { sleeps.push(ms); })).toBe("sent");
    expect(terms.writes).toEqual(["\x1b[200~line one\nline two\x1b[201~", "\r"]);
    expect(sleeps).toEqual([100]);
  });

  it("strips ESC and C1 CSI bytes so the text cannot end the paste early", async () => {
    const terms = fakeTerms({ attached: true });
    await sendToAgent(terms, "agent-1", "a\x1b[201~\rrm -rf /\x1b[200~\x9b201~b", async () => {});
    expect(terms.writes[0]).toBe("\x1b[200~a[201~rm -rf /[200~201~b\x1b[201~");
    expect(terms.writes[0]).not.toContain("\x9b");
    expect(terms.writes[0].split("\x1b").length - 1).toBe(2); // only our own two markers
  });

  it("strips other C0 controls, CR and DEL but keeps newlines and tabs", async () => {
    const terms = fakeTerms({ attached: true });
    await sendToAgent(terms, "agent-1", "a\x00b\x03c\x07d\x08e\x7ff\r\ng\th\x0bi\x0cj\x1fk\nl", async () => {});
    expect(terms.writes).toEqual(["\x1b[200~abcdef\ng\thijk\nl\x1b[201~", "\r"]);
  });

  it("reattaches a persisted session that is not attached in this process", async () => {
    const terms = fakeTerms({ session: true });
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {})).toBe("sent");
    expect(terms.state.reattached).toBe(1);
    expect(terms.writes).toHaveLength(2);
  });

  it("returns not-live and writes nothing when there is no session", async () => {
    const terms = fakeTerms();
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {})).toBe("not-live");
    expect(terms.writes).toEqual([]);
  });

  it("checkReady: a tracked PTY that is not input-ready returns starting and gets nothing", async () => {
    const terms = fakeTerms({ attached: true, ready: false });
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {}, { checkReady: true })).toBe("starting");
    expect(terms.writes).toEqual([]);
  });

  it("checkReady: a tracked PTY that is input-ready is typed into", async () => {
    const terms = fakeTerms({ attached: true });
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {}, { checkReady: true })).toBe("sent");
    expect(terms.writes).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
  });

  it("checkReady: an untracked live session is reattached and typed into", async () => {
    const terms = fakeTerms({ session: true, ready: false });
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {}, { checkReady: true })).toBe("sent");
    expect(terms.state.reattached).toBe(1);
    expect(terms.writes).toHaveLength(2);
  });

  it("checkReady: no session returns not-live and writes nothing", async () => {
    const terms = fakeTerms();
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {}, { checkReady: true })).toBe("not-live");
    expect(terms.writes).toEqual([]);
  });

  it("checkReady: readiness is checked inside the typing lock, after the holder before it", async () => {
    const terms = fakeTerms({ attached: true });
    const held = withTypingLock("agent-1", async () => {
      await new Promise((r) => setTimeout(r, 0));
      terms.state.ready = false; // a relaunch respawned the PTY while it held the lock
    });
    const sent = sendToAgent(terms, "agent-1", "hi", async () => {}, { checkReady: true });
    await held;
    expect(await sent).toBe("starting");
    expect(terms.writes).toEqual([]);
  });

  it("flag off: without checkReady a tracked PTY that is not input-ready is typed into as today", async () => {
    const terms = fakeTerms({ attached: true, ready: false });
    expect(await sendToAgent(terms, "agent-1", "hi", async () => {})).toBe("sent");
    expect(terms.writes).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
  });
});

describe("withTypingLock", () => {
  it("two concurrent sends on one agent do not interleave paste and Enter", async () => {
    const terms = fakeTerms({ attached: true });
    const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / 10));
    await Promise.all([
      sendToAgent(terms, "agent-1", "one", slow),
      sendToAgent(terms, "agent-1", "two", slow),
    ]);
    expect(terms.writes).toEqual(["\x1b[200~one\x1b[201~", "\r", "\x1b[200~two\x1b[201~", "\r"]);
  });

  it("goes on after a holder throws", async () => {
    const order: string[] = [];
    const a = withTypingLock("lock-x", async () => { order.push("a"); throw new Error("boom"); });
    const b = withTypingLock("lock-x", async () => { order.push("b"); return 2; });
    await expect(a).rejects.toThrow("boom");
    expect(await b).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("handleReply", () => {
  it("needs-input: sends to the agent and goes back to running", async () => {
    const t = await setup({ status: "needs-input", agentId: "agent-1" });
    await handleReply(t.deps, "t100", reply(200, "Safari 17"));
    expect(t.terms.writes).toEqual(["\x1b[200~Safari 17\x1b[201~", "\r"]);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", chatMessageIds: [100, 1000, 200] });
  });

  it("pr-open: sends follow-up work and stays pr-open", async () => {
    const t = await setup({ status: "pr-open", agentId: "agent-1", prUrl: "https://github.com/o/r/pull/7" });
    await handleReply(t.deps, "t100", reply(201, "also fix the footer"));
    expect(t.terms.writes).toHaveLength(2);
    expect((await t.store.get("t100"))?.status).toBe("pr-open");
  });

  it("a reply to a closed, stopped agent resumes it with the reply as the prompt", async () => {
    const t = await setup({ status: "running", agentId: "agent-1" }, { terms: fakeTerms() });
    const resumed: [string, string][] = [];
    t.deps.resumeClosed = async (id, text) => { resumed.push([id, text]); return true; };
    await handleReply(t.deps, "t100", reply(214, "pick it up again"));
    expect(resumed).toEqual([["agent-1", "pick it up again"]]);
    expect(t.terms.writes).toEqual([]);
    expect(lastPost(t.bot)).not.toBe(REPLY_TEXT.notLive);
  });

  it("skips a re-delivered reply", async () => {
    const t = await setup({ status: "running", agentId: "agent-1" });
    await handleReply(t.deps, "t100", reply(202, "once"));
    await handleReply(t.deps, "t100", reply(202, "once"));
    expect(t.terms.writes).toHaveLength(2);
  });

  it("pending: appends the text and re-renders the card", async () => {
    const t = await setup({ status: "pending" });
    await handleReply(t.deps, "t100", reply(203, "only on mobile"));
    expect((await t.store.get("t100"))?.text).toBe("Login button broken\n\nonly on mobile");
    expect((await t.store.get("t100"))?.chatMessageIds).toContain(203);
    expect(t.bot.sent("editMessageText")).toHaveLength(1);
    expect(t.terms.writes).toEqual([]);
  });

  it("starting: records the reply, asks to resend, and leaves the text alone", async () => {
    const t = await setup({ status: "starting", agentId: "agent-1" });
    await handleReply(t.deps, "t100", reply(212, "only on mobile"));
    const cur = await t.store.get("t100");
    expect(cur?.chatMessageIds).toContain(212);
    expect(cur?.text).toBe("Login button broken");
    expect(cur?.status).toBe("starting");
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.starting);
    expect(REPLY_TEXT.starting).toBe("Agent is starting — send this again in a moment.");
    expect(t.bot.sent("editMessageText")).toHaveLength(0);
    expect(t.terms.writes).toEqual([]);
  });

  it("a photo-only reply whose download fails still reports the failure", async () => {
    const t = await setup({ status: "needs-input", agentId: "agent-1" });
    await handleReply(t.deps, "t100", tgMessage(213, {
      photo: [{ file_id: "big", width: 10, height: 10, file_size: 21 * 1024 * 1024 }], reply_to_message: { message_id: 1000 },
    }));
    expect(t.terms.writes).toHaveLength(2);
    expect(t.terms.writes[0]).not.toBe("\x1b[200~\x1b[201~");
    expect((await t.store.get("t100"))?.chatMessageIds).toContain(213);
  });

  it("dropped → issue closed; error without agent → tap Fix to retry", async () => {
    const a = await setup({ status: "dropped" });
    await handleReply(a.deps, "t100", reply(204, "?"));
    expect(lastPost(a.bot)).toBe(REPLY_TEXT.closed);
    const b = await setup({ status: "error", error: "boom" });
    await handleReply(b.deps, "t100", reply(205, "?"));
    expect(lastPost(b.bot)).toBe(REPLY_TEXT.startFailed);
  });

  it("done with a live session: reopens (pr-open if a PR exists) and sends", async () => {
    const t = await setup(
      { status: "done", agentId: "agent-1", prUrl: "https://github.com/o/r/pull/7" },
      { terms: fakeTerms({ session: true }) },
    );
    await handleReply(t.deps, "t100", reply(206, "one more thing"));
    expect(t.terms.writes).toHaveLength(2);
    expect((await t.store.get("t100"))?.status).toBe("pr-open");
  });

  it("error with a live session: reopens, clears the error and sends", async () => {
    const t = await setup({ status: "error", error: "agent errored", agentId: "agent-1" }, { terms: fakeTerms({ session: true }) });
    await handleReply(t.deps, "t100", reply(210, "try again"));
    expect(t.terms.writes).toHaveLength(2);
    expect((await t.store.get("t100"))?.status).toBe("running");
    expect((await t.store.get("t100"))?.error).toBeUndefined();
  });

  it("error with agent but no session → tell the user to resume", async () => {
    const t = await setup({ status: "error", agentId: "agent-1" }, { terms: fakeTerms() });
    await handleReply(t.deps, "t100", reply(207, "hello?"));
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.notLive);
    expect((await t.store.get("t100"))?.status).toBe("error");
  });

  it("done with the agent deleted → issue closed", async () => {
    const t = await setup({ status: "done", agentId: "agent-1" }, { agent: false });
    await handleReply(t.deps, "t100", reply(208, "hello?"));
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.closed);
  });

  it("running with the agent deleted → done and issue closed", async () => {
    const t = await setup({ status: "running", agentId: "agent-1" }, { agent: false });
    await handleReply(t.deps, "t100", reply(209, "hello?"));
    expect((await t.store.get("t100"))?.status).toBe("done");
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.closed);
  });

  it("running but the session is gone → tell the user to resume", async () => {
    const t = await setup({ status: "running", agentId: "agent-1" }, { terms: fakeTerms() });
    await handleReply(t.deps, "t100", reply(210, "hello?"));
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.notLive);
    expect(t.terms.writes).toEqual([]);
  });

  it("checkReady: running, PTY not input-ready → asks to resend, types nothing, stays running", async () => {
    const t = await setup({ status: "running", agentId: "agent-1" }, { terms: fakeTerms({ attached: true, ready: false }) });
    t.deps.checkReady = true;
    await handleReply(t.deps, "t100", reply(215, "hello?"));
    expect(t.terms.writes).toEqual([]);
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.starting);
    const cur = await t.store.get("t100");
    expect(cur?.status).toBe("running");
    expect(cur?.chatMessageIds).toContain(215);
  });

  it("checkReady: done, PTY not input-ready → asks to resend and does not reopen", async () => {
    const t = await setup({ status: "done", agentId: "agent-1" }, { terms: fakeTerms({ attached: true, ready: false }) });
    t.deps.checkReady = true;
    await handleReply(t.deps, "t100", reply(216, "one more thing"));
    expect(t.terms.writes).toEqual([]);
    expect(lastPost(t.bot)).toBe(REPLY_TEXT.starting);
    const cur = await t.store.get("t100");
    expect(cur?.status).toBe("done");
    expect(cur?.chatMessageIds).toContain(216);
  });

  it("flag off: without checkReady a PTY that is not input-ready is typed into as today", async () => {
    const t = await setup({ status: "needs-input", agentId: "agent-1" }, { terms: fakeTerms({ attached: true, ready: false }) });
    await handleReply(t.deps, "t100", reply(217, "Safari 17"));
    expect(t.terms.writes).toEqual(["\x1b[200~Safari 17\x1b[201~", "\r"]);
    expect((await t.store.get("t100"))?.status).toBe("running");
  });

  it("a photo reply is downloaded and its path is pasted with the caption", async () => {
    const t = await setup({ status: "needs-input", agentId: "agent-1" }, { files: { "photos/rp.jpg": Buffer.from("img") } });
    await handleReply(t.deps, "t100", tgMessage(211, {
      caption: "this one", photo: [{ file_id: "rp", width: 10, height: 10 }], reply_to_message: { message_id: 1000 },
    }));
    const path = join(t.store.dir, "t100", "reply-211-1.jpg");
    expect(t.terms.writes[0]).toBe(`\x1b[200~this one\n\nScreenshot (read it with the Read tool): ${path}\x1b[201~`);
  });
});

// Spec §6.2 source 2 and plan ambiguity 13: a reply typed into the agent is a
// user line (via issue-telegram); a `rule:` reply makes a candidate, and a
// duplicate one gets its hint in the issue thread.
describe("handleReply capture (chief)", () => {
  const PR = "https://github.com/o/r/pull/7";
  async function withCapture(issue: Partial<Issue>, o: Parameters<typeof setup>[1] = {}) {
    const t = await setup(issue, o);
    const dir = await mkdtemp(join(tmpdir(), "issues-reply-brain-"));
    const decisions = new DecisionLog(join(dir, "decisions.jsonl"));
    const rules = new RuleStore(join(dir, "rules.jsonl"));
    const cards: Rule[] = [];
    t.deps.capture = (line) => captureUserLine({ decisions, rules, onCandidate: async (r) => { cards.push(r); } }, line);
    const lines = async () => (await decisions.read()).map(({ at: _at, ...rest }) => rest);
    return { ...t, dir, decisions, rules, cards, lines };
  }

  it("a sent reply is logged with via issue-telegram, the agent id and the record's prUrl", async () => {
    const t = await withCapture({ status: "pr-open", agentId: "agent-1", prUrl: PR });
    await handleReply(t.deps, "t100", reply(301, "also fix the footer"));
    expect(t.terms.writes).toEqual(["\x1b[200~also fix the footer\x1b[201~", "\r"]);
    await vi.waitFor(async () => expect(await t.lines()).toEqual([
      { by: "user", correction: null, via: "issue-telegram", agentId: "agent-1", prUrl: PR, text: "also fix the footer" },
    ]));
  });

  it("logs a reply that resumed a closed agent, and a reopened done issue", async () => {
    const a = await withCapture({ status: "running", agentId: "agent-1" }, { terms: fakeTerms() });
    a.deps.resumeClosed = async () => true;
    await handleReply(a.deps, "t100", reply(302, "pick it up again"));
    await vi.waitFor(async () => expect((await a.lines()).map((l) => l.text)).toEqual(["pick it up again"]));
    const b = await withCapture({ status: "done", agentId: "agent-1" }, { terms: fakeTerms({ session: true }) });
    await handleReply(b.deps, "t100", reply(303, "one more thing"));
    await vi.waitFor(async () => expect((await b.lines()).map((l) => l.via)).toEqual(["issue-telegram"]));
  });

  it("logs the user's caption only, not the screenshot note", async () => {
    const t = await withCapture({ status: "needs-input", agentId: "agent-1" }, { files: { "photos/rp.jpg": Buffer.from("img") } });
    await handleReply(t.deps, "t100", tgMessage(304, {
      caption: "this one", photo: [{ file_id: "rp", width: 10, height: 10 }], reply_to_message: { message_id: 1000 },
    }));
    expect(t.terms.writes[0]).toContain("Screenshot (read it with the Read tool)");
    await vi.waitFor(async () => expect((await t.lines()).map((l) => l.text)).toEqual(["this one"]));
  });

  it("a reply that was not typed is not logged", async () => {
    const pending = await withCapture({ status: "pending" });
    await handleReply(pending.deps, "t100", reply(305, "only on mobile"));
    const gone = await withCapture({ status: "running", agentId: "agent-1" }, { terms: fakeTerms() });
    await handleReply(gone.deps, "t100", reply(306, "hello?"));
    const starting = await withCapture({ status: "running", agentId: "agent-1" }, { terms: fakeTerms({ attached: true, ready: false }) });
    starting.deps.checkReady = true;
    await handleReply(starting.deps, "t100", reply(307, "hello?"));
    await new Promise((r) => setTimeout(r, 20));
    for (const t of [pending, gone, starting]) expect(await t.decisions.read()).toEqual([]);
  });

  it("rule: → candidate with origin user-line and onCandidate; the reply is typed unchanged", async () => {
    const t = await withCapture({ status: "running", agentId: "agent-1", prUrl: PR });
    await handleReply(t.deps, "t100", reply(308, "rule: always run tests"));
    expect(t.terms.writes).toEqual(["\x1b[200~rule: always run tests\x1b[201~", "\r"]);
    await vi.waitFor(async () => expect(await t.rules.all()).toHaveLength(1));
    expect((await t.rules.all())[0]).toMatchObject({
      text: "always run tests", state: "candidate",
      source: { origin: "user-line", via: "issue-telegram", agentId: "agent-1", prUrl: PR },
    });
    await vi.waitFor(() => expect(t.cards).toHaveLength(1));
  });

  it("a duplicate rule: posts the hint in the issue thread", async () => {
    const t = await withCapture({ status: "running", agentId: "agent-1" });
    await handleReply(t.deps, "t100", reply(309, "rule: always run tests"));
    await vi.waitFor(async () => expect(await t.rules.all()).toHaveLength(1));
    const [first] = await t.rules.all();
    await handleReply(t.deps, "t100", reply(310, "Rule: always run tests!"));
    await vi.waitFor(() => expect(lastPost(t.bot)).toBe(`Already a rule (${first!.id}).`));
    expect(t.bot.sent("sendMessage").at(-1)).toMatchObject({ reply_parameters: { message_id: 1000 } });
    await vi.waitFor(async () => expect((await t.store.get("t100"))?.chatMessageIds.length).toBe(5));
    expect(t.terms.writes).toHaveLength(4);
  });

  it("a throwing capture still records the reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setup({ status: "needs-input", agentId: "agent-1" });
    const seen: CaptureLine[] = [];
    t.deps.capture = (line) => { seen.push(line); throw new Error("capture broke"); };
    await handleReply(t.deps, "t100", reply(311, "Safari 17"));
    expect(t.terms.writes).toEqual(["\x1b[200~Safari 17\x1b[201~", "\r"]);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", chatMessageIds: [100, 1000, 311] });
    await vi.waitFor(() => expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("capture broke"));
    expect(seen).toEqual([{ text: "Safari 17", via: "issue-telegram", agentId: "agent-1" }]);
    t.deps.capture = async () => { throw new Error("capture rejected"); };
    await handleReply(t.deps, "t100", reply(312, "again"));
    expect((await t.store.get("t100"))?.chatMessageIds).toContain(312);
    await vi.waitFor(() => expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("capture rejected"));
    warn.mockRestore();
  });

  it("a capture that never resolves does not hold the reply", async () => {
    const t = await setup({ status: "needs-input", agentId: "agent-1" });
    t.deps.capture = () => new Promise(() => {});
    await handleReply(t.deps, "t100", reply(313, "Safari 17"));
    await handleReply(t.deps, "t100", reply(314, "and Chrome"));
    expect(t.terms.writes).toHaveLength(4);
    expect((await t.store.get("t100"))?.chatMessageIds).toEqual([100, 1000, 313, 314]);
  });

  it("flag off (no capture): same status, same posts, no decision line", async () => {
    const t = await setup({ status: "needs-input", agentId: "agent-1", prUrl: PR });
    const dir = await mkdtemp(join(tmpdir(), "issues-reply-off-"));
    await handleReply(t.deps, "t100", reply(315, "rule: always run tests"));
    expect(t.terms.writes).toEqual(["\x1b[200~rule: always run tests\x1b[201~", "\r"]);
    expect(await t.store.get("t100")).toMatchObject({ status: "running", chatMessageIds: [100, 1000, 315] });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.bot.sent("sendMessage")).toEqual([]);
    expect(existsSync(join(dir, "decisions.jsonl"))).toBe(false);
  });
});
