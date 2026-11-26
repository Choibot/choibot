// server/chief/api.test.ts — POST /api/chief/pair/start and /claim (spec §3.1
// steps 2 and 5, §7, §15): a tiny Fastify app with the real gate, real
// PairingCodes and a real DeviceStore in a temp dir; only Telegram and the log
// are fakes.
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChiefApi } from "./api.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, PAIR_TTL_MS, PairingCodes } from "./auth.js";
import { makeGate } from "./gate.js";

const CONSOLE = "http://127.0.0.1:4999";
const NOW = 1_000_000;

let app: FastifyInstance | undefined;
let dirs: string[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function setup(o: {
  userAuth?: "telegram" | "log"; misconfigured?: string | null; deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "chief-api-"));
  dirs.push(root);
  const file = join(root, "user-devices.json");
  const devices = new DeviceStore(file, { setTimer: () => ({ clear() {} }) });
  let now = NOW;
  const pairing = new PairingCodes({ now: () => now, setTimer: () => ({ clear() {} }) });
  const mint = vi.spyOn(pairing, "mint");
  const add = vi.spyOn(devices, "add");
  const caller = vi.fn();
  const gate = makeGate({
    misconfigured: o.misconfigured ?? null, userAuth: o.userAuth ?? "log",
    deps: { devices, agents: { load: async () => { caller(); return null; } } },
  });
  const deleteMessage = vi.fn(o.deleteMessage ?? (async () => {}));
  const logs: string[] = [];
  app = Fastify();
  registerChiefApi(app, { gate, pairing, devices, consoleUrl: CONSOLE, tg: { deleteMessage }, log: (s) => { logs.push(s); } });
  await app.ready();
  const post = (path: "start" | "claim", body?: unknown, headers: Record<string, string> = {}) =>
    app!.inject({
      method: "POST", url: `/api/chief/pair/${path}`, headers,
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const codeOf = (url: string): string => url.slice(`${CONSOLE}/#pair=`.length);
  return { file, devices, pairing, mint, add, caller, deleteMessage, logs, post, codeOf, advance: (ms: number) => { now += ms; } };
}

describe("POST /api/chief/pair/start", () => {
  it("log mode: mints a code, logs the link once and returns {url, expiresAt}", async () => {
    const t = await setup();
    const res = await t.post("start", { label: "laptop" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; expiresAt: number };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "url"]);
    expect(body.url.startsWith(`${CONSOLE}/#pair=`)).toBe(true);
    expect(t.codeOf(body.url)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.expiresAt).toBe(NOW + PAIR_TTL_MS);
    expect(t.mint).toHaveBeenCalledTimes(1);
    expect(t.mint).toHaveBeenCalledWith("laptop");
    expect(t.logs).toEqual([`[chief] pairing link for laptop: ${body.url}`]);
    // The start itself pairs nothing.
    expect(t.add).not.toHaveBeenCalled();
  });

  it("the returned link claims the device it was started for", async () => {
    const t = await setup();
    const { url } = (await t.post("start", { label: "cli" })).json() as { url: string };
    const res = await t.post("claim", { code: t.codeOf(url) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { label: string }).label).toBe("cli");
  });

  it("telegram mode: 404, no code minted, nothing logged", async () => {
    const t = await setup({ userAuth: "telegram" });
    const res = await t.post("start", { label: "laptop" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.logs).toEqual([]);
  });

  it("agent headers: 403, no code minted, nothing logged", async () => {
    const t = await setup();
    const cases: Array<Record<string, string>> = [
      { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: "tok-w1" },
      { [AGENT_HEADER]: "cron:nightly" },
      { [AGENT_TOKEN_HEADER]: "tok-w1" },
    ];
    for (const headers of cases) {
      const res = await t.post("start", { label: "laptop" }, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json()).toEqual({ error: "agent headers are not allowed" });
    }
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.logs).toEqual([]);
  });

  it("a bad label: 400, no code minted, nothing logged", async () => {
    const t = await setup();
    const bodies: unknown[] = [{ label: "Lap Top" }, { label: "" }, { label: "a".repeat(33) }, { label: "-x" }, { label: 7 }, {}, ["laptop"]];
    for (const b of bodies) {
      const res = await t.post("start", b);
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
    }
    expect((await t.post("start")).statusCode).toBe(400);
    expect(t.mint).not.toHaveBeenCalled();
    expect(t.logs).toEqual([]);
  });

  it("the longest valid label (32 characters) is accepted", async () => {
    const t = await setup();
    const res = await t.post("start", { label: "a".repeat(32) });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/chief/pair/claim", () => {
  it("a valid code: 200 {token, label}; the token verifies in the real DeviceStore and is not stored", async () => {
    const t = await setup();
    const { code } = t.pairing.mint("laptop");
    const res = await t.post("claim", { code });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; label: string };
    expect(Object.keys(body).sort()).toEqual(["label", "token"]);
    expect(body.label).toBe("laptop");
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await t.devices.verify(body.token)).toMatchObject({ label: "laptop" });
    expect(await t.devices.verify("x".repeat(43))).toBeNull();
    expect(await readFile(t.file, "utf8")).not.toContain(body.token);
    // A code without Telegram meta deletes nothing.
    expect(t.deleteMessage).not.toHaveBeenCalled();
  });

  it("a second claim of the same code: 410, no second device token", async () => {
    const t = await setup();
    const { code } = t.pairing.mint("laptop");
    expect((await t.post("claim", { code })).statusCode).toBe(200);
    const again = await t.post("claim", { code });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: "pairing code expired or used" });
    expect(t.add).toHaveBeenCalledTimes(1);
  });

  it("an unknown, expired or missing code: 410 (decision 10), no device added", async () => {
    const t = await setup();
    const { code } = t.pairing.mint("laptop");
    t.advance(PAIR_TTL_MS);
    const cases: unknown[] = [{ code }, { code: "junk" }, { code: "" }, { code: 7 }, {}];
    for (const b of cases) {
      const res = await t.post("claim", b);
      expect(res.statusCode, JSON.stringify(b)).toBe(410);
      expect(res.json()).toEqual({ error: "pairing code expired or used" });
    }
    expect((await t.post("claim")).statusCode).toBe(410);
    expect(t.add).not.toHaveBeenCalled();
    expect(await t.devices.list()).toEqual([]);
  });

  it("a code from /pair: deletes the private message that held the link", async () => {
    const t = await setup();
    const { code } = t.pairing.mint("phone");
    expect(t.pairing.attachMessage(code, 4242, 777)).toBe(true);
    const res = await t.post("claim", { code });
    expect(res.statusCode).toBe(200);
    expect(t.deleteMessage).toHaveBeenCalledTimes(1);
    expect(t.deleteMessage).toHaveBeenCalledWith(4242, 777);
    expect(await t.devices.verify((res.json() as { token: string }).token)).toMatchObject({ label: "phone" });
  });

  it("Review Focus 3: a deleteMessage that rejects does not fail the claim", async () => {
    const t = await setup({ deleteMessage: async () => { throw new Error("telegram 400: message can't be deleted"); } });
    const { code } = t.pairing.mint("phone");
    t.pairing.attachMessage(code, 4242, 777);
    const res = await t.post("claim", { code });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; label: string };
    expect(body.label).toBe("phone");
    expect(await t.devices.verify(body.token)).toMatchObject({ label: "phone" });
    await vi.waitFor(() => expect(t.logs).toEqual(["[chief] pairing deleteMessage failed: telegram 400: message can't be deleted"]));
  });

  it("Review Focus 3: a deleteMessage that never settles does not hold the claim", async () => {
    const t = await setup({ deleteMessage: () => new Promise<void>(() => {}) });
    const { code } = t.pairing.mint("phone");
    t.pairing.attachMessage(code, 4242, 777);
    const res = await t.post("claim", { code });
    expect(res.statusCode).toBe(200);
    expect(await t.devices.verify((res.json() as { token: string }).token)).toMatchObject({ label: "phone" });
    expect(t.deleteMessage).toHaveBeenCalledWith(4242, 777);
  });

  it("claims with an existing label replace that device (spec §3.1 step 3)", async () => {
    const t = await setup();
    const first = (await t.post("claim", { code: t.pairing.mint("laptop").code })).json() as { token: string };
    const second = (await t.post("claim", { code: t.pairing.mint("laptop").code })).json() as { token: string };
    expect(await t.devices.verify(first.token)).toBeNull();
    expect(await t.devices.verify(second.token)).toMatchObject({ label: "laptop" });
    expect((await t.devices.list()).map((d) => d.label)).toEqual(["laptop"]);
  });
});

describe("misconfigured mode", () => {
  it("503 chief-misconfigured on both routes in both modes; no code minted or consumed", async () => {
    for (const userAuth of ["log", "telegram"] as const) {
      const t = await setup({ userAuth, misconfigured: "CHIEF_CONSOLE_URL is missing" });
      const { code } = t.pairing.mint("laptop");
      t.pairing.attachMessage(code, 4242, 777);
      t.mint.mockClear();
      const start = await t.post("start", { label: "laptop" });
      expect(start.statusCode).toBe(503);
      expect(start.json()).toEqual({ error: "chief-misconfigured" });
      const claim = await t.post("claim", { code });
      expect(claim.statusCode).toBe(503);
      expect(claim.json()).toEqual({ error: "chief-misconfigured" });
      // Agent headers do not change the answer: 503 comes first.
      expect((await t.post("start", { label: "laptop" }, { [AGENT_HEADER]: "w1" })).statusCode).toBe(503);
      expect(t.mint).not.toHaveBeenCalled();
      expect(t.add).not.toHaveBeenCalled();
      expect(t.deleteMessage).not.toHaveBeenCalled();
      expect(t.logs).toEqual([]);
      // The 503 did not consume the code.
      expect(t.pairing.claim(code)).toMatchObject({ label: "laptop" });
      await app!.close();
      app = undefined;
    }
  });
});

describe("caller lookup", () => {
  it("neither route looks up a caller (no record load, no device verify)", async () => {
    const t = await setup();
    const verify = vi.spyOn(t.devices, "verify");
    await t.post("start", { label: "laptop" }, { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: "tok-w1" });
    await t.post("start", { label: "laptop" }, { "x-choibot-user": "u".repeat(43) });
    await t.post("claim", { code: "junk" }, { "x-choibot-user": "u".repeat(43) });
    expect(t.caller).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});
