import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueIntake, PHOTO_MAX_BYTES, CARD_RETRY_MS } from "./intake.js";
import { IssueActions } from "./actions.js";
import { IssueStore } from "./store.js";
import type { RepoGuess } from "./guess.js";
import { fakeBotApi, clientFor, USER_ID } from "./testkit.js";

async function setup(o: { files?: Record<string, Buffer>; guess?: () => Promise<RepoGuess> } = {}) {
  const store = new IssueStore(await mkdtemp(join(tmpdir(), "issues-in-")));
  const bot = fakeBotApi({ files: o.files });
  const tg = clientFor(bot);
  const actions = new IssueActions({ store, tg, chatId: USER_ID, dispatch: async () => "a" });
  const intake = new IssueIntake({
    store, actions, tg, now: () => 5,
    listRepoNames: async () => ["app-shop", "choibot"],
    guess: o.guess ?? (async () => ({ repo: "choibot", confidence: 0.9 })),
  });
  return { store, bot, intake };
}

describe("IssueIntake.fromTelegram", () => {
  it("saves the issue with photos, guess and summary, then posts its card", async () => {
    const t = await setup({ files: { "photos/p1.jpg": Buffer.from("one") } });
    const issue = await t.intake.fromTelegram({
      firstMessageId: 11, messageIds: [11, 12], text: "Checkout broken\n\ndetails", forwardedFrom: "Dana",
      photos: [{ file_id: "p1", width: 10, height: 10 }],
    });
    expect(issue).toMatchObject({
      id: "t11", source: "telegram", status: "pending", createdAt: 5,
      summary: "Checkout broken", forwardedFrom: "Dana", text: "Checkout broken\n\ndetails",
      repo: "choibot", repoConfidence: 0.9, repoChoices: ["app-shop", "choibot"],
      cardMessageId: 1000, chatMessageIds: [11, 12, 1000],
    });
    expect(issue.photos).toEqual([join(t.store.dir, "t11", "photo-1.jpg")]);
    expect(await readFile(issue.photos[0], "utf8")).toBe("one");
    expect(t.bot.sent()).toHaveLength(1);
    expect(t.bot.sent()[0].reply_parameters).toEqual({ message_id: 11, allow_sending_without_reply: true });
  });

  it("is idempotent: a re-delivered message makes no second issue or card", async () => {
    const t = await setup();
    const m = { firstMessageId: 11, messageIds: [11], text: "Bug", photos: [] };
    await t.intake.fromTelegram(m);
    await t.intake.fromTelegram(m);
    expect(await t.store.list()).toHaveLength(1);
    expect(t.bot.sent()).toHaveLength(1);
  });

  it("stays idempotent when two flushes deliver the same message at once", async () => {
    const t = await setup({ files: { "photos/p1.jpg": Buffer.from("one") } });
    const m = { firstMessageId: 18, messageIds: [18], text: "Bug", photos: [{ file_id: "p1", width: 1, height: 1 }] };
    const [a, b] = await Promise.all([t.intake.fromTelegram(m), t.intake.fromTelegram(m)]);
    expect(await t.store.list()).toHaveLength(1);
    expect(t.bot.sent()).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ cardMessageId: 1000, chatMessageIds: [18, 1000] });
  });

  it("skips a photo over 20 MB with a note, without calling getFile", async () => {
    const t = await setup();
    const issue = await t.intake.fromTelegram({
      firstMessageId: 13, messageIds: [13], text: "",
      photos: [{ file_id: "huge", width: 9000, height: 9000, file_size: PHOTO_MAX_BYTES + 1 }],
    });
    expect(issue.photos).toEqual([]);
    expect(issue.text).toBe("(photo skipped: over 20 MB)");
    expect(t.bot.sent("getFile")).toEqual([]);
  });

  it("summarizes a photo-only issue as (photo) and notes a failed download", async () => {
    const t = await setup(); // no files → download 404
    const issue = await t.intake.fromTelegram({ firstMessageId: 14, messageIds: [14], text: "", photos: [{ file_id: "p9", width: 1, height: 1 }] });
    expect(issue.text).toBe("(photo skipped: download failed)");
    const ok = await (await setup({ files: { "photos/p2.jpg": Buffer.from("x") } })).intake.fromTelegram(
      { firstMessageId: 15, messageIds: [15], text: "", photos: [{ file_id: "p2", width: 1, height: 1 }] });
    expect(ok.summary).toBe("(photo)");
  });

  it("retries a failed card send once after ~2 s", async () => {
    const t = await setup();
    const sleeps: number[] = [];
    const intake = new IssueIntake({
      store: t.store, tg: clientFor(t.bot), now: () => 5, sleep: async (ms) => { sleeps.push(ms); },
      actions: new IssueActions({ store: t.store, tg: clientFor(t.bot), chatId: USER_ID, dispatch: async () => "a" }),
      listRepoNames: async () => ["app-shop", "choibot"],
      guess: async () => ({ repo: "choibot", confidence: 0.9 }),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.bot.failNext(502, "Bad Gateway"); // the first sendMessage fails
    const issue = await intake.fromTelegram({ firstMessageId: 17, messageIds: [17], text: "Bug", photos: [] });
    vi.restoreAllMocks();
    expect(sleeps).toEqual([CARD_RETRY_MS]);
    expect(t.bot.sent()).toHaveLength(2);
    expect(issue).toMatchObject({ cardMessageId: 1000, chatMessageIds: [17, 1000] });
  });

  it("still posts a card (without Fix) when the guesser fails", async () => {
    const t = await setup({ guess: async () => { throw new Error("jev down"); } });
    const issue = await t.intake.fromTelegram({ firstMessageId: 16, messageIds: [16], text: "Bug", photos: [] });
    expect(issue).toMatchObject({ repo: null, repoConfidence: 0 });
    expect(t.bot.sent()[0].reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["Repo ▾", "Drop"]);
  });
});

describe("IssueIntake.fromUi", () => {
  it("creates a ui issue with a guessed repo and sends nothing to Telegram", async () => {
    const t = await setup();
    const issue = await t.intake.fromUi("  Wallet tab blank  ");
    expect(issue).toMatchObject({ source: "ui", status: "pending", text: "Wallet tab blank", repo: "choibot", chatMessageIds: [] });
    expect(issue.id).toMatch(/^u[0-9a-z]{8}$/);
    expect(t.bot.calls).toEqual([]);
  });
});
