// server/settings/link.ts — "Telegram with no ids": the console reads the user's Telegram account
// and the fleet master chat from ONE message each, so nobody types a user id, a group id or a
// topic id.
//
//   account  the user presses "Connect your chat", gets a one-time code, and sends it to the bot
//            in a private chat ("Open Telegram" = /start <code>). The sender of THAT message is
//            the user.
//   chat     the user sends a second code in the topic they want. The group and the topic of
//            THAT message are the fleet master chat. Only the connected account can do it.
//
// The hard rule: nothing binds "the first person who writes to the bot". Only a message that
// carries the code binds. The code is random (40 bits), lives 10 minutes, works one time, is
// held as a hash in memory only (never in a file, a log or a status), and is made only by
// start(), which the route calls after gateUser. LINK_TRIES wrong codes end it. A wrong or old
// code changes nothing else and gets no answer.
//
// The ids go to the console's settings file through envfile.ts (the one writer), and the console
// reads them at its next start, as before. The small state file next to the chief's data holds
// only what the page shows (the name of the account, the title of the group) and when the test
// message went out. It is never read as an id: a change of that file binds nothing.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { DISPLAY_NAME } from "../brand.js";
import { readJson, writeJson } from "../chief/files.js";
import { chiefMisconfigured } from "../chief/paths.js";
import { parseIssuesUserId } from "../issues/paths.js";
import type { TgMessage, TgUpdate } from "../issues/telegram.js";
import { parseMasterTgConfig } from "../master/telegram.js";
import { readEnvFileKeys, writeEnvFile, type EnvChanges, type WritableKey } from "./envfile.js";
import { readsGroup, sendText, type Env, type TelegramDeps } from "./telegram.js";

export const LINK_TTL_MS = 600_000;
// Wrong codes one code takes. The last one ends the code.
export const LINK_TRIES = 5;
// 8 characters of 32: 40 bits. With 5 tries a guess hits 1 time in 2^37.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

export type LinkKind = "account" | "chat";
export type LinkRoute = "handled" | "pass";
// How a code ended. ok: the id is saved. expired: 10 minutes passed. spent: too many wrong
// codes. not-saved: the settings file could not be written. refused: a value is there and the
// user did not confirm its replacement.
export type LinkEnd = "ok" | "expired" | "spent" | "not-saved" | "refused";
export type Restart = { ok: true } | { ok: false; why: string };

export type LinkView = {
  account: { connected: boolean; name: string | null; tested: boolean };
  chat: { connected: boolean; title: string | null };
  // A code waits for its message. Never the code. `problem`: the right code came, but the
  // message cannot be used as it is (plain words, the user can repair it and send again).
  pending: { kind: LinkKind; expiresAt: number; problem: string | null } | null;
  // The last code that ended, until the next one starts. `who`: the account or the group.
  last: { kind: LinkKind; end: LinkEnd; who: string | null; test: boolean; restart: Restart | null } | null;
  // A value is saved, and the console must start again to use it.
  waitsRestart: boolean;
};

export const LINK_TEXT = {
  accountOk: `Connected. This chat now belongs to your ${DISPLAY_NAME} console: your tickets come here with answer buttons. This is the test message: nothing to do.`,
  chatOk: `Connected. This topic is now the fleet master chat of your ${DISPLAY_NAME} console: your tickets come here now, with answer buttons, and you can write to the fleet master here. This is the test message: nothing to do.`,
  test: `Test message from your ${DISPLAY_NAME} console. Nothing to do.`,
  otherPerson: "A message with the code came from another Telegram account. Send it from the account that you connected.",
  noTopics: "This group has no topics. Turn on Topics in the settings of the group, make a topic for the fleet master, and send the message again in that topic.",
  general: "This is the General topic. Make a topic of its own for the fleet master, and send the message again there.",
  privacy: "The bot cannot read the messages of this group. Make the bot an admin of the group, then send the message again. Or turn off its privacy mode: in @BotFather send /setprivacy, pick the bot, pick Disable. Then remove the bot from the group and add it again.",
  noAnswer: "Telegram did not answer the check of the group. Send the message again.",
  keepChat: "This console pairs devices through the fleet master chat, so it cannot disconnect it.",
} as const;

export type StartResult =
  | { ok: true; code: string; raw: string; expiresAt: number }
  // exists: a value is there. The page asks the user to confirm, then calls again with replace.
  | { ok: false; error: string; exists?: true };

type Shown = { userId: string; name: string; testAt: number | null; chat?: { id: string; title: string } };

type Pending = {
  kind: LinkKind; hash: Buffer; expiresAt: number; tries: number; replace: boolean;
  problem: string | null; timer: { clear(): void };
};

export type LinkDeps = {
  // The env the console started with.
  env: Env;
  envFile: string;
  // What the page shows of a connection (see the head of this file). Not an id store.
  stateFile: string;
  telegram?: TelegramDeps;
  // After a value was saved: start the console again (the route's own restart, one at a time).
  afterSave: () => Promise<Restart>;
  // The steps of the Set-up page read the state again.
  onChange?: () => void;
  now?: () => number;
  log?: (s: string) => void;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
};

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

// What a person types, as the code was made: no space, no hyphen, upper case, and the letters
// that the alphabet leaves out read as the digits they look like.
export const normalizeCode = (typed: string): string =>
  typed.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

// The code a message carries: "/start CODE" (what "Open Telegram" sends), "/connect@bot CODE"
// (a command reaches the bot in every group), or the code alone. `command`: an explicit try.
export function typedCode(m: TgMessage): { typed: string; command: boolean } | null {
  const text = (m.text ?? "").trim().slice(0, 200);
  const cmd = /^\/(?:start|connect)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (cmd) return cmd[1]?.trim() ? { typed: cmd[1].trim(), command: true } : null;
  return text && !text.startsWith("/") ? { typed: text, command: false } : null;
}

const nameOf = (m: TgMessage): string => {
  const u = m.from;
  if (!u) return "";
  return u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 64);
};

function asShown(raw: unknown): Shown | null {
  if (!raw || typeof raw !== "object") return null;
  const { userId, name, testAt, chat } = raw as Record<string, unknown>;
  if (typeof userId !== "string" || !/^\d{1,16}$/.test(userId)) return null;
  const c = chat as Record<string, unknown> | undefined;
  return {
    userId, name: typeof name === "string" ? name.slice(0, 64) : "",
    testAt: typeof testAt === "number" && Number.isFinite(testAt) ? testAt : null,
    ...(c && typeof c.id === "string" && typeof c.title === "string" ? { chat: { id: c.id, title: c.title.slice(0, 64) } } : {}),
  };
}

export class TelegramLink {
  // The console listens for the bot's messages while a code waits (server/index.ts: when the
  // one poller does not run, because no account is connected yet, it runs for that time only).
  onListen: (on: boolean) => void = () => {};
  private pending: Pending | null = null;
  private last: LinkView["last"] = null;
  private saved = false;
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: LinkDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  private token(): string { return (this.d.env.TELEGRAM_BOT_TOKEN ?? "").trim(); }
  private userId(): number | null { return parseIssuesUserId(this.d.env.TELEGRAM_ISSUES_USER_ID); }
  private chatReady(): boolean { return parseMasterTgConfig(this.d.env, this.userId()) !== null; }

  private async shown(): Promise<Shown | null> {
    const s = asShown(await readJson<unknown>(this.d.stateFile).catch(() => null));
    return s && s.userId === (this.d.env.TELEGRAM_ISSUES_USER_ID ?? "").trim() ? s : null;
  }

  private setPending(p: Pending | null): void {
    const was = this.pending;
    was?.timer.clear();
    this.pending = p;
    if (!!p !== !!was) this.onListen(!!p);
  }

  private end(kind: LinkKind, end: LinkEnd, o: { who?: string; test?: boolean; restart?: Restart } = {}): void {
    this.setPending(null);
    this.last = { kind, end, who: o.who ?? null, test: o.test === true, restart: o.restart ?? null };
    this.d.onChange?.();
  }

  // A new code, on the user's press (the route passed gateUser). It replaces the code before it.
  // The code goes back to the caller one time; this object keeps its hash.
  async start(kind: LinkKind, replace: boolean): Promise<StartResult> {
    if (!this.token()) return { ok: false, error: "Add the bot token first." };
    let file: Partial<Record<WritableKey, string>>;
    try { file = await readEnvFileKeys(this.d.envFile); } catch { return { ok: false, error: "The settings file of the console cannot be read." }; }
    const has = (k: WritableKey): boolean => (file[k] ?? "").trim() !== "";
    if (kind === "account") {
      if (has("TELEGRAM_ISSUES_USER_ID") && !replace) return { ok: false, exists: true, error: "A Telegram account is connected. A new one replaces it." };
    } else {
      if (this.userId() === null) {
        return { ok: false, error: has("TELEGRAM_ISSUES_USER_ID") ? "Your account is saved. Start the console again first." : "Connect your chat first." };
      }
      if ((has("TELEGRAM_MASTER_CHAT_ID") || has("TELEGRAM_MASTER_THREAD_ID")) && !replace) {
        return { ok: false, exists: true, error: "A fleet master chat is connected. A new one replaces it." };
      }
    }
    let raw = "";
    for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = this.now() + LINK_TTL_MS;
    const setTimer = this.d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { clear: () => clearTimeout(t) }; });
    const p: Pending = {
      kind, hash: sha256(raw), expiresAt, tries: 0, replace, problem: null,
      timer: setTimer(() => { if (this.pending === p) this.end(kind, "expired"); }, LINK_TTL_MS),
    };
    this.last = null;
    this.setPending(p);
    return { ok: true, code: `${raw.slice(0, 4)}-${raw.slice(4)}`, raw, expiresAt };
  }

  // The live code, or null. A code past its time ends here too (the timer is the other way).
  private live(): Pending | null {
    const p = this.pending;
    if (p && this.now() >= p.expiresAt) { this.end(p.kind, "expired"); return null; }
    return this.pending;
  }

  // Asked by the one poller before every other route. With no code waiting it passes at once:
  // a console where nobody pressed "Connect" behaves as before.
  async route(u: TgUpdate): Promise<LinkRoute> {
    const m = u.message;
    const p = this.live();
    if (!p || !m) return "pass";
    const priv = m.chat.type === "private";
    const group = m.chat.type === "group" || m.chat.type === "supergroup";
    if (p.kind === "account" ? !priv : !group) return "pass";
    const c = typedCode(m);
    if (!c) return "pass";
    // Hashes of equal length: the compare leaks neither the code nor its length.
    if (!timingSafeEqual(p.hash, sha256(normalizeCode(c.typed)))) {
      // Plain talk is not a try. A command with a wrong code is: no answer, and the last one
      // ends the code.
      if (!c.command) return "pass";
      if (++p.tries >= LINK_TRIES) this.end(p.kind, "spent");
      return "handled";
    }
    try {
      if (p.kind === "account") await this.bindAccount(m, p);
      else await this.bindChat(m, p);
    } catch (e) {
      this.log(`[settings] telegram link failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return "handled";
  }

  private async bindAccount(m: TgMessage, p: Pending): Promise<void> {
    const from = m.from;
    // A person in their own private chat with the bot, never a bot or a channel.
    if (!from || from.is_bot === true || from.id !== m.chat.id || !Number.isSafeInteger(from.id) || from.id <= 0) return;
    this.setPending(null); // one use: gone before any write
    const id = String(from.id);
    const who = nameOf(m);
    let have: string;
    try { have = ((await readEnvFileKeys(this.d.envFile)).TELEGRAM_ISSUES_USER_ID ?? "").trim(); } catch { return this.end("account", "not-saved"); }
    // A value that exists is never replaced without the user's confirm.
    if (have && have !== id && !p.replace) return this.end("account", "refused");
    if (have !== id) {
      try { await writeEnvFile(this.d.envFile, { TELEGRAM_ISSUES_USER_ID: id }); } catch { return this.end("account", "not-saved"); }
      this.saved = true;
      this.log("[settings] telegram account connected with a one-time code: TELEGRAM_ISSUES_USER_ID saved");
    }
    const test = await sendText(this.d.telegram ?? {}, this.token(), from.id, LINK_TEXT.accountOk).then(() => true, () => false);
    await writeJson(this.d.stateFile, { userId: id, name: who, testAt: test ? this.now() : null } satisfies Shown).catch(() => {});
    this.end("account", "ok", { who, test, ...(have !== id ? { restart: await this.d.afterSave() } : {}) });
  }

  private async bindChat(m: TgMessage, p: Pending): Promise<void> {
    const tg = this.d.telegram ?? {};
    const userId = this.userId();
    // Only the connected account. Another person gets no answer; the page says what came.
    if (userId === null || m.from?.id !== userId) { p.problem = LINK_TEXT.otherPerson; return; }
    const say = (text: string): Promise<void> => {
      p.problem = text;
      return sendText(tg, this.token(), m.chat.id, text, { threadId: m.message_thread_id, replyTo: m.message_id }).catch(() => {});
    };
    if (m.chat.type !== "supergroup" || m.chat.is_forum !== true) return say(LINK_TEXT.noTopics);
    const threadId = m.message_thread_id;
    if (m.is_topic_message !== true || !threadId || !Number.isSafeInteger(threadId) || threadId <= 0) return say(LINK_TEXT.general);
    let reads: boolean;
    try { reads = await readsGroup(tg, this.token(), m.chat.id); } catch { return say(LINK_TEXT.noAnswer); }
    if (!reads) return say(LINK_TEXT.privacy);
    if (this.pending !== p) return; // a new code came while Telegram answered
    this.setPending(null);
    const chatId = String(m.chat.id), topic = String(threadId), title = (m.chat.title ?? "").slice(0, 64);
    let file: Partial<Record<WritableKey, string>>;
    try { file = await readEnvFileKeys(this.d.envFile); } catch { return this.end("chat", "not-saved"); }
    const haveChat = (file.TELEGRAM_MASTER_CHAT_ID ?? "").trim(), haveTopic = (file.TELEGRAM_MASTER_THREAD_ID ?? "").trim();
    const same = haveChat === chatId && haveTopic === topic;
    if ((haveChat || haveTopic) && !same && !p.replace) return this.end("chat", "refused");
    if (!same) {
      try { await writeEnvFile(this.d.envFile, { TELEGRAM_MASTER_CHAT_ID: chatId, TELEGRAM_MASTER_THREAD_ID: topic }); } catch { return this.end("chat", "not-saved"); }
      this.saved = true;
      this.log("[settings] telegram fleet master chat connected with a one-time code: TELEGRAM_MASTER_CHAT_ID, TELEGRAM_MASTER_THREAD_ID saved");
    }
    const test = await sendText(tg, this.token(), m.chat.id, LINK_TEXT.chatOk, { threadId }).then(() => true, () => false);
    const cur = await this.shown();
    await writeJson(this.d.stateFile, { userId: String(userId), name: cur?.name ?? "", testAt: cur?.testAt ?? null, chat: { id: chatId, title } } satisfies Shown).catch(() => {});
    this.end("chat", "ok", { who: title, test, ...(!same ? { restart: await this.d.afterSave() } : {}) });
  }

  // "Disconnect", on the user's press and confirm (the route passed gateUser). chat: the fleet
  // master chat only. account: the account, and the fleet master chat with it (the chat answers
  // only that account). The bot token stays.
  async disconnect(what: LinkKind): Promise<{ ok: true; changed: boolean; restart: Restart | null } | { ok: false; error: string }> {
    let file: Partial<Record<WritableKey, string>>;
    try { file = await readEnvFileKeys(this.d.envFile); } catch { return { ok: false, error: "The settings file of the console cannot be read." }; }
    const keys: WritableKey[] = what === "chat"
      ? ["TELEGRAM_MASTER_CHAT_ID", "TELEGRAM_MASTER_THREAD_ID"]
      : ["TELEGRAM_ISSUES_USER_ID", "TELEGRAM_MASTER_CHAT_ID", "TELEGRAM_MASTER_THREAD_ID"];
    const changes: EnvChanges = {};
    for (const k of keys) if (file[k] !== undefined) changes[k] = null;
    this.setPending(null);
    this.last = null;
    if (!Object.keys(changes).length) return { ok: true, changed: false, restart: null };
    // The chief of staff must still start after it (a console that pairs through Telegram
    // needs its fleet master chat).
    const after: Env = { ...this.d.env };
    for (const k of Object.keys(changes)) after[k] = undefined;
    if (chiefMisconfigured(this.d.env) === null && chiefMisconfigured(after) !== null) return { ok: false, error: LINK_TEXT.keepChat };
    try { await writeEnvFile(this.d.envFile, changes); } catch { return { ok: false, error: "Not saved: the settings file could not be written." }; }
    this.saved = true;
    this.log(`[settings] telegram ${what} disconnected: ${Object.keys(changes).join(", ")} removed`);
    const cur = what === "chat" ? await this.shown() : null;
    if (cur) await writeJson(this.d.stateFile, { userId: cur.userId, name: cur.name, testAt: cur.testAt } satisfies Shown).catch(() => {});
    else await rm(this.d.stateFile, { force: true }).catch(() => {});
    this.d.onChange?.();
    return { ok: true, changed: true, restart: await this.d.afterSave() };
  }

  // One more test message to the connected account (the page's button). Throws a scrubbed error.
  async testAccount(): Promise<void> {
    const userId = this.userId();
    if (userId === null) throw new Error("no account is connected");
    await sendText(this.d.telegram ?? {}, this.token(), userId, LINK_TEXT.test);
    const cur = await this.shown();
    await writeJson(this.d.stateFile, { ...(cur ?? { userId: String(userId), name: "" }), testAt: this.now() } satisfies Shown).catch(() => {});
    this.d.onChange?.();
  }

  async view(): Promise<LinkView> {
    const p = this.live();
    const s = await this.shown();
    const chat = this.chatReady();
    return {
      account: { connected: this.userId() !== null, name: s?.name || null, tested: s?.testAt != null },
      chat: { connected: chat, title: chat && s?.chat && s.chat.id === (this.d.env.TELEGRAM_MASTER_CHAT_ID ?? "").trim() ? s.chat.title || null : null },
      pending: p ? { kind: p.kind, expiresAt: p.expiresAt, problem: p.problem } : null,
      last: this.last,
      waitsRestart: this.saved,
    };
  }
}
