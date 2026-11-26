// server/chief/queue/cardmove.test.ts — when the chat of the ticket cards changes, the open
// items get a new card there; a console with a fleet master chat that never had its cards in a
// private chat (the owner's console) is not touched.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardChat } from "../../master/telegram.js";
import { MOVED_TEXT, moveCards } from "./cardmove.js";
import { QueueStore, type NewItem } from "./store.js";
import type { QueueItem } from "./types.js";

const ADA = 4242, EVE = 666;
const TOPIC: CardChat = { chatId: -1001, threadId: 7, userId: ADA };
const OWN: CardChat = { chatId: ADA, userId: ADA };
const W = "3ee90a02-aaaa-bbbb";
const choice: NewItem = {
  kind: "choice", agentId: W, createdBy: { agentId: W, kind: "worker" }, repo: "app", area: "app", title: "Pick", body: "b", blocking: true,
  choice: { options: [{ key: "A", label: "A" }, { key: "B", label: "B" }] },
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "chief-cardmove-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setup() {
  const store = new QueueStore(join(root, "queue"), { log: () => {} });
  const marker = join(root, "cards-chat.json");
  const edits: Array<[number, number, string]> = [];
  const tg = { editMessageText: vi.fn(async (chatId: number, messageId: number, text: string) => { edits.push([chatId, messageId, text]); }) };
  const logs: string[] = [];
  const patch = async (id: string, fn: (it: QueueItem) => QueueItem) => { await store.withItem(id, async () => { await store.write(fn((await store.get(id))!)); }); };
  // An item with a posted card (the poster's job).
  const add = async (card: number | null, over: Partial<QueueItem> = {}): Promise<string> => {
    const { id } = await store.add(choice);
    await patch(id, (it) => ({ ...it, ...(card === null ? {} : { telegram: { cardMessageId: card, renderHash: "h", extraMessageIds: [card + 1], awaiting: "other" as const } }), ...over }));
    return id;
  };
  const move = (chat: CardChat) => moveCards({ store, marker, chat, tg, log: (s) => { logs.push(s); } });
  const files = () => Object.fromEntries(readdirSync(join(root, "queue")).filter((f) => f.endsWith(".json")).map((f) => [f, readFileSync(join(root, "queue", f), "utf8")]));
  return { store, marker, edits, tg, logs, add, move, files };
}

describe("moveCards", () => {
  it("a console with a fleet master chat and no marker (the owner's console): nothing is written, nothing is sent", async () => {
    const t = setup();
    await t.add(100);
    await t.add(200, { status: "snoozed" });
    const before = t.files();
    const mtime = statSync(join(root, "queue")).mtimeMs;
    expect(await t.move(TOPIC)).toBe(0);
    expect(await t.move(TOPIC)).toBe(0);
    expect(t.files()).toEqual(before);
    expect(statSync(join(root, "queue")).mtimeMs).toBe(mtime);
    expect(existsSync(t.marker)).toBe(false);
    expect(readdirSync(root)).toEqual(["queue"]);
    expect(t.edits).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it("the first start with the cards in the private chat writes the marker; the next start changes nothing", async () => {
    const t = setup();
    const id = await t.add(null);
    expect(await t.move(OWN)).toBe(0);
    expect(JSON.parse(readFileSync(t.marker, "utf8"))).toEqual({ privateChat: ADA });
    // The poster posts the card in the private chat.
    await t.store.withItem(id, async () => { await t.store.write({ ...(await t.store.get(id))!, telegram: { cardMessageId: 55, renderHash: "h" } }); });
    const before = t.files();
    expect(await t.move(OWN)).toBe(0);
    expect(t.files()).toEqual(before);
    expect(t.edits).toEqual([]);
  });

  it("private chat, then a fleet master chat: each open item forgets its card (a new one is posted there), the old card loses its buttons", async () => {
    const t = setup();
    await t.move(OWN);
    const open = await t.add(55);
    const snoozed = await t.add(57, { status: "snoozed" });
    const answered = await t.add(59, { status: "answered", answer: { value: "A", by: "user", via: "tab", at: 1 } });
    const never = await t.add(null);
    expect(await t.move(TOPIC)).toBe(2);
    expect((await t.store.get(open))!.telegram).toBeUndefined();
    expect((await t.store.get(snoozed))!.telegram).toBeUndefined();
    // A closed item keeps its card (it shows the outcome). An item with no card is not written.
    expect((await t.store.get(answered))!.telegram).toMatchObject({ cardMessageId: 59 });
    expect((await t.store.get(never))!.telegram).toBeUndefined();
    expect(existsSync(t.marker)).toBe(false);
    await vi.waitFor(() => expect(t.edits).toHaveLength(2));
    expect(t.edits.sort((a, b) => a[1] - b[1])).toEqual([[ADA, 55, MOVED_TEXT], [ADA, 57, MOVED_TEXT]]);
    expect(t.logs).toEqual(["[chief] ticket cards: 2 open item(s) get a new card in the fleet master chat"]);
    // Done one time: the next start with the same chat changes nothing.
    const before = t.files();
    expect(await t.move(TOPIC)).toBe(0);
    expect(t.files()).toEqual(before);
  });

  it("a fleet master chat, then the private chat (the chat was disconnected): the open items forget their cards", async () => {
    const t = setup();
    const id = await t.add(100);
    expect(await t.move(OWN)).toBe(1);
    expect((await t.store.get(id))!.telegram).toBeUndefined();
    expect(JSON.parse(readFileSync(t.marker, "utf8"))).toEqual({ privateChat: ADA });
    // The old chat is not known any more: no edit there.
    expect(t.edits).toEqual([]);
  });

  it("another account was connected: the cards go to its private chat, the cards of the old one lose their buttons", async () => {
    const t = setup();
    await t.move(OWN);
    const id = await t.add(55);
    expect(await t.move({ chatId: EVE, userId: EVE })).toBe(1);
    expect((await t.store.get(id))!.telegram).toBeUndefined();
    expect(JSON.parse(readFileSync(t.marker, "utf8"))).toEqual({ privateChat: EVE });
    await vi.waitFor(() => expect(t.edits).toEqual([[ADA, 55, MOVED_TEXT]]));
  });

  it("a broken marker reads as no marker; a failure is logged and never thrown", async () => {
    const t = setup();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(t.marker, "{not json");
    const id = await t.add(100);
    expect(await t.move(TOPIC)).toBe(0);
    expect((await t.store.get(id))!.telegram).toMatchObject({ cardMessageId: 100 });
    const broken = { list: async () => { throw new Error("disk"); }, get: t.store.get.bind(t.store), withItem: t.store.withItem.bind(t.store), write: t.store.write.bind(t.store) };
    const logs: string[] = [];
    expect(await moveCards({ store: broken, marker: t.marker, chat: OWN, log: (s) => { logs.push(s); } })).toBe(0);
    expect(logs).toEqual(["[chief] ticket cards: the move failed: disk"]);
  });
});
