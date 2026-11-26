import { describe, it, expect, vi } from "vitest";
import { TG_TEXT_MAX, TelegramError, clip, createTelegramClient } from "./telegram.js";
import { fakeBotApi, clientFor, tgMessage } from "./testkit.js";

describe("telegram client", () => {
  it("long-polls with the offset, the timeout, and only message + callback_query updates", async () => {
    const bot = fakeBotApi();
    bot.push({ update_id: 4, message: tgMessage(1) }, { update_id: 5, message: tgMessage(2, { text: "hi" }) });
    const got = await clientFor(bot).getUpdates(5, 30);
    expect(got.map((u) => u.update_id)).toEqual([5]);
    expect(bot.calls[0]).toEqual({
      method: "getUpdates",
      body: { offset: 5, timeout: 30, allowed_updates: ["message", "callback_query"] },
    });
  });

  it("clips message text to 3 900 chars and threads the reply", async () => {
    const bot = fakeBotApi();
    const m = await clientFor(bot).sendMessage(42, "x".repeat(100_000), { replyTo: 7 });
    const body = bot.sent()[0];
    expect(body.text.length).toBe(TG_TEXT_MAX);
    expect(body.text.endsWith("…")).toBe(true);
    expect(body.reply_parameters).toEqual({ message_id: 7, allow_sending_without_reply: true });
    expect(body.chat_id).toBe(42);
    expect(m.message_id).toBe(1000);
  });

  it("sends the inline keyboard when given, and none otherwise", async () => {
    const bot = fakeBotApi();
    const tg = clientFor(bot);
    const kb = { inline_keyboard: [[{ text: "Fix", callback_data: "f:t1" }]] };
    await tg.sendMessage(42, "card", { keyboard: kb });
    await tg.editMessageText(42, 9, "Dropped");
    expect(bot.sent()[0].reply_markup).toEqual(kb);
    expect(bot.sent("editMessageText")[0]).toEqual({ chat_id: 42, message_id: 9, text: "Dropped" });
  });

  it("treats 'message is not modified' as success", async () => {
    const bot = fakeBotApi();
    bot.failNext(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
    await expect(clientFor(bot).editMessageText(42, 9, "same")).resolves.toBeUndefined();
  });

  it("throws TelegramError with the API status for other failures, without the token", async () => {
    const bot = fakeBotApi();
    bot.failNext(409, "Conflict: terminated by other getUpdates request");
    const err = await clientFor(bot).getUpdates(0, 30).catch((e) => e);
    expect(err).toMatchObject({ name: "TelegramError", status: 409 });
    expect(String(err.message)).not.toContain("TEST-TOKEN");
  });

  it("answers a callback query and downloads a file", async () => {
    const bot = fakeBotApi({ files: { "photos/abc.jpg": Buffer.from("img") } });
    const tg = clientFor(bot);
    await tg.answerCallbackQuery("cq1");
    expect(bot.sent("answerCallbackQuery")[0]).toEqual({ callback_query_id: "cq1" });
    const f = await tg.getFile("abc");
    expect(f.file_path).toBe("photos/abc.jpg");
    expect((await tg.downloadFile("photos/abc.jpg")).toString()).toBe("img");
  });

  it("clip leaves short text alone", () => {
    expect(clip("hello")).toBe("hello");
  });

  it("clip bounds UTF-16 code units and never splits a surrogate pair", () => {
    const c = clip("x".repeat(TG_TEXT_MAX - 2) + "😀" + "yy");
    expect(c).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(c.length).toBeLessThanOrEqual(TG_TEXT_MAX);
    expect(c).toBe("x".repeat(TG_TEXT_MAX - 2) + "…");
    const e = clip("😀".repeat(3000));
    expect(e).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(e.length).toBeLessThanOrEqual(TG_TEXT_MAX);
    expect(e.endsWith("😀…")).toBe(true);
    expect(clip("😀".repeat(TG_TEXT_MAX / 2))).toBe("😀".repeat(TG_TEXT_MAX / 2)); // exactly at the limit
  });

  it("clip takes a max and keeps the same surrogate-safe cut", () => {
    expect(clip("x".repeat(10), 10)).toBe("x".repeat(10));
    expect(clip("x".repeat(11), 10)).toBe("x".repeat(9) + "…");
    // The emoji's high surrogate at the cut point: step back one unit.
    expect(clip("x".repeat(8) + "😀" + "yy", 10)).toBe("x".repeat(8) + "…");
  });
});

describe("sendMessage threadId", () => {
  it("sends message_thread_id only when given", async () => {
    const bot = fakeBotApi();
    const tg = clientFor(bot);
    await tg.sendMessage(-100, "a", { threadId: 7 });
    await tg.sendMessage(42, "b");
    expect(bot.sent()[0]).toMatchObject({ chat_id: -100, text: "a", message_thread_id: 7 });
    expect(bot.sent()[1]).not.toHaveProperty("message_thread_id");
  });
});

describe("deleteMessage and url buttons", () => {
  it("posts chat_id and message_id to deleteMessage", async () => {
    const bot = fakeBotApi();
    await clientFor(bot).deleteMessage(5, 9);
    expect(bot.sent("deleteMessage")).toEqual([{ chat_id: 5, message_id: 9 }]);
  });

  it("treats 'message to delete not found' as success", async () => {
    const bot = fakeBotApi();
    bot.failNext(400, "Bad Request: message to delete not found");
    await expect(clientFor(bot).deleteMessage(5, 9)).resolves.toBeUndefined();
  });

  it("throws TelegramError for other deleteMessage failures", async () => {
    const bot = fakeBotApi();
    bot.failNext(400, "Bad Request: message can't be deleted");
    await expect(clientFor(bot).deleteMessage(5, 9)).rejects.toBeInstanceOf(TelegramError);
    bot.failNext(403, "Forbidden: bot was blocked by the user");
    await expect(clientFor(bot).deleteMessage(5, 9)).rejects.toBeInstanceOf(TelegramError);
  });

  it("sends a url button unchanged", async () => {
    const bot = fakeBotApi();
    const kb = { inline_keyboard: [[{ text: "Diff", url: "https://x" }]] };
    await clientFor(bot).sendMessage(5, "card", { keyboard: kb });
    expect(bot.sent()[0].reply_markup).toEqual(kb);
  });

  describe("photos, media groups, markup edits, 429", () => {
    const png = (n: number) => ({ data: Buffer.from([0x89, 0x50, n]), filename: `p${n}.png`, mime: "image/png" });

    it("sendPhoto posts multipart with chat_id, message_thread_id and a photo part", async () => {
      const bot = fakeBotApi();
      const m = await clientFor(bot).sendPhoto(42, png(1), { threadId: 7 });
      expect(m.message_id).toBe(1000);
      expect(bot.calls).toHaveLength(1);
      expect(bot.calls[0].method).toBe("sendPhoto");
      expect(bot.calls[0].body).toEqual({ chat_id: "42", message_thread_id: "7" });
      expect(bot.calls[0].files).toEqual({ photo: { filename: "p1.png", type: "image/png", size: 3 } });
    });

    it("sendPhoto omits message_thread_id without a thread", async () => {
      const bot = fakeBotApi();
      await clientFor(bot).sendPhoto(42, png(1));
      expect(bot.calls[0].body).toEqual({ chat_id: "42" });
    });

    it.each([1, 11])("sendMediaGroup with %i photos throws before any request", async (n) => {
      const bot = fakeBotApi();
      await expect(clientFor(bot).sendMediaGroup(42, Array.from({ length: n }, (_, i) => png(i)))).rejects.toThrow(/2.*10/);
      expect(bot.calls).toHaveLength(0);
    });

    it("sendMediaGroup sends one request with attach:// refs and returns every message", async () => {
      const bot = fakeBotApi();
      const got = await clientFor(bot).sendMediaGroup(42, [png(1), png(2), png(3)], { threadId: 9 });
      expect(got.map((m) => m.message_id)).toEqual([1000, 1001, 1002]);
      expect(bot.calls).toHaveLength(1);
      const c = bot.calls[0];
      expect(c.method).toBe("sendMediaGroup");
      expect(JSON.parse(c.body.media)).toEqual([
        { type: "photo", media: "attach://p0" }, { type: "photo", media: "attach://p1" }, { type: "photo", media: "attach://p2" },
      ]);
      expect(Object.keys(c.files ?? {})).toEqual(["p0", "p1", "p2"]);
      expect(c.body.message_thread_id).toBe("9");
    });

    it("on 429 sleeps retry_after seconds once and retries", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "Too Many Requests: retry after 2", 2);
      const m = await tg.sendMessage(1, "hi");
      expect(sleep.mock.calls).toEqual([[2000]]);
      expect(m.message_id).toBe(1000);
      expect(bot.calls).toHaveLength(2);
    });

    it("retries a multipart call on 429 too", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "slow down", 1);
      await tg.sendPhoto(1, png(1));
      expect(sleep).toHaveBeenCalledWith(1000);
      expect(bot.calls.map((c) => c.method)).toEqual(["sendPhoto", "sendPhoto"]);
      expect(bot.calls[1].files?.photo.size).toBe(3);
    });

    it("throws TelegramError 429 when the retry is 429 as well", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "slow", 1);
      bot.failNext(429, "slow", 1);
      const err = await tg.sendMessage(1, "hi").catch((e) => e);
      expect(err).toBeInstanceOf(TelegramError);
      expect(err.status).toBe(429);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("a 429 with retry_after 30 still sleeps and retries", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "Too Many Requests: retry after 30", 30);
      await tg.sendMessage(1, "hi");
      expect(sleep.mock.calls).toEqual([[30_000]]);
      expect(bot.calls).toHaveLength(2);
    });

    it("a 429 with retry_after above 30 throws TelegramError 429 at once (a long flood wait never stalls the caller)", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "Too Many Requests: retry after 31", 31);
      const err = await tg.sendPhoto(1, png(1)).catch((e) => e);
      expect(err).toBeInstanceOf(TelegramError);
      expect(err.status).toBe(429);
      expect(sleep).not.toHaveBeenCalled();
      expect(bot.calls).toHaveLength(1);
    });

    it("a 429 without retry_after sleeps 1 s", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "slow");
      await tg.sendMessage(1, "hi");
      expect(sleep).toHaveBeenCalledWith(1000);
    });

    it("editMessageReplyMarkup sends the keyboard, or no reply_markup to remove it", async () => {
      const bot = fakeBotApi();
      const tg = clientFor(bot);
      const kb = { inline_keyboard: [[{ text: "Undo", callback_data: "q:u:q1:1" }]] };
      await tg.editMessageReplyMarkup(5, 9, kb);
      await tg.editMessageReplyMarkup(5, 9);
      const sent = bot.sent("editMessageReplyMarkup");
      expect(sent[0]).toEqual({ chat_id: 5, message_id: 9, reply_markup: kb });
      expect(sent[1]).toEqual({ chat_id: 5, message_id: 9 });
    });

    it("editMessageReplyMarkup resolves on 'message is not modified'", async () => {
      const bot = fakeBotApi();
      bot.failNext(400, "Bad Request: message is not modified");
      await expect(clientFor(bot).editMessageReplyMarkup(5, 9)).resolves.toBeUndefined();
    });

    it("getUpdates is not retried on 429 (the poller owns its backoff and abort)", async () => {
      const bot = fakeBotApi();
      const sleep = vi.fn(async () => {});
      const tg = createTelegramClient({ token: "T", fetch: bot.fetch, baseUrl: "http://tg.test", sleep });
      bot.failNext(429, "slow", 1);
      await expect(tg.getUpdates(0, 1)).rejects.toMatchObject({ status: 429 });
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
