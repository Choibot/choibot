import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssuePoller, linkOnlyPoller, type PollerDeps } from "./poller.js";
import { TelegramError, type TgUpdate } from "./telegram.js";
import { fakeBotApi, clientFor, tgMessage, USER_ID } from "./testkit.js";

async function setup(o: { known?: Record<number, string>; tg?: PollerDeps["tg"]; onNew?: PollerDeps["onNew"] } = {}) {
  const bot = fakeBotApi();
  const dir = await mkdtemp(join(tmpdir(), "issues-poll-"));
  const seen = { callbacks: [] as string[], replies: [] as Array<[string, number]>, news: [] as number[] };
  const deps: PollerDeps = {
    tg: o.tg ?? clientFor(bot),
    userId: USER_ID,
    offsetFile: join(dir, "offset.json"),
    onCallback: async (cq) => { seen.callbacks.push(cq.data ?? ""); },
    onReply: async (id, m) => { seen.replies.push([id, m.message_id]); },
    onNew: o.onNew ?? ((m) => { seen.news.push(m.message_id); }),
    findIssueByMessageId: async (mid) => (o.known?.[mid] ? { id: o.known[mid] } : null),
  };
  return { bot, dir, seen, deps, poller: new IssuePoller(deps) };
}

describe("IssuePoller", () => {
  it("routes allowed updates and drops the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setup({ known: { 1000: "t9", 9: "t9" } });
    t.bot.push(
      { update_id: 1, message: tgMessage(10, { text: "Login broken" }) },
      { update_id: 2, message: tgMessage(11, { from: { id: 7 }, text: "spam" }) },
      { update_id: 3, message: tgMessage(12, { chat: { id: -100, type: "supergroup" }, migrate_to_chat_id: -1001 }) },
      { update_id: 4, message: tgMessage(13, { text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }) },
      { update_id: 5, message: tgMessage(14, { text: "Safari", reply_to_message: { message_id: 1000 } }) },
      { update_id: 6, message: tgMessage(15, { text: "new thing", reply_to_message: { message_id: 555 } }) },
      { update_id: 7, callback_query: { id: "c", from: { id: USER_ID }, message: tgMessage(1000), data: "f:t9" } },
      { update_id: 8, message: tgMessage(9, { text: "re-delivered" }) },
    );
    await t.poller.pollOnce();
    expect(t.seen.news).toEqual([10, 15]);
    expect(t.seen.replies).toEqual([["t9", 14]]);
    expect(t.seen.callbacks).toEqual(["f:t9"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("migrated"))).toBe(true);
    expect(JSON.parse(await readFile(t.deps.offsetFile, "utf8"))).toEqual({ offset: 9 });
    warn.mockRestore();
  });

  it("polls with the stored offset, also after a restart", async () => {
    const t = await setup();
    t.bot.push({ update_id: 41, message: tgMessage(1, { text: "a" }) });
    await t.poller.pollOnce();
    await t.poller.pollOnce();
    const restarted = new IssuePoller(t.deps);
    await restarted.loadOffset();
    await restarted.pollOnce();
    expect(t.bot.calls.map((c) => c.body.offset)).toEqual([0, 42, 42]);
    expect(t.bot.calls[0].body.timeout).toBe(30);
    expect(t.seen.news).toEqual([1]);
  });

  it("a failing handler does not block later updates", async () => {
    const t = await setup({ onNew: () => { throw new Error("boom"); } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.bot.push({ update_id: 1, message: tgMessage(1, { text: "a" }) });
    await t.poller.pollOnce();
    expect(JSON.parse(await readFile(t.deps.offsetFile, "utf8"))).toEqual({ offset: 2 });
    vi.restoreAllMocks();
  });

  it("a getUpdates error propagates and does not move the offset", async () => {
    const t = await setup();
    t.bot.failNext(409, "Conflict: terminated by other getUpdates request");
    await expect(t.poller.pollOnce()).rejects.toMatchObject({ status: 409 });
    await expect(readFile(t.deps.offsetFile, "utf8")).rejects.toThrow();
  });

  it("backs off 1 s, doubling, capped at 60 s", async () => {
    const t = await setup();
    const waits = Array.from({ length: 8 }, () => t.poller.nextBackoff());
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("the loop backs off after an error, recovers, and stops", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const tg: PollerDeps["tg"] = {
      getUpdates: async () => {
        n++;
        if (n === 1) throw new TelegramError(409, "Conflict");
        await new Promise((r) => setTimeout(r, 5)); // stand-in for the long poll
        return [];
      },
    };
    const waits: number[] = [];
    const t = await setup({ tg });
    const poller = new IssuePoller({ ...t.deps, sleep: async (ms) => { waits.push(ms); } });
    poller.start();
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(3));
    poller.stop();
    expect(waits).toEqual([1000]);
    vi.restoreAllMocks();
  });
});

describe("IssuePoller with issue intake off", () => {
  it("redirects new private messages; card replies and buttons still work", async () => {
    const t = await setup({ known: { 1000: "t9" } });
    const redirected: number[] = [];
    const p = new IssuePoller({ ...t.deps, intakeOff: true, onIntakeOff: (m) => { redirected.push(m.message_id); } });
    t.bot.push(
      { update_id: 1, message: tgMessage(10, { text: "Login broken" }) },
      { update_id: 2, message: tgMessage(14, { text: "Safari", reply_to_message: { message_id: 1000 } }) },
      { update_id: 3, callback_query: { id: "c", from: { id: USER_ID }, message: tgMessage(1000), data: "f:t9" } },
    );
    await p.pollOnce();
    expect(redirected).toEqual([10]);
    expect(t.seen.news).toEqual([]);
    expect(t.seen.replies).toEqual([["t9", 14]]);
    expect(t.seen.callbacks).toEqual(["f:t9"]);
  });
});

describe("IssuePoller master route", () => {
  it("routes master updates first, drops group noise, and leaves private routing alone", async () => {
    const t = await setup();
    const master: number[] = [];
    t.deps.master = {
      route: (u) => (u.message?.chat.id === -1001 ? (u.message.message_thread_id === 7 ? "master" : "drop") : "pass"),
      onMessage: async (m) => { master.push(m.message_id); },
    };
    const poller = new IssuePoller(t.deps);
    t.bot.push(
      { update_id: 1, message: tgMessage(10, { chat: { id: -1001, type: "supergroup" }, message_thread_id: 7, text: "hi" }) },
      { update_id: 2, message: tgMessage(11, { chat: { id: -1001, type: "supergroup" }, text: "general" }) },
      { update_id: 3, message: tgMessage(12, { text: "a private issue" }) },
    );
    await poller.pollOnce();
    await new Promise((r) => setImmediate(r));
    expect(master).toEqual([10]);
    expect(t.seen.news).toEqual([12]);
  });
});

describe("IssuePoller chief route", () => {
  const topicMsg = (id: number, text: string) =>
    tgMessage(id, { chat: { id: -1001, type: "supergroup" }, message_thread_id: 7, is_topic_message: true, text });

  async function withChief(chief: PollerDeps["chief"]) {
    const t = await setup();
    const master: number[] = [];
    const masterRoute = vi.fn((u: TgUpdate) => (u.message?.chat.id === -1001 ? "master" as const : "pass" as const));
    t.deps.master = { route: masterRoute, onMessage: async (m) => { master.push(m.message_id); } };
    t.deps.chief = chief;
    return { ...t, master, masterRoute, poller: new IssuePoller(t.deps) };
  }

  it("a handled update never reaches the master route or the master", async () => {
    const seen: number[] = [];
    const t = await withChief({ route: (u) => { seen.push(u.update_id); return "handled"; } });
    t.bot.push({ update_id: 1, message: topicMsg(10, "/pair laptop") });
    await t.poller.pollOnce();
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([1]);
    expect(t.masterRoute).not.toHaveBeenCalled();
    expect(t.master).toEqual([]);
    expect(t.seen.news).toEqual([]);
    expect(JSON.parse(await readFile(t.deps.offsetFile, "utf8"))).toEqual({ offset: 2 });
  });

  it("a passed update takes today's master and issues routing", async () => {
    const t = await withChief({ route: () => "pass" });
    t.bot.push(
      { update_id: 1, message: topicMsg(10, "hello master") },
      { update_id: 2, message: tgMessage(11, { text: "a private issue" }) },
    );
    await t.poller.pollOnce();
    await new Promise((r) => setImmediate(r));
    expect(t.masterRoute).toHaveBeenCalledTimes(2);
    expect(t.master).toEqual([10]);
    expect(t.seen.news).toEqual([11]);
  });

  it("without chief the routing is today's", async () => {
    const t = await withChief(undefined);
    t.bot.push(
      { update_id: 1, message: topicMsg(10, "/pair laptop") },
      { update_id: 2, message: tgMessage(11, { text: "a private issue" }) },
    );
    await t.poller.pollOnce();
    await new Promise((r) => setImmediate(r));
    expect(t.master).toEqual([10]);
    expect(t.seen.news).toEqual([11]);
  });
});

describe("the one-time codes of the Settings page (link)", () => {
  it("is asked before every other route; a handled update goes no further, a passed one goes on as before", async () => {
    const t = await setup();
    const asked: number[] = [];
    const poller = new IssuePoller({ ...t.deps, link: { route: async (u) => { asked.push(u.update_id); return u.update_id === 1 ? "handled" : "pass"; } } });
    t.bot.push(
      { update_id: 1, message: tgMessage(10, { text: "/start ABCD-EFGH" }) },
      { update_id: 2, message: tgMessage(11, { text: "Login broken" }) },
    );
    await poller.pollOnce();
    expect(asked).toEqual([1, 2]);
    expect(t.seen.news).toEqual([11]);
    expect(JSON.parse(await readFile(t.deps.offsetFile, "utf8"))).toEqual({ offset: 3 });
  });

  it("with no connected account only the link takes a message: nothing becomes an issue, and the offset moves on", async () => {
    const t = await setup();
    const asked: number[] = [];
    const poller = linkOnlyPoller({ tg: t.deps.tg, offsetFile: t.deps.offsetFile, link: { route: async (u) => { asked.push(u.update_id); return "pass"; } } });
    t.bot.push(
      { update_id: 5, message: tgMessage(10, { text: "Login broken" }) },
      { update_id: 6, callback_query: { id: "c", from: { id: USER_ID }, message: tgMessage(1000), data: "f:t9" } },
    );
    await poller.pollOnce();
    expect(asked).toEqual([5, 6]);
    expect(t.seen).toEqual({ callbacks: [], replies: [], news: [] });
    expect(JSON.parse(await readFile(t.deps.offsetFile, "utf8"))).toEqual({ offset: 7 });
  });
});
