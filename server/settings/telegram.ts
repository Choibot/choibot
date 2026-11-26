// server/settings/telegram.ts — the Telegram part of the Settings page: what the running console
// has configured (from its env, read at boot), where it posts, whether the bot token works
// (getMe), and a test message per target.
//
// SECRETS: the bot token never leaves this module. The status carries `token: true|false`, the
// bot's public name, chat and topic ids, and env key NAMES. Every error text goes through
// scrub() first, which removes the token wherever it appears (a fetch error can name the URL).
import { createHash } from "node:crypto";
import { parseIssuesUserId } from "../issues/paths.js";
import { parseMasterTgConfig } from "../master/telegram.js";

export type Env = Record<string, string | undefined>;

export type TargetId = "master" | "queue" | "cron" | "notify";
export type Target = {
  id: TargetId;
  label: string;
  // What the console posts there, in a few words.
  what: string;
  // The env keys this target reads, in the order to set them.
  keys: string[];
  // The keys that are not set or not valid (names only). Empty = ready.
  missing: string[];
  chatId: string | null;
  threadId: string | null;
  // Another target this one posts to (the queue cards go to the Master topic).
  sameAs?: TargetId;
  // A target the console has turned off on purpose (TELEGRAM_NOTIFY_AGENTS=0).
  off?: string;
  // Why it does not post although its keys are set (the chief's misconfigured reason).
  problem?: string;
  // Has its own destination: a test message can go there.
  testable: boolean;
};

export type TelegramConfig = {
  token: boolean;
  userId: string | null;
  targets: Target[];
};

const val = (env: Env, k: string): string => (env[k] ?? "").trim();
const isNegInt = (v: string): boolean => /^-\d+$/.test(v) && Number.isSafeInteger(Number(v));
const isPosInt = (v: string): boolean => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
// A chat id: a user (positive) or a group (negative).
const isChat = (v: string): boolean => isNegInt(v) || isPosInt(v);

// Mirrors the server's own boot rules (index.ts: the Notifier, the cron sender, the master bridge
// and the card poster), so "ready" here means the console posts there.
// `chief`: whether the chief runs, and its misconfigured reason (a fixed sentence, no value).
export function telegramConfig(env: Env, chief: { active: boolean; problem: string | null }): TelegramConfig {
  const token = val(env, "TELEGRAM_BOT_TOKEN") !== "";
  const user = val(env, "TELEGRAM_ISSUES_USER_ID");
  const userOk = parseIssuesUserId(user) !== null;
  const tokenMissing = token ? [] : ["TELEGRAM_BOT_TOKEN"];

  const mChat = val(env, "TELEGRAM_MASTER_CHAT_ID"), mThread = val(env, "TELEGRAM_MASTER_THREAD_ID");
  const masterMissing = [
    ...tokenMissing,
    ...(userOk ? [] : ["TELEGRAM_ISSUES_USER_ID"]),
    ...(isNegInt(mChat) ? [] : ["TELEGRAM_MASTER_CHAT_ID"]),
    ...(isPosInt(mThread) ? [] : ["TELEGRAM_MASTER_THREAD_ID"]),
  ];
  // The same rule the bridge uses (a check that the two never drift: the test).
  const masterReady = parseMasterTgConfig(env, parseIssuesUserId(user)) !== null;
  const master: Target = {
    // /pair works only on a console that pairs devices through Telegram (chief/telegram.ts).
    id: "master", label: "Fleet master chat", what: env.CHIEF_USER_AUTH === "log" ? "You talk to the fleet master here; /queue works here" : "You talk to the fleet master here; /pair and /queue work here",
    keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ISSUES_USER_ID", "TELEGRAM_MASTER_CHAT_ID", "TELEGRAM_MASTER_THREAD_ID"],
    missing: masterReady ? [] : masterMissing.length ? masterMissing : ["TELEGRAM_MASTER_CHAT_ID"],
    chatId: mChat || null, threadId: mThread || null, testable: true,
  };
  // The ticket cards: in the fleet master chat. With a connected account and no fleet master
  // chat they go to the user's private chat with the bot (master/telegram.ts cardChatOf).
  const privateCards = !masterReady && token && userOk;
  const queue: Target = {
    id: "queue", label: "Queue cards",
    what: privateCards ? "One card per ticket, with its answer buttons, in your chat with the bot" : "One card per ticket, with its answer buttons, in the fleet master chat",
    keys: [...master.keys, "CHIEF_ENABLED"],
    missing: [...(privateCards ? [] : master.missing), ...(chief.active || chief.problem ? [] : ["CHIEF_ENABLED"])],
    chatId: privateCards ? user : master.chatId, threadId: privateCards ? null : master.threadId,
    ...(privateCards ? {} : { sameAs: "master" as const }), testable: false,
    ...(!chief.active && chief.problem ? { problem: chief.problem } : {}),
  };

  const nChat = val(env, "TELEGRAM_CHAT_ID");
  const notifyOff = ["0", "false"].includes(val(env, "TELEGRAM_NOTIFY_AGENTS"));
  const notify: Target = {
    id: "notify", label: "Agent notifications", what: "A line when an agent finishes or needs you",
    keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    missing: [...tokenMissing, ...(isChat(nChat) ? [] : ["TELEGRAM_CHAT_ID"])],
    chatId: nChat || null, threadId: null, testable: true,
    ...(notifyOff ? { off: "Turned off: only recurring results use this chat" } : {}),
  };

  // Recurring results (the env keys keep the word "cron"): their own topic when both ids are set, else the notifications chat.
  const cChat = val(env, "TELEGRAM_CRON_CHAT_ID"), cThread = val(env, "TELEGRAM_CRON_THREAD_ID");
  const ownTopic = token && cChat !== "" && isPosInt(cThread);
  const cron: Target = ownTopic
    ? {
      id: "cron", label: "Recurring results", what: "The result of each run of a recurring task",
      keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CRON_CHAT_ID", "TELEGRAM_CRON_THREAD_ID"],
      missing: isChat(cChat) ? [] : ["TELEGRAM_CRON_CHAT_ID"], chatId: cChat, threadId: cThread, testable: true,
    }
    : {
      id: "cron", label: "Recurring results", what: "The result of each run of a recurring task",
      keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CRON_CHAT_ID", "TELEGRAM_CRON_THREAD_ID"],
      // No topic of its own: the console falls back to the notifications chat.
      missing: notify.missing.length ? [...new Set([...notify.missing, "TELEGRAM_CRON_CHAT_ID", "TELEGRAM_CRON_THREAD_ID"])] : [],
      chatId: notify.chatId, threadId: null, sameAs: notify.missing.length ? undefined : "notify", testable: false,
    };

  return { token, userId: user || null, targets: [master, queue, cron, notify] };
}

// Removes the token (and any /bot<token>/ path) from a text that may go to the browser or a log.
export function scrub(text: string, token: string | undefined): string {
  let t = text;
  if (token) t = t.split(token).join("<token>");
  return t.replace(/\/bot[^/\s]+\//g, "/bot<token>/").slice(0, 300);
}

export type BotInfo = { ok: true; username: string; name: string } | { ok: false; error: string };

type TgReply = {
  ok?: boolean; description?: string;
  result?: { id?: number; username?: string; first_name?: string; can_read_all_group_messages?: boolean; status?: string };
};

export type TelegramDeps = {
  fetch?: typeof fetch;
  // The Bot API origin (tests and the isolated instance give a fake one).
  apiBase?: string;
  now?: () => number;
};

const API = "https://api.telegram.org";

// The test-only Bot API origin (CHIEF_TEST=1 + CHIEF_TEST_TELEGRAM_API): accepted only for a
// loopback http origin, else ignored with one log line. The token goes in the URL path.
export function testTelegramApi(env: Env, log: (s: string) => void = (s) => console.warn(s)): string | undefined {
  const v = (env.CHIEF_TEST_TELEGRAM_API ?? "").trim();
  if (env.CHIEF_TEST !== "1" || !v) return undefined;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(v)) return v;
  log("[settings] CHIEF_TEST_TELEGRAM_API ignored: only http://127.0.0.1 or http://localhost");
  return undefined;
}
const GETME_TTL_MS = 5 * 60_000;

async function call(d: TelegramDeps, token: string, method: string, body: object): Promise<TgReply> {
  const f = d.fetch ?? fetch;
  const base = (d.apiBase ?? API).replace(/\/$/, "");
  const res = await f(`${base}/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let json: TgReply = {};
  try { json = (await res.json()) as TgReply; } catch { /* not JSON */ }
  if (!res.ok || !json.ok) throw new Error(json.description ?? `HTTP ${res.status}`);
  return json;
}

// getMe, cached per token (keyed by its hash, never the token itself).
export class BotCheck {
  private cache: { key: string; at: number; info: BotInfo } | null = null;
  constructor(private readonly d: TelegramDeps = {}) {}

  async info(token: string, fresh = false): Promise<BotInfo> {
    const now = (this.d.now ?? Date.now)();
    const key = createHash("sha256").update(token).digest("hex");
    if (!fresh && this.cache && this.cache.key === key && now - this.cache.at < GETME_TTL_MS) return this.cache.info;
    let info: BotInfo;
    try {
      const r = await call(this.d, token, "getMe", {});
      info = { ok: true, username: r.result?.username ?? "", name: r.result?.first_name ?? "" };
    } catch (e) {
      info = { ok: false, error: scrub(e instanceof Error ? e.message : String(e), token) };
    }
    this.cache = { key, at: now, info };
    return info;
  }
}

// One plain message (the link flow of link.ts: the test message and its answers). Throws a
// scrubbed error.
export async function sendText(d: TelegramDeps, token: string, chatId: number, text: string, o: { threadId?: number; replyTo?: number } = {}): Promise<void> {
  try {
    await call(d, token, "sendMessage", {
      chat_id: chatId, text,
      ...(o.threadId ? { message_thread_id: o.threadId } : {}),
      ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    });
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e), token));
  }
}

// Does the bot get every message of this group? Yes when its privacy mode is off, or when it is
// an admin of the group. Else it gets only commands, and the fleet master chat cannot work.
// Throws a scrubbed error when Telegram does not answer.
export async function readsGroup(d: TelegramDeps, token: string, chatId: number): Promise<boolean> {
  try {
    const me = (await call(d, token, "getMe", {})).result;
    if (me?.can_read_all_group_messages === true) return true;
    if (typeof me?.id !== "number") return false;
    const member = (await call(d, token, "getChatMember", { chat_id: chatId, user_id: me.id })).result;
    return member?.status === "administrator" || member?.status === "creator";
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e), token));
  }
}

export const TEST_TEXT = "Test message from the console's Settings page. Nothing to do.";

// One test message to a target's chat (and topic). Throws a scrubbed error.
export async function sendTest(d: TelegramDeps, token: string, t: Target, label = t.label): Promise<void> {
  if (!t.chatId) throw new Error("no chat id");
  try {
    await call(d, token, "sendMessage", {
      chat_id: Number(t.chatId), text: `${TEST_TEXT} (${label})`,
      ...(t.threadId ? { message_thread_id: Number(t.threadId) } : {}),
    });
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e), token));
  }
}

// A live check of a NEW token (the set-up form): getMe, no cache. `refused`: Telegram answered
// and does not accept it; else Telegram could not be reached. Nothing of the token is returned.
export async function checkToken(d: TelegramDeps, token: string): Promise<{ ok: true; username: string } | { ok: false; refused: boolean }> {
  const f = d.fetch ?? fetch;
  const base = (d.apiBase ?? API).replace(/\/$/, "");
  let res: Response;
  try {
    res = await f(`${base}/bot${token}/getMe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, refused: false };
  }
  let json: TgReply = {};
  try { json = (await res.json()) as TgReply; } catch { /* not JSON */ }
  if (res.ok && json.ok) return { ok: true, username: json.result?.username ?? "" };
  return { ok: false, refused: res.status >= 400 && res.status < 500 };
}
