// server/settings/link.test.ts — "Telegram with no ids": the one-time codes that connect the
// account and the fleet master chat from one message each. The hard rules, each with a test:
// only the paired user makes a code; only a message with the code binds (never "the first
// person who writes"); a code works one time, for 10 minutes, with 5 tries; a value that is
// there is replaced only after a confirm; the token and the code are in no status and no log;
// and a console where nobody presses anything behaves as before.
// A temp settings file, a fake Bot API (fetch), a fake restarter. Made-up values only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import type { TgMessage, TgUpdate } from "../issues/telegram.js";
import { registerSettingsApi } from "./api.js";
import { LINK_TEXT, LINK_TRIES, LINK_TTL_MS, normalizeCode, typedCode, type LinkView } from "./link.js";

const TOKEN = "123456789:AAH-made-up-token-for-tests-ONLY_x";
const CHIEF_UT = "user-token";
const HOOK = "hook-1";
const ADA = 4242, EVE = 666;
const GROUP = -1001234567890;
const BASE = ["# Console", "CONSOLE_COOKIE_SECRET=not-a-real-secret-0123456789abcdef", "", `TELEGRAM_BOT_TOKEN=${TOKEN}`, "AGENT_ENV_PASS=", ""];
// A new install: devices pair from the server, a bot token, nothing else.
const NEW_ENV = { TELEGRAM_BOT_TOKEN: TOKEN, CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "http://x", CHIEF_USER_AUTH: "log" };
const NEW_FILE = BASE.join("\n");
// The same install after the account is connected.
const ACCOUNT_ENV = { ...NEW_ENV, TELEGRAM_ISSUES_USER_ID: String(ADA) };
const ACCOUNT_FILE = [...BASE.slice(0, -1), `TELEGRAM_ISSUES_USER_ID=${ADA}`, ""].join("\n");
// The owner's console: the ids typed by hand, devices pair through Telegram.
const OWNER_ENV = { ...ACCOUNT_ENV, CHIEF_USER_AUTH: "telegram", TELEGRAM_MASTER_CHAT_ID: String(GROUP), TELEGRAM_MASTER_THREAD_ID: "2" };
const OWNER_FILE = [...BASE.slice(0, -1), `TELEGRAM_ISSUES_USER_ID=${ADA}`, `TELEGRAM_MASTER_CHAT_ID=${GROUP}`, "TELEGRAM_MASTER_THREAD_ID=2", ""].join("\n");

let dir: string;
let envFile: string;
let stateFile: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tglink-"));
  envFile = join(dir, ".env");
  stateFile = join(dir, "state", "telegram-link.json");
  clock = 1_000_000;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

type Call = { method: string; body: Record<string, unknown> };
function fakeBot(o: { readsAll?: boolean; admin?: boolean; down?: boolean; sendFails?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { ...o };
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    if (state.down) throw new TypeError(`fetch failed ${url}`);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 99, username: "new_bot", first_name: "New", can_read_all_group_messages: state.readsAll === true } });
    if (method === "getChatMember") return Response.json({ ok: true, result: { status: state.admin ? "administrator" : "member" } });
    if (method === "sendMessage" && state.sendFails) return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden" }), { status: 403 });
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
  return { calls, state, fetch: f as unknown as typeof fetch, sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body) };
}

async function app(o: { env?: Record<string, string>; file?: string; userAuth?: "telegram" | "log"; bot?: ReturnType<typeof fakeBot>; armed?: boolean } = {}) {
  await writeFile(envFile, o.file ?? NEW_FILE, { mode: 0o600 });
  await chmod(envFile, 0o600);
  const a = Fastify();
  const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
    ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
  const env = { ...(o.env ?? NEW_ENV) };
  const gate = makeGate({
    misconfigured: null, userAuth: env.CHIEF_USER_AUTH === "telegram" ? "telegram" : "log",
    deps: { devices: { verify: async (t: string) => (t === CHIEF_UT ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
  });
  const bot = o.bot ?? fakeBot({ admin: true });
  const schedule = vi.fn(async () => {});
  const lines: string[] = [];
  const changed = vi.fn();
  const { link } = registerSettingsApi(a, {
    env, chief: { gate, active: true, devices: { list: async () => [] } },
    telegram: { fetch: bot.fetch, apiBase: "http://tg.test" },
    gh: async () => "{}", ghRepos: async () => [],
    envFile, linkStateFile: stateFile, onLinkChange: changed,
    restarter: { armed: async () => (o.armed === false ? { ok: false, why: "this console is a dev server, not a production build" } : { ok: true }), schedule },
    bootAt: 1, now: () => clock, log: (s) => lines.push(s),
  });
  const listen = vi.fn();
  link!.onListen = listen;
  const file = () => readFile(envFile, "utf8");
  const view = async (): Promise<LinkView> => (await a.inject({ url: "/api/settings/telegram" })).json().link;
  const mint = (kind: "account" | "chat", more: object = {}, headers: Record<string, string> = user) =>
    a.inject({ method: "POST", url: "/api/settings/telegram/link", headers, payload: { kind, ...more } });
  const code = async (kind: "account" | "chat", more: object = {}): Promise<string> => {
    const res = await mint(kind, more);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().code;
  };
  return { a, link: link!, bot, schedule, lines, changed, listen, file, view, mint, code };
}

const user = { [USER_HEADER]: CHIEF_UT };
const agentAs = (id: string, token = HOOK) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
const NOT_USER: Array<[string, Record<string, string>]> = [
  ["no token", {}],
  ["a wrong user token", { [USER_HEADER]: "nope" }],
  ["a worker (with the user token too)", { ...agentAs("w1"), [USER_HEADER]: CHIEF_UT }],
  ["a lead", agentAs("lead-app")],
  ["the fleet master", agentAs("fleet-master")],
  ["an agent header that does not match", agentAs("w1", "wrong")],
];

let nextId = 1;
const update = (m: Partial<TgMessage>): TgUpdate => {
  const id = nextId++;
  return { update_id: id, message: { message_id: id, date: 0, chat: { id: ADA, type: "private" }, from: { id: ADA, first_name: "Ada", username: "ada" }, ...m } };
};
// A message in the bot's private chat with a person.
const priv = (text: string, who = ADA, name = "ada"): TgUpdate => update({ text, chat: { id: who, type: "private" }, from: { id: who, first_name: name, username: name } });
// A message in a topic of a forum group.
const topic = (text: string, over: Partial<TgMessage> = {}): TgUpdate => update({
  text, chat: { id: GROUP, type: "supergroup", title: "Ada's fleet", is_forum: true }, message_thread_id: 5, is_topic_message: true, ...over,
});

describe("the code in a message", () => {
  it("reads /start CODE, /connect@bot CODE and the code alone; nothing else", () => {
    const t = (text: string) => typedCode({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, text });
    expect(t("/start ABCD-EFGH")).toEqual({ typed: "ABCD-EFGH", command: true });
    expect(t("/start@new_bot abcdefgh")).toEqual({ typed: "abcdefgh", command: true });
    expect(t("/connect@new_bot ABCD-EFGH")).toEqual({ typed: "ABCD-EFGH", command: true });
    expect(t("ABCD-EFGH")).toEqual({ typed: "ABCD-EFGH", command: false });
    expect(t("/start")).toBeNull();
    expect(t("/pair laptop")).toBeNull();
    expect(t("")).toBeNull();
    expect(normalizeCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeCode(" o1l0 ")).toBe("0110");
  });
});

describe("who may ask for a code or disconnect", () => {
  it("refuses every caller but the paired user: no code, no listening, nothing written", async () => {
    const t = await app({ env: OWNER_ENV, file: OWNER_FILE });
    for (const [who, headers] of NOT_USER) {
      for (const kind of ["account", "chat"] as const) {
        const res = await t.mint(kind, { replace: true }, headers);
        expect(res.statusCode, who).toBe(403);
        expect(res.json().code, who).toBeUndefined();
      }
      for (const what of ["account", "chat"]) {
        const res = await t.a.inject({ method: "POST", url: "/api/settings/telegram/disconnect", headers, payload: { what } });
        expect(res.statusCode, who).toBe(403);
      }
      const test = await t.a.inject({ method: "POST", url: "/api/settings/telegram/test", headers, payload: { target: "account" } });
      expect(test.statusCode, who).toBe(403);
    }
    expect(t.bot.calls).toEqual([]);
    expect((await t.view()).pending).toBeNull();
    expect(t.listen).not.toHaveBeenCalled();
    expect(t.schedule).not.toHaveBeenCalled();
    expect(await t.file()).toBe(OWNER_FILE);
    expect(await readdir(dir)).toEqual([".env"]);
  });

  it("refuses a body it does not know, and a console with no bot token", async () => {
    const t = await app();
    expect((await t.mint("account", { userId: "1" })).statusCode).toBe(400);
    expect((await t.a.inject({ method: "POST", url: "/api/settings/telegram/link", headers: user, payload: { kind: "master" } })).statusCode).toBe(400);
    const none = await app({ env: { ...NEW_ENV, TELEGRAM_BOT_TOKEN: "" } });
    const res = await none.mint("account");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Add the bot token first.");
  });
});

describe("connect your chat (the account)", () => {
  it("gives a code, the Open Telegram link and the line to send; the status and the log never hold the code or the token", async () => {
    const t = await app();
    expect(await t.view()).toEqual({
      account: { connected: false, name: null, tested: false }, chat: { connected: false, title: null },
      pending: null, last: null, waitsRestart: false,
    });
    const res = await t.mint("account");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const raw = b.code.replace("-", "");
    expect(b).toEqual({ kind: "account", code: b.code, expiresAt: clock + LINK_TTL_MS, bot: "new_bot", url: `https://t.me/new_bot?start=${raw}`, send: `/start ${b.code}` });
    expect(t.listen.mock.calls).toEqual([[true]]);
    const status = (await t.a.inject({ url: "/api/settings/telegram" })).body;
    expect(JSON.parse(status).link.pending).toEqual({ kind: "account", expiresAt: clock + LINK_TTL_MS, problem: null });
    for (const text of [status, t.lines.join("\n"), res.body]) expect(text).not.toContain(TOKEN);
    for (const text of [status, t.lines.join("\n")]) { expect(text).not.toContain(raw); expect(text).not.toContain(b.code); }
    expect(await readdir(dir)).toEqual([".env"]); // the code is in no file
    expect(await t.file()).toBe(NEW_FILE);
  });

  it("binds the sender of the message that carries the code, sends the test message, and restarts", async () => {
    const t = await app();
    const code = await t.code("account");
    expect(await t.link.route(priv(`/start ${code.replace("-", "")}`))).toBe("handled");
    expect(await t.file()).toBe(`${NEW_FILE}TELEGRAM_ISSUES_USER_ID=${ADA}\n`);
    expect(t.bot.sent()).toEqual([{ chat_id: ADA, text: LINK_TEXT.accountOk }]);
    expect(t.schedule).toHaveBeenCalledTimes(1);
    expect(t.listen.mock.calls).toEqual([[true], [false]]);
    expect(t.changed).toHaveBeenCalled();
    const v = await t.view();
    expect(v.pending).toBeNull();
    expect(v.last).toEqual({ kind: "account", end: "ok", who: "@ada", test: true, restart: { ok: true } });
    expect(v.waitsRestart).toBe(true);
    // What the page shows after the restart: the name and the test, never an id of its own.
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ userId: String(ADA), name: "@ada", testAt: clock });
    expect(t.lines.join("\n")).not.toContain(String(ADA));
    expect(t.lines.join("\n")).not.toContain(code);
  });

  it("works one time: the same code from another person afterwards changes nothing", async () => {
    const t = await app();
    const code = await t.code("account");
    await t.link.route(priv(`/start ${code}`));
    const after = await t.file();
    expect(await t.link.route(priv(`/start ${code}`, EVE, "eve"))).toBe("pass");
    expect(await t.file()).toBe(after);
    expect(t.bot.sent()).toHaveLength(1);
  });

  it("never binds the first person who writes: a message with no code, or with a wrong code, changes nothing and gets no answer", async () => {
    const t = await app();
    const code = await t.code("account");
    const wrong = code.startsWith("0") ? `1${code.slice(1)}` : `0${code.slice(1)}`;
    expect(await t.link.route(priv("/start", EVE, "eve"))).toBe("pass");
    expect(await t.link.route(priv("hello, is this my console?", EVE, "eve"))).toBe("pass");
    expect(await t.link.route(priv(`/start ${wrong}`, EVE, "eve"))).toBe("handled");
    // The right code, but not from a person in their own private chat.
    expect(await t.link.route(topic(`/start ${code}`))).toBe("pass");
    await t.link.route(update({ text: `/start ${code}`, chat: { id: ADA, type: "private" }, from: { id: 7, is_bot: true, first_name: "bot" } }));
    await t.link.route(update({ text: `/start ${code}`, chat: { id: ADA, type: "private" }, from: { id: EVE, first_name: "eve" } }));
    await t.link.route(update({ text: `/start ${code}`, chat: { id: ADA, type: "private" }, from: undefined }));
    expect(await t.file()).toBe(NEW_FILE);
    expect(t.bot.sent()).toEqual([]);
    expect(t.schedule).not.toHaveBeenCalled();
    expect((await t.view()).pending).not.toBeNull();
    // The code still works for the user.
    await t.link.route(priv(`/start ${code}`));
    expect(await t.file()).toContain(`TELEGRAM_ISSUES_USER_ID=${ADA}\n`);
  });

  it(`ends the code after ${LINK_TRIES} wrong codes: then the right code binds nothing`, async () => {
    const t = await app();
    const code = await t.code("account");
    for (let i = 0; i < LINK_TRIES; i++) expect(await t.link.route(priv("/start ZZZZ-ZZZZ", EVE, "eve"))).toBe("handled");
    expect((await t.view()).last).toMatchObject({ kind: "account", end: "spent" });
    expect(await t.link.route(priv(`/start ${code}`))).toBe("pass");
    expect(await t.file()).toBe(NEW_FILE);
    expect(t.bot.sent()).toEqual([]);
    expect(t.listen.mock.calls).toEqual([[true], [false]]);
  });

  it("ends the code after 10 minutes", async () => {
    const t = await app();
    const code = await t.code("account");
    clock += LINK_TTL_MS;
    expect(await t.link.route(priv(`/start ${code}`))).toBe("pass");
    expect(await t.file()).toBe(NEW_FILE);
    const v = await t.view();
    expect(v.pending).toBeNull();
    expect(v.last).toMatchObject({ kind: "account", end: "expired" });
  });

  it("a new code replaces the code before it", async () => {
    const t = await app();
    const first = await t.code("account");
    const second = await t.code("account");
    expect(second).not.toBe(first);
    expect(await t.link.route(priv(`/start ${first}`))).toBe("handled"); // a wrong code now: a try, no bind
    expect(await t.file()).toBe(NEW_FILE);
    await t.link.route(priv(`/start ${second}`));
    expect(await t.file()).toContain(`TELEGRAM_ISSUES_USER_ID=${ADA}\n`);
    expect(t.listen.mock.calls).toEqual([[true], [false]]);
  });

  it("says so when the console cannot restart itself, and when the test message did not go out", async () => {
    const t = await app({ armed: false, bot: fakeBot({ sendFails: true }) });
    await t.link.route(priv(`/start ${await t.code("account")}`));
    expect((await t.view()).last).toEqual({ kind: "account", end: "ok", who: "@ada", test: false, restart: { ok: false, why: "this console is a dev server, not a production build" } });
    expect(JSON.parse(await readFile(stateFile, "utf8")).testAt).toBeNull();
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it("an account that is there is never replaced without the confirm", async () => {
    const t = await app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE });
    const res = await t.mint("account");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "A Telegram account is connected. A new one replaces it.", exists: true });
    expect(t.listen).not.toHaveBeenCalled();
    const code = await t.code("account", { replace: true });
    await t.link.route(priv(`/start ${code}`, EVE, "eve"));
    expect(await t.file()).toBe(ACCOUNT_FILE.replace(String(ADA), String(EVE)));
    expect((await t.view()).last).toMatchObject({ end: "ok", who: "@eve" });
  });

  it("refuses the bind when an account came into the settings file after the code was made", async () => {
    const t = await app();
    const code = await t.code("account");
    await writeFile(envFile, ACCOUNT_FILE);
    await t.link.route(priv(`/start ${code}`, EVE, "eve"));
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect((await t.view()).last).toMatchObject({ end: "refused" });
    expect(t.bot.sent()).toEqual([]);
  });

  it("the same account again writes nothing and restarts nothing; it sends the test message", async () => {
    const t = await app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE });
    await t.link.route(priv(`/start ${await t.code("account", { replace: true })}`));
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect(await readdir(dir)).toEqual([".env", "state"]); // no backup: no write
    expect(t.schedule).not.toHaveBeenCalled();
    const v = await t.view();
    expect(v.account).toEqual({ connected: true, name: "@ada", tested: true });
    expect(v.waitsRestart).toBe(false);
  });

  it("sends one more test message to the connected account on the user's press", async () => {
    const t = await app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE });
    expect((await t.view()).account).toEqual({ connected: true, name: null, tested: false });
    const res = await t.a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "account" } });
    expect(res.statusCode).toBe(200);
    expect(t.bot.sent()).toEqual([{ chat_id: ADA, text: LINK_TEXT.test }]);
    expect((await t.view()).account.tested).toBe(true);
    const none = await app();
    expect((await none.a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "account" } })).statusCode).toBe(409);
  });
});

describe("the fleet master chat", () => {
  const ready = () => app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE });

  it("needs the connected account first", async () => {
    const t = await app();
    const res = await t.mint("chat");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Connect your chat first.");
  });

  it("reads the group and the topic from the user's message with the code, on a console that pairs devices from the server", async () => {
    const t = await ready();
    const res = await t.mint("chat");
    const b = res.json();
    expect(b).toEqual({ kind: "chat", code: b.code, expiresAt: clock + LINK_TTL_MS, bot: "new_bot", send: `/connect@new_bot ${b.code}` });
    expect(await t.link.route(topic(b.send))).toBe("handled");
    expect(await t.file()).toBe(`${ACCOUNT_FILE}TELEGRAM_MASTER_CHAT_ID=${GROUP}\nTELEGRAM_MASTER_THREAD_ID=5\n`);
    expect(t.bot.sent()).toEqual([{ chat_id: GROUP, text: LINK_TEXT.chatOk, message_thread_id: 5 }]);
    expect(t.schedule).toHaveBeenCalledTimes(1);
    expect((await t.view()).last).toEqual({ kind: "chat", end: "ok", who: "Ada's fleet", test: true, restart: { ok: true } });
    expect(JSON.parse(await readFile(stateFile, "utf8")).chat).toEqual({ id: String(GROUP), title: "Ada's fleet" });
  });

  it("takes the code as a plain message too (a bot that reads the group)", async () => {
    const t = await app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE, bot: fakeBot({ readsAll: true }) });
    const code = await t.code("chat");
    expect(await t.link.route(topic("good morning"))).toBe("pass");
    expect(await t.link.route(topic("tomorrow"))).toBe("pass"); // 8 letters of plain talk: not a try
    expect(await t.link.route(topic(code.toLowerCase()))).toBe("handled");
    expect(await t.file()).toContain(`TELEGRAM_MASTER_CHAT_ID=${GROUP}\n`);
    expect(t.bot.calls.some((c) => c.method === "getChatMember")).toBe(false);
  });

  it("a message from another person changes nothing and gets no answer; the page says what came; the user's own message still works", async () => {
    const t = await ready();
    const code = await t.code("chat");
    expect(await t.link.route(topic(`/connect ${code}`, { from: { id: EVE, first_name: "Eve" } }))).toBe("handled");
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect(t.bot.calls).toEqual([{ method: "getMe", body: {} }]); // the name of the bot for the code, nothing else
    expect((await t.view()).pending).toEqual({ kind: "chat", expiresAt: clock + LINK_TTL_MS, problem: LINK_TEXT.otherPerson });
    await t.link.route(topic(`/connect ${code}`));
    expect(await t.file()).toContain(`TELEGRAM_MASTER_THREAD_ID=5\n`);
  });

  it.each([
    ["a group with no topics", { chat: { id: -4001, type: "group" as const, title: "Small" }, message_thread_id: undefined, is_topic_message: undefined }, LINK_TEXT.noTopics],
    ["a supergroup with topics off", { chat: { id: GROUP, type: "supergroup" as const, title: "Big" }, message_thread_id: undefined, is_topic_message: undefined }, LINK_TEXT.noTopics],
    ["the General topic", { message_thread_id: undefined, is_topic_message: undefined }, LINK_TEXT.general],
    ["a reply thread that is not a topic", { message_thread_id: 9, is_topic_message: undefined }, LINK_TEXT.general],
  ])("%s: saves nothing, says how to repair it on the page and in the group, and keeps the code", async (_name, over, text) => {
    const t = await ready();
    const code = await t.code("chat");
    const u = topic(`/connect ${code}`, over);
    expect(await t.link.route(u)).toBe("handled");
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect((await t.view()).pending?.problem).toBe(text);
    expect(t.bot.sent()).toHaveLength(1);
    expect(t.bot.sent()[0]).toMatchObject({ chat_id: u.message!.chat.id, text });
    expect(t.schedule).not.toHaveBeenCalled();
    // Repaired: the same code in a topic.
    await t.link.route(topic(`/connect ${code}`));
    expect(await t.file()).toContain(`TELEGRAM_MASTER_CHAT_ID=${GROUP}\n`);
  });

  it("a bot that cannot read the group's messages: says what to change in @BotFather, then works after the repair", async () => {
    const bot = fakeBot({ readsAll: false, admin: false });
    const t = await app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE, bot });
    const code = await t.code("chat");
    await t.link.route(topic(`/connect@new_bot ${code}`));
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect((await t.view()).pending?.problem).toBe(LINK_TEXT.privacy);
    expect(LINK_TEXT.privacy).toMatch(/@BotFather.*\/setprivacy.*Disable/);
    expect(bot.sent()).toEqual([{ chat_id: GROUP, text: LINK_TEXT.privacy, message_thread_id: 5, reply_parameters: expect.any(Object) }]);
    bot.state.admin = true;
    await t.link.route(topic(`/connect@new_bot ${code}`));
    expect(await t.file()).toContain(`TELEGRAM_MASTER_THREAD_ID=5\n`);
    expect((await t.view()).last).toMatchObject({ kind: "chat", end: "ok" });
  });

  it("Telegram does not answer the check: nothing is saved, the code stays", async () => {
    const bot = fakeBot({ admin: true });
    const t = await app({ env: ACCOUNT_ENV, file: ACCOUNT_FILE, bot });
    const code = await t.code("chat");
    bot.state.down = true;
    await t.link.route(topic(`/connect ${code}`));
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect((await t.view()).pending?.problem).toBe(LINK_TEXT.noAnswer);
  });

  it("wrong codes in a command end the code; a private message is not looked at", async () => {
    const t = await ready();
    const code = await t.code("chat");
    expect(await t.link.route(priv(`/start ${code}`))).toBe("pass");
    for (let i = 0; i < LINK_TRIES; i++) expect(await t.link.route(topic("/connect ZZZZ-ZZZZ", { from: { id: EVE, first_name: "Eve" } }))).toBe("handled");
    expect(await t.link.route(topic(`/connect ${code}`))).toBe("pass");
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect((await t.view()).last).toMatchObject({ kind: "chat", end: "spent" });
  });

  it("a chat that is there is never replaced without the confirm", async () => {
    const t = await app({ env: { ...OWNER_ENV, CHIEF_USER_AUTH: "log" }, file: OWNER_FILE });
    const res = await t.mint("chat");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "A fleet master chat is connected. A new one replaces it.", exists: true });
    const code = await t.code("chat", { replace: true });
    await t.link.route(topic(`/connect ${code}`, { chat: { id: -1009, type: "supergroup", title: "New", is_forum: true }, message_thread_id: 8 }));
    expect(await t.file()).toBe(OWNER_FILE.replace(String(GROUP), "-1009").replace("THREAD_ID=2", "THREAD_ID=8"));
  });
});

describe("disconnect", () => {
  const post = (a: ReturnType<typeof Fastify>, what: string) => a.inject({ method: "POST", url: "/api/settings/telegram/disconnect", headers: user, payload: { what } });

  it("the fleet master chat: its group and topic go, the account and the token stay", async () => {
    const t = await app({ env: { ...OWNER_ENV, CHIEF_USER_AUTH: "log" }, file: OWNER_FILE });
    const res = await post(t.a, "chat");
    expect(res.json()).toEqual({ changed: true, restart: { ok: true } });
    expect(await t.file()).toBe(ACCOUNT_FILE);
    expect(t.schedule).toHaveBeenCalledTimes(1);
    expect(t.bot.calls).toEqual([]);
  });

  it("the account: the account and its fleet master chat go, the token stays; a code that waits ends", async () => {
    const t = await app({ env: { ...OWNER_ENV, CHIEF_USER_AUTH: "log" }, file: OWNER_FILE });
    await t.code("chat", { replace: true });
    expect((await post(t.a, "account")).statusCode).toBe(200);
    expect(await t.file()).toBe(NEW_FILE);
    expect((await t.view()).pending).toBeNull();
    expect(t.listen.mock.calls).toEqual([[true], [false]]);
  });

  it("nothing to remove: no write, no restart", async () => {
    const t = await app();
    expect((await post(t.a, "account")).json()).toEqual({ changed: false, restart: null });
    expect(await readdir(dir)).toEqual([".env"]);
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it("a console that pairs devices through Telegram keeps its fleet master chat", async () => {
    const t = await app({ env: OWNER_ENV, file: OWNER_FILE });
    for (const what of ["chat", "account"]) {
      const res = await post(t.a, what);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(LINK_TEXT.keepChat);
    }
    expect(await t.file()).toBe(OWNER_FILE);
    expect(await readdir(dir)).toEqual([".env"]);
    expect(t.schedule).not.toHaveBeenCalled();
  });
});

describe("a console with its ids typed by hand (the owner's console), where nobody presses anything", () => {
  it("no code, no message, no write, no listening change: every update passes", async () => {
    const t = await app({ env: OWNER_ENV, file: OWNER_FILE });
    const v = await t.view();
    expect(v).toEqual({
      account: { connected: true, name: null, tested: false }, chat: { connected: true, title: null },
      pending: null, last: null, waitsRestart: false,
    });
    const before = t.bot.calls.length; // the status read the name of the bot (getMe), as before
    for (const u of [
      priv("/start"), priv("/start ABCD-EFGH"), priv("ABCD-EFGH"), priv("hello"), priv("/start ZZZZ-ZZZZ", EVE, "eve"),
      topic("/connect ABCD-EFGH"), topic("/pair laptop"), topic("deploy the fix"),
      { update_id: 900, callback_query: { id: "1", from: { id: ADA }, data: "q:a:x" } } as TgUpdate,
    ]) expect(await t.link.route(u)).toBe("pass");
    expect(t.bot.calls.length).toBe(before);
    expect(t.bot.sent()).toEqual([]);
    expect(t.listen).not.toHaveBeenCalled();
    expect(t.schedule).not.toHaveBeenCalled();
    expect(await t.file()).toBe(OWNER_FILE);
    expect(await readdir(dir)).toEqual([".env"]);
    expect(t.lines).toEqual([]);
  });
});
