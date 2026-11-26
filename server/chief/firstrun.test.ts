// server/chief/firstrun.test.ts — the first device of a new install: the code of the box, the
// claim route, and the lock. One refusal test for each rule.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { NEW_NAMES, OLD_NAMES } from "../names.mjs";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER, callerOf } from "./auth.js";
import {
  BOX_CODE_TRIES, BOX_CODE_TTL_MS, BoxCodes, FIRST_DEVICE_LABEL, FIRST_RUN_ERR, FIRST_RUN_PAGE, FIRST_RUN_ROUTE,
  firstRunOn, mintBoxCode, newInstall, normalizeCode, registerFirstRun,
} from "./firstrun.js";
import { ClaimLinks } from "./claimlink.js";
import { CHIEF_ERR } from "./gate.js";
import { VERSION_ROUTE } from "../release.js";

let dir: string;
let codeFile: string;
let now: number;
let app: FastifyInstance;
let devices: DeviceStore;

const MASTER: AgentRecord = {
  id: "fleet-master", label: "master", repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: "tok-master", status: "idle", createdAt: 1, kind: "fleet-master",
};
const agent = (id: string, token: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
const LOCKED = { error: CHIEF_ERR.pairRequired, userAuth: "log", locked: true };

// A code that is not `code`: its first character changes.
const other = (code: string): string => (code[0] === "2" ? "3" : "2") + code.slice(1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "firstrun-"));
  codeFile = join(dir, "chief", "pair-code.json");
  now = 1_000_000;
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

// The lock and the claim route in front of four routes of a console: one API route, one
// socket, the agent hook, and the catch-all that serves the pages (it answers with the address
// that the page server would get).
async function build(): Promise<void> {
  devices = new DeviceStore(join(dir, "chief", "user-devices.json"), { now: () => now });
  const agents = { load: async (id: string) => (id === MASTER.id ? MASTER : null) };
  app = Fastify();
  await app.register(websocket);
  registerFirstRun(app, {
    devices, codes: new BoxCodes(codeFile, { now: () => now }),
    links: new ClaimLinks({ firstStart: join(dir, "chief", "first-start.json"), state: join(dir, "chief", "claim-link.json") }, { now: () => now }),
    caller: (req) => callerOf(req.headers, { devices, agents }), pageRoute: "/*",
  });
  app.get("/api/agents", async () => ({ agents: [] }));
  app.get(VERSION_ROUTE, async () => ({ version: 841 }));
  app.post(VERSION_ROUTE, async () => ({ posted: true }));
  app.post("/api/chief/pair/start", async () => ({ url: "x" }));
  app.post("/api/agents/:id/hook", async () => ({ hook: true }));
  app.get("/api/sock", { websocket: true }, (socket) => { socket.send("hi"); });
  app.all("/*", async (req) => ({ page: req.raw.url }));
  await app.ready();
}

const mint = (ttlMs?: number) => mintBoxCode(codeFile, { now: () => now, ...(ttlMs ? { ttlMs } : {}) });
const claim = (code: unknown, extra: { headers?: Record<string, string>; label?: unknown } = {}) =>
  app.inject({ method: "POST", url: FIRST_RUN_ROUTE, headers: extra.headers ?? {}, payload: { code, ...(extra.label !== undefined ? { label: extra.label } : {}) } });

describe("the marker of a new install", () => {
  it("every install is new", () => {
    expect(newInstall(OLD_NAMES)).toBe(true);
    expect(newInstall(NEW_NAMES)).toBe(true);
  });
  it("a new install: only with the Queue on and pairing from the box", () => {
    expect(firstRunOn({ active: true, userAuth: "log" }, NEW_NAMES)).toBe(true);
    expect(firstRunOn({ active: true, userAuth: "telegram" }, NEW_NAMES)).toBe(false);
    expect(firstRunOn({ active: false, userAuth: "log" }, NEW_NAMES)).toBe(false);
  });
  it("the test suite itself runs as a new install", () => {
    expect(newInstall()).toBe(true);
  });
});

describe("the code of the box", () => {
  it("is 8 characters in 2 groups, and the file holds only its hash, for the owner only", async () => {
    const { code, expiresAt } = await mint();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt).toBe(now + BOX_CODE_TTL_MS);
    const text = readFileSync(codeFile, "utf8");
    expect(text).not.toContain(code);
    expect(text).not.toContain(normalizeCode(code));
    expect(JSON.parse(text)).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), expiresAt, tries: 0 });
    expect(statSync(codeFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "chief")).mode & 0o777).toBe(0o700);
  });
  it("two codes are not the same", async () => {
    expect((await mint()).code).not.toBe((await mint()).code);
  });
  it("reads what a person types: lower case, spaces, no hyphen, O for 0, I and L for 1", () => {
    expect(normalizeCode(" k7qf 2m9x ")).toBe("K7QF2M9X");
    expect(normalizeCode("O0IL-1o1l")).toBe("00111011");
  });
  it("a new code replaces the code before it", async () => {
    const codes = new BoxCodes(codeFile, { now: () => now });
    const first = await mint();
    const second = await mint();
    expect(await codes.claim(first.code)).toBe("wrong");
    expect(await codes.claim(second.code)).toBe("ok");
  });
  it("a file that is not a code reads as no code", async () => {
    const codes = new BoxCodes(codeFile, { now: () => now });
    expect(await codes.claim("K7QF-2M9X")).toBe("gone");
  });
});

describe("the claim of the first device", () => {
  beforeEach(build);

  it("the right code pairs this device: a normal device with a token that works", async () => {
    const { code } = await mint();
    const res = await claim(code.toLowerCase().replace("-", " "), { label: "laptop" });
    expect(res.statusCode).toBe(200);
    const { token, label } = res.json() as { token: string; label: string };
    expect(label).toBe("laptop");
    expect((await devices.list()).map((d) => d.label)).toEqual(["laptop"]);
    expect(await devices.verify(token)).toMatchObject({ label: "laptop" });
    expect(await devices.revoke("laptop")).toBe(true);
  });

  it("a label that is not valid becomes the default one", async () => {
    const { code } = await mint();
    expect((await claim(code, { label: "../x" })).json()).toMatchObject({ label: FIRST_DEVICE_LABEL });
  });

  it("refuses a wrong code, and says nothing of the code", async () => {
    const { code } = await mint();
    const res = await claim(other(code));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: FIRST_RUN_ERR.wrong });
    expect(res.body).not.toContain(normalizeCode(code));
    expect(await devices.list()).toEqual([]);
  });

  it("refuses a used code", async () => {
    const { code } = await mint();
    expect((await claim(code)).statusCode).toBe(200);
    // The first device is paired, so the route is closed; with no device it says "gone".
    expect((await claim(code)).statusCode).toBe(404);
    await devices.revoke(FIRST_DEVICE_LABEL);
    const res = await claim(code);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: FIRST_RUN_ERR.gone });
    expect(await devices.list()).toEqual([]);
  });

  it("refuses an expired code", async () => {
    const { code, expiresAt } = await mint();
    now = expiresAt;
    expect((await claim(code)).statusCode).toBe(410);
    now = expiresAt - 1; // and it does not come back
    expect((await claim(code)).statusCode).toBe(410);
    expect(await devices.list()).toEqual([]);
  });

  it("refuses after too many tries: the last wrong try ends the code", async () => {
    const { code } = await mint();
    for (let i = 1; i < BOX_CODE_TRIES; i++) expect((await claim(other(code))).statusCode).toBe(403);
    const last = await claim(other(code));
    expect(last.statusCode).toBe(429);
    expect(last.json()).toEqual({ error: FIRST_RUN_ERR.spent });
    expect((await claim(code)).statusCode).toBe(410);
    expect(await devices.list()).toEqual([]);
  });

  it("the tries are counted in the file, so a restart does not give new ones", async () => {
    const { code } = await mint();
    for (let i = 1; i < BOX_CODE_TRIES; i++) await claim(other(code));
    await app.close();
    await build();
    expect((await claim(other(code))).statusCode).toBe(429);
  });

  it("refuses a request with an agent header, also with the right code and a valid agent", async () => {
    const { code } = await mint();
    const marked: Record<string, string>[] = [agent(MASTER.id, MASTER.hookToken), { [AGENT_HEADER]: "x" }, { [AGENT_TOKEN_HEADER]: "x" }];
    for (const headers of marked) {
      const res = await claim(code, { headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: FIRST_RUN_ERR.agentHeaders });
    }
    expect(await devices.list()).toEqual([]);
    expect((await claim(code)).statusCode).toBe(200); // the code was not spent by them
  });

  it("no code in the body, or no code on the box: gone", async () => {
    expect((await claim("K7QF-2M9X")).statusCode).toBe(410);
    await mint();
    expect((await claim(undefined)).statusCode).toBe(410);
    expect((await claim(12345678)).statusCode).toBe(410);
  });

  it("two claims at the same time: one device", async () => {
    const { code } = await mint();
    const both = await Promise.all([claim(code), claim(code)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    expect(await devices.list()).toHaveLength(1);
  });
});

describe("the lock of a console with no paired device", () => {
  beforeEach(build);

  it("says that it is locked", async () => {
    expect((await app.inject({ method: "GET", url: FIRST_RUN_ROUTE })).json()).toEqual({ locked: true, link: "none", hosted: false });
  });

  it("refuses every other API route, with or without a token of a user", async () => {
    for (const req of [
      { method: "GET", url: "/api/agents" },
      { method: "GET", url: "/api/agents", headers: { [USER_HEADER]: "u".repeat(43) } },
      { method: "POST", url: "/api/chief/pair/start", payload: { label: "laptop" } },
      { method: "GET", url: "/api/unknown" },
      { method: "POST", url: "/" },
      { method: "DELETE", url: "/anything" },
    ] as const) {
      const res = await app.inject(req);
      expect([req.method, req.url, res.statusCode]).toEqual([req.method, req.url, 403]);
      expect(res.json()).toEqual(LOCKED);
    }
  });

  it("answers which version runs (GET only): the updater's check before any claim", async () => {
    expect((await app.inject({ method: "GET", url: VERSION_ROUTE })).json()).toEqual({ version: 841 });
    const post = await app.inject({ method: "POST", url: VERSION_ROUTE, payload: {} });
    expect([post.statusCode, post.json()]).toEqual([403, LOCKED]);
  });

  it("refuses a socket", async () => {
    await expect(app.injectWS("/api/sock")).rejects.toThrow(/403/);
    await expect(app.injectWS("/_next/webpack-hmr")).rejects.toThrow(/403/);
  });

  it("serves the pairing screen for every page, and the files of the app as they are", async () => {
    for (const url of ["/", "/settings", "/?x=1", "/first-run", "/anything/else"]) {
      expect((await app.inject({ method: "GET", url })).json()).toEqual({ page: FIRST_RUN_PAGE });
    }
    for (const url of ["/_next/static/chunks/main.js", "/favicon.ico", "/icon.svg", "/apple-icon.png"]) {
      expect((await app.inject({ method: "GET", url })).json()).toEqual({ page: url });
    }
  });

  it("lets the console's own agents work: the hook route, and a caller with the secret of an agent", async () => {
    expect((await app.inject({ method: "POST", url: "/api/agents/fleet-master/hook?token=x", payload: {} })).json()).toEqual({ hook: true });
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: agent(MASTER.id, MASTER.hookToken) })).statusCode).toBe(200);
  });

  it("refuses agent headers that do not authenticate", async () => {
    const bad: Record<string, string>[] = [agent(MASTER.id, "wrong"), agent("nobody", "tok-master"), { [AGENT_HEADER]: MASTER.id }];
    for (const headers of bad) {
      const res = await app.inject({ method: "GET", url: "/api/agents", headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(LOCKED);
    }
  });

  it("opens after the first device is paired, and locks again when the last one is revoked", async () => {
    const { code } = await mint();
    const { token } = (await claim(code, { label: "laptop" })).json() as { token: string };
    expect((await app.inject({ method: "GET", url: FIRST_RUN_ROUTE })).json()).toEqual({ locked: false });
    // As a console of today: the routes answer, with the token and without it.
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: { [USER_HEADER]: token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).json()).toEqual({ page: "/" });
    (await app.injectWS("/api/sock")).terminate();
    await devices.revoke("laptop");
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: { [USER_HEADER]: token } })).statusCode).toBe(403);
  });
});

describe("a console where the first-run rules are off (the owner's console)", () => {
  it("has no lock and no claim route: an unpaired browser reads as today", async () => {
    // index.ts registers nothing when firstRunOn is false. The same app without the call:
    devices = new DeviceStore(join(dir, "chief", "user-devices.json"));
    app = Fastify();
    await app.register(websocket);
    app.get("/api/agents", async () => ({ agents: [] }));
    app.get("/api/sock", { websocket: true }, (socket) => { socket.send("hi"); });
    app.all("/*", async (req) => ({ page: req.raw.url }));
    await app.ready();
    expect(await devices.list()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).json()).toEqual({ page: "/" });
    expect((await app.inject({ method: "POST", url: FIRST_RUN_ROUTE, payload: { code: "K7QF-2M9X" } })).json()).toEqual({ page: FIRST_RUN_ROUTE });
    (await app.injectWS("/api/sock")).terminate();
  });
});
