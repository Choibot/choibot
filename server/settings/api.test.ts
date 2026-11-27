// server/settings/api.test.ts — the Settings add-on routes: what they say, the USER gate of the
// test message, and the hard rule that no secret value (the bot token, an env value) is in any
// answer, error or log line. A fake Bot API (fetch) and a fake gh; nothing leaves the process.
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { cardChatOf, parseMasterTgConfig } from "../master/telegram.js";
import { parseIssuesUserId } from "../issues/paths.js";
import { registerSettingsApi, type SettingsApiDeps } from "./api.js";
import { scrub, telegramConfig, testTelegramApi } from "./telegram.js";
import { scrubGh } from "./github.js";

const TOKEN = "123456789:AAH-made-up-token-for-tests-ONLY_x";
const CHIEF_UT = "user-token";
const HOOK = "hook-1";

const ON = { active: true, problem: null };
const OFF = { active: false, problem: null };
const FULL = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_ISSUES_USER_ID: "4242",
  TELEGRAM_MASTER_CHAT_ID: "-1001234567890",
  TELEGRAM_MASTER_THREAD_ID: "2",
  TELEGRAM_CHAT_ID: "-1009999",
  TELEGRAM_CRON_CHAT_ID: "-1001234567890",
  TELEGRAM_CRON_THREAD_ID: "4",
};

type Call = { url: string; body: Record<string, unknown> };
function fakeBot(o: { fail?: string; throwWithUrl?: boolean } = {}) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (o.throwWithUrl) throw new TypeError(`fetch failed for ${url}`);
    if (o.fail) return new Response(JSON.stringify({ ok: false, error_code: 400, description: o.fail }), { status: 400 });
    if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { username: "acme_test_bot", first_name: "ChoiBot" } });
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
  return { calls, fetch: f as unknown as typeof fetch };
}

function app(o: { env?: Record<string, string>; chief?: boolean; misconfigured?: string | null; bot?: ReturnType<typeof fakeBot>; gh?: SettingsApiDeps["gh"]; log?: (s: string) => void; now?: () => number } = {}) {
  const a = Fastify();
  const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
    ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
  const gate = makeGate({
    misconfigured: o.misconfigured ?? null, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === CHIEF_UT ? { label: "phone", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
  });
  const bot = o.bot ?? fakeBot();
  const settings = registerSettingsApi(a, {
    env: o.env ?? FULL,
    chief: o.chief === false ? undefined : { gate, active: true, devices: { list: async () => [{ label: "phone", createdAt: 1, lastUsedAt: 1 }] } },
    telegram: { fetch: bot.fetch, apiBase: "http://tg.test" },
    gh: o.gh ?? (async () => { throw new Error("no gh"); }),
    ghRepos: async () => [{ name: "app", slug: "acme/app", path: "/w/app" }, { name: "gone", slug: "acme/gone", path: "/w/gone" }],
    log: o.log ?? (() => {}),
    now: o.now,
  });
  return { a, settings, bot };
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

describe("telegramConfig", () => {
  it("is ready everywhere with every key set", () => {
    const c = telegramConfig(FULL, ON);
    expect(c.token).toBe(true);
    expect(c.targets.map((t) => [t.id, t.missing])).toEqual([["master", []], ["queue", []], ["cron", []], ["notify", []]]);
  });
  it("names each missing key, never a value", () => {
    const c = telegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN }, OFF);
    const by = Object.fromEntries(c.targets.map((t) => [t.id, t.missing]));
    expect(by.master).toEqual(["TELEGRAM_ISSUES_USER_ID", "TELEGRAM_MASTER_CHAT_ID", "TELEGRAM_MASTER_THREAD_ID"]);
    expect(by.queue).toContain("CHIEF_ENABLED");
    expect(by.notify).toEqual(["TELEGRAM_CHAT_ID"]);
    expect(by.cron).toEqual(["TELEGRAM_CHAT_ID", "TELEGRAM_CRON_CHAT_ID", "TELEGRAM_CRON_THREAD_ID"]);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });
  it("says the token first when it is missing", () => {
    expect(telegramConfig({}, ON).targets.every((t) => t.missing[0] === "TELEGRAM_BOT_TOKEN")).toBe(true);
  });
  it("the Master topic is ready exactly when the bridge's own rule says so", () => {
    const cases: Record<string, string>[] = [
      FULL, { ...FULL, TELEGRAM_MASTER_CHAT_ID: "123" }, { ...FULL, TELEGRAM_MASTER_THREAD_ID: "0" },
      { ...FULL, TELEGRAM_ISSUES_USER_ID: "x" }, { ...FULL, TELEGRAM_BOT_TOKEN: "" }, { ...FULL, TELEGRAM_MASTER_THREAD_ID: " 3 " },
    ];
    for (const env of cases) {
      const ready = telegramConfig(env, ON).targets[0].missing.length === 0;
      expect(ready, JSON.stringify(env)).toBe(parseMasterTgConfig(env, parseIssuesUserId(env.TELEGRAM_ISSUES_USER_ID)) !== null);
    }
  });
  it("cron results fall back to the notifications chat without a topic of their own", () => {
    const { TELEGRAM_CRON_CHAT_ID: _c, TELEGRAM_CRON_THREAD_ID: _t, ...rest } = FULL;
    const cron = telegramConfig(rest, ON).targets.find((t) => t.id === "cron")!;
    expect(cron).toMatchObject({ missing: [], sameAs: "notify", testable: false, chatId: FULL.TELEGRAM_CHAT_ID });
  });
  it("a misconfigured chief: the queue cards say why, not CHIEF_ENABLED", () => {
    const q = telegramConfig(FULL, { active: false, problem: "CHIEF_CONSOLE_URL is not set" }).targets[1];
    expect(q.missing).toEqual([]);
    expect(q.problem).toBe("CHIEF_CONSOLE_URL is not set");
  });
  it("the queue cards: in the fleet master chat; with an account and no fleet master chat, in the user's chat with the bot", () => {
    const withChat = telegramConfig(FULL, ON).targets[1];
    expect(withChat).toMatchObject({ id: "queue", missing: [], sameAs: "master", chatId: FULL.TELEGRAM_MASTER_CHAT_ID, threadId: FULL.TELEGRAM_MASTER_THREAD_ID });
    expect(withChat.what).toMatch(/in the fleet master chat$/);
    const account = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ISSUES_USER_ID: "4242" };
    const own = telegramConfig(account, ON).targets[1];
    expect(own).toMatchObject({ id: "queue", missing: [], chatId: "4242", threadId: null });
    expect(own.sameAs).toBeUndefined();
    expect(own.what).toMatch(/in your chat with the bot$/);
    // The same rule as the server's card chat (master/telegram.ts cardChatOf).
    for (const env of [FULL, account, { TELEGRAM_BOT_TOKEN: TOKEN }, { ...account, TELEGRAM_MASTER_CHAT_ID: "-100123" }]) {
      const userId = parseIssuesUserId((env as Record<string, string>).TELEGRAM_ISSUES_USER_ID);
      const chat = cardChatOf(parseMasterTgConfig(env, userId), userId);
      const q = telegramConfig(env, ON).targets[1];
      expect(q.missing.length === 0, JSON.stringify(Object.keys(env))).toBe(chat !== null);
      if (chat) expect(q.chatId).toBe(String(chat.chatId));
    }
    // No account: no card, and the row says what is missing. The Queue off: not ready.
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN }, ON).targets[1].missing).toContain("TELEGRAM_ISSUES_USER_ID");
    expect(telegramConfig(account, OFF).targets[1].missing).toEqual(["CHIEF_ENABLED"]);
  });
  it("marks agent notifications off with TELEGRAM_NOTIFY_AGENTS=0", () => {
    expect(telegramConfig({ ...FULL, TELEGRAM_NOTIFY_AGENTS: "0" }, ON).targets.find((t) => t.id === "notify")!.off).toBeTruthy();
  });
});

describe("scrub", () => {
  it("removes the token and any bot path", () => {
    expect(scrub(`fetch failed http://x/bot${TOKEN}/getMe and ${TOKEN}`, TOKEN)).toBe("fetch failed http://x/bot<token>/getMe and <token>");
    expect(scrub("see /botABC:DEF/sendMessage", undefined)).toBe("see /bot<token>/sendMessage");
  });
  it("scrubGh masks GitHub tokens and Authorization lines", () => {
    expect(scrubGh("bad token gho_abcdefghijklmnop1234 and github_pat_11AAAA_bbbbbbbbbbbb")).toBe("bad token <token> and <token>");
    expect(scrubGh("Authorization: token abcdef123456")).toBe("Authorization: <token>");
  });
});

describe("GET /api/settings/telegram", () => {
  it("answers booleans, ids, the bot's public name and key names: never the token", async () => {
    const { a } = app();
    const res = await a.inject({ method: "GET", url: "/api/settings/telegram" });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ token: true, bot: { ok: true, username: "acme_test_bot" }, devices: 1, canTest: true, chief: "on", userAuth: "log" });
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain("AAH-made-up");
  });
  it("no token: token false, no getMe call", async () => {
    const bot = fakeBot();
    const { a } = app({ env: {}, bot });
    const j = (await a.inject({ method: "GET", url: "/api/settings/telegram" })).json();
    expect(j).toMatchObject({ token: false, bot: null });
    expect(bot.calls).toHaveLength(0);
  });
  it("a failing getMe (even one whose error names the URL) comes back scrubbed", async () => {
    const { a } = app({ bot: fakeBot({ throwWithUrl: true }) });
    const res = await a.inject({ method: "GET", url: "/api/settings/telegram" });
    expect(res.json().bot.ok).toBe(false);
    expect(res.body).not.toContain(TOKEN);
    expect(res.json().bot.error).toContain("/bot<token>/");
  });
  it("caches getMe; ?fresh=1 asks again, at most every 10 s", async () => {
    let t = 1_000_000;
    const bot = fakeBot();
    const { a } = app({ bot, now: () => t });
    await a.inject({ method: "GET", url: "/api/settings/telegram" });
    await a.inject({ method: "GET", url: "/api/settings/telegram" });
    expect(bot.calls).toHaveLength(1);
    await a.inject({ method: "GET", url: "/api/settings/telegram?fresh=1" });
    expect(bot.calls).toHaveLength(2);
    await a.inject({ method: "GET", url: "/api/settings/telegram?fresh=1" });
    expect(bot.calls).toHaveLength(2);
    t += 10_000;
    await a.inject({ method: "GET", url: "/api/settings/telegram?fresh=1" });
    expect(bot.calls).toHaveLength(3);
  });
  it("answers while the chief is misconfigured (this is where the user looks)", async () => {
    const { a } = app({ misconfigured: "no console url" });
    const res = await a.inject({ method: "GET", url: "/api/settings/telegram" });
    expect(res.statusCode).toBe(200);
    expect(res.json().chief).toBe("misconfigured");
  });
});

describe("POST /api/settings/telegram/test", () => {
  it("refuses every caller but the paired user, and sends nothing", async () => {
    const { a, bot } = app();
    for (const [who, headers] of NOT_USER) {
      const res = await a.inject({ method: "POST", url: "/api/settings/telegram/test", headers, payload: { target: "master" } });
      expect(res.statusCode, who).toBe(403);
      expect(res.json().error, who).toBe("pair-required");
    }
    expect(bot.calls).toHaveLength(0);
  });
  it("chief off: refused (no user identity), nothing sent", async () => {
    const { a, bot } = app({ chief: false });
    const res = await a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "master" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("needs-chief");
    expect(bot.calls).toHaveLength(0);
  });
  it("misconfigured: 503, nothing sent", async () => {
    const { a, bot } = app({ misconfigured: "x" });
    expect((await a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "master" } })).statusCode).toBe(503);
    expect(bot.calls).toHaveLength(0);
  });
  it("the user: one message to the target's chat and topic", async () => {
    const { a, bot } = app();
    const res = await a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "cron" } });
    expect(res.statusCode).toBe(200);
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0].url).toMatch(/\/sendMessage$/);
    expect(bot.calls[0].body).toMatchObject({ chat_id: -1001234567890, message_thread_id: 4 });
    expect(String(bot.calls[0].body.text)).toContain("Test message");
  });
  it("one test per target per 15 s", async () => {
    let t = 1_000_000;
    const { a, bot } = app({ now: () => t });
    const send = () => a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "master" } });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
    t += 15_000;
    expect((await send()).statusCode).toBe(200);
    expect(bot.calls).toHaveLength(2);
  });
  it("a target that is not set up names the missing keys; an unknown or shared target is refused", async () => {
    const { a, bot } = app({ env: { TELEGRAM_BOT_TOKEN: TOKEN } });
    const res = await a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "notify" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Not set: TELEGRAM_CHAT_ID");
    const { a: b } = app();
    expect((await b.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "queue" } })).statusCode).toBe(409);
    expect((await b.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "nope" } })).statusCode).toBe(400);
    expect(bot.calls).toHaveLength(0);
  });
  it("a Telegram refusal is a 500 (not 502: the edge's own page would hide it) whose text and log line hold no token", async () => {
    const lines: string[] = [];
    const { a } = app({ bot: fakeBot({ throwWithUrl: true }), log: (s) => lines.push(s) });
    const res = await a.inject({ method: "POST", url: "/api/settings/telegram/test", headers: user, payload: { target: "master" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines).toHaveLength(1);
  });
});

describe("GET /api/settings/github", () => {
  const ghOk = async (args: string[]) => {
    const p = args.join(" ");
    if (p === "api user") return JSON.stringify({ login: "octo" });
    if (p === "api rate_limit") return JSON.stringify({ resources: { core: { limit: 5000, remaining: 4900, reset: 1795119000 } } });
    if (p === "api repos/acme/app") return JSON.stringify({ permissions: { pull: true, push: true } });
    throw new Error("gh: Not Found (HTTP 404)");
  };
  it("the login, the rate limit and each repo's access", async () => {
    const { a } = app({ gh: ghOk });
    const j = (await a.inject({ method: "GET", url: "/api/settings/github" })).json();
    expect(j.login).toBe("octo");
    expect(j.rate).toEqual({ limit: 5000, remaining: 4900, reset: 1795119000 });
    expect(j.repos).toEqual([
      { name: "app", slug: "acme/app", read: true, push: true },
      { name: "gone", slug: "acme/gone", read: false, push: null, error: "not found, or no access" },
    ]);
  });
  it("not logged in: says so, reads nothing else", async () => {
    const gh = vi.fn(async () => { throw new Error("To get started with GitHub CLI, please run: gh auth login"); });
    const { a } = app({ gh });
    const j = (await a.inject({ method: "GET", url: "/api/settings/github" })).json();
    expect(j).toMatchObject({ login: null, error: "gh is not logged in", repos: [] });
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it("an error text is scrubbed of token shapes", async () => {
    const { a } = app({ gh: async () => { throw new Error("boom ghp_abcdefghijklmnopqrst"); } });
    const res = await a.inject({ method: "GET", url: "/api/settings/github" });
    expect(res.body).not.toContain("ghp_abcdefghijklmnopqrst");
  });
  it("a new GitHub login shows at once: after forgetGithub the next read asks GitHub again", async () => {
    let t = 0;
    const gh = vi.fn(ghOk);
    const { a, settings } = app({ gh, now: () => t });
    await a.inject({ method: "GET", url: "/api/settings/github" });
    const n = gh.mock.calls.length;
    t = 2_000;   // inside the gap of a fresh read
    await a.inject({ method: "GET", url: "/api/settings/github?fresh=1" });
    expect(gh.mock.calls.length).toBe(n);
    settings.forgetGithub();   // the code login ended well (index.ts)
    await a.inject({ method: "GET", url: "/api/settings/github?fresh=1" });
    expect(gh.mock.calls.length).toBe(2 * n);
  });

  it("caches a minute; ?fresh=1 checks again after 10 s", async () => {
    let t = 0;
    const gh = vi.fn(ghOk);
    const { a } = app({ gh, now: () => t });
    await a.inject({ method: "GET", url: "/api/settings/github" });
    const n = gh.mock.calls.length;
    t = 5_000;
    await a.inject({ method: "GET", url: "/api/settings/github?fresh=1" });
    expect(gh.mock.calls.length).toBe(n);
    t = 11_000;
    await a.inject({ method: "GET", url: "/api/settings/github?fresh=1" });
    expect(gh.mock.calls.length).toBe(2 * n);
  });
});

describe("the test-only Bot API origin", () => {
  it("is taken only with CHIEF_TEST=1 and a loopback http origin; anything else is ignored with one log line", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(testTelegramApi({ CHIEF_TEST: "1", CHIEF_TEST_TELEGRAM_API: "http://127.0.0.1:4321" }, log)).toBe("http://127.0.0.1:4321");
    expect(testTelegramApi({ CHIEF_TEST: "1", CHIEF_TEST_TELEGRAM_API: "http://localhost:9" }, log)).toBe("http://localhost:9");
    expect(testTelegramApi({ CHIEF_TEST_TELEGRAM_API: "http://127.0.0.1:4321" }, log)).toBeUndefined();
    expect(lines).toEqual([]);
    for (const v of ["https://evil.example", "http://127.0.0.1.evil.example:80", "http://10.0.0.1:80", "http://localhost:80/x"]) {
      expect(testTelegramApi({ CHIEF_TEST: "1", CHIEF_TEST_TELEGRAM_API: v }, log), v).toBeUndefined();
    }
    expect(lines).toHaveLength(4);
  });
});
