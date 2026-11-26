import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramError, type TelegramClient } from "../../issues/telegram.js";
import { clientFor, fakeBotApi, USER_ID, type FakeBot } from "../../issues/testkit.js";
import type { MasterTgConfig } from "../../master/telegram.js";
import { CardPoster, cardRenderHash } from "./poster.js";
import { QueueStore, type NewItem } from "./store.js";
import type { Answer, QueueItem } from "./types.js";

const CFG: MasterTgConfig = { chatId: -1001, threadId: 7, userId: USER_ID };
const CONSOLE = "https://console.test";
const RULE = (id: string) => (id === "r_8f3k2" ? "app-shop token lists are explicit" : undefined);
const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const W = "3ee90a02-aaaa-bbbb";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-poster-"));
  clock = Date.UTC(2026, 10, 8, 14, 0, 0);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const choice = (over: Partial<NewItem> = {}): NewItem => ({
  kind: "choice", agentId: W, createdBy: { agentId: W, kind: "worker" },
  repo: "app-shop", area: "stats", title: "Stats page: token list source",
  body: "Option A keeps the explicit list. Option B reads the indexer registry.", blocking: true,
  choice: { options: [{ key: "A", label: "Explicit list" }, { key: "B", label: "Indexer registry" }] },
  ...over,
});
const preview = (images: string[]): NewItem => ({ ...choice({ choice: undefined }), kind: "preview", title: "Login page", preview: { images } });
const RECOMMEND = { value: "B", why: "w", ruleIds: ["r_8f3k2"], by: "fleet-master", at: 1 };
const userAnswer = (): Answer => ({ value: "B", by: "user", via: "tab", at: clock });
const answered = (it: QueueItem): QueueItem => ({ ...it, status: "answered", answer: userAnswer(), answerSeq: it.answerSeq + 1 });
const undone = (it: QueueItem): QueueItem => {
  const { answer, ...rest } = it;
  return { ...rest, status: "open", history: [...it.history, answer!] };
};

type Method = "sendMessage" | "sendPhoto" | "sendMediaGroup" | "editMessageText" | "editMessageReplyMarkup";
const METHODS: Method[] = ["sendMessage", "sendPhoto", "sendMediaGroup", "editMessageText", "editMessageReplyMarkup"];

// A poster over a real QueueStore under `root` (its onChange plays the hub
// `queue` event) and the fake Bot API. `fail[m]` makes the next n calls of m
// throw a 502 before they reach the bot; `hang` makes m never resolve.
// `attempts` lists every call the poster made, `bot.calls` those that reached
// the bot. `wired = false` stops the hub events (an item added while the
// poster was down).
function setup(o: { readMedia?: (item: QueueItem, name: string) => Promise<Buffer>; telegramAuto?: boolean; cfg?: ConstructorParameters<typeof CardPoster>[0]["cfg"] } = {}) {
  const bot: FakeBot = fakeBotApi();
  const client = clientFor(bot);
  const attempts: Method[] = [];
  const fail: Partial<Record<Method, number>> = {};
  const hang = new Set<Method>();
  const hangFirst = new Set<Method>(); // hangs the next call of m only
  const tg = Object.fromEntries(METHODS.map((m) => [m, (...args: unknown[]) => {
    attempts.push(m);
    if (hang.has(m)) return new Promise(() => {});
    if (hangFirst.delete(m)) return new Promise(() => {});
    if (fail[m]) { fail[m]!--; return Promise.reject(new TelegramError(502, "Bad Gateway")); }
    return (client[m] as (...a: unknown[]) => Promise<unknown>)(...args);
  }])) as unknown as Pick<TelegramClient, Method>;
  const events: QueueItem[] = [];
  const h = {
    bot, attempts, fail, hang, hangFirst, events, wired: true,
    index: new Map<number, string>(),
    logs: [] as string[],
    media: [] as string[],
    poster: undefined as unknown as CardPoster,
    deps: undefined as unknown as ConstructorParameters<typeof CardPoster>[0],
    store: undefined as unknown as QueueStore,
  };
  h.store = new QueueStore(join(root, "queue"), {
    now: () => clock, log: () => {},
    onChange: (i) => { events.push(i); if (h.wired) h.poster.onItem(i); },
  });
  h.deps = {
    tg, cfg: o.cfg ?? CFG, consoleUrl: CONSOLE, store: h.store,
    cards: { addItem: (messageId, itemId) => { h.index.set(messageId, itemId); } },
    readMedia: o.readMedia ?? (async (item, name) => { h.media.push(`${item.id}/${name}`); return IMG; }),
    ruleText: RULE, telegramAuto: o.telegramAuto ?? true, now: () => clock, log: (s) => { h.logs.push(s); },
  };
  h.poster = new CardPoster(h.deps);
  return h;
}
type H = ReturnType<typeof setup>;

const get = async (h: H, id: string): Promise<QueueItem> => (await h.store.get(id))!;
const patch = async (h: H, id: string, fn: (it: QueueItem) => QueueItem): Promise<void> => {
  await h.store.withItem(id, async () => { await h.store.write(fn((await h.store.get(id))!)); });
};
const methods = (h: H): string[] => h.bot.calls.map((c) => c.method);
const count = (h: H, m: Method): number => h.attempts.filter((a) => a === m).length;
const edits = (h: H) => h.bot.sent("editMessageText");
const buttons = (kb: { inline_keyboard: { text: string }[][] } | undefined): string[] =>
  (kb?.inline_keyboard ?? []).flat().map((b) => b.text);

// An item added while the poster was not listening.
async function addQuiet(h: H, input: NewItem, fn?: (it: QueueItem) => QueueItem): Promise<string> {
  h.wired = false;
  const { id } = await h.store.add(input);
  if (fn) await patch(h, id, fn);
  h.wired = true;
  return id;
}

// Real time, real file I/O: wait (event-loop turns, at most 2 s) for cond.
async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setImmediate(r));
  }
}

describe("CardPoster posts", () => {
  it("a new choice item posts one card in the Master topic and stores its id and render hash", async () => {
    const h = setup();
    const { id } = await h.store.add(choice());
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMessage"]);
    const [card] = h.bot.sent("sendMessage");
    expect(card.chat_id).toBe(CFG.chatId);
    expect(card.message_thread_id).toBe(CFG.threadId);
    expect(card.text.split("\n")[0]).toBe("▸ choice · app-shop · agent-3ee90a02 · now");
    expect(buttons(card.reply_markup)).toEqual(["Explicit list", "Indexer registry", "Other…", "Snooze 1h"]);
    const it = await get(h, id);
    expect(it.telegram?.cardMessageId).toBe(1000);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
    expect(it.telegram?.postFailed).toBeUndefined();
  });

  it("with no fleet master chat the card, its images and its edit go to the user's private chat, with no topic", async () => {
    const h = setup({ cfg: { chatId: USER_ID, userId: USER_ID } });
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    for (const c of h.bot.calls) {
      expect(Number(c.body.chat_id)).toBe(USER_ID);
      expect(c.body.message_thread_id).toBeUndefined();
    }
    const cardId = (await get(h, id)).telegram!.cardMessageId!;
    expect(h.index.get(cardId)).toBe(id);
    await patch(h, id, answered);
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    expect(edits(h)[0]).toMatchObject({ chat_id: USER_ID, message_id: cardId });
  });

  it("a preview with 3 images posts one media group (no caption, mime from the name), then the card", async () => {
    const h = setup();
    const { id } = await h.store.add(preview(["1.png", "2.jpg", "3.webp"]));
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    const group = h.bot.calls[0];
    expect(group.body.chat_id).toBe(String(CFG.chatId));
    expect(group.body.message_thread_id).toBe(String(CFG.threadId));
    expect(JSON.parse(group.body.media)).toEqual([0, 1, 2].map((i) => ({ type: "photo", media: `attach://p${i}` })));
    expect(Object.values(group.files!).map((f) => [f.filename, f.type])).toEqual(
      [["1.png", "image/png"], ["2.jpg", "image/jpeg"], ["3.webp", "image/webp"]]);
    expect(h.media).toEqual([`${id}/1.png`, `${id}/2.jpg`, `${id}/3.webp`]);
    const it = await get(h, id);
    expect(it.telegram).toMatchObject({ mediaMessageIds: [1000, 1001, 1002], cardMessageId: 1003 });
  });

  it("a pr item with screenshots (decision 65) posts its images, then one card with the pr buttons", async () => {
    const h = setup();
    const { id } = await h.store.add({ ...preview(["1.png", "2.png"]), kind: "pr", blocking: false, pr: { url: "https://github.com/o/app-shop/pull/7", number: 7 } });
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    expect(h.media).toEqual([`${id}/1.png`, `${id}/2.png`]);
    expect((await get(h, id)).telegram).toMatchObject({ mediaMessageIds: [1000, 1001], cardMessageId: 1002 });
    const card = h.bot.sent("sendMessage")[0];
    expect(card.text).toContain("Not merged yet");
    expect(JSON.stringify(card.reply_markup)).not.toContain("Looks good");
  });
  it("a pr item with no screenshots posts only its card", async () => {
    const h = setup();
    await h.store.add({ ...choice({ choice: undefined }), kind: "pr", blocking: false, pr: { url: "https://github.com/o/app-shop/pull/7", number: 7 } });
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMessage"]);
  });

  it("a preview with one image posts it with sendPhoto", async () => {
    const h = setup();
    const { id } = await h.store.add(preview(["1.png"]));
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendPhoto", "sendMessage"]);
    expect(h.bot.calls[0].files?.photo).toMatchObject({ filename: "1.png", type: "image/png" });
    expect(h.bot.calls[0].body.message_thread_id).toBe(String(CFG.threadId));
    expect((await get(h, id)).telegram).toMatchObject({ mediaMessageIds: [1000], cardMessageId: 1001 });
  });

  it("the index learns the card id and each media id", async () => {
    const h = setup();
    const { id } = await h.store.add(preview(["1.png", "2.png", "3.png"]));
    await h.poster.idle();
    expect([...h.index.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1000, id], [1001, id], [1002, id], [1003, id]]);
  });

  it("Review Focus 2: the media group succeeds and the card send throws → media ids stored, postFailed; the tick posts only the card", async () => {
    const h = setup();
    h.fail.sendMessage = 1;
    const { id } = await h.store.add(preview(["1.png", "2.png", "3.png"]));
    await h.poster.idle();
    let it = await get(h, id);
    expect(it.telegram?.mediaMessageIds).toEqual([1000, 1001, 1002]);
    expect(it.telegram?.postFailed).toBe(true);
    expect(it.telegram?.cardMessageId).toBeUndefined();
    expect(h.logs).toEqual([expect.stringContaining(id)]);

    await h.poster.tick();
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    expect(h.attempts).toEqual(["sendMediaGroup", "sendMessage", "sendMessage"]);
    it = await get(h, id);
    expect(it.telegram).toMatchObject({ mediaMessageIds: [1000, 1001, 1002], cardMessageId: 1003 });
    expect(it.telegram?.postFailed).toBeUndefined();
    expect(h.index.get(1003)).toBe(id);
  });

  it("a media group failure posts no card; the tick posts the media and the card", async () => {
    const h = setup();
    h.fail.sendMediaGroup = 1;
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect(h.attempts).toEqual(["sendMediaGroup"]);
    expect((await get(h, id)).telegram).toEqual({ postFailed: true });
    await h.poster.tick();
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    expect((await get(h, id)).telegram).toMatchObject({ mediaMessageIds: [1000, 1001], cardMessageId: 1002 });
  });

  it("a media file that cannot be read is permanent: no media call, mediaFailed, the card posted with the images line, never read again", async () => {
    let reads = 0;
    const h = setup({ readMedia: () => { reads++; return Promise.reject(new Error("ENOENT: 1.png")); } });
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    for (let i = 0; i < 3; i++) { clock += 30_000; await h.poster.tick(); await h.poster.idle(); }
    expect(methods(h)).toEqual(["sendMessage"]);
    expect(reads).toBe(2);
    const it = await get(h, id);
    expect(it.telegram).toMatchObject({ mediaFailed: true, cardMessageId: 1000 });
    expect(it.telegram?.postFailed).toBeUndefined();
    expect(h.bot.sent("sendMessage")[0].text.split("\n").at(-1)).toBe("2 images — see the Queue tab");
    expect(h.logs).toEqual([expect.stringContaining("ENOENT")]);
  });

  it("one item never gets two cards (two onItem calls in a row, a stale event, a tick at once)", async () => {
    const h = setup();
    const id = await addQuiet(h, choice());
    const it = await get(h, id);
    h.poster.onItem(it);
    h.poster.onItem(it);
    await h.poster.tick();
    await h.poster.idle();
    h.poster.onItem(it); // the payload still has no card id
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(1);
    expect((await get(h, id)).telegram?.cardMessageId).toBe(1000);
  });

  it("posts only open items: a snoozed item gets its card when it is open again; answered and withdrawn items never", async () => {
    const h = setup();
    const snoozed = await addQuiet(h, choice(), (i) => ({ ...i, status: "snoozed", snoozedUntil: clock + 3_600_000 }));
    const done = await addQuiet(h, choice(), answered);
    const gone = await addQuiet(h, choice(), (i) => ({ ...i, status: "withdrawn", closedAt: clock }));
    await h.poster.tick();
    await h.poster.idle();
    expect(h.attempts).toEqual([]);
    await patch(h, snoozed, (i) => ({ ...i, status: "open", snoozedUntil: undefined }));
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(1);
    expect((await get(h, snoozed)).telegram?.cardMessageId).toBe(1000);
    expect((await get(h, done)).telegram).toBeUndefined();
    expect((await get(h, gone)).telegram).toBeUndefined();
  });
});

describe("CardPoster edits in place", () => {
  async function posted(h: H, input: NewItem = choice()): Promise<string> {
    const { id } = await h.store.add(input);
    await h.poster.idle();
    return id;
  }

  it("an answered item's card is edited with ✓ and no keyboard", async () => {
    const h = setup();
    const id = await posted(h);
    await patch(h, id, answered);
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    const [e] = edits(h);
    expect(e.chat_id).toBe(CFG.chatId);
    expect(e.message_id).toBe(1000);
    expect(e.text).toMatch(/\n✓ B · you · \d\d:\d\d$/);
    expect(e.reply_markup).toBeUndefined();
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
  });

  it("a recommend written later edits the card text and keyboard (★ appears)", async () => {
    const h = setup();
    const id = await posted(h);
    expect(h.bot.sent("sendMessage")[0].text).not.toContain("★");
    await patch(h, id, (i) => ({ ...i, recommend: RECOMMEND }));
    await h.poster.idle();
    const [e] = edits(h);
    expect(e.message_id).toBe(1000);
    expect(e.text.split("\n").pop()).toBe('★ Master suggests B — rule r_8f3k2: "app-shop token lists are explicit"');
    expect(buttons(e.reply_markup)).toEqual(["Explicit list", "★ Indexer registry", "Other…", "Snooze 1h"]);
  });

  it("an undo that reopens the item restores the buttons", async () => {
    const h = setup();
    const id = await posted(h);
    await patch(h, id, answered);
    await h.poster.idle();
    await patch(h, id, undone);
    await h.poster.idle();
    expect(edits(h)).toHaveLength(2);
    const back = edits(h)[1];
    expect(back.text).not.toContain("✓");
    expect(buttons(back.reply_markup)).toEqual(["Explicit list", "Indexer registry", "Other…", "Snooze 1h"]);
  });

  it("an unchanged item is not edited twice, and an item that only aged is not edited at all", async () => {
    const h = setup();
    const id = await posted(h);
    const other = await posted(h);
    await patch(h, id, answered);
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    // A write that changes nothing the card shows (the delivery slot), a repeated event, a tick hours later.
    await patch(h, id, (i) => ({ ...i, delivery: { msgId: `${id}-1`, state: "delivered", attempts: 1 } }));
    h.poster.onItem(await get(h, id));
    h.poster.onItem(await get(h, other));
    clock += 5 * 3_600_000;
    await h.poster.tick();
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    expect(count(h, "sendMessage")).toBe(2);
  });

  it("a snooze changes nothing on the card", async () => {
    const h = setup();
    const id = await posted(h);
    await patch(h, id, (i) => ({ ...i, status: "snoozed", snoozedUntil: clock + 3_600_000 }));
    await h.poster.idle();
    expect(h.attempts).toEqual(["sendMessage"]);
  });

  it("a new poster over the same items (a restart) edits nothing when telegram.renderHash matches", async () => {
    const h = setup();
    const a = await posted(h);
    const b = await posted(h, preview(["1.png", "2.png"]));
    await patch(h, a, answered);
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMessage", "sendMediaGroup", "sendMessage", "editMessageText"]);

    const h2 = setup();
    await h2.poster.tick();
    h2.poster.onItem(await get(h2, a));
    h2.poster.onItem(await get(h2, b));
    await h2.poster.idle();
    expect(h2.attempts).toEqual([]);
  });

  it("the tick re-syncs a card whose stored hash is stale", async () => {
    const h = setup();
    const id = await posted(h);
    h.wired = false;
    await patch(h, id, (i) => ({ ...answered(i), telegram: { ...i.telegram, renderHash: "stale" } }));
    h.wired = true;
    await h.poster.tick();
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    expect(edits(h)[0].text).toContain("✓ B · you");
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
  });

  it("a 400 'message is not modified' counts as success: the hash is stored", async () => {
    const h = setup();
    const id = await posted(h);
    h.bot.failNext(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
    await patch(h, id, answered);
    await h.poster.idle();
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "editMessageText")).toBe(1);
    expect(h.logs).toEqual([]);
  });

  it("a card the user deleted: the hash is stored, logged once, no retry every tick", async () => {
    const h = setup();
    const id = await posted(h);
    h.bot.failNext(400, "Bad Request: message to edit not found");
    await patch(h, id, answered);
    await h.poster.idle();
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
    await h.poster.tick();
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "editMessageText")).toBe(1);
    expect(h.logs).toEqual([expect.stringContaining(id)]);
    expect((await get(h, id)).telegram?.postFailed).toBeUndefined();
  });

  it("any other edit error is logged and the tick retries the card", async () => {
    const h = setup();
    const id = await posted(h);
    const before = (await get(h, id)).telegram?.renderHash;
    h.fail.editMessageText = 1;
    await patch(h, id, answered);
    await h.poster.idle();
    let it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(before);
    expect(it.telegram?.postFailed).toBeUndefined();
    expect(h.logs).toEqual([expect.stringContaining(id)]);
    await h.poster.tick();
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
  });
});

describe("CardPoster retries and locks", () => {
  it("no tight loop: a card send that always throws makes one send for the first event and exactly one per tick", async () => {
    const h = setup();
    h.fail.sendMessage = Infinity;
    const { id } = await h.store.add(choice()); // onItem 1
    await h.poster.idle();
    const it = await get(h, id);
    expect(it.telegram?.postFailed).toBe(true);
    // The postFailed write was a hub event too (onItem 2), and it posted nothing.
    expect(h.events.filter((e) => e.telegram?.postFailed === true)).toHaveLength(1);
    expect(count(h, "sendMessage")).toBe(1);
    h.poster.onItem(it); // onItem 3
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(1);
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(2);
    clock += 60_000; // the backoff after a second failure
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(3);
    // postFailed is written only when it changes; the same failure is logged once.
    expect(h.events.filter((e) => e.telegram?.postFailed === true)).toHaveLength(1);
    expect(h.logs).toHaveLength(1);
  });

  it("start() posts an open item that never had a card at once, ticks every 30 s, and stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = setup();
    h.fail.sendMessage = 1;
    const a = await addQuiet(h, choice());
    const stop = h.poster.start();
    await until(() => count(h, "sendMessage") === 1);
    await h.poster.idle();
    await until(() => h.events.some((e) => e.telegram?.postFailed === true));
    vi.advanceTimersByTime(29_999);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(count(h, "sendMessage")).toBe(1);
    vi.advanceTimersByTime(1);
    await until(() => count(h, "sendMessage") === 2);
    await h.poster.idle();
    expect((await get(h, a)).telegram?.cardMessageId).toBe(1000);
    stop();
    const b = await addQuiet(h, choice());
    vi.advanceTimersByTime(120_000);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(count(h, "sendMessage")).toBe(2);
    expect((await get(h, b)).telegram).toBeUndefined();
  });

  it("a tick whose list fails is logged, never thrown", async () => {
    const h = setup();
    h.store.list = () => Promise.reject(new Error("EIO"));
    await expect(h.poster.tick()).resolves.toBeUndefined();
    expect(h.logs).toEqual([expect.stringContaining("EIO")]);
  });

  it("a Telegram call that never resolves does not block withItem for the same item, nor post twice", async () => {
    const h = setup();
    h.hang.add("sendMessage");
    const { id } = await h.store.add(choice());
    await until(() => count(h, "sendMessage") === 1);
    const free = h.store.withItem(id, async () => "free");
    const timeout = new Promise((r) => setTimeout(() => r("blocked"), 1000));
    expect(await Promise.race([free, timeout])).toBe("free");
    await patch(h, id, (i) => ({ ...i, recommend: RECOMMEND }));
    h.poster.onItem(await get(h, id));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(count(h, "sendMessage")).toBe(1);
  });

  it("a hung Telegram call on one item does not stop the tick from posting another", async () => {
    const h = setup();
    await addQuiet(h, choice());
    await addQuiet(h, choice({ title: "Second" }));
    h.hangFirst.add("sendMessage");
    await h.poster.tick();
    await until(() => count(h, "sendMessage") === 2);
    let posted = 0;
    for (let i = 0; i < 200 && posted === 0; i++) {
      await new Promise((r) => setImmediate(r));
      posted = (await h.store.list()).filter((it) => it.telegram?.cardMessageId !== undefined).length;
    }
    expect(posted).toBe(1);
  });

  it("onItem never throws", () => {
    const h = setup();
    expect(() => h.poster.onItem({ id: "qzzzzzzzz", status: "open" } as QueueItem)).not.toThrow();
    expect(() => h.poster.onItem(null as unknown as QueueItem)).not.toThrow();
  });
});

describe("CardPoster permanent refusals, backoff and the per-tick cap", () => {
  const PR: NewItem = { ...choice({ choice: undefined }), kind: "pr", title: "PR #3", pr: { url: "https://github.com/o/r/pull/3", number: 3 } };
  const tickAfter = async (h: H, ms: number): Promise<void> => {
    clock += ms;
    await h.poster.tick();
    await h.poster.idle();
  };

  it.each([
    ["sendMediaGroup", ["1.png", "2.png", "3.png"], "3 images — see the Queue tab"],
    ["sendPhoto", ["1.png"], "1 image — see the Queue tab"],
  ] as const)("a 400 from %s is permanent: one upload over three ticks, mediaFailed set, the card posted with the images line", async (m, images, line) => {
    const h = setup();
    h.bot.failNext(400, "Bad Request: PHOTO_INVALID_DIMENSIONS");
    const { id } = await h.store.add(preview([...images]));
    await h.poster.idle();
    for (let i = 0; i < 3; i++) await tickAfter(h, 30_000);
    expect(methods(h)).toEqual([m, "sendMessage"]);
    expect(h.media).toHaveLength(images.length);
    const it = await get(h, id);
    expect(it.telegram).toMatchObject({ mediaFailed: true, cardMessageId: 1000 });
    expect(it.telegram?.mediaMessageIds).toBeUndefined();
    expect(it.telegram?.postFailed).toBeUndefined();
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE));
    expect(h.bot.sent("sendMessage")[0].text.split("\n").at(-1)).toBe(line);
    expect(h.logs).toEqual([expect.stringContaining("PHOTO_INVALID_DIMENSIONS")]);
  });

  it("a 429 from the media send stays a retry: postFailed, no mediaFailed; the tick posts the media and the card", async () => {
    const h = setup();
    h.bot.failNext(429, "Too Many Requests: retry after 0", 0);
    h.bot.failNext(429, "Too Many Requests: retry after 0", 0);
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect((await get(h, id)).telegram).toEqual({ postFailed: true });
    await tickAfter(h, 30_000);
    expect((await get(h, id)).telegram).toMatchObject({ mediaMessageIds: [1000, 1001], cardMessageId: 1002 });
    expect((await get(h, id)).telegram?.mediaFailed).toBeUndefined();
  });

  it("a card refused with a 400 is sent once more at once without its URL buttons", async () => {
    const h = setup();
    h.bot.failNext(400, "Bad Request: BUTTON_URL_INVALID");
    const { id } = await h.store.add(PR);
    await h.poster.idle();
    const [first, second] = h.bot.sent("sendMessage");
    expect(h.bot.sent("sendMessage")).toHaveLength(2);
    expect(buttons(first.reply_markup)).toEqual(["Changes…", "Open PR", "Snooze 1h"]);
    expect(second.reply_markup).toEqual({ inline_keyboard: [
      [{ text: "Changes…", callback_data: `q:c:${id}` }],
      [{ text: "Snooze 1h", callback_data: `q:s:${id}` }],
    ] });
    expect(second.text).toBe(first.text);
    const it = await get(h, id);
    expect(it.telegram?.cardMessageId).toBe(1000);
    expect(it.telegram?.postFailed).toBeUndefined();
    expect(h.index.get(1000)).toBe(id);
    await tickAfter(h, 30_000);
    expect(h.attempts).toEqual(["sendMessage", "sendMessage"]);
  });

  it("a 400 on a card with no URL button is not resent; a 400 on both sends is a post failure", async () => {
    const h = setup();
    h.bot.failNext(400, "Bad Request: something");
    const c = await addQuiet(h, choice());
    h.poster.onItem(await get(h, c));
    await h.poster.idle();
    expect(h.attempts).toEqual(["sendMessage"]);
    expect((await get(h, c)).telegram).toEqual({ postFailed: true });
    h.bot.failNext(400, "Bad Request: BUTTON_URL_INVALID");
    h.bot.failNext(400, "Bad Request: something else");
    const p = await addQuiet(h, PR);
    h.poster.onItem(await get(h, p));
    await h.poster.idle();
    expect(h.attempts).toEqual(["sendMessage", "sendMessage", "sendMessage"]);
    expect((await get(h, p)).telegram).toEqual({ postFailed: true });
  });

  it("backoff: retried at the next tick after a first failure, not at the next tick after a second; then 60 s, doubling, at most 10 min", async () => {
    const h = setup();
    h.fail.sendMessage = Infinity;
    await h.store.add(choice());
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(1);
    await tickAfter(h, 30_000);
    expect(count(h, "sendMessage")).toBe(2);
    await tickAfter(h, 30_000); // the next tick after the second failure
    expect(count(h, "sendMessage")).toBe(2);
    // A tick every 30 s: when each attempt ran, then the seconds between them.
    const at = [clock - 60_000, clock - 30_000];
    while (at.length < 8) {
      await tickAfter(h, 30_000);
      if (count(h, "sendMessage") > at.length) at.push(clock);
    }
    expect(at.slice(1).map((t, i) => (t - at[i]) / 1000)).toEqual([30, 60, 120, 240, 480, 600, 600]);
  });

  it("a tick posts at most 10 new cards; the rest wait for the next tick", async () => {
    const h = setup();
    for (let i = 0; i < 15; i++) await addQuiet(h, choice({ title: `Item ${i}` }));
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(10);
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(15);
    expect((await h.store.list()).every((it) => it.telegram?.cardMessageId !== undefined)).toBe(true);
  });

  it("a run still hung from an earlier tick takes no slot: the next tick posts the others", async () => {
    const h = setup();
    for (let i = 0; i < 12; i++) await addQuiet(h, choice({ title: `Item ${i}` }));
    h.hang.add("sendMessage");
    await h.poster.tick();
    await until(() => count(h, "sendMessage") === 10);
    h.hang.delete("sendMessage");
    await h.poster.tick();
    await until(() => count(h, "sendMessage") === 12);
    let posted = 0;
    for (let i = 0; i < 200 && posted < 2; i++) {
      await new Promise((r) => setImmediate(r));
      posted = (await h.store.list()).filter((it) => it.telegram?.cardMessageId !== undefined).length;
    }
    expect(posted).toBe(2);
  });
});

describe("CardPoster 2b carry-overs: message budget, age order, media refusals, edit fallback, settled cards, lost records", () => {
  const PR: NewItem = { ...choice({ choice: undefined }), kind: "pr", title: "PR #3", pr: { url: "https://github.com/o/r/pull/3", number: 3 } };
  const IMAGES = (n: number): string[] => Array.from({ length: n }, (_, i) => `${i + 1}.png`);
  const tickAfter = async (h: H, ms: number): Promise<void> => {
    clock += ms;
    await h.poster.tick();
    await h.poster.idle();
  };
  const cardOf = async (h: H, id: string): Promise<number | undefined> => (await get(h, id)).telegram?.cardMessageId;
  // Makes the next n store writes that match `when` throw (a lost record write).
  const failWrites = (h: H, when: (it: QueueItem) => boolean, n = 1): void => {
    const write = h.store.write.bind(h.store);
    h.store.write = async (item) => {
      if (n > 0 && when(item)) { n--; throw new Error("EIO: record lost"); }
      return write(item);
    };
  };

  it("the budget counts messages: a 10-image preview (11 messages) first in the tick still posts; the item after it waits a tick", async () => {
    const h = setup();
    const big = await addQuiet(h, preview(IMAGES(10)));
    clock += 1000;
    const next = await addQuiet(h, choice());
    await h.poster.tick();
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    expect(await cardOf(h, big)).toBe(1010);
    expect(await cardOf(h, next)).toBeUndefined();
    await h.poster.tick();
    await h.poster.idle();
    expect(await cardOf(h, next)).toBe(1011);
  });

  it("the budget: two 4-image previews (5 messages each) fill a tick; the next post waits; a preview whose media is stored costs 1", async () => {
    const h = setup();
    const a = await addQuiet(h, preview(IMAGES(4)));
    clock += 1000;
    const b = await addQuiet(h, preview(IMAGES(4)));
    clock += 1000;
    const c = await addQuiet(h, choice());
    await h.poster.tick();
    await h.poster.idle();
    expect(methods(h).sort()).toEqual(["sendMediaGroup", "sendMediaGroup", "sendMessage", "sendMessage"]);
    expect(await cardOf(h, a)).toBeDefined();
    expect(await cardOf(h, b)).toBeDefined();
    expect(await cardOf(h, c)).toBeUndefined();
    // Nine 1-message items plus a preview whose images are already posted: 10 messages, one tick.
    const d = await addQuiet(h, preview(IMAGES(4)), (i) => ({ ...i, telegram: { mediaMessageIds: [1, 2, 3, 4] } }));
    for (let i = 0; i < 8; i++) { clock += 1000; await addQuiet(h, choice({ title: `Item ${i}` })); }
    await h.poster.tick();
    await h.poster.idle();
    expect((await h.store.list()).every((it) => it.telegram?.cardMessageId !== undefined)).toBe(true);
    expect((await get(h, d)).telegram?.mediaMessageIds).toEqual([1, 2, 3, 4]);
  });

  it("oldest first (createdAt, then id), whatever order the store lists the items in", async () => {
    const h = setup();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await addQuiet(h, choice({ title: `Item ${i}` })));
      clock += 1000;
    }
    clock -= 1000;
    ids.push(await addQuiet(h, choice({ title: "Item 10" }))); // the same createdAt as Item 9
    const [first, last] = [ids[9], ids[10]].sort();
    const list = h.store.list.bind(h.store);
    // Newest first: the reverse of the order the budget must follow.
    h.store.list = async () => (await list()).sort((p, q) => q.createdAt - p.createdAt || (p.id < q.id ? 1 : -1));
    await h.poster.tick();
    await h.poster.idle();
    const posted = (await list()).filter((it) => it.telegram?.cardMessageId !== undefined).map((it) => it.id).sort();
    expect(posted).toEqual([...ids.slice(0, 9), first].sort());
    expect(await cardOf(h, last)).toBeUndefined();
  });

  it("a 401 on the media and a failing card: postFailed, no mediaFailed; the next attempt sends the media again, then the card", async () => {
    const h = setup();
    h.bot.failNext(401, "Unauthorized");
    h.bot.failNext(401, "Unauthorized");
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    expect((await get(h, id)).telegram).toEqual({ postFailed: true });
    expect(h.events.some((e) => e.telegram?.mediaFailed === true)).toBe(false);
    await tickAfter(h, 30_000);
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage", "sendMediaGroup", "sendMessage"]);
    const it = await get(h, id);
    expect(it.telegram).toMatchObject({ mediaMessageIds: [1000, 1001], cardMessageId: 1002 });
    expect(it.telegram?.mediaFailed).toBeUndefined();
    expect(h.bot.sent("sendMessage")[1].text).not.toContain("see the Queue tab");
  });

  it("a 400 on the media and a card that goes: mediaFailed is written with the card id, in the same write", async () => {
    const h = setup();
    h.bot.failNext(400, "Bad Request: PHOTO_INVALID_DIMENSIONS");
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    const it = await get(h, id);
    expect(it.telegram).toMatchObject({ mediaFailed: true, cardMessageId: 1000 });
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE, RULE));
    const marked = h.events.filter((e) => e.telegram?.mediaFailed === true);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((e) => e.telegram?.cardMessageId === 1000)).toBe(true);
    expect(h.bot.sent("sendMessage")[0].text.split("\n").at(-1)).toBe("2 images — see the Queue tab");
    await tickAfter(h, 30_000);
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
  });

  it("an edit refused for a URL button is retried once at once without its link buttons, logged once per item; the tick does not edit again", async () => {
    const h = setup();
    const { id } = await h.store.add(PR);
    await h.poster.idle();
    h.bot.failNext(400, "Bad Request: BUTTON_URL_INVALID");
    await patch(h, id, (i) => ({ ...i, recommend: { ...RECOMMEND, value: "approve" } }));
    await h.poster.idle();
    expect(edits(h)).toHaveLength(2);
    const [first, second] = edits(h);
    expect(buttons(first.reply_markup)).toEqual(["Changes…", "Open PR", "Snooze 1h"]);
    expect(second.reply_markup).toEqual({ inline_keyboard: [
      [{ text: "Changes…", callback_data: `q:c:${id}` }],
      [{ text: "Snooze 1h", callback_data: `q:s:${id}` }],
    ] });
    expect(second.text).toBe(first.text);
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE, RULE));
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(2);
    // The next change is refused the same way: retried again, not logged again.
    h.bot.failNext(400, "Bad Request: BUTTON_URL_INVALID");
    await patch(h, id, (i) => ({ ...i, title: "PR #3 (rebased)" }));
    await h.poster.idle();
    expect(edits(h)).toHaveLength(4);
    expect(h.logs).toEqual([expect.stringContaining("BUTTON_URL_INVALID")]);
  });

  it("an edit refused for a URL button whose retry is refused too logs one stable line across ticks (2 edit calls a pass, hash stale)", async () => {
    const h = setup();
    const { id } = await h.store.add(PR);
    await h.poster.idle();
    const before = (await get(h, id)).telegram?.renderHash;
    for (let i = 0; i < 3; i++) {
      h.bot.failNext(400, "Bad Request: BUTTON_URL_INVALID");
      h.bot.failNext(401, "Unauthorized");
    }
    await patch(h, id, (i) => ({ ...i, title: "PR #3 (rebased)" }));
    await h.poster.idle();
    await tickAfter(h, 30_000);
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(6);
    expect(h.logs).toEqual([expect.stringContaining("Unauthorized")]);
    expect((await get(h, id)).telegram?.renderHash).toBe(before);
  });

  it("an edit refused with a 401 (not a URL-button problem) is not retried without its link buttons: one edit call a pass", async () => {
    const h = setup();
    const { id } = await h.store.add(PR);
    await h.poster.idle();
    h.bot.failNext(401, "Unauthorized");
    h.bot.failNext(401, "Unauthorized");
    await patch(h, id, (i) => ({ ...i, title: "PR #3 (rebased)" }));
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(2);
    expect(h.logs).toEqual([expect.stringContaining("Unauthorized")]);
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(3);
    expect(buttons(edits(h)[2].reply_markup)).toEqual(["Changes…", "Open PR", "Snooze 1h"]);
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE, RULE));
  });

  it("an edit of a card with a URL button: 'message to edit not found' keeps its handling (no retry, hash stored)", async () => {
    const h = setup();
    const { id } = await h.store.add(PR);
    await h.poster.idle();
    h.bot.failNext(400, "Bad Request: message to edit not found");
    await patch(h, id, (i) => ({ ...i, title: "PR #3 (rebased)" }));
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    const it = await get(h, id);
    expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE, RULE));
  });

  it("a card posted before the rule texts loaded is edited once they arrive (the tick), then left alone", async () => {
    const h = setup();
    h.deps.ruleText = () => undefined;
    const id = await addQuiet(h, choice(), (i) => ({ ...i, recommend: RECOMMEND }));
    await tickAfter(h, 0);
    expect(h.bot.sent("sendMessage")[0].text.split("\n").at(-1)).toBe("★ Master suggests B — rule r_8f3k2");
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(0);
    h.deps.ruleText = RULE;
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(1);
    expect(edits(h)[0].message_id).toBe(await cardOf(h, id));
    expect(edits(h)[0].text.split("\n").at(-1)).toBe('★ Master suggests B — rule r_8f3k2: "app-shop token lists are explicit"');
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(1);
  });

  it("a stale hash on an item closed 2 days ago is stored without an edit; one closed an hour ago is edited", async () => {
    const h = setup();
    const old = await addQuiet(h, choice());
    const recent = await addQuiet(h, choice({ title: "Recent" }));
    await tickAfter(h, 0);
    h.wired = false;
    const stale = (closedAt: number) => (i: QueueItem): QueueItem => ({ ...answered(i), closedAt, telegram: { ...i.telegram, renderHash: "stale" } });
    await patch(h, old, stale(clock - 2 * 86_400_000));
    await patch(h, recent, stale(clock - 3_600_000));
    h.wired = true;
    await tickAfter(h, 30_000);
    expect(edits(h).map((e) => e.message_id)).toEqual([await cardOf(h, recent)]);
    for (const id of [old, recent]) {
      const it = await get(h, id);
      expect(it.telegram?.renderHash).toBe(cardRenderHash(it, CONSOLE, RULE));
    }
    await tickAfter(h, 30_000);
    expect(edits(h)).toHaveLength(1);
  });

  it("a card sent whose record write throws: postFailed; the next attempt sends nothing and records the kept id", async () => {
    const h = setup();
    failWrites(h, (it) => it.telegram?.cardMessageId !== undefined);
    const { id } = await h.store.add(choice());
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(1);
    expect((await get(h, id)).telegram).toEqual({ postFailed: true });
    await tickAfter(h, 30_000);
    expect(count(h, "sendMessage")).toBe(1);
    const it = await get(h, id);
    expect(it.telegram).toMatchObject({ cardMessageId: 1000, renderHash: cardRenderHash(it, CONSOLE, RULE) });
    expect(it.telegram?.postFailed).toBeUndefined();
    expect(h.index.get(1000)).toBe(id);
    await tickAfter(h, 30_000);
    expect(h.attempts).toEqual(["sendMessage"]);
  });

  it("media sent whose record write throws: the next attempt records the kept media ids and sends only the card", async () => {
    const h = setup();
    failWrites(h, (it) => it.telegram?.mediaMessageIds !== undefined);
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect(methods(h)).toEqual(["sendMediaGroup"]);
    expect((await get(h, id)).telegram).toEqual({ postFailed: true });
    await tickAfter(h, 30_000);
    expect(methods(h)).toEqual(["sendMediaGroup", "sendMessage"]);
    expect((await get(h, id)).telegram).toMatchObject({ mediaMessageIds: [1000, 1001], cardMessageId: 1002 });
  });

  it("kept media ids of an item that closed before its card went are dropped (they can never be recorded)", async () => {
    const h = setup();
    const kept = () => (h.poster as unknown as { unrecorded: Map<string, unknown> }).unrecorded;
    failWrites(h, (it) => it.telegram?.mediaMessageIds !== undefined);
    const { id } = await h.store.add(preview(["1.png", "2.png"]));
    await h.poster.idle();
    expect(kept().has(id)).toBe(true);
    // Snoozed: it can be open again, so the ids stay (no second image set later).
    await patch(h, id, (i) => ({ ...i, status: "snoozed", snoozedUntil: clock + 3_600_000 }));
    await tickAfter(h, 30_000);
    expect(kept().has(id)).toBe(true);
    await patch(h, id, (i) => ({ ...i, status: "withdrawn", snoozedUntil: undefined, closedAt: clock }));
    await tickAfter(h, 30_000);
    expect(kept().has(id)).toBe(false);
    expect(methods(h)).toEqual(["sendMediaGroup"]);
  });

  it("a kept card on an item answered before its id was recorded: the tick records it, then the card is edited to the answer", async () => {
    const h = setup();
    failWrites(h, (it) => it.telegram?.cardMessageId !== undefined);
    const { id } = await h.store.add(choice());
    await h.poster.idle();
    await patch(h, id, answered);
    await h.poster.idle();
    await tickAfter(h, 30_000);
    expect(count(h, "sendMessage")).toBe(1);
    expect(await cardOf(h, id)).toBe(1000);
    expect(edits(h)).toHaveLength(1);
    expect(edits(h)[0].text).toContain("✓ B · you");
  });
});

describe("cardRenderHash", () => {
  const base = (over: Partial<QueueItem> = {}): QueueItem => ({
    ...choice(), id: "q7k2m9x1a", createdAt: clock, updatedAt: clock, status: "open", history: [], answerSeq: 0, ...over,
  });

  it("is a sha256 hex that does not change as the item ages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    const h1 = cardRenderHash(base(), CONSOLE);
    vi.setSystemTime(clock + 26 * 3_600_000);
    expect(cardRenderHash(base(), CONSOLE)).toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with what the card shows: a recommend, an answer, a new keyboard URL; not with a snooze", () => {
    const open = cardRenderHash(base(), CONSOLE);
    expect(cardRenderHash(base({ recommend: RECOMMEND }), CONSOLE)).not.toBe(open);
    expect(cardRenderHash(answered(base()), CONSOLE)).not.toBe(open);
    expect(cardRenderHash(base({ status: "snoozed", snoozedUntil: clock + 1 }), CONSOLE)).toBe(open);
    const pr = base({ kind: "pr", choice: undefined, pr: { local: { repo: "r", branch: "b" } } });
    expect(cardRenderHash(pr, CONSOLE)).not.toBe(cardRenderHash(pr, "https://other.test"));
    expect(cardRenderHash(base({ telegram: { cardMessageId: 5, renderHash: "x" }, updatedAt: 9 }), CONSOLE)).toBe(open);
  });

  it("includes the cited rule's text the card shows: the hash changes when the rule text appears or changes", () => {
    const rec = base({ recommend: RECOMMEND });
    const bare = cardRenderHash(rec, CONSOLE);
    expect(cardRenderHash(rec, CONSOLE, () => undefined)).toBe(bare);
    const withText = cardRenderHash(rec, CONSOLE, RULE);
    expect(withText).not.toBe(bare);
    expect(cardRenderHash(rec, CONSOLE, () => "another text")).not.toBe(withText);
    // An item that cites no rule hashes as before.
    expect(cardRenderHash(base(), CONSOLE, RULE)).toBe(cardRenderHash(base(), CONSOLE));
  });
});

describe("CardPoster auto line", () => {
  const AUTO: Answer = { value: "B", by: "master", via: "cli", at: 1, ruleIds: ["r_8f3k2"], confidence: 0.95 };
  const toAuto = (it: QueueItem): QueueItem => ({ ...it, status: "auto", answer: AUTO, answerSeq: it.answerSeq + 1 });
  async function autoItem(h: H): Promise<string> {
    const id = await addQuiet(h, choice());
    await patch(h, id, toAuto);
    return id;
  }

  it("postAuto sends one line with [Undo], stores the id in the index, autoMessageId and extraMessageIds", async () => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    const [line] = h.bot.sent("sendMessage");
    expect(line.text).toBe(`auto · ${id} · B · r_8f3k2`);
    expect(line.message_thread_id).toBe(CFG.threadId);
    expect(line.reply_markup).toEqual({ inline_keyboard: [[{ text: "Undo", callback_data: `q:u:${id}:1` }]] });
    const it = await get(h, id);
    expect(it.telegram?.autoMessageId).toBe(1000);
    expect(it.telegram?.extraMessageIds).toEqual([1000]);
    expect(h.index.get(1000)).toBe(id);
    await h.poster.postAuto(it);
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(1);
  });

  it("after an undo the keyboard is removed once, autoCleared is set, later events do nothing", async () => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    await patch(h, id, undone);
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
    const call = h.bot.calls.find((c) => c.method === "editMessageReplyMarkup")!;
    expect(call.body.message_id).toBe(1000);
    expect(call.body.reply_markup).toBeUndefined();
    expect((await get(h, id)).telegram?.autoCleared).toBe(true);
    h.poster.onItem(await get(h, id));
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
  });

  it("an auto item closed after its window (still auto) has its [Undo] removed once", async () => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    await patch(h, id, (i) => ({ ...i, closedAt: clock }));
    await h.poster.idle();
    expect((await get(h, id)).status).toBe("auto");
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
    expect(h.bot.calls.find((c) => c.method === "editMessageReplyMarkup")!.body).toEqual({ chat_id: CFG.chatId, message_id: 1000 });
    expect((await get(h, id)).telegram?.autoCleared).toBe(true);
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
  });

  it("a superseding user answer also removes the keyboard", async () => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    await patch(h, id, (i) => ({ ...i, status: "answered", answer: userAnswer(), answerSeq: i.answerSeq + 1 }));
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
    expect((await get(h, id)).telegram?.autoCleared).toBe(true);
  });

  it("a failed removal is logged and retried by the tick only; 'not modified' counts as done", async () => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    h.fail.editMessageReplyMarkup = 1;
    await patch(h, id, (i) => ({ ...i, status: "withdrawn" }));
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
    expect((await get(h, id)).telegram?.autoCleared).toBeUndefined();
    expect(h.logs).toHaveLength(1);
    await h.poster.tick();
    await h.poster.idle();
    expect((await get(h, id)).telegram?.autoCleared).toBe(true);
    const n = count(h, "editMessageReplyMarkup");
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(n);
  });

  it("a restart does not clear again; an unsent clear is done by the tick of a new poster", async () => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    h.wired = false;
    await patch(h, id, (it) => ({ ...it, status: "withdrawn" }));
    h.wired = true;
    const second = new CardPoster(h.deps); // a restart: same store, new poster
    await second.tick();
    await second.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
    expect((await get(h, id)).telegram?.autoCleared).toBe(true);
    const third = new CardPoster(h.deps);
    await third.tick();
    await third.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
  });

  it("production path: an auto commit on a posted card edits the card and postAuto merges into that run", async () => {
    const h = setup();
    const { id } = await h.store.add(choice());
    await h.poster.idle();
    await patch(h, id, toAuto); // wired: the hub event starts a card-edit run
    await h.poster.postAuto(await get(h, id)); // before idle(): merges via cur.auto
    await h.poster.idle();
    expect(edits(h)).toHaveLength(1);
    expect(edits(h)[0].text).toContain("· auto");
    const lines = h.bot.sent("sendMessage").filter((m) => m.text.startsWith("auto · "));
    expect(lines).toHaveLength(1);
    expect(lines[0].reply_markup).toEqual({ inline_keyboard: [[{ text: "Undo", callback_data: `q:u:${id}:1` }]] });
    expect((await get(h, id)).telegram?.autoMessageId).toBeDefined();
  });

  it.each([
    ["message gone", "Bad Request: message to edit not found"],
    ["not modified", "Bad Request: message is not modified: specified new message content and reply markup are exactly the same"],
  ])("a 400 '%s' on the removal counts as done: autoCleared set, no retry on the tick", async (_n, desc) => {
    const h = setup();
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    h.bot.failNext(400, desc);
    await patch(h, id, (i) => ({ ...i, status: "withdrawn" }));
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
    expect((await get(h, id)).telegram?.autoCleared).toBe(true);
    await h.poster.tick();
    await h.poster.idle();
    expect(count(h, "editMessageReplyMarkup")).toBe(1);
  });

  it("a success clears the logged failure, so the same failure logs again later", async () => {
    const h = setup();
    const id = await autoItem(h);
    h.fail.sendMessage = 1;
    await h.poster.postAuto(await get(h, id));
    expect(h.logs).toHaveLength(1);
    await h.poster.postAuto(await get(h, id)); // succeeds
    await h.poster.idle();
    h.fail.editMessageReplyMarkup = 1;
    await patch(h, id, (i) => ({ ...i, status: "withdrawn" }));
    await h.poster.idle();
    expect(h.logs).toHaveLength(2);
  });

  it("telegramAuto false sends nothing", async () => {
    const h = setup({ telegramAuto: false });
    const id = await autoItem(h);
    await h.poster.postAuto(await get(h, id));
    await h.poster.idle();
    expect(count(h, "sendMessage")).toBe(0);
  });

  it("an item no longer auto gets no line; a failed send is logged, never thrown", async () => {
    const h = setup();
    const open = await addQuiet(h, choice());
    await h.poster.postAuto(await get(h, open));
    await h.poster.idle();
    expect(methods(h).filter((m) => m === "sendMessage")).toEqual(["sendMessage"]); // its card only
    const id = await autoItem(h);
    h.fail.sendMessage = 1;
    await expect(h.poster.postAuto(await get(h, id))).resolves.toBeUndefined();
    expect((await get(h, id)).telegram?.autoMessageId).toBeUndefined();
    expect(h.logs.some((l) => l.includes(id))).toBe(true);
  });
});
