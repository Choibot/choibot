import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { CHIEF_TG_TEXT, ChiefTelegram, commandWord, type ChiefTgDeps } from "./telegram.js";
import { DeviceStore, PairingCodes } from "./auth.js";
import { IssuePoller } from "../issues/poller.js";
import { TG_TEXT_MAX, TelegramError, type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from "../issues/telegram.js";
import { clientFor, fakeBotApi, tgMessage, USER_ID } from "../issues/testkit.js";
import type { MasterTgConfig } from "../master/telegram.js";
import type { ConsoleEvent } from "../events.js";
import { onChain, readJsonl } from "./files.js";
import { chiefPaths } from "./paths.js";
import { CardIndex, proposalCardText, proposalKeyboard, ruleCardKeyboard, ruleCardText, sha256Hex } from "./cards.js";
import { DecisionLog, RuleStore, type Rule, type RuleEvent } from "./brain/store.js";
import { captureUserLine } from "./brain/capture.js";
import { readProposal } from "./brain/distill.js";
import type { QueueItem } from "./queue/types.js";
import { QueueStore, type NewItem } from "./queue/store.js";
import { QueueActions, withAnswer } from "./queue/actions.js";
import { AuditLog } from "./queue/auto.js";
import { ok } from "./queue/actions.fixture.js";
import { cardIdsOf } from "./queue/cards.js";
import type { MergeState } from "./queue/prgate.js";
import type { Caller } from "./auth.js";

const CFG: MasterTgConfig = { chatId: -1001, threadId: 7, userId: USER_ID };
const CONSOLE = "https://console.example.ts.net";
const forum = { id: -1001, type: "supergroup" as const, is_forum: true };

type SendOpts = { replyTo?: number; threadId?: number; keyboard?: InlineKeyboard };
type Sent = { chatId: number; text: string; opts?: SendOpts; messageId: number };
type Edit = { chatId: number; messageId: number; text: string; keyboard?: InlineKeyboard };

let nextId = 100;
// A message from the user in the Master topic; a leading /word gets a
// bot_command entity, as Telegram sends it.
function topic(text: string, over: Partial<TgMessage> = {}): TgUpdate {
  const id = nextId++;
  const cmd = /^\/\S+/.exec(text);
  return {
    update_id: id,
    message: tgMessage(id, {
      chat: forum, message_thread_id: 7, is_topic_message: true, text,
      ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd[0].length }] } : {}),
      ...over,
    }),
  };
}

// Fake client: `sent` holds only the messages Telegram accepted. `onSend` runs
// before a message is accepted and may throw (a refused send) or never resolve;
// `onEdit` the same for an edit.
function fakeTg(onSend?: (chatId: number, text: string) => unknown, onEdit?: (messageId: number) => unknown) {
  const sent: Sent[] = [];
  const attempts: Array<{ chatId: number; text: string }> = [];
  const deleted: Array<[number, number]> = [];
  const edits: Edit[] = [];
  let mid = 900;
  const tg: ChiefTgDeps["tg"] = {
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) => {
      await onEdit?.(messageId);
      edits.push({ chatId, messageId, text, keyboard });
    }),
    sendMessage: vi.fn(async (chatId: number, text: string, opts?: SendOpts) => {
      attempts.push({ chatId, text });
      await onSend?.(chatId, text);
      const messageId = mid++;
      sent.push({ chatId, text, opts, messageId });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, text } as TgMessage;
    }),
    deleteMessage: vi.fn(async (chatId: number, messageId: number) => { deleted.push([chatId, messageId]); }),
    answerCallbackQuery: vi.fn(async () => {}),
  };
  return { tg, sent, attempts, deleted, edits };
}

function setup(o: { misconfigured?: string | null; userAuth?: "telegram" | "log"; onSend?: (chatId: number, text: string) => unknown; tg?: ChiefTgDeps["tg"] } = {}) {
  const fake = fakeTg(o.onSend);
  const pairing = new PairingCodes({ setTimer: () => ({ clear() {} }) });
  const devices = { revoke: vi.fn(async (label: string) => label === "laptop") };
  const logs: string[] = [];
  const chief = new ChiefTelegram({
    tg: o.tg ?? fake.tg, cfg: CFG, consoleUrl: CONSOLE, misconfigured: o.misconfigured ?? null,
    ...(o.userAuth ? { userAuth: o.userAuth } : {}),
    pairing, devices, log: (s) => { logs.push(s); },
  });
  const mint = vi.spyOn(pairing, "mint");
  const mintedCode = (i = 0): string => (mint.mock.results[i].value as { code: string }).code;
  const topicReplies = () => fake.sent.filter((s) => s.chatId === CFG.chatId);
  const privates = () => fake.sent.filter((s) => s.chatId === CFG.userId);
  return { ...fake, pairing, devices, logs, chief, mint, mintedCode, topicReplies, privates };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("commandWord", () => {
  it("is the bot_command at offset 0, without the @botname", () => {
    expect(commandWord(topic("/pair laptop").message!)).toBe("/pair");
    expect(commandWord(topic("/pair@acmebot laptop").message!)).toBe("/pair");
    expect(commandWord(topic("/unpair@acmebot").message!)).toBe("/unpair");
  });

  it("is null for plain text, a command later in the text, or no text", () => {
    expect(commandWord(topic("pair laptop").message!)).toBeNull();
    const later = tgMessage(1, { text: "please /pair laptop", entities: [{ type: "bot_command", offset: 7, length: 5 }] });
    expect(commandWord(later)).toBeNull();
    const bold = tgMessage(2, { text: "/pair laptop", entities: [{ type: "bold", offset: 0, length: 5 }] });
    expect(commandWord(bold)).toBeNull();
    const noText = tgMessage(3, { entities: [{ type: "bot_command", offset: 0, length: 5 }] });
    expect(commandWord(noText)).toBeNull();
  });
});

describe("ChiefTelegram.route acceptance matrix", () => {
  it("handles /pair laptop only from the user in the configured chat and topic", async () => {
    const t = setup();
    const cases: Array<[string, TgUpdate]> = [
      ["other chat", topic("/pair laptop", { chat: { id: -2002, type: "supergroup", is_forum: true } })],
      ["private chat", topic("/pair laptop", { chat: { id: USER_ID, type: "private" }, message_thread_id: undefined, is_topic_message: undefined })],
      ["other thread", topic("/pair laptop", { message_thread_id: 8 })],
      ["General topic", topic("/pair laptop", { message_thread_id: undefined })],
      ["is_topic_message false", topic("/pair laptop", { is_topic_message: false })],
      ["is_topic_message absent", topic("/pair laptop", { is_topic_message: undefined })],
      ["other from.id", topic("/pair laptop", { from: { id: 9, first_name: "Eve" } })],
      ["no from", topic("/pair laptop", { from: undefined })],
    ];
    for (const [name, u] of cases) expect(t.chief.route(u), name).toBe("pass");
    await t.chief.idle();
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.attempts).toEqual([]);

    expect(t.chief.route(topic("/pair laptop"))).toBe("handled");
    await t.chief.idle();
    expect(t.mint).toHaveBeenCalledTimes(1);
  });

  it("handles /pair@acmebot laptop as /pair", async () => {
    const t = setup();
    expect(t.chief.route(topic("/pair@acmebot laptop"))).toBe("handled");
    await t.chief.idle();
    expect(t.mint).toHaveBeenCalledWith("laptop");
  });

  it("passes other text, other commands and callbacks (clauses a, b, d arrive in 1b)", async () => {
    const t = setup();
    const cq = { id: "c", from: { id: USER_ID }, message: tgMessage(5, { chat: forum, message_thread_id: 7 }), data: "q:k:r_abcde" };
    const updates: TgUpdate[] = [
      topic("hello master"),
      topic("rule: never merge on Fridays"),
      topic("/start"),
      topic("/queue"),
      topic("/pairing laptop"),
      topic("please /pair laptop"),
      topic("reply", { reply_to_message: { message_id: 42 } }),
      { update_id: nextId++, callback_query: cq },
      { update_id: nextId++ },
    ];
    for (const u of updates) expect(t.chief.route(u)).toBe("pass");
    await t.chief.idle();
    expect(t.attempts).toEqual([]);
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.devices.revoke).not.toHaveBeenCalled();
  });
});

describe("a console that pairs devices from the server (log mode)", () => {
  it.each([["/pair laptop"], ["/unpair laptop"], ["/pair"]])("%s mints no code, removes no device, and answers one fixed line", async (text) => {
    const t = setup({ userAuth: "log" });
    const u = topic(text);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.devices.revoke).not.toHaveBeenCalled();
    expect(t.privates()).toEqual([]);
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.pairOnServer]);
    expect(t.sent.some((s) => s.text.includes("#pair="))).toBe(false);
  });

  it("/pair from another person or another chat is still not handled", () => {
    const t = setup({ userAuth: "log" });
    expect(t.chief.route(topic("/pair laptop", { from: { id: 9, first_name: "Eve" } }))).toBe("pass");
    expect(t.chief.route(topic("/pair laptop", { message_thread_id: 8 }))).toBe("pass");
    expect(t.mint).not.toHaveBeenCalled();
  });
});

describe("/pair", () => {
  it("sends the link by private message to the user and only a notice in the topic", async () => {
    const t = setup();
    const u = topic("/pair laptop");
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();

    expect(t.mint).toHaveBeenCalledTimes(1);
    expect(t.mint).toHaveBeenCalledWith("laptop");
    const code = t.mintedCode();
    expect(t.privates()).toHaveLength(1);
    const priv = t.privates()[0];
    expect(priv.text).toContain(`${CONSOLE}/#pair=`);
    expect(priv.text).toBe(CHIEF_TG_TEXT.privateLink(`${CONSOLE}/#pair=${code}`));
    expect(priv.opts?.threadId).toBeUndefined();

    expect(t.topicReplies()).toEqual([
      { chatId: CFG.chatId, text: CHIEF_TG_TEXT.pairSent, opts: { threadId: CFG.threadId, replyTo: u.message!.message_id }, messageId: expect.any(Number) },
    ]);
    expect(t.topicReplies().some((s) => s.text.includes("#pair="))).toBe(false);
    expect(t.sent).toHaveLength(2);
    expect(t.deleted).toEqual([]);

    // The private message is attached to the code: the claim can delete it.
    expect(t.pairing.claim(code)).toMatchObject({ label: "laptop", tg: { chatId: CFG.userId, messageId: priv.messageId } });
  });

  it("a 403 on the private send (no /start) sends no link anywhere and drops the code", async () => {
    const t = setup({
      onSend: (chatId) => {
        if (chatId === CFG.userId) throw new TelegramError(403, "Forbidden: bot can't initiate conversation with a user");
      },
    });
    const u = topic("/pair laptop");
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();

    expect(t.mint).toHaveBeenCalledTimes(1);
    expect(t.pairing.claim(t.mintedCode())).toBeNull();
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.needStart]);
    expect(t.topicReplies()[0].opts).toEqual({ threadId: CFG.threadId, replyTo: u.message!.message_id });
    expect(t.sent.some((s) => s.text.includes("#pair="))).toBe(false);
    expect(t.privates()).toEqual([]);
  });

  it("the 403 path works end to end through the real client", async () => {
    const bot = fakeBotApi();
    const t = setup({ tg: clientFor(bot) });
    bot.failNext(403, "Forbidden: bot can't initiate conversation with a user");
    expect(t.chief.route(topic("/pair laptop"))).toBe("handled");
    await t.chief.idle();

    const sends = bot.sent();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ chat_id: CFG.userId });        // refused by Telegram
    expect(sends[1]).toMatchObject({ chat_id: CFG.chatId, message_thread_id: CFG.threadId, text: CHIEF_TG_TEXT.needStart });
    expect(sends[1].text).not.toContain("#pair=");
    expect(t.pairing.claim(t.mintedCode())).toBeNull();
  });

  it("a code claimed before the private send resolved: the private message is deleted at once", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup({
      onSend: (chatId, text) => {
        // The user taps the link before sendMessage returns.
        const code = /#pair=([A-Za-z0-9_-]+)/.exec(text)?.[1];
        if (chatId === CFG.userId && code) expect(t.pairing.claim(code)).not.toBeNull();
      },
    });
    expect(t.chief.route(topic("/pair laptop"))).toBe("handled");
    await t.chief.idle();

    expect(t.privates()).toHaveLength(1);
    expect(t.deleted).toEqual([[CFG.userId, t.privates()[0].messageId]]);
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.pairSent]);
  });

  it("a failing delete of an already-claimed link is logged, no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let t!: ReturnType<typeof setup>;
      t = setup({
        onSend: (chatId, text) => {
          const code = /#pair=([A-Za-z0-9_-]+)/.exec(text)?.[1];
          if (chatId === CFG.userId && code) t.pairing.claim(code);
        },
      });
      vi.mocked(t.tg.deleteMessage).mockRejectedValue(new TelegramError(400, "Bad Request: message can't be deleted"));
      t.chief.route(topic("/pair laptop"));
      await t.chief.idle();
      await new Promise((r) => setTimeout(r, 10));
      expect(t.tg.deleteMessage).toHaveBeenCalledTimes(1);
      expect(t.logs.some((l) => l.includes("message can't be deleted"))).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  // Review Focus 2.
  it.each([
    ["/pair Lap Top"],
    ["/pair"],
    ["/pair " + "a".repeat(40)],
    ["/pair Laptop"],
    ["/pair -laptop"],
    ["/pair lap/top"],
  ])("%s answers the usage line and mints no code", async (text) => {
    const t = setup();
    const u = topic(text);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.privates()).toEqual([]);
    expect(t.topicReplies()).toEqual([
      { chatId: CFG.chatId, text: CHIEF_TG_TEXT.pairUsage, opts: { threadId: CFG.threadId, replyTo: u.message!.message_id }, messageId: expect.any(Number) },
    ]);
  });

  it("accepts a label of exactly 32 characters and surrounding spaces", async () => {
    const t = setup();
    t.chief.route(topic("/pair " + "a".repeat(32)));
    t.chief.route(topic("/pair   phone_2  "));
    await t.chief.idle();
    expect(t.mint.mock.calls).toEqual([["a".repeat(32)], ["phone_2"]]);
  });
});

describe("/unpair", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it("revokes the device and answers removed, then no device", async () => {
    dir = await mkdtemp(join(tmpdir(), "chief-tg-"));
    const devices = new DeviceStore(join(dir, "user-devices.json"));
    await devices.add("laptop");
    await devices.add("phone");
    const fake = fakeTg();
    const chief = new ChiefTelegram({
      tg: fake.tg, cfg: CFG, consoleUrl: CONSOLE, misconfigured: null,
      pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices,
    });
    const revoke = vi.spyOn(devices, "revoke");
    const first = topic("/unpair laptop");
    expect(chief.route(first)).toBe("handled");
    expect(chief.route(topic("/unpair@acmebot laptop"))).toBe("handled");
    await chief.idle();

    expect(revoke.mock.calls).toEqual([["laptop"], ["laptop"]]);
    expect(fake.sent.map((s) => s.text)).toEqual([CHIEF_TG_TEXT.unpaired("laptop"), CHIEF_TG_TEXT.noDevice("laptop")]);
    expect(fake.sent[0]).toMatchObject({ chatId: CFG.chatId, opts: { threadId: CFG.threadId, replyTo: first.message!.message_id } });
    expect((await devices.list()).map((d) => d.label)).toEqual(["phone"]);
  });

  it.each([["/unpair"], ["/unpair Lap Top"], ["/unpair " + "a".repeat(40)]])("%s answers the usage line and revokes nothing", async (text) => {
    const t = setup();
    expect(t.chief.route(topic(text))).toBe("handled");
    await t.chief.idle();
    expect(t.devices.revoke).not.toHaveBeenCalled();
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.unpairUsage]);
  });
});

describe("misconfigured", () => {
  const MIS = "CHIEF_USER_AUTH=telegram but the Master topic is not configured";

  it("/pair and /unpair get the misconfigured reply; nothing is minted or revoked", async () => {
    const t = setup({ misconfigured: MIS });
    const pair = topic("/pair laptop");
    expect(t.chief.route(pair)).toBe("handled");
    expect(t.chief.route(topic("/unpair laptop"))).toBe("handled");
    expect(t.chief.route(topic("/pair"))).toBe("handled");
    await t.chief.idle();
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.devices.revoke).not.toHaveBeenCalled();
    expect(t.privates()).toEqual([]);
    expect(t.topicReplies().map((s) => s.text)).toEqual([
      CHIEF_TG_TEXT.misconfigured, CHIEF_TG_TEXT.misconfigured, CHIEF_TG_TEXT.misconfigured,
    ]);
    expect(t.topicReplies()[0].opts).toEqual({ threadId: CFG.threadId, replyTo: pair.message!.message_id });
  });

  it("everything else passes", async () => {
    const t = setup({ misconfigured: MIS });
    expect(t.chief.route(topic("hello master"))).toBe("pass");
    expect(t.chief.route(topic("/start"))).toBe("pass");
    expect(t.chief.route(topic("/pair laptop", { from: { id: 9 } }))).toBe("pass");
    await t.chief.idle();
    expect(t.attempts).toEqual([]);
  });
});

describe("route never waits on Telegram", () => {
  it("returns handled synchronously while sendMessage never resolves; the next update routes at once", () => {
    const t = setup({ onSend: () => new Promise(() => {}) });
    const r1 = t.chief.route(topic("/pair laptop"));
    expect(r1).toBe("handled");                     // a value, not a promise
    expect(t.chief.route(topic("/unpair phone"))).toBe("handled");
    expect(t.chief.route(topic("hello master"))).toBe("pass");
  });

  it("the poller finishes its batch and the master still gets its text while a private send hangs", async () => {
    const bot = fakeBotApi();
    const dir = await mkdtemp(join(tmpdir(), "chief-tg-poll-"));
    try {
      const t = setup({ onSend: () => new Promise(() => {}) });
      const toMaster: number[] = [];
      const poller = new IssuePoller({
        tg: clientFor(bot), userId: USER_ID, offsetFile: join(dir, "offset.json"),
        onCallback: async () => {}, onReply: async () => {}, onNew: () => {}, findIssueByMessageId: async () => null,
        chief: t.chief,
        master: {
          route: (u) => (u.message?.chat.id === CFG.chatId ? "master" : "pass"),
          onMessage: async (m) => { toMaster.push(m.message_id); },
        },
      });
      const pair = topic("/pair laptop");
      const hello = topic("hello master");
      bot.push(pair, hello);
      await poller.pollOnce();
      await new Promise((r) => setImmediate(r));
      expect(toMaster).toEqual([hello.message!.message_id]);
      expect(t.attempts.map((a) => a.chatId)).toEqual([CFG.userId]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a rejecting sendMessage is logged, drops the code, and raises no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const t = setup({ onSend: () => { throw new Error("network down"); } });
      expect(t.chief.route(topic("/pair laptop"))).toBe("handled");
      expect(t.chief.route(topic("/unpair laptop"))).toBe("handled");
      expect(t.chief.route(topic("/pair Lap Top"))).toBe("handled");
      await t.chief.idle();
      await new Promise((r) => setTimeout(r, 10));
      expect(t.logs.filter((l) => l.includes("network down"))).toHaveLength(3);
      expect(t.logs.some((l) => l.includes("#pair="))).toBe(false);
      expect(t.pairing.claim(t.mintedCode())).toBeNull();
      expect(t.devices.revoke).toHaveBeenCalledWith("laptop");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a rejecting revoke is logged, no unhandled rejection; later work still runs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const t = setup();
      t.devices.revoke.mockRejectedValueOnce(new Error("EIO"));
      t.chief.route(topic("/unpair laptop"));
      t.chief.route(topic("/unpair laptop"));
      await t.chief.idle();
      await new Promise((r) => setTimeout(r, 10));
      expect(t.logs.some((l) => l.includes("EIO"))).toBe(true);
      expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.unpaired("laptop")]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("CHIEF_TG_TEXT", () => {
  it("holds the spec texts verbatim", () => {
    expect(CHIEF_TG_TEXT.pairSent).toBe("Pairing link sent to you privately.");
    expect(CHIEF_TG_TEXT.needStart).toBe("Open a private chat with the bot, send /start, then /pair again");
    expect(CHIEF_TG_TEXT.misconfigured).toBe("Chief misconfigured — see `pnpm choibot doctor`");
    expect(CHIEF_TG_TEXT.pairUsage).toBe("Usage: /pair <label> (a-z, 0-9, - or _, up to 32 characters)");
    expect(CHIEF_TG_TEXT.unpairUsage).toBe("Usage: /unpair <label>");
    expect(CHIEF_TG_TEXT.privateLink("https://c/#pair=x")).toBe("Pair this device: https://c/#pair=x\nThe link works once, within 10 minutes.");
    expect(CHIEF_TG_TEXT.unpaired("laptop")).toBe("Device laptop removed.");
    expect(CHIEF_TG_TEXT.noDevice("laptop")).toBe("No device named laptop.");
  });
});

// ---- Phase 1b: clauses a (k d p q), b and d; rule and proposal cards ----

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

type BrainOpts = {
  misconfigured?: string | null;
  onSend?: (chatId: number, text: string) => unknown;
  onEdit?: (messageId: number) => unknown;
  decisions?: Pick<DecisionLog, "append">;
  noCapture?: boolean;
  noDecisions?: boolean;
};

async function brainSetup(o: BrainOpts = {}) {
  const root = await mkdtemp(join(tmpdir(), "chief-tg-brain-"));
  roots.push(root);
  const paths = chiefPaths(root);
  const rules = new RuleStore(paths.rules);
  const log = new DecisionLog(paths.decisions);
  // A stub append stands in for the whole log (capture calls only append).
  const decisions = (o.decisions ?? log) as DecisionLog;
  const cards = new CardIndex(paths.cards);
  const events: ConsoleEvent[] = [];
  const hub = { emitEvent: (e: ConsoleEvent) => { events.push(e); } };
  const fake = fakeTg(o.onSend, o.onEdit);
  const logs: string[] = [];
  const logFn = (s: string) => { logs.push(s); };
  let chief!: ChiefTelegram;
  chief = new ChiefTelegram({
    tg: fake.tg, cfg: CFG, consoleUrl: CONSOLE, misconfigured: o.misconfigured ?? null,
    pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: vi.fn(async () => false) }, log: logFn,
    rules, cards, paths, hub,
    ...(o.noDecisions ? {} : { decisions }),
    ...(o.noCapture ? {} : {
      capture: (line) => captureUserLine({ decisions, rules, log: logFn }, line),
    }),
  });
  const ruleEvents = () => readJsonl<RuleEvent>(paths.rules);
  const lines = () => log.read();
  const candidate = async (text = "never squash merge"): Promise<Rule> =>
    (await rules.add({ text, state: "candidate", scope: { area: "*", audience: "all" }, kind: "preference", source: { origin: "user-line" } })).rule;
  // Posts the card through the module; resolves with its message id.
  const ruleCard = async (r: Rule): Promise<number> => { await chief.postRuleCard(r); return fake.sent.at(-1)!.messageId; };
  const propose = async (text: string, retire: { id: string; why: string; text: string }[] = []) => {
    await mkdir(paths.brainDir, { recursive: true });
    await writeFile(paths.proposed, text);
    await writeFile(join(paths.brainDir, "proposal.json"), JSON.stringify({ sha256: sha256Hex(text), retire, createdAt: 1 }));
  };
  const proposalCard = async (): Promise<number> => {
    await chief.postProposalCard((await readProposal(paths))!);
    return fake.sent.at(-1)!.messageId;
  };
  const topicReplies = () => fake.sent.filter((s) => s.chatId === CFG.chatId && !s.opts?.keyboard);
  const cardsSent = () => fake.sent.filter((s) => s.opts?.keyboard);
  return { ...fake, root, paths, rules, decisions: log, cards, events, hub, logs, chief, ruleEvents, lines, candidate, ruleCard, propose, proposalCard, topicReplies, cardsSent };
}

let cqId = 0;
// A button tap by the user on message `messageId` in the Master topic.
function tap(data: string | undefined, messageId: number, over: Partial<TgCallbackQuery> = {}): TgUpdate {
  return {
    update_id: nextId++,
    callback_query: {
      id: `cq${cqId++}`, from: { id: USER_ID, first_name: "Me" },
      message: tgMessage(messageId, { chat: forum, message_thread_id: 7, is_topic_message: true }),
      ...(data === undefined ? {} : { data }), ...over,
    },
  };
}

const confirms = (evs: RuleEvent[]) => evs.filter((e) => e.ev === "confirm");

describe("rule and proposal cards", () => {
  it("postRuleCard sends the card in the topic and records it in cards.json", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const id = await t.ruleCard(r);
    expect(t.sent).toEqual([{ chatId: CFG.chatId, text: ruleCardText(r), opts: { threadId: CFG.threadId, keyboard: ruleCardKeyboard(r) }, messageId: id }]);
    expect(t.cards.lookup(id)).toMatchObject({ kind: "rule", ruleId: r.id, textSha256: sha256Hex(r.text) });
    expect(JSON.parse(await readFile(t.paths.cards, "utf8"))[String(id)]).toMatchObject({ ruleId: r.id });
  });

  it("postProposalCard sends the proposal card in the topic and records its hash", async () => {
    const t = await brainSetup();
    await t.propose("# Brain (2026-11-09)\n## Always\n- x [r_aaaaa]");
    const p = (await readProposal(t.paths))!;
    const id = await t.proposalCard();
    expect(t.sent).toEqual([{ chatId: CFG.chatId, text: proposalCardText(p), opts: { threadId: CFG.threadId, keyboard: proposalKeyboard(CONSOLE) }, messageId: id }]);
    expect(t.cards.lookup(id)).toMatchObject({ kind: "brain", proposalSha256: p.sha256 });
  });
});

describe("clause a: callbacks", () => {
  it("acceptance matrix: only the user's q: taps in the configured chat are handled", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    const cases: Array<[string, TgUpdate]> = [
      ["other chat", tap(`q:k:${r.id}`, card, { message: tgMessage(card, { chat: { id: -2002, type: "supergroup", is_forum: true } }) })],
      ["other user", tap(`q:k:${r.id}`, card, { from: { id: 9, first_name: "Eve" } })],
      ["other thread", tap(`q:k:${r.id}`, card, { message: tgMessage(card, { chat: forum, message_thread_id: 8, is_topic_message: true }) })],
      ["no thread", tap(`q:k:${r.id}`, card, { message: tgMessage(card, { chat: forum }) })],
      ["no message", tap(`q:k:${r.id}`, card, { message: undefined })],
      ["no data", tap(undefined, card)],
      ["not q:", tap("t:a:t100", card)],
    ];
    for (const [name, u] of cases) expect(t.chief.route(u), name).toBe("pass");
    await t.chief.idle();
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
    expect(confirms(await t.ruleEvents())).toEqual([]);

    const u = tap(`q:k:${r.id}`, card);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(t.tg.answerCallbackQuery).toHaveBeenCalledWith(u.callback_query!.id);
    expect(confirms(await t.ruleEvents())).toHaveLength(1);
  });

  it("q:k: on an unknown message id is handled and changes nothing", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const u = tap(`q:k:${r.id}`, 4711);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(t.tg.answerCallbackQuery).toHaveBeenCalledWith(u.callback_query!.id);
    expect(await t.ruleEvents()).toHaveLength(1);
    expect(t.sent).toEqual([]);
    expect(t.edits).toEqual([]);
  });

  it("q:k: with an id that is not the card's rule changes nothing", async () => {
    const t = await brainSetup();
    const a = await t.candidate("rule a");
    const b = await t.candidate("rule b");
    const card = await t.ruleCard(a);
    expect(t.chief.route(tap(`q:k:${b.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(confirms(await t.ruleEvents())).toEqual([]);
    expect(t.edits).toEqual([]);
  });

  it("q:k: happy path writes confirm via telegram and edits the card, no keyboard", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    const c = confirms(await t.ruleEvents());
    expect(c).toEqual([expect.objectContaining({ id: r.id, via: "telegram", by: "user" })]);
    expect((await t.rules.get(r.id))!.state).toBe("active");
    expect(t.edits).toEqual([{ chatId: CFG.chatId, messageId: card, text: CHIEF_TG_TEXT.confirmed(r.text), keyboard: undefined }]);
    expect(t.sent).toHaveLength(1);    // the card only
  });

  it("q:k: after the rule text changed: no confirm, `changed` reply, a fresh card recorded", async () => {
    const t = await brainSetup();
    const r = await t.candidate("never squash merge");
    const card = await t.ruleCard(r);
    const edited = await t.rules.update(r.id, { text: "never squash merge on app-shop" });
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(confirms(await t.ruleEvents())).toEqual([]);
    expect(t.topicReplies()).toEqual([
      { chatId: CFG.chatId, text: CHIEF_TG_TEXT.changed, opts: { threadId: CFG.threadId, replyTo: card }, messageId: expect.any(Number) },
    ]);
    const cs = t.cardsSent();
    expect(cs).toHaveLength(2);
    expect(cs[1].text).toBe(ruleCardText(edited));
    expect(t.cards.lookup(cs[1].messageId)).toMatchObject({ kind: "rule", ruleId: r.id, textSha256: sha256Hex(edited.text) });
    expect(t.edits).toEqual([]);

    // The fresh card confirms.
    t.chief.route(tap(`q:k:${r.id}`, cs[1].messageId));
    await t.chief.idle();
    expect(confirms(await t.ruleEvents())).toHaveLength(1);
  });

  // Review Focus 5.
  it("the same [Confirm] tap twice leaves one confirm event and posts no extra card", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(confirms(await t.ruleEvents())).toHaveLength(1);
    expect(t.cardsSent()).toHaveLength(1);
    expect(t.topicReplies()).toEqual([]);
    expect(t.tg.answerCallbackQuery).toHaveBeenCalledTimes(3);
  });

  it("[Confirm] after a tab confirm made since the card writes a telegram confirm, once", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    await t.rules.confirm(r.id, { via: "tab" });
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(confirms(await t.ruleEvents()).map((e) => e.via)).toEqual(["tab", "telegram"]);
    expect(t.edits).toEqual([{ chatId: CFG.chatId, messageId: card, text: CHIEF_TG_TEXT.confirmed(r.text), keyboard: undefined }]);
  });

  it("[Confirm] on a card for an active rule confirms it again once", async () => {
    const t = await brainSetup();
    // A panel add long before the card; the module's RuleStore reads the same file.
    const panel = new RuleStore(t.paths.rules, { now: () => 1000 });
    const { rule } = await panel.add({ text: "always run tests", state: "active", scope: { area: "*" }, kind: "preference", source: { origin: "panel" } });
    const card = await t.ruleCard(rule);
    t.chief.route(tap(`q:k:${rule.id}`, card));
    await t.chief.idle();
    expect(confirms(await t.ruleEvents()).map((e) => e.via)).toEqual(["tab", "telegram"]);
  });

  it("q:d: retires the candidate by the user and edits the card; a second tap writes nothing", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    expect(t.chief.route(tap(`q:d:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(t.chief.route(tap(`q:d:${r.id}`, card))).toBe("handled");
    await t.chief.idle();
    const retires = (await t.ruleEvents()).filter((e) => e.ev === "retire");
    expect(retires).toEqual([expect.objectContaining({ id: r.id, by: "user", why: "discarded on Telegram" })]);
    expect((await t.rules.get(r.id))!.state).toBe("retired");
    expect(t.edits[0]).toEqual({ chatId: CFG.chatId, messageId: card, text: CHIEF_TG_TEXT.discarded, keyboard: undefined });
    expect(t.cardsSent()).toHaveLength(1);
    expect(t.logs).toEqual([]);
  });

  it("q:p: applies the proposal and edits the card to applied(version)", async () => {
    const t = await brainSetup();
    const text = "# Brain (2026-11-09)\n## Always\n- x [r_aaaaa]";
    await t.propose(text);
    const card = await t.proposalCard();
    expect(t.chief.route(tap("q:p:brain", card))).toBe("handled");
    await t.chief.idle();
    expect(await readFile(t.paths.brain, "utf8")).toBe(text);
    expect(await readProposal(t.paths)).toBeNull();
    expect(t.edits).toHaveLength(1);
    expect(t.edits[0]).toMatchObject({ chatId: CFG.chatId, messageId: card, keyboard: undefined });
    // The first apply saves no previous brain.
    expect(t.edits[0].text).toBe("✓ Applied");
    expect(t.events).toEqual([expect.objectContaining({ type: "brain", proposed: false })]);

    const next = "# Brain (2026-11-10)\n## Always\n- y [r_bbbbb]";
    await t.propose(next);
    const card2 = await t.proposalCard();
    t.chief.route(tap("q:p:brain", card2));
    await t.chief.idle();
    const [v] = await readdir(t.paths.versionsDir);
    expect(await readFile(join(t.paths.versionsDir, v!), "utf8")).toBe(text);
    expect(t.edits[1].text).toBe(`✓ Applied (previous brain saved as ${v!.replace(/\.md$/, "")})`);
  });

  it("q:p: with a stale proposal hash applies nothing and posts a fresh card", async () => {
    const t = await brainSetup();
    await t.propose("# Brain (old)\n## Always\n- a [r_aaaaa]");
    const card = await t.proposalCard();
    const newer = "# Brain (new)\n## Always\n- b [r_bbbbb]";
    await t.propose(newer);
    expect(t.chief.route(tap("q:p:brain", card))).toBe("handled");
    await t.chief.idle();
    expect(existsSync(t.paths.brain)).toBe(false);
    expect((await readProposal(t.paths))!.text).toBe(newer);
    expect(t.topicReplies().map((s) => [s.text, s.opts?.replyTo])).toEqual([[CHIEF_TG_TEXT.changed, card]]);
    const cs = t.cardsSent();
    expect(cs).toHaveLength(2);
    expect(cs[1].text).toBe(proposalCardText((await readProposal(t.paths))!));
    expect(t.cards.lookup(cs[1].messageId)).toMatchObject({ kind: "brain", proposalSha256: sha256Hex(newer) });
    expect(t.edits).toEqual([]);
  });

  it("q:p: with no proposal answers noProposal", async () => {
    const t = await brainSetup();
    await t.propose("# Brain (x)\n## Always\n- a [r_aaaaa]");
    const card = await t.proposalCard();
    await rm(t.paths.proposed);
    expect(t.chief.route(tap("q:p:brain", card))).toBe("handled");
    await t.chief.idle();
    expect(existsSync(t.paths.brain)).toBe(false);
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.noProposal]);
    expect(t.cardsSent()).toHaveLength(1);
    expect(t.edits).toEqual([]);
  });

  it("q:q: discards the proposal and edits the card; a stale hash keeps the newer proposal", async () => {
    const t = await brainSetup();
    await t.propose("# Brain (a)\n## Always\n- a [r_aaaaa]");
    const card = await t.proposalCard();
    expect(t.chief.route(tap("q:q:brain", card))).toBe("handled");
    await t.chief.idle();
    expect(await readProposal(t.paths)).toBeNull();
    expect(t.edits).toEqual([{ chatId: CFG.chatId, messageId: card, text: CHIEF_TG_TEXT.discarded, keyboard: undefined }]);

    await t.propose("# Brain (b)\n## Always\n- b [r_bbbbb]");
    const card2 = await t.proposalCard();
    await t.propose("# Brain (c)\n## Always\n- c [r_ccccc]");
    t.chief.route(tap("q:q:brain", card2));
    await t.chief.idle();
    expect((await readProposal(t.paths))!.text).toContain("Brain (c)");
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.changed]);
    expect(t.cardsSent()).toHaveLength(3);

    await rm(t.paths.proposed);
    t.chief.route(tap("q:q:brain", card2));
    await t.chief.idle();
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.changed, CHIEF_TG_TEXT.noProposal]);
  });

  it("other q: actions are handled, answered only", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    for (const data of ["q:a:q7k2m9x1a", "q:k:brain", "q:p:r_abcde", "q:k:r_ABCDE", "q:z:brain"]) {
      expect(t.chief.route(tap(data, card)), data).toBe("handled");
    }
    await t.chief.idle();
    expect(t.tg.answerCallbackQuery).toHaveBeenCalledTimes(5);
    expect(await t.ruleEvents()).toHaveLength(1);
    expect(t.edits).toEqual([]);
    expect(t.cardsSent()).toHaveLength(1);
    expect(t.topicReplies()).toEqual([]);
  });

  it("a callback queued behind a never-resolving fn on chief-tg:rules: route returns at once and the next update routes", async () => {
    const t = await brainSetup();
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    let release!: () => void;
    const blocker = onChain("chief-tg:rules", () => new Promise<void>((res) => { release = res; }));
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    expect(t.chief.route(topic("hello master"))).toBe("pass");
    await vi.waitFor(async () => expect((await t.lines()).map((l) => l.text)).toEqual(["hello master"]));
    expect(confirms(await t.ruleEvents())).toEqual([]);
    release();
    await blocker;
    await t.chief.idle();
    expect(confirms(await t.ruleEvents())).toHaveLength(1);
  });

  it("two taps queued in order apply in order", async () => {
    const t = await brainSetup();
    const a = await t.candidate("rule a");
    const b = await t.candidate("rule b");
    const cardA = await t.ruleCard(a);
    const cardB = await t.ruleCard(b);
    t.chief.route(tap(`q:k:${b.id}`, cardB));
    t.chief.route(tap(`q:d:${a.id}`, cardA));
    t.chief.route(tap(`q:k:${a.id}`, cardA));
    await t.chief.idle();
    const evs = (await t.ruleEvents()).filter((e) => e.ev !== "add").map((e) => [e.ev, e.id]);
    expect(evs).toEqual([["confirm", b.id], ["retire", a.id]]);
  });

  it("a never-resolving editMessageText does not block the next tap on the same chain", async () => {
    const t = await brainSetup({ onEdit: () => new Promise(() => {}) });
    const a = await t.candidate("rule a");
    const b = await t.candidate("rule b");
    const cardA = await t.ruleCard(a);
    const cardB = await t.ruleCard(b);
    t.chief.route(tap(`q:k:${a.id}`, cardA));
    t.chief.route(tap(`q:k:${b.id}`, cardB));
    await vi.waitFor(async () => expect(confirms(await t.ruleEvents()).map((e) => e.id)).toEqual([a.id, b.id]));
    expect(t.tg.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("a never-resolving sendMessage on the changed path does not block the next tap", async () => {
    let hang = false;
    const t = await brainSetup({ onSend: () => (hang ? new Promise(() => {}) : undefined) });
    const a = await t.candidate("rule a");
    const b = await t.candidate("rule b");
    const cardA = await t.ruleCard(a);
    const cardB = await t.ruleCard(b);
    await t.rules.update(a.id, { text: "rule a2" });
    hang = true;
    t.chief.route(tap(`q:k:${a.id}`, cardA));      // changed: reply + fresh card hang
    t.chief.route(tap(`q:k:${b.id}`, cardB));
    await vi.waitFor(async () => expect(confirms(await t.ruleEvents()).map((e) => e.id)).toEqual([b.id]));
  });

  it("a never-resolving answerCallbackQuery does not delay the tap", async () => {
    const t = await brainSetup();
    vi.mocked(t.tg.answerCallbackQuery).mockImplementation(() => new Promise(() => {}));
    const r = await t.candidate();
    const card = await t.ruleCard(r);
    expect(t.chief.route(tap(`q:k:${r.id}`, card))).toBe("handled");
    await vi.waitFor(async () => expect(confirms(await t.ruleEvents())).toHaveLength(1));
  });

  it("a store error is logged, never thrown; no unhandled rejection; the next tap runs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const t = await brainSetup();
      const r = await t.candidate();
      const card = await t.ruleCard(r);
      vi.spyOn(t.rules, "confirm").mockRejectedValueOnce(new Error("EIO on rules.jsonl"));
      t.chief.route(tap(`q:k:${r.id}`, card));
      t.chief.route(tap(`q:k:${r.id}`, card));
      await t.chief.idle();
      await new Promise((res) => setTimeout(res, 10));
      expect(t.logs.some((l) => l.includes("EIO on rules.jsonl"))).toBe(true);
      expect(confirms(await t.ruleEvents())).toHaveLength(1);    // the second tap still ran
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("without rules, cards or paths, callbacks and card replies pass as in 1a", async () => {
    const t = setup();
    expect(t.chief.route(tap("q:k:r_abcde", 5))).toBe("pass");
    expect(t.chief.route(tap("q:p:brain", 5))).toBe("pass");
    await t.chief.idle();
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
    await expect(t.chief.postProposalCard({ text: "x", sha256: sha256Hex("x"), retire: [], createdAt: 1 })).rejects.toThrow();
  });
});

describe("clause b: quoted replies to cards", () => {
  it("a quoted reply to a rule card edits the candidate (USER edit) and posts a new card; not logged", async () => {
    const t = await brainSetup();
    const r = await t.candidate("never squash merge");
    const card = await t.ruleCard(r);
    expect(t.chief.route(topic("never squash merge on app-shop", { reply_to_message: { message_id: card } }))).toBe("handled");
    await t.chief.idle();
    const after = (await t.rules.get(r.id))!;
    expect(after.text).toBe("never squash merge on app-shop");
    expect(after.state).toBe("candidate");
    expect((await t.ruleEvents()).filter((e) => e.ev === "edit")).toEqual([expect.objectContaining({ id: r.id, by: "user", text: "never squash merge on app-shop" })]);
    const cs = t.cardsSent();
    expect(cs).toHaveLength(2);
    expect(cs[1].text).toBe(ruleCardText(after));
    expect(t.cards.lookup(cs[1].messageId)).toMatchObject({ kind: "rule", ruleId: r.id, textSha256: sha256Hex(after.text) });
    expect(await t.lines()).toEqual([]);
  });

  it("a reply to the proposal card answers useButtons and changes nothing", async () => {
    const t = await brainSetup();
    await t.propose("# Brain (x)\n## Always\n- a [r_aaaaa]");
    const card = await t.proposalCard();
    const u = topic("apply it", { reply_to_message: { message_id: card } });
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(t.topicReplies()).toEqual([
      { chatId: CFG.chatId, text: CHIEF_TG_TEXT.useButtons, opts: { threadId: CFG.threadId, replyTo: u.message!.message_id }, messageId: expect.any(Number) },
    ]);
    expect(await readProposal(t.paths)).not.toBeNull();
    expect(existsSync(t.paths.brain)).toBe(false);
    expect(await t.lines()).toEqual([]);
  });

  it("a forum message whose reply_to_message is the topic root passes and is logged", async () => {
    const t = await brainSetup();
    const u = topic("please rebase agent-3", { reply_to_message: { message_id: CFG.threadId } });
    expect(t.chief.route(u)).toBe("pass");
    await t.chief.idle();
    expect(await t.lines()).toEqual([expect.objectContaining({ by: "user", via: "master-telegram", correction: null, text: "please rebase agent-3" })]);
    expect(t.sent).toEqual([]);
  });
});

describe("clause d and Master-topic logging", () => {
  it("rule: never offer to merge → pass, candidate created, no rule card (a queue item asks instead), line logged", async () => {
    const t = await brainSetup();
    expect(t.chief.route(topic("rule: never offer to merge"))).toBe("pass");
    await t.chief.idle();
    const all = await t.rules.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ text: "never offer to merge", state: "candidate", source: { origin: "user-line", via: "master-telegram" } });
    expect(t.cardsSent()).toEqual([]);
    expect(await t.lines()).toEqual([expect.objectContaining({ by: "user", via: "master-telegram", correction: null, text: "rule: never offer to merge" })]);
  });

  it("a duplicate rule: line passes and answers Already a rule (<id>).", async () => {
    const t = await brainSetup();
    const r = await t.candidate("never offer to merge");
    const u = topic("RULE: Never offer to merge.");
    expect(t.chief.route(u)).toBe("pass");
    await t.chief.idle();
    expect(await t.rules.all()).toHaveLength(1);
    expect(t.topicReplies()).toEqual([
      { chatId: CFG.chatId, text: `Already a rule (${r.id}).`, opts: { threadId: CFG.threadId, replyTo: u.message!.message_id }, messageId: expect.any(Number) },
    ]);
    expect((await t.lines()).map((l) => l.text)).toEqual(["RULE: Never offer to merge."]);
  });

  it("a forwarded rule: x passes, nothing logged, no candidate", async () => {
    const t = await brainSetup();
    const fwd = { forward_origin: { type: "user" as const, date: 0, sender_user: { id: 77, first_name: "Bob" } } };
    expect(t.chief.route(topic("rule: x", fwd))).toBe("pass");
    expect(t.chief.route(topic("a forwarded bug report", fwd))).toBe("pass");
    await t.chief.idle();
    expect(await t.rules.all()).toEqual([]);
    expect(await t.lines()).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("/pair is handled and not logged; other topic lines are logged in arrival order", async () => {
    const t = await brainSetup();
    expect(t.chief.route(topic("/pair laptop"))).toBe("handled");
    expect(t.chief.route(topic("first"))).toBe("pass");
    expect(t.chief.route(topic("rule: always run tests"))).toBe("pass");
    expect(t.chief.route(topic("third"))).toBe("pass");
    await t.chief.idle();
    expect((await t.lines()).map((l) => l.text)).toEqual(["first", "rule: always run tests", "third"]);
  });

  it("messages from other users, chats or threads are not logged", async () => {
    const t = await brainSetup();
    expect(t.chief.route(topic("hi", { from: { id: 9, first_name: "Eve" } }))).toBe("pass");
    expect(t.chief.route(topic("hi", { message_thread_id: 8 }))).toBe("pass");
    expect(t.chief.route(topic("rule: x", { chat: { id: -2002, type: "supergroup", is_forum: true } }))).toBe("pass");
    await t.chief.idle();
    expect(await t.lines()).toEqual([]);
    expect(await t.rules.all()).toEqual([]);
  });

  it.each([
    ["throws", () => { throw new Error("disk full"); }],
    ["rejects", async () => { throw new Error("disk full"); }],
  ])("a decisions.append that %s → still pass, error logged, no unhandled rejection", async (_name, impl) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const append = vi.fn(impl) as unknown as DecisionLog["append"];
      const t = await brainSetup({ decisions: { append } });
      expect(t.chief.route(topic("hello master"))).toBe("pass");
      expect(t.chief.route(topic("rule: never offer to merge"))).toBe("pass");
      await t.chief.idle();
      await new Promise((res) => setTimeout(res, 10));
      expect(t.logs.filter((l) => l.includes("disk full"))).toHaveLength(2);
      expect(await t.rules.all()).toHaveLength(1);       // the candidate still made
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("without capture, a rule: line is only logged; without decisions, nothing is logged", async () => {
    const a = await brainSetup({ noCapture: true });
    expect(a.chief.route(topic("rule: x"))).toBe("pass");
    await a.chief.idle();
    expect(await a.rules.all()).toEqual([]);
    expect((await a.lines()).map((l) => l.text)).toEqual(["rule: x"]);

    const b = await brainSetup({ noCapture: true, noDecisions: true });
    expect(b.chief.route(topic("hello"))).toBe("pass");
    await b.chief.idle();
    expect(await b.lines()).toEqual([]);
  });
});

describe("misconfigured fails closed", () => {
  const MIS = "CHIEF_USER_AUTH=telegram but the Master topic is not configured";

  it("a q:k: tap passes, no confirm, no answer", async () => {
    const t = await brainSetup({ misconfigured: MIS });
    const r = await t.candidate();
    expect(t.chief.route(tap(`q:k:${r.id}`, 4711))).toBe("pass");
    expect(t.chief.route(tap("q:p:brain", 4712))).toBe("pass");
    await t.chief.idle();
    expect(confirms(await t.ruleEvents())).toEqual([]);
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("a plain topic message passes with no decision line; rule: x passes with no candidate; a card reply passes", async () => {
    const t = await brainSetup({ misconfigured: MIS });
    expect(t.chief.route(topic("hello master"))).toBe("pass");
    expect(t.chief.route(topic("rule: x"))).toBe("pass");
    expect(t.chief.route(topic("edit", { reply_to_message: { message_id: 4711 } }))).toBe("pass");
    await t.chief.idle();
    expect(await t.lines()).toEqual([]);
    expect(await t.rules.all()).toEqual([]);
    expect(t.attempts).toEqual([]);
  });

  it("/pair still gets the misconfigured reply", async () => {
    const t = await brainSetup({ misconfigured: MIS });
    expect(t.chief.route(topic("/pair laptop"))).toBe("handled");
    await t.chief.idle();
    expect(t.topicReplies().map((s) => s.text)).toEqual([CHIEF_TG_TEXT.misconfigured]);
    expect(await t.lines()).toEqual([]);
  });
});

describe("CHIEF_TG_TEXT (1b)", () => {
  it("holds the 1b texts verbatim", () => {
    expect(CHIEF_TG_TEXT.changed).toBe("changed since this card — see the new card");
    expect(CHIEF_TG_TEXT.useButtons).toBe("Use the buttons on the card.");
    expect(CHIEF_TG_TEXT.noProposal).toBe("No proposal waiting.");
    expect(CHIEF_TG_TEXT.confirmed("x")).toBe('✓ Confirmed: "x"');
    expect(CHIEF_TG_TEXT.discarded).toBe("✗ Discarded");
    expect(CHIEF_TG_TEXT.applied("123")).toBe("✓ Applied (previous brain saved as 123)");
    expect(CHIEF_TG_TEXT.applied(null)).toBe("✓ Applied");
  });
});

// ---- Phase 2a: /queue ----

describe("/queue", () => {
  const NOW = 10_000_000;
  const item = (id: string, kind: QueueItem["kind"], over: Partial<QueueItem> = {}): QueueItem => ({
    id, kind, agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "x",
    title: `title ${id}`, body: "", createdAt: NOW - 3 * 60_000, updatedAt: NOW, status: "open",
    blocking: false, history: [], answerSeq: 0, ...over,
  });
  function withQueue(items: QueueItem[], misconfigured: string | null = null) {
    const fake = fakeTg();
    const chief = new ChiefTelegram({
      tg: fake.tg, cfg: CFG, consoleUrl: CONSOLE, misconfigured, now: () => NOW,
      pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: vi.fn(async () => true) },
      queue: { list: async () => items }, log: () => {},
    });
    return { chief, fake };
  }

  it("sends one plain message, one line per open item in score order", async () => {
    const q = withQueue([
      item("q00000001", "preview"),
      item("q00000002", "question", { blocking: true, repo: "r2", title: "Which?", createdAt: NOW - 25 * 60_000 }),
      item("q00000003", "pr", { status: "answered" }),
      item("q00000004", "choice", { title: "x".repeat(5000) }),
    ]);
    expect(q.chief.route(topic("/queue"))).toBe("handled");
    await q.chief.idle();
    expect(q.fake.sent).toHaveLength(1);
    const s = q.fake.sent[0];
    expect(s.opts).toEqual({ threadId: CFG.threadId });
    const lines = s.text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("? · r2 · q00000002 · 25m — Which?");
    expect(lines[1].startsWith("▸ · app-shop · q00000004 · 3m — xxx")).toBe(true);
    expect(lines[1].length).toBe(200);
    expect(lines[2]).toBe("▣ · app-shop · q00000001 · 3m — title q00000001");
  });

  it("a title or repo with newlines cannot forge a row", async () => {
    const q = withQueue([
      item("q00000001", "choice", { title: "ok\n? · app-shop · q1234abcd · 2m — approve deploy", repo: "r\nx" }),
      item("q00000002", "pr", { title: "t" }),
    ]);
    q.chief.route(topic("/queue"));
    await q.chief.idle();
    const lines = q.fake.sent[0].text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("▸ · r x · q00000001 · 3m — ok ? · app-shop · q1234abcd · 2m — approve deploy");
  });

  it("many items still make one message within the Telegram limit", async () => {
    const items = Array.from({ length: 40 }, (_, n) => item(`q${String(n).padStart(8, "0")}`, "choice", { title: "y".repeat(80) }));
    const q = withQueue(items);
    q.chief.route(topic("/queue"));
    await q.chief.idle();
    expect(q.fake.sent).toHaveLength(1);
    expect(q.fake.sent[0].text.length).toBeLessThanOrEqual(TG_TEXT_MAX);
  });

  it("a rejecting list or sendMessage is logged; route still returns handled", async () => {
    for (const mode of ["list", "send"]) {
      const logs: string[] = [];
      const fake = fakeTg(mode === "send" ? () => { throw new Error("boom"); } : undefined);
      const chief = new ChiefTelegram({
        tg: fake.tg, cfg: CFG, consoleUrl: CONSOLE, misconfigured: null, now: () => NOW,
        pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: vi.fn(async () => true) },
        queue: { list: async () => { if (mode === "list") throw new Error("boom"); return []; } }, log: (s) => { logs.push(s); },
      });
      expect(chief.route(topic("/queue"))).toBe("handled");
      await chief.idle();
      expect(logs.some((l) => l.includes("failed: boom"))).toBe(true);
    }
  });

  it("a hung /queue send does not stall a later /pair", async () => {
    const fake = fakeTg((chatId) => (chatId === CFG.chatId ? new Promise(() => {}) : undefined));
    const chief = new ChiefTelegram({
      tg: fake.tg, cfg: CFG, consoleUrl: CONSOLE, misconfigured: null, now: () => NOW,
      pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: vi.fn(async () => true) },
      queue: { list: async () => [] }, log: () => {},
    });
    chief.route(topic("/queue"));
    chief.route(topic("/pair laptop"));
    await vi.waitFor(() => expect(fake.sent.some((s) => s.chatId === CFG.userId)).toBe(true));
  });

  it("empty queue says Nothing waits on you.", async () => {
    const q = withQueue([]);
    q.chief.route(topic("/queue@acmebot"));
    await q.chief.idle();
    expect(q.fake.sent.map((s) => s.text)).toEqual(["Nothing waits on you."]);
  });

  it("misconfigured: /queue passes; without the dep it passes too", async () => {
    const q = withQueue([], "bad");
    expect(q.chief.route(topic("/queue"))).toBe("pass");
    await q.chief.idle();
    expect(q.fake.attempts).toEqual([]);
    const t = setup();
    expect(t.chief.route(topic("/queue"))).toBe("pass");
    expect(withQueue([]).chief.route(topic("/queue", { from: { id: 9 } }))).toBe("pass");
  });
});

// ---- Phase 2b: item callbacks and awaited replies (Task 2b-4) ----

describe("CHIEF_TG_TEXT (2b)", () => {
  it("holds the 2b texts verbatim", () => {
    expect(CHIEF_TG_TEXT.alreadyAnswered).toBe("Already answered — see the Queue tab.");
    expect(CHIEF_TG_TEXT.replyChanges).toBe("Reply to this card with the changes.");
    expect(CHIEF_TG_TEXT.replyAnswer).toBe("Reply to this card with your answer.");
    expect(CHIEF_TG_TEXT.tapFirst).toBe("Tap a button on the card first.");
    expect(CHIEF_TG_TEXT.refused("value must be approve or changes")).toBe("Not accepted: value must be approve or changes");
  });
});

describe("item callbacks and awaited replies", () => {
  const W = "a1";
  const UNDO_MS = 600_000;
  const USER_CALLER: Caller = { level: "user", agentHeaders: false };
  const base = { agentId: W, createdBy: { agentId: W, kind: "worker" as const }, repo: "app-shop", area: "app-shop", body: "b" };
  const CHOICE: NewItem = { ...base, kind: "choice", title: "Pick", blocking: true,
    choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] } };
  const PR: NewItem = { ...base, kind: "pr", title: "PR #12", blocking: false, pr: { url: "https://github.com/o/app-shop/pull/12", number: 12 } };
  const QUESTION: NewItem = { ...base, kind: "question", title: "How?", blocking: true };
  // The review kind that still takes `approve` (a pr item never does, overview decision 60).
  const PREVIEW: NewItem = { ...base, kind: "preview", title: "Stats page", blocking: false, preview: { images: ["1.png"] } };

  async function itemSetup(o: {
    misconfigured?: string | null; onSend?: (chatId: number, text: string) => unknown; cfg?: ChiefTgDeps["cfg"];
    files?: ChiefTgDeps["files"]; worktree?: string;
  } = {}) {
    const root = await mkdtemp(join(tmpdir(), "chief-tg-items-"));
    roots.push(root);
    const paths = chiefPaths(root);
    const rules = new RuleStore(paths.rules);
    const decisions = new DecisionLog(paths.decisions);
    const store = new QueueStore(join(root, "queue"), { log: () => {} });
    const clock = { now: 9_000_000 };
    // What the merge gate reads for a pr item; a test sets `merge.state`.
    const merge: { state: MergeState } = { state: { state: "not-merged", detail: "open" } };
    const kicks: string[] = [];
    const actions = new QueueActions({
      store, rules, decisions, deliverer: { kick: (id) => { kicks.push(id); } },
      // An agent with a worktree: an answer's image is copied there (queue/answerImages.ts).
      agents: { load: async (id) => (o.worktree ? { id, worktree: o.worktree, repo: o.worktree } as never : null) },
      inbox: { cancel: () => "absent" }, audit: new AuditLog(paths.auditAuto), undoMs: UNDO_MS, now: () => clock.now, log: () => {},
      mergeState: async () => merge.state,
    });
    const cards = new CardIndex(paths.cards);
    const fake = fakeTg(o.onSend);
    const logs: string[] = [];
    const captured: string[] = [];
    const make = (index: CardIndex) => new ChiefTelegram({
      tg: fake.tg, cfg: o.cfg ?? CFG, consoleUrl: CONSOLE, misconfigured: o.misconfigured ?? null,
      pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: vi.fn(async () => false) },
      log: (s) => { logs.push(s); }, rules, decisions, cards: index, paths, hub: { emitEvent() {} },
      actions, queueStore: store, queue: store, ...(o.files ? { files: o.files } : {}),
      capture: async (line) => { captured.push(line.text); return {}; },
    });
    const chief = make(cards);
    let nextCard = 5000;
    // An item whose card is posted: its message id on the item and in the index (the poster's job).
    const add = async (input: NewItem): Promise<{ id: string; card: number }> => {
      const { id } = await store.add(input);
      const card = nextCard++;
      await store.withItem(id, async () => { await store.write({ ...(await store.get(id))!, telegram: { cardMessageId: card } }); });
      cards.addItem(card, id);
      return { id, card };
    };
    const get = async (id: string): Promise<QueueItem> => (await store.get(id))!;
    const file = (id: string) => readFile(join(root, "queue", `${id}.json`), "utf8");
    const replies = () => fake.sent.filter((s) => s.chatId === CFG.chatId).map((s) => s.text);
    return { ...fake, root, paths, rules, decisions, store, actions, cards, chief, make, clock, logs, add, get, file, replies, merge, kicks, captured };
  }
  const reply = (text: string, to: number, over: Partial<TgMessage> = {}) => topic(text, { reply_to_message: { message_id: to }, ...over });

  // With a connected account and no fleet master chat the ticket cards are in the user's private
  // chat with the bot: a tap and a quoted reply count there exactly as in the fleet master chat,
  // from the same one user. Nothing else is read in that chat.
  describe("the private chat with the bot (no fleet master chat)", () => {
    const PRIVATE: ChiefTgDeps["cfg"] = { chatId: USER_ID, userId: USER_ID };
    const own = { id: USER_ID, type: "private" as const };
    // A message of the user in their private chat with the bot.
    const dm = (text: string, over: Partial<TgMessage> = {}): TgUpdate => {
      const u = topic(text, { chat: own, message_thread_id: undefined, is_topic_message: undefined, ...over });
      return u;
    };
    const dmTap = (data: string, messageId: number, over: Partial<TgCallbackQuery> = {}): TgUpdate =>
      tap(data, messageId, { message: tgMessage(messageId, { chat: own }), ...over });

    it("a tap of the user on a ticket card answers it, as in the fleet master chat", async () => {
      const t = await itemSetup({ cfg: PRIVATE });
      const { id, card } = await t.add(CHOICE);
      const u = dmTap(`q:o:${id}:1`, card);
      expect(t.chief.route(u)).toBe("handled");
      await t.chief.idle();
      expect((await t.get(id)).answer).toMatchObject({ value: "B", by: "user", via: "telegram" });
      expect(t.tg.answerCallbackQuery).toHaveBeenCalledWith(u.callback_query!.id);
      expect(await t.decisions.read()).toEqual([expect.objectContaining({ via: "queue-telegram", itemId: id, value: "B" })]);
    });

    it("a tap from any other sender or any other chat passes and changes nothing", async () => {
      const t = await itemSetup({ cfg: PRIVATE });
      const { id, card } = await t.add(CHOICE);
      const before = await t.file(id);
      const eve = { id: 9, first_name: "Eve" };
      const data = `q:o:${id}:1`;
      const others: Array<[string, TgUpdate]> = [
        ["another person in their own chat with the bot", tap(data, card, { from: eve, message: tgMessage(card, { chat: { id: 9, type: "private" } }) })],
        ["another person, the card of the user's chat", dmTap(data, card, { from: eve })],
        ["the user, a card in another person's chat", tap(data, card, { message: tgMessage(card, { chat: { id: 9, type: "private" } }) })],
        ["the user, in a topic of a group", tap(data, card)],
        ["the user, in a group with the user's id as its id (never a private chat)", tap(data, card, { message: tgMessage(card, { chat: { id: USER_ID, type: "group" } }) })],
        ["the user, a message of a thread", tap(data, card, { message: tgMessage(card, { chat: own, message_thread_id: 3 }) })],
        ["no message", tap(data, card, { message: undefined })],
      ];
      for (const [name, u] of others) expect(t.chief.route(u), name).toBe("pass");
      await t.chief.idle();
      expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
      expect(await t.file(id)).toBe(before);
      expect(t.sent).toEqual([]);
    });

    it("only ticket cards live there: a rule tap or a proposal tap does nothing", async () => {
      const t = await itemSetup({ cfg: PRIVATE });
      const rule = (await t.rules.add({ text: "never squash", state: "candidate", scope: { area: "*", audience: "all" }, kind: "preference", source: { origin: "user-line" } })).rule;
      await t.cards.recordRule(7000, rule);
      for (const data of [`q:k:${rule.id}`, `q:d:${rule.id}`, "q:p:brain", "q:q:brain"]) t.chief.route(dmTap(data, 7000));
      await t.chief.idle();
      expect((await t.rules.get(rule.id))!.state).toBe("candidate");
      expect(t.sent).toEqual([]);
      expect(t.edits).toEqual([]);
    });

    it("no other message is read there: no command, no rule line, no decision line (the chat is also where issues come in)", async () => {
      const t = await itemSetup({ cfg: PRIVATE });
      const { id } = await t.add(CHOICE);
      const before = await t.file(id);
      for (const text of ["the login button is broken", "rule: never squash merge", "/pair laptop", "/unpair laptop", "/queue"]) {
        expect(t.chief.route(dm(text)), text).toBe("pass");
      }
      // A reply to a message that is no ticket card (an issue card): not this module's.
      expect(t.chief.route(dm("it is Safari", { reply_to_message: { message_id: 4242 } }))).toBe("pass");
      await t.chief.idle();
      expect(t.sent).toEqual([]);
      expect(t.captured).toEqual([]);
      expect(await t.decisions.read()).toEqual([]);
      expect(await t.file(id)).toBe(before);
    });

    it("Reply… then a quoted reply answers a question; the hint goes to the private chat with no topic", async () => {
      const t = await itemSetup({ cfg: PRIVATE });
      const { id, card } = await t.add(QUESTION);
      expect(t.chief.route(dmTap(`q:r:${id}`, card))).toBe("handled");
      await t.chief.idle();
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ chatId: USER_ID, text: CHIEF_TG_TEXT.replyAnswer, opts: { threadId: undefined, replyTo: card } });
      // From another person, or with a forward: nothing.
      expect(t.chief.route(dm("use the registry", { reply_to_message: { message_id: t.sent[0].messageId }, from: { id: 9, first_name: "Eve" } }))).toBe("pass");
      expect(t.chief.route(dm("use the registry", { reply_to_message: { message_id: t.sent[0].messageId }, forward_origin: { type: "hidden_user", sender_user_name: "x" } }))).toBe("pass");
      await t.chief.idle();
      expect((await t.get(id)).status).toBe("open");
      expect(t.chief.route(dm("use the registry", { reply_to_message: { message_id: t.sent[0].messageId } }))).toBe("handled");
      await t.chief.idle();
      expect((await t.get(id)).answer).toMatchObject({ value: "reply", text: "use the registry", by: "user", via: "telegram" });
    });

    it("misconfigured: nothing is taken", async () => {
      const t = await itemSetup({ cfg: PRIVATE, misconfigured: "CHIEF_CONSOLE_URL is not set" });
      const { id, card } = await t.add(CHOICE);
      expect(t.chief.route(dmTap(`q:o:${id}:1`, card))).toBe("pass");
      expect(t.chief.route(dm("x", { reply_to_message: { message_id: card } }))).toBe("pass");
      await t.chief.idle();
      expect((await t.get(id)).status).toBe("open");
    });

    it("a console with a fleet master chat (the owner's console) takes no tap and no reply from the private chat, as before", async () => {
      const t = await itemSetup();
      const { id, card } = await t.add(CHOICE);
      const before = await t.file(id);
      expect(t.chief.route(dmTap(`q:o:${id}:1`, card))).toBe("pass");
      expect(t.chief.route(dm("B", { reply_to_message: { message_id: card } }))).toBe("pass");
      await t.chief.idle();
      expect(await t.file(id)).toBe(before);
      expect(t.sent).toEqual([]);
      expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
    });
  });

  it("q:o:<id>:1 answers B via telegram; the tap is answered; no reply", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    const u = tap(`q:o:${id}:1`, card);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("answered");
    expect(it.answer).toMatchObject({ value: "B", by: "user", via: "telegram" });
    expect(t.tg.answerCallbackQuery).toHaveBeenCalledWith(u.callback_query!.id);
    expect(t.replies()).toEqual([]);
    expect(await t.decisions.read()).toEqual([expect.objectContaining({ via: "queue-telegram", itemId: id, value: "B" })]);
  });

  it("a valid tap from the user in the Master chat on a card in another thread passes and changes nothing (queue, rule and proposal buttons)", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    const elsewhere = { message: tgMessage(card, { chat: forum, message_thread_id: CFG.threadId + 1, is_topic_message: true }) };
    const before = await t.file(id);
    for (const data of [`q:o:${id}:1`, `q:s:${id}`, `q:c:${id}`, "q:k:r_abcde", "q:p:brain"]) {
      expect(t.chief.route(tap(data, card, elsewhere)), data).toBe("pass");
    }
    await t.chief.idle();
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
    expect(await t.file(id)).toBe(before);
    expect(t.replies()).toEqual([]);
    expect(await t.decisions.read()).toEqual([]);
    // The same tap in the Master topic is handled.
    expect(t.chief.route(tap(`q:o:${id}:1`, card))).toBe("handled");
    await t.chief.idle();
    expect((await t.get(id)).answer).toMatchObject({ value: "B", via: "telegram" });
  });

  it("q:a on a preview answers approve via telegram", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PREVIEW);
    expect(t.chief.route(tap(`q:a:${id}`, card))).toBe("handled");
    await t.chief.idle();
    expect((await t.get(id)).answer).toMatchObject({ value: "approve", by: "user", via: "telegram" });
    expect(t.replies()).toEqual([]);
  });

  // Overview decision 60. A card posted before the rule still has its [Approve] button.
  it("q:a on a pr whose PR is not merged: refused with the reason on the card, the item unchanged", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    const before = await t.file(id);
    expect(t.chief.route(tap(`q:a:${id}`, card))).toBe("handled");
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.refused("PR #12 is not merged (open). Merge it first: this item then closes on its own.")]);
    expect(t.sent.at(-1)!.opts?.replyTo).toBe(card);
    expect(await t.decisions.read()).toEqual([]);
    expect(t.kicks).toEqual([]);
  });

  it("q:a on a pr whose state cannot be read: refused (fail closed), and the reply says so", async () => {
    const t = await itemSetup();
    t.merge.state = { state: "unknown", why: "gh pr view timed out after 10000 ms" };
    const { id, card } = await t.add(PR);
    const before = await t.file(id);
    t.chief.route(tap(`q:a:${id}`, card));
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.refused("Could not read the state of PR #12 (gh pr view timed out after 10000 ms). Approve is refused. Try again.")]);
  });

  it("q:a on a pr whose PR is merged closes the item as merged; no reply; the merged line is owed", async () => {
    const t = await itemSetup();
    t.merge.state = { state: "merged" };
    const { id, card } = await t.add(PR);
    t.chief.route(tap(`q:a:${id}`, card));
    await t.chief.idle();
    const it = await t.get(id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", delivery: { msgId: `${id}-m`, state: "pending" } });
    expect(it.answer).toBeUndefined();
    expect(t.replies()).toEqual([]);
    expect(t.kicks).toEqual([id]);
    expect(await t.decisions.read()).toEqual([expect.objectContaining({ via: "queue-telegram", itemId: id, value: "approve", correction: false })]);
  });

  it("Changes… on a pr still works while the PR is not merged", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    t.chief.route(tap(`q:c:${id}`, card));
    await t.chief.idle();
    t.chief.route(reply("split the migration", card));
    await t.chief.idle();
    expect(await t.get(id)).toMatchObject({ status: "answered", answer: { value: "changes", text: "split the migration", via: "telegram" } });
  });

  it("q:c sets awaiting changes and posts the hint on the card; a quoted reply answers changes with its text and clears awaiting", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    expect(t.chief.route(tap(`q:c:${id}`, card))).toBe("handled");
    await t.chief.idle();
    expect((await t.get(id)).telegram?.awaiting).toBe("changes");
    const hint = t.sent.at(-1)!;
    expect(hint).toEqual({ chatId: CFG.chatId, text: CHIEF_TG_TEXT.replyChanges, opts: { threadId: CFG.threadId, replyTo: card }, messageId: hint.messageId });
    expect(t.chief.route(reply("rename it", card))).toBe("handled");
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("answered");
    expect(it.answer).toMatchObject({ value: "changes", text: "rename it", by: "user", via: "telegram" });
    expect(it.telegram).toEqual({ cardMessageId: card, extraMessageIds: [hint.messageId] });
    // Handled: no Master-topic line, only the answer's own decision line.
    expect((await t.decisions.read()).map((l) => l.via)).toEqual(["queue-telegram"]);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyChanges]);
  });

  it("a quoted reply to the hint after q:c answers changes; multi-line text passes as is", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    t.chief.route(tap(`q:c:${id}`, card));
    await t.chief.idle();
    const hintId = t.sent.at(-1)!.messageId;
    expect(t.cards.lookup(hintId)).toMatchObject({ kind: "item", itemId: id });
    expect(t.chief.route(reply("rename it\n\nand split the migration", hintId))).toBe("handled");
    await t.chief.idle();
    expect((await t.get(id)).answer).toMatchObject({ value: "changes", text: "rename it\n\nand split the migration" });
  });

  it("q:r: a choice awaits other, a question awaits reply; the quoted reply answers reply with its text", async () => {
    const t = await itemSetup();
    const c = await t.add(CHOICE);
    const q = await t.add(QUESTION);
    t.chief.route(tap(`q:r:${c.id}`, c.card));
    t.chief.route(tap(`q:r:${q.id}`, q.card));
    await t.chief.idle();
    expect((await t.get(c.id)).telegram?.awaiting).toBe("other");
    expect((await t.get(q.id)).telegram?.awaiting).toBe("reply");
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyAnswer, CHIEF_TG_TEXT.replyAnswer]);
    t.chief.route(reply("neither: use the indexer", c.card));
    t.chief.route(reply("Use Postgres.", q.card));
    await t.chief.idle();
    expect((await t.get(c.id)).answer).toMatchObject({ value: "reply", text: "neither: use the indexer", via: "telegram" });
    expect((await t.get(q.id)).answer).toMatchObject({ value: "reply", text: "Use Postgres.", via: "telegram" });
    expect((await t.get(c.id)).telegram?.awaiting).toBeUndefined();
    expect((await t.get(q.id)).telegram?.awaiting).toBeUndefined();
  });

  it("a tap and a quoted reply routed back to back keep arrival order (the reply sees awaiting)", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    t.chief.route(tap(`q:c:${id}`, card));
    t.chief.route(reply("rename it", card));
    await t.chief.idle();
    expect((await t.get(id)).answer).toMatchObject({ value: "changes", text: "rename it" });
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyChanges]);
  });

  it("the hint's message id survives a restart: a new CardIndex loaded over the items finds it", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    t.chief.route(tap(`q:c:${id}`, card));
    await t.chief.idle();
    const hintId = t.sent.at(-1)!.messageId;
    expect((await t.get(id)).telegram?.extraMessageIds).toEqual([hintId]);
    const fresh = new CardIndex(t.paths.cards);
    await fresh.load((await t.store.list()).flatMap((i) => cardIdsOf(i).map((messageId) => ({ messageId, itemId: i.id }))));
    expect(fresh.lookup(hintId)).toMatchObject({ kind: "item", itemId: id });
    expect(fresh.lookup(card)).toMatchObject({ kind: "item", itemId: id });
    const after = t.make(fresh);
    expect(after.route(reply("rename it", hintId))).toBe("handled");
    await after.idle();
    expect((await t.get(id)).answer).toMatchObject({ value: "changes", text: "rename it" });
  });

  it("Review Focus 4: after q:r, a topic message that is not a reply is not an answer; it passes and is logged", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(QUESTION);
    t.chief.route(tap(`q:r:${id}`, card));
    await t.chief.idle();
    expect(t.chief.route(topic("use postgres"))).toBe("pass");
    expect(t.chief.route(reply("use sqlite", CFG.threadId))).toBe("pass");   // the topic root
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("open");
    expect(it.answer).toBeUndefined();
    expect(it.telegram?.awaiting).toBe("reply");
    expect(await t.decisions.read()).toEqual([
      expect.objectContaining({ by: "user", via: "master-telegram", text: "use postgres" }),
      expect.objectContaining({ by: "user", via: "master-telegram", text: "use sqlite" }),
    ]);
  });

  it("q:c, then a tab answer and a tab undo: the reopened item has no awaiting, and a later quoted reply gets Tap a button on the card first.", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PREVIEW);
    t.chief.route(tap(`q:c:${id}`, card));
    await t.chief.idle();
    expect((await t.get(id)).telegram?.awaiting).toBe("changes");
    // The tab answer drops awaiting in its own commit.
    expect(ok(await t.actions.answerUser(id, { value: "approve" }, "tab")).telegram?.awaiting).toBeUndefined();
    const reopened = ok(await t.actions.undo(id, USER_CALLER));
    expect(reopened.status).toBe("open");
    expect(reopened.telegram?.awaiting).toBeUndefined();
    const before = await t.file(id);
    const u = reply("rename it", card);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyChanges, CHIEF_TG_TEXT.tapFirst]);
    expect((await t.decisions.read()).map((l) => l.reason)).toEqual([undefined, "undo-own"]);
  });

  it("a quoted reply to an item card without awaiting answers Tap a button on the card first. and changes nothing", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    const before = await t.file(id);
    const u = reply("looks fine", card);
    expect(t.chief.route(u)).toBe("handled");
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect(t.sent).toEqual([{ chatId: CFG.chatId, text: CHIEF_TG_TEXT.tapFirst, opts: { threadId: CFG.threadId, replyTo: u.message!.message_id }, messageId: expect.any(Number) }]);
    expect(await t.decisions.read()).toEqual([]);
  });

  it("Review Focus 3: a tap on an answered or withdrawn item changes nothing and answers Already answered", async () => {
    const t = await itemSetup();
    const p = await t.add(PREVIEW);
    ok(await t.actions.answerUser(p.id, { value: "approve" }, "tab"));
    const c = await t.add(CHOICE);
    ok(await t.actions.withdraw(c.id, USER_CALLER));
    const before = [await t.file(p.id), await t.file(c.id)];
    const lines = await t.decisions.read();
    for (const data of [`q:a:${p.id}`, `q:c:${p.id}`, `q:s:${p.id}`, `q:o:${c.id}:0`, `q:r:${c.id}`, `q:x:${c.id}`]) {
      expect(t.chief.route(tap(data, data.includes(p.id) ? p.card : c.card)), data).toBe("handled");
    }
    await t.chief.idle();
    expect([await t.file(p.id), await t.file(c.id)]).toEqual(before);
    expect(await t.decisions.read()).toEqual(lines);
    expect(t.replies()).toEqual(Array(6).fill(CHIEF_TG_TEXT.alreadyAnswered));
    // Each reply quotes the tapped card (the two items' chains run side by side).
    expect(t.sent.map((s) => s.opts?.replyTo).sort()).toEqual([p.card, p.card, p.card, c.card, c.card, c.card]);
  });

  it("Review Focus 3: q:o on the card of an item an undo reopened answers it", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    ok(await t.actions.answerUser(id, { value: "A" }, "tab"));
    ok(await t.actions.undo(id, USER_CALLER));
    t.chief.route(tap(`q:o:${id}:1`, card));
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("answered");
    expect(it.answer).toMatchObject({ value: "B", via: "telegram" });
    expect(it.answerSeq).toBe(2);
    expect(t.replies()).toEqual([]);
  });

  // The master's auto answer on a choice, as AutoAnswer commits it (status auto, a held slot).
  const autoAnswered = async (t: Awaited<ReturnType<typeof itemSetup>>, id: string, state: "held" | "pending" | "delivered") => {
    await t.store.withItem(id, async () => {
      const a = { value: "A", by: "master" as const, via: "cli" as const, at: t.clock.now, ruleIds: ["r_aaaaa"], confidence: 0.95 };
      await t.store.write(withAnswer((await t.store.get(id))!, a, { state, deliverAfter: t.clock.now + 60_000, attempts: 0 }));
    });
  };

  it("spec §5.6: q:o on a held auto item wins: the user's answer commits, the auto answer goes to history, audit superseded", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    await autoAnswered(t, id, "held");
    expect((await t.get(id)).status).toBe("auto");
    t.chief.route(tap(`q:o:${id}:1`, card));
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("answered");
    expect(it.answer).toMatchObject({ value: "B", by: "user", via: "telegram" });
    expect(it.history).toEqual([expect.objectContaining({ value: "A", by: "master" })]);
    expect(it.delivery).toMatchObject({ state: "pending" });
    expect(await readJsonl(t.paths.auditAuto)).toEqual([expect.objectContaining({ itemId: id, event: "superseded", value: "A" })]);
    expect(t.replies()).toEqual([]);
  });

  it("spec §5.6: q:o on an auto item past held (409 undo first) changes nothing and answers Already answered", async () => {
    for (const state of ["pending", "delivered"] as const) {
      const t = await itemSetup();
      const { id, card } = await t.add(CHOICE);
      await autoAnswered(t, id, state);
      const before = await t.file(id);
      t.chief.route(tap(`q:o:${id}:1`, card));
      await t.chief.idle();
      expect(await t.file(id)).toBe(before);
      expect(await readJsonl(t.paths.auditAuto)).toEqual([]);
      expect(t.replies()).toEqual([CHIEF_TG_TEXT.alreadyAnswered]);
    }
  });

  it("spec §5.6: q:r, then a held auto commits, then the quoted reply: the user's answer wins, the auto goes to history, audit superseded", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    t.chief.route(tap(`q:r:${id}`, card));
    await t.chief.idle();
    await autoAnswered(t, id, "held");
    expect((await t.get(id))).toMatchObject({ status: "auto", telegram: { awaiting: "other" } });
    expect(t.chief.route(reply("neither: use the indexer", card))).toBe("handled");
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("answered");
    expect(it.answer).toMatchObject({ value: "reply", text: "neither: use the indexer", by: "user", via: "telegram" });
    expect(it.history).toEqual([expect.objectContaining({ value: "A", by: "master" })]);
    expect(it.delivery).toMatchObject({ state: "pending" });
    expect(it.telegram?.awaiting).toBeUndefined();
    expect(await readJsonl(t.paths.auditAuto)).toEqual([expect.objectContaining({ itemId: id, event: "superseded", value: "A" })]);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyAnswer]);
  });

  it("spec §5.6: q:r, then an auto past held, then the quoted reply: Already answered, nothing changes", async () => {
    for (const state of ["pending", "delivered"] as const) {
      const t = await itemSetup();
      const { id, card } = await t.add(CHOICE);
      t.chief.route(tap(`q:r:${id}`, card));
      await t.chief.idle();
      await autoAnswered(t, id, state);
      const before = await t.file(id);
      t.chief.route(reply("neither", card));
      await t.chief.idle();
      expect(await t.file(id)).toBe(before);
      expect(await readJsonl(t.paths.auditAuto)).toEqual([]);
      expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyAnswer, CHIEF_TG_TEXT.alreadyAnswered]);
    }
  });

  it("a quoted reply to the card of an auto item that awaits nothing answers Already answered (that card has no buttons)", async () => {
    for (const state of ["held", "delivered"] as const) {
      const t = await itemSetup();
      const { id, card } = await t.add(CHOICE);
      await autoAnswered(t, id, state);
      const before = await t.file(id);
      const u = reply("B please", card);
      t.chief.route(u);
      await t.chief.idle();
      expect(await t.file(id)).toBe(before);
      expect(t.sent.map((s) => [s.text, s.opts?.replyTo])).toEqual([[CHIEF_TG_TEXT.alreadyAnswered, u.message!.message_id]]);
    }
  });

  it("q:r on a held auto item awaits the reply and the reply wins; on an auto past held it answers Already answered", async () => {
    const t = await itemSetup();
    const held = await t.add(CHOICE);
    await autoAnswered(t, held.id, "held");
    t.chief.route(tap(`q:r:${held.id}`, held.card));
    await t.chief.idle();
    expect((await t.get(held.id)).telegram?.awaiting).toBe("other");
    t.chief.route(reply("C: both", held.card));
    await t.chief.idle();
    expect(await t.get(held.id)).toMatchObject({ status: "answered", answer: { value: "reply", text: "C: both", by: "user" } });
    const past = await t.add(CHOICE);
    await autoAnswered(t, past.id, "pending");
    const before = await t.file(past.id);
    t.chief.route(tap(`q:r:${past.id}`, past.card));
    await t.chief.idle();
    expect(await t.file(past.id)).toBe(before);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.replyAnswer, CHIEF_TG_TEXT.alreadyAnswered]);
  });

  it("q:a then q:s on one card: the approve commits and the snooze answers Already answered", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PREVIEW);
    t.chief.route(tap(`q:a:${id}`, card));
    t.chief.route(tap(`q:s:${id}`, card));
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("answered");
    expect(it.answer?.value).toBe("approve");
    expect(it.snoozedUntil).toBeUndefined();
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.alreadyAnswered]);
  });

  it("two taps on one card apply in arrival order", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    t.chief.route(tap(`q:o:${id}:1`, card));
    t.chief.route(tap(`q:o:${id}:0`, card));
    await t.chief.idle();
    expect((await t.get(id)).answer?.value).toBe("B");
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.alreadyAnswered]);
  });

  it("a held item lock does not delay route() or the next update; the tap runs once the lock is free", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    const q = await t.add(PR);
    let release!: () => void;
    const blocker = t.store.withItem(id, () => new Promise<void>((res) => { release = res; }));
    const blocker2 = t.store.withItem(q.id, () => blocker);
    const u = tap(`q:o:${id}:0`, card);
    expect(t.chief.route(u)).toBe("handled");
    expect(t.chief.route(tap(`q:c:${q.id}`, q.card))).toBe("handled");
    expect(t.chief.route(topic("hello master"))).toBe("pass");
    await vi.waitFor(async () => expect((await t.decisions.read()).map((l) => l.text)).toEqual(["hello master"]));
    expect(t.tg.answerCallbackQuery).toHaveBeenCalledWith(u.callback_query!.id);
    expect((await t.get(id)).status).toBe("open");
    expect((await t.get(q.id)).telegram?.awaiting).toBeUndefined();
    release();
    await blocker;
    await blocker2;
    await t.chief.idle();
    expect((await t.get(id)).answer?.value).toBe("A");
    expect((await t.get(q.id)).telegram?.awaiting).toBe("changes");
  });

  it("q:u within the window undoes the named answer; the decision line is via queue-telegram", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    const a = ok(await t.actions.answerUser(id, { value: "B" }, "tab")).answer!;
    t.clock.now += 60_000;
    t.chief.route(tap(`q:u:${id}:1`, card));
    await t.chief.idle();
    const it = await t.get(id);
    expect(it.status).toBe("open");
    expect(it.history).toEqual([a]);
    expect(t.replies()).toEqual([]);
    expect((await t.decisions.read()).at(-1)).toMatchObject({ via: "queue-telegram", reason: "undo-own", value: "B" });
  });

  it("an [Undo] tap whose seq is older than answerSeq (undone and answered again) undoes nothing: Already answered", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(CHOICE);
    ok(await t.actions.answerUser(id, { value: "B" }, "tab"));
    ok(await t.actions.undo(id, USER_CALLER));
    ok(await t.actions.answerUser(id, { value: "A" }, "tab"));
    const before = await t.file(id);
    t.chief.route(tap(`q:u:${id}:1`, card));
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect((await t.get(id)).answer?.value).toBe("A");
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.alreadyAnswered]);
  });

  it("q:s snoozes 60 minutes; q:x withdraws", async () => {
    const t = await itemSetup();
    const s = await t.add(QUESTION);
    const x = await t.add(PR);
    t.chief.route(tap(`q:s:${s.id}`, s.card));
    t.chief.route(tap(`q:x:${x.id}`, x.card));
    await t.chief.idle();
    expect(await t.get(s.id)).toMatchObject({ status: "snoozed", snoozedUntil: t.clock.now + 60 * 60_000 });
    expect(await t.get(x.id)).toMatchObject({ status: "withdrawn", closedAt: t.clock.now });
    expect(t.replies()).toEqual([]);
  });

  it("a 400 changes nothing and gets a short reply: an option the item does not have, a reply with no text", async () => {
    const t = await itemSetup();
    const c = await t.add(CHOICE);
    const p = await t.add(PR);
    const before = await t.file(c.id);
    t.chief.route(tap(`q:o:${c.id}:5`, c.card));
    await t.chief.idle();
    expect(await t.file(c.id)).toBe(before);
    expect(t.replies()).toEqual([CHIEF_TG_TEXT.refused("no option 5 on this item")]);
    t.chief.route(tap(`q:c:${p.id}`, p.card));
    await t.chief.idle();
    // A photo reply with no caption, and no Telegram file client (`files`): only the text counts, so
    // changes needs text; awaiting stays.
    t.chief.route(reply("", p.card, { text: undefined, photo: [{ file_id: "f", width: 1, height: 1 }] }));
    await t.chief.idle();
    const it = await t.get(p.id);
    expect(it.status).toBe("open");
    expect(it.telegram?.awaiting).toBe("changes");
    expect(t.replies().at(-1)).toBe(CHIEF_TG_TEXT.refused("changes needs text"));
  });

  // A photo in an awaited reply becomes the answer's image (queue/answerImages.ts), its caption the text.
  describe("a photo reply", () => {
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
    const photo = (id: string, size?: number) => [{ file_id: `${id}-s`, width: 90, height: 90, file_size: 10 }, { file_id: id, width: 1280, height: 720, ...(size !== undefined ? { file_size: size } : {}) }];
    async function photoSetup(bytes: Record<string, Buffer | Error> = {}) {
      const wt = await mkdtemp(join(tmpdir(), "chief-tg-wt-"));
      roots.push(wt);
      const asked: string[] = [];
      const files: NonNullable<ChiefTgDeps["files"]> = {
        getFile: vi.fn(async (fileId: string) => { asked.push(fileId); return { file_path: `photos/${fileId}.jpg`, file_size: 20 }; }),
        downloadFile: vi.fn(async (path: string) => {
          const b = bytes[path.slice("photos/".length, -".jpg".length)] ?? JPG;
          if (b instanceof Error) throw b;
          return b;
        }),
      };
      const t = await itemSetup({ files, worktree: wt });
      return { ...t, wt, asked, files };
    }
    const uploads = (wt: string) => readdir(join(wt, ".choibot", "uploads")).catch(() => [] as string[]);

    it("Reply…, then a photo with a caption: the largest size goes up; the agent's copy, the ticket's copy, the caption as text", async () => {
      const t = await photoSetup();
      const { id, card } = await t.add(QUESTION);
      t.chief.route(tap(`q:r:${id}`, card));
      await t.chief.idle();
      t.chief.route(reply("", card, { text: undefined, caption: "the error\nafter Sign in", photo: photo("big") }));
      await t.chief.idle();
      expect(t.asked).toEqual(["big"]);
      const it = await t.get(id);
      expect(it.status).toBe("answered");
      expect(it.answer).toMatchObject({ value: "reply", text: "the error\nafter Sign in", via: "telegram", images: [{ name: "a1-1.jpg" }] });
      expect(it.answer!.images![0]!.path).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.jpg$/);
      expect(await readFile(join(t.wt, it.answer!.images![0]!.path))).toEqual(JPG);
      expect(await readdir(join(t.root, "queue", "media", id))).toEqual(["a1-1.jpg"]);
      expect(it.telegram?.awaiting).toBeUndefined();
      expect(t.kicks).toEqual([id]);
    });
    it("Changes… on a pr, then a photo with no caption: the change request is the image alone", async () => {
      const t = await photoSetup();
      const { id, card } = await t.add(PR);
      t.chief.route(tap(`q:c:${id}`, card));
      await t.chief.idle();
      t.chief.route(reply("", card, { text: undefined, photo: photo("p1") }));
      await t.chief.idle();
      const it = await t.get(id);
      expect(it.answer).toMatchObject({ value: "changes", images: [{ name: "a1-1.jpg" }] });
      expect(it.answer!.text).toBeUndefined();
    });
    it("the bytes are checked as for every answer image: not an image, too large or not readable is refused; nothing is answered, the card still waits", async () => {
      const t = await photoSetup({ html: Buffer.from("<html><script>1</script></html>"), gone: new Error("socket hang up") });
      const { id, card } = await t.add(QUESTION);
      t.chief.route(tap(`q:r:${id}`, card));
      await t.chief.idle();
      t.chief.route(reply("", card, { text: undefined, photo: photo("html") }));
      t.chief.route(reply("", card, { text: undefined, photo: photo("huge", 11 * 1024 * 1024) }));
      t.chief.route(reply("", card, { text: undefined, photo: photo("gone") }));
      await t.chief.idle();
      expect(t.replies().slice(-3).sort()).toEqual([
        CHIEF_TG_TEXT.refused("not a PNG, JPEG, GIF or WebP image"),
        CHIEF_TG_TEXT.refused("the photo is too large (max 10 MB)"),
        CHIEF_TG_TEXT.refused(CHIEF_TG_TEXT.photoUnread),
      ].sort());
      expect(t.asked).not.toContain("huge"); // its size said no before any download
      const it = await t.get(id);
      expect(it.status).toBe("open");
      expect(it.telegram?.awaiting).toBe("reply");
      expect(await uploads(t.wt)).toEqual([]);
    });
    it("an album: the first photo answers, each other one gets Already answered", async () => {
      const t = await photoSetup();
      const { id, card } = await t.add(QUESTION);
      t.chief.route(tap(`q:r:${id}`, card));
      await t.chief.idle();
      t.chief.route(reply("", card, { text: undefined, caption: "two views", media_group_id: "g1", photo: photo("one") }));
      t.chief.route(reply("", card, { text: undefined, media_group_id: "g1", photo: photo("two") }));
      await t.chief.idle();
      const it = await t.get(id);
      expect(it.answer!.images).toHaveLength(1);
      expect(t.replies().at(-1)).toBe(CHIEF_TG_TEXT.alreadyAnswered);
      expect(await uploads(t.wt)).toHaveLength(1);
    });
    it("a photo with no button tapped first: Tap a button on the card first., and no image is kept", async () => {
      const t = await photoSetup();
      const { id, card } = await t.add(QUESTION);
      t.chief.route(reply("", card, { text: undefined, photo: photo("x") }));
      await t.chief.idle();
      expect(t.replies()).toEqual([CHIEF_TG_TEXT.tapFirst]);
      expect((await t.get(id)).status).toBe("open");
      expect(await readdir(join(t.root, "queue", "media", id)).catch(() => [])).toEqual([]);
    });
  });

  it("a tap on an item that is gone (404) answers Already answered", async () => {
    const t = await itemSetup();
    t.chief.route(tap("q:a:q00000000", 4711));
    t.chief.route(tap("q:o:q00000000:0", 4711));
    t.chief.route(tap("q:c:q00000000", 4711));
    await t.chief.idle();
    expect(t.replies()).toEqual(Array(3).fill(CHIEF_TG_TEXT.alreadyAnswered));
  });

  it("a callback from another user, or in another chat, passes and changes nothing", async () => {
    const t = await itemSetup();
    const { id, card } = await t.add(PR);
    const before = await t.file(id);
    expect(t.chief.route(tap(`q:a:${id}`, card, { from: { id: 9, first_name: "Eve" } }))).toBe("pass");
    expect(t.chief.route(tap(`q:a:${id}`, card, { message: tgMessage(card, { chat: { id: -2002, type: "supergroup", is_forum: true } }) }))).toBe("pass");
    expect(t.chief.route(reply("rename it", card, { from: { id: 9, first_name: "Eve" } }))).toBe("pass");
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("misconfigured: item taps and item card replies pass", async () => {
    const t = await itemSetup({ misconfigured: "bad" });
    const { id, card } = await t.add(PR);
    const before = await t.file(id);
    expect(t.chief.route(tap(`q:a:${id}`, card))).toBe("pass");
    expect(t.chief.route(reply("rename it", card))).toBe("pass");
    await t.chief.idle();
    expect(await t.file(id)).toBe(before);
    expect(t.tg.answerCallbackQuery).not.toHaveBeenCalled();
    expect(t.attempts).toEqual([]);
  });

  it("a never-resolving hint send does not block the next tap; a button answer clears awaiting", async () => {
    let hang = false;
    const t = await itemSetup({ onSend: () => (hang ? new Promise(() => {}) : undefined) });
    const { id, card } = await t.add(PREVIEW);
    hang = true;
    t.chief.route(tap(`q:c:${id}`, card));
    t.chief.route(tap(`q:a:${id}`, card));
    await vi.waitFor(async () => expect((await t.get(id)).answer?.value).toBe("approve"));
    await vi.waitFor(async () => expect((await t.get(id)).telegram?.awaiting).toBeUndefined());
  });

  it("an action that throws is logged, never thrown; no unhandled rejection; the next tap runs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const t = await itemSetup();
      const { id, card } = await t.add(PREVIEW);
      vi.spyOn(t.actions, "answerUser").mockRejectedValueOnce(new Error("EIO on queue"));
      t.chief.route(tap(`q:a:${id}`, card));
      t.chief.route(tap(`q:a:${id}`, card));
      await t.chief.idle();
      await new Promise((res) => setTimeout(res, 10));
      expect(t.logs.some((l) => l.includes("EIO on queue"))).toBe(true);
      expect((await t.get(id)).answer?.value).toBe("approve");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
