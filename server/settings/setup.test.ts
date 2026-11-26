// server/settings/setup.test.ts — the Telegram set-up form (POST /api/settings/telegram/setup):
// USER only, the checks before any write (shape, a live getMe, the ids, the chief still starts),
// a write-only token that is never sent back or logged, one save at a time, and the restart.
// A temp .env, a fake Bot API, a fake restarter. Made-up values only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { registerSettingsApi } from "./api.js";
import { planSetup } from "./setup.js";
import { envFilePath, loadTestEnvFile } from "./envfile.js";

const OLD = "123456789:AAH-made-up-token-for-tests-ONLY_x";
const NEW = "987654321:BBH-another-made-up-token-for-tests_y";
const CHIEF_UT = "user-token";
const HOOK = "hook-1";
const FILE = [
  "# Console", "CONSOLE_COOKIE_SECRET=not-a-real-secret-0123456789abcdef", "",
  "# Telegram", `TELEGRAM_BOT_TOKEN=${OLD}`, "TELEGRAM_ISSUES_USER_ID=4242",
  "TELEGRAM_MASTER_CHAT_ID=-1001234567890", "TELEGRAM_MASTER_THREAD_ID=2", "AGENT_ENV_PASS=", "",
].join("\n");
const ENV = { TELEGRAM_BOT_TOKEN: OLD, TELEGRAM_ISSUES_USER_ID: "4242", TELEGRAM_MASTER_CHAT_ID: "-1001234567890", TELEGRAM_MASTER_THREAD_ID: "2", CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "http://x", CHIEF_USER_AUTH: "telegram" };

let dir: string;
let envFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tgsetup-"));
  envFile = join(dir, ".env");
  await writeFile(envFile, FILE, { mode: 0o600 });
  await chmod(envFile, 0o600);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function fakeBot(o: { refuse?: boolean; down?: boolean } = {}) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string) => {
    calls.push(url.replace(/\/bot[^/]+\//, "/bot<t>/"));
    if (o.down) throw new TypeError(`fetch failed ${url}`);
    if (o.refuse) return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
    return Response.json({ ok: true, result: { username: "new_bot", first_name: "New" } });
  });
  return { calls, fetch: f as unknown as typeof fetch };
}

function app(o: { env?: Record<string, string>; chief?: boolean; misconfigured?: string | null; bot?: ReturnType<typeof fakeBot>; armed?: boolean; log?: (s: string) => void; schedule?: () => Promise<void> } = {}) {
  const a = Fastify();
  const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
    ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
  const gate = makeGate({
    misconfigured: o.misconfigured ?? null, userAuth: "telegram",
    deps: { devices: { verify: async (t: string) => (t === CHIEF_UT ? { label: "phone", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
  });
  const bot = o.bot ?? fakeBot();
  const schedule = vi.fn(o.schedule ?? (async () => {}));
  const lines: string[] = [];
  registerSettingsApi(a, {
    env: { ...(o.env ?? ENV) },
    chief: o.chief === false ? undefined : { gate, active: (o.misconfigured ?? null) === null, devices: { list: async () => [] } },
    telegram: { fetch: bot.fetch, apiBase: "http://tg.test" },
    gh: async () => "{}", ghRepos: async () => [],
    envFile,
    restarter: { armed: async () => (o.armed === false ? { ok: false, why: "this console is a dev server, not a production build" } : { ok: true }), schedule },
    bootAt: 1,
    log: o.log ?? ((s) => lines.push(s)),
  });
  return { a, bot, schedule, lines };
}

const user = { [USER_HEADER]: CHIEF_UT };
const save = (a: ReturnType<typeof Fastify>, payload: object, headers: Record<string, string> = user) =>
  a.inject({ method: "POST", url: "/api/settings/telegram/setup", headers, payload });
const agentAs = (id: string, token = HOOK) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
const NOT_USER: Array<[string, Record<string, string>]> = [
  ["no token", {}],
  ["a wrong user token", { [USER_HEADER]: "nope" }],
  ["a worker (with the user token too)", { ...agentAs("w1"), [USER_HEADER]: CHIEF_UT }],
  ["a lead", agentAs("lead-app")],
  ["the fleet master", agentAs("fleet-master")],
  ["an agent header that does not match", agentAs("w1", "wrong")],
];
const unchanged = async () => {
  expect(await readFile(envFile, "utf8")).toBe(FILE);
  expect(await readdir(dir)).toEqual([".env"]);
};

describe("POST /api/settings/telegram/setup: who may save", () => {
  it("refuses every caller but the paired user; nothing is checked or written", async () => {
    const { a, bot, schedule } = app();
    for (const [who, headers] of NOT_USER) {
      const res = await save(a, { token: NEW }, headers);
      expect(res.statusCode, who).toBe(403);
      expect(res.body, who).not.toContain(NEW);
    }
    expect(bot.calls).toHaveLength(0);
    expect(schedule).not.toHaveBeenCalled();
    await unchanged();
  });
  it("chief off: refused; misconfigured: 503; nothing written", async () => {
    expect((await save(app({ chief: false }).a, { token: NEW })).statusCode).toBe(403);
    expect((await save(app({ misconfigured: "x" }).a, { token: NEW })).statusCode).toBe(503);
    await unchanged();
  });
});

describe("POST /api/settings/telegram/setup: the checks before the write", () => {
  it("a token of the wrong shape names the field, never the value", async () => {
    const { a, bot } = app();
    const bad = "not-a-token-value-xyz";
    const res = await save(a, { token: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe("token");
    expect(res.body).not.toContain(bad);
    expect(bot.calls).toHaveLength(0);
    await unchanged();
  });
  it("a token Telegram refuses, or no answer from Telegram: nothing is written", async () => {
    for (const bot of [fakeBot({ refuse: true }), fakeBot({ down: true })]) {
      const { a } = app({ bot });
      const res = await save(a, { token: NEW, account: "4242", masterGroup: "-1001234567890", masterTopic: "2" });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe("token");
      expect(res.body).not.toContain(NEW);
      await unchanged();
    }
  });
  it("ids of the wrong sign or shape name their field", async () => {
    const cases: Array<[object, string]> = [
      [{ masterGroup: "1001234", masterTopic: "2", account: "4242" }, "masterGroup"],
      [{ masterGroup: "-100123", masterTopic: "-2", account: "4242" }, "masterTopic"],
      [{ account: "-5", masterGroup: "-100123", masterTopic: "2" }, "account"],
      [{ cronGroup: "-100123", account: "4242", masterGroup: "-100123", masterTopic: "2" }, "cronTopic"],
      [{ cronGroup: "abc", cronTopic: "4", account: "4242", masterGroup: "-100123", masterTopic: "2" }, "cronGroup"],
    ];
    for (const [body, field] of cases) {
      const res = await save(app().a, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().field, JSON.stringify(body)).toBe(field);
    }
    await unchanged();
  });
  it("refuses a save that would stop the chief of staff (telegram sign-in without a fleet master chat)", async () => {
    const res = await save(app().a, { account: "4242", masterGroup: "", masterTopic: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe("masterGroup");
    expect(res.json().error).not.toMatch(/CHIEF_|TELEGRAM_/);
    await unchanged();
  });
  it("a console that pairs devices from the server takes a fleet master chat (no dead end)", () => {
    const env = { ...ENV, CHIEF_USER_AUTH: "log", TELEGRAM_MASTER_CHAT_ID: "", TELEGRAM_MASTER_THREAD_ID: "" };
    const r = planSetup({ account: "4242", masterGroup: "-100123", masterTopic: "2" }, env, { TELEGRAM_ISSUES_USER_ID: "4242" });
    expect(r).toEqual({ changes: { TELEGRAM_MASTER_CHAT_ID: "-100123", TELEGRAM_MASTER_THREAD_ID: "2" }, newToken: null });
  });
  it("errors never name an env key (the form speaks plain words)", () => {
    const r = planSetup({ account: "4242", masterGroup: "", masterTopic: "" }, ENV, { TELEGRAM_MASTER_CHAT_ID: "-1001234567890", TELEGRAM_MASTER_THREAD_ID: "2" });
    expect("error" in r && r.error).toMatch(/pairs devices through the fleet master chat/);
    expect(JSON.stringify(r)).not.toMatch(/CHIEF_|TELEGRAM_/);
  });
});

describe("POST /api/settings/telegram/setup: the write and the restart", () => {
  it("a new token: checked with getMe, written, the old file kept as .env.bak, the restart scheduled; never echoed or logged", async () => {
    const { a, bot, schedule, lines } = app();
    const res = await save(a, { token: NEW, account: "4242", masterGroup: "-1001234567890", masterTopic: "2" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true, restart: { ok: true } });
    expect(bot.calls).toEqual(["http://tg.test/bot<t>/getMe"]);
    expect(await readFile(envFile, "utf8")).toBe(FILE.replace(OLD, NEW));
    expect(await readFile(`${envFile}.bak`, "utf8")).toBe(FILE);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(res.body).not.toContain(NEW);
    expect(lines.join("\n")).not.toContain(NEW);
    expect(lines.join("\n")).toContain("TELEGRAM_BOT_TOKEN");
  });
  it("an empty token keeps the current one; only the changed keys are written", async () => {
    const { a, bot } = app();
    const res = await save(a, { token: "", account: "4242", masterGroup: "-1001234567890", masterTopic: "2", cronGroup: "-1009", cronTopic: "4" });
    expect(res.json().saved).toBe(true);
    expect(bot.calls).toHaveLength(0);
    expect(await readFile(envFile, "utf8")).toBe(`${FILE}TELEGRAM_CRON_CHAT_ID=-1009\nTELEGRAM_CRON_THREAD_ID=4\n`);
  });
  it("nothing changed: nothing written, no restart", async () => {
    const { a, schedule } = app();
    const res = await save(a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "2" });
    expect(res.json()).toEqual({ saved: false, text: "Nothing changed." });
    expect(schedule).not.toHaveBeenCalled();
    await unchanged();
  });
  it("a console that cannot restart itself: saved, and the answer says why", async () => {
    const { a, schedule } = app({ armed: false });
    const res = await save(a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "3" });
    expect(res.json()).toEqual({ saved: true, restart: { ok: false, why: "this console is a dev server, not a production build" } });
    expect(schedule).not.toHaveBeenCalled();
  });
  it("while a restart is on its way, a second save is refused", async () => {
    const { a } = app();
    expect((await save(a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "3" })).statusCode).toBe(200);
    expect((await save(a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "4" })).statusCode).toBe(409);
  });
  it("two saves at once: one writes, the other is refused (never interleaved)", async () => {
    const { a } = app({ armed: false });
    const [r1, r2] = await Promise.all([
      save(a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "5" }),
      save(a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "6" }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes[0]).toBe(200);
    const text = await readFile(envFile, "utf8");
    expect(text.match(/^TELEGRAM_MASTER_THREAD_ID=/gm)).toHaveLength(1);
  });
  it("a symlinked .env is never written through", async () => {
    const real = join(dir, "real.env");
    await writeFile(real, FILE, { mode: 0o600 });
    await rm(envFile);
    const { symlink } = await import("node:fs/promises");
    await symlink(real, envFile);
    const res = await save(app().a, { account: "4242", masterGroup: "-1001234567890", masterTopic: "3" });
    expect(res.statusCode).toBe(409);
    expect(await readFile(real, "utf8")).toBe(FILE);
  });
});

describe("GET /api/settings/telegram: the form's state", () => {
  it("the ids, whether the token is set (never its value), and whether a save restarts the console", async () => {
    const res = await app().a.inject({ method: "GET", url: "/api/settings/telegram" });
    const j = res.json();
    expect(j.setup).toEqual({
      values: { account: "4242", masterGroup: "-1001234567890", masterTopic: "2", cronGroup: "", cronTopic: "" },
      tokenSet: true, canSave: true, why: null, restart: { ok: true }, restarting: false,
    });
    expect(j.bootAt).toBe(1);
    expect(res.body).not.toContain(OLD);
  });
});

describe("the test-only .env path", () => {
  it("is taken only with CHIEF_TEST=1 and an absolute path; else the console's own .env", () => {
    expect(envFilePath({ CHIEF_TEST: "1", CHIEF_TEST_ENV_FILE: "/tmp/chief-x/tg.env" }, "/srv/console")).toBe("/tmp/chief-x/tg.env");
    expect(envFilePath({ CHIEF_TEST_ENV_FILE: "/tmp/chief-x/tg.env" }, "/srv/console")).toBe("/srv/console/.env");
    expect(envFilePath({ CHIEF_TEST: "1", CHIEF_TEST_ENV_FILE: "rel.env" }, "/srv/console")).toBe("/srv/console/.env");
  });
  it("loadTestEnvFile sets only the writable keys from the file", async () => {
    const env: Record<string, string | undefined> = { CHIEF_TEST: "1", CHIEF_TEST_ENV_FILE: envFile, PORT: "1", TELEGRAM_CRON_CHAT_ID: "-5" };
    await loadTestEnvFile(env);
    expect(env).toMatchObject({ TELEGRAM_BOT_TOKEN: OLD, TELEGRAM_MASTER_THREAD_ID: "2", PORT: "1" });
    expect(env.TELEGRAM_CRON_CHAT_ID).toBeUndefined();
    expect(env.CONSOLE_COOKIE_SECRET).toBeUndefined();
  });
});
