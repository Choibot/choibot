// server/issues/telegram.ts — the small slice of the Telegram Bot API the
// Issues subsystem needs. `fetch` and the base URL are injectable so tests run
// against the in-memory fake in testkit.ts. The token only ever appears in the
// request URL — never in an error message or a log line.

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
export type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; is_forum?: boolean };
export type TgPhotoSize = { file_id: string; file_unique_id?: string; width: number; height: number; file_size?: number };
export type TgEntity = { type: string; offset: number; length: number };
export type TgForwardOrigin =
  | { type: "user"; date?: number; sender_user: TgUser }
  | { type: "hidden_user"; date?: number; sender_user_name: string }
  | { type: "chat"; date?: number; sender_chat: TgChat }
  | { type: "channel"; date?: number; chat: TgChat };
export type TgMessage = {
  message_id: number; date: number; chat: TgChat; from?: TgUser;
  text?: string; caption?: string; entities?: TgEntity[];
  photo?: TgPhotoSize[]; media_group_id?: string;
  forward_origin?: TgForwardOrigin;
  message_thread_id?: number;   // forum topic (absent in the General topic)
  is_topic_message?: boolean;
  reply_to_message?: { message_id: number };
  migrate_to_chat_id?: number;
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

// Telegram's hard limit is 4 096; keep headroom for the ellipsis and entities.
export const TG_TEXT_MAX = 3900;
// Only what we route. Anything else that still arrives is dropped by the poller.
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

// Telegram counts the limit in UTF-16 code units, so bound units (not code
// points), and step back one unit rather than keep a lone high surrogate.
// At most `max` units, "…" included.
export function clip(text: string, max = TG_TEXT_MAX): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

export class TelegramError extends Error {
  constructor(public status: number, public description: string) {
    super(`telegram ${status}: ${description}`);
    this.name = "TelegramError";
  }
}

export type TgFile = { data: Buffer; filename: string; mime: string };

export type TelegramClient = {
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: { replyTo?: number; keyboard?: InlineKeyboard; threadId?: number }): Promise<TgMessage>;
  // Omitting `keyboard` removes the message's inline keyboard.
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  // Omitting `keyboard` removes the message's inline keyboard.
  editMessageReplyMarkup(chatId: number, messageId: number, keyboard?: InlineKeyboard): Promise<void>;
  sendPhoto(chatId: number, photo: TgFile, opts?: { threadId?: number }): Promise<TgMessage>;
  // 2..10 photos (the API needs at least two); anything else throws before a request.
  sendMediaGroup(chatId: number, photos: TgFile[], opts?: { threadId?: number }): Promise<TgMessage[]>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  // An already-deleted message (400 "message to delete not found") resolves.
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
  downloadFile(filePath: string): Promise<Buffer>;
};

// The longest 429 wait (retry_after, seconds) the client sleeps through.
const RETRY_AFTER_MAX_S = 30;

type ApiReply<T> = {
  ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number };
};

export function createTelegramClient(opts: {
  token: string; fetch?: typeof fetch; baseUrl?: string; sleep?: (ms: number) => Promise<void>;
}): TelegramClient {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // One attempt. `retry` (default) sleeps `retry_after` on a 429 and tries once
  // more; the second 429 throws. A wait above RETRY_AFTER_MAX_S throws at once:
  // this client also serves issue intake, which a long flood wait must not
  // stall. getUpdates opts out: its caller owns the backoff, and a sleep here
  // would ignore the abort signal on shutdown.
  async function send<T>(method: string, init: RequestInit, retry: boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${base}/bot${opts.token}/${method}`, { method: "POST", ...init });
      let json: ApiReply<T> = {};
      try { json = (await res.json()) as ApiReply<T>; } catch { /* non-JSON error page */ }
      if (!res.ok || !json.ok) {
        const status = json.error_code ?? res.status;
        const after = json.parameters?.retry_after;
        const secs = Math.max(0, typeof after === "number" && Number.isFinite(after) ? after : 1);
        if (status === 429 && retry && attempt === 0 && secs <= RETRY_AFTER_MAX_S) {
          await sleep(secs * 1000);
          continue;
        }
        throw new TelegramError(status, json.description ?? `HTTP ${res.status}`);
      }
      return json.result as T;
    }
  }

  const call = <T>(method: string, body: object, signal?: AbortSignal, retry = true): Promise<T> =>
    send<T>(method, { headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }, retry);

  const callMultipart = <T>(method: string, fields: Record<string, string>, files: Record<string, TgFile>): Promise<T> => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const [k, v] of Object.entries(files)) form.append(k, new Blob([new Uint8Array(v.data)], { type: v.mime }), v.filename);
    return send<T>(method, { body: form }, true);
  };

  const threadField = (threadId?: number): Record<string, string> => (threadId ? { message_thread_id: String(threadId) } : {});

  return {
    getUpdates: (offset, timeoutSec, signal) =>
      call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES }, signal, false),

    sendMessage: (chatId, text, o = {}) =>
      call<TgMessage>("sendMessage", {
        chat_id: chatId,
        text: clip(text),
        ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
        ...(o.keyboard ? { reply_markup: o.keyboard } : {}),
        ...(o.threadId ? { message_thread_id: o.threadId } : {}),
      }),

    async editMessageText(chatId, messageId, text, keyboard) {
      try {
        await call("editMessageText", {
          chat_id: chatId, message_id: messageId, text: clip(text),
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
      } catch (e) {
        // Re-rendering an unchanged card is normal (double tap, retry).
        if (e instanceof TelegramError && /message is not modified/i.test(e.description)) return;
        throw e;
      }
    },

    async editMessageReplyMarkup(chatId, messageId, keyboard) {
      try {
        await call("editMessageReplyMarkup", {
          chat_id: chatId, message_id: messageId, ...(keyboard ? { reply_markup: keyboard } : {}),
        });
      } catch (e) {
        if (e instanceof TelegramError && /message is not modified/i.test(e.description)) return;
        throw e;
      }
    },

    sendPhoto: (chatId, photo, o = {}) =>
      callMultipart<TgMessage>("sendPhoto", { chat_id: String(chatId), ...threadField(o.threadId) }, { photo }),

    async sendMediaGroup(chatId, photos, o = {}) {
      if (photos.length < 2 || photos.length > 10) throw new Error(`sendMediaGroup needs 2..10 photos, got ${photos.length}`);
      const files: Record<string, TgFile> = {};
      photos.forEach((p, i) => { files[`p${i}`] = p; });
      const media = photos.map((_, i) => ({ type: "photo", media: `attach://p${i}` }));
      return callMultipart<TgMessage[]>(
        "sendMediaGroup", { chat_id: String(chatId), media: JSON.stringify(media), ...threadField(o.threadId) }, files);
    },

    async answerCallbackQuery(id, text) {
      await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
    },

    async deleteMessage(chatId, messageId) {
      try {
        await call("deleteMessage", { chat_id: chatId, message_id: messageId });
      } catch (e) {
        if (e instanceof TelegramError && e.status === 400 && /message to delete not found/i.test(e.description)) return;
        throw e;
      }
    },

    getFile: (fileId) => call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }),

    async downloadFile(filePath) {
      const res = await f(`${base}/file/bot${opts.token}/${filePath}`);
      if (!res.ok) throw new TelegramError(res.status, "file download failed");
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
