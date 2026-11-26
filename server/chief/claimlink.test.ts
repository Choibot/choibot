// server/chief/claimlink.test.ts — the claim link of a first-start file: the file, the claim
// route, and how the link ends. One refusal test for each rule.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, callerOf } from "./auth.js";
import { CLAIM_LIFE_MS, CLAIM_MAX_LIFE_MS, CLAIM_TRIES, ClaimLinks, parseFirstStart } from "./claimlink.js";
import { BoxCodes, FIRST_RUN_ERR, FIRST_RUN_ROUTE, mintBoxCode, registerFirstRun } from "./firstrun.js";

let dir: string;
let chief: string;
let now: number;
let app: FastifyInstance;
let devices: DeviceStore;
let logs: string[];

const MASTER: AgentRecord = {
  id: "fleet-master", label: "master", repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: "tok-master", status: "idle", createdAt: 1, kind: "fleet-master",
};

// A secret as the control plane makes it, and the hash that goes into the first-start file.
const newSecret = (): string => randomBytes(32).toString("base64url");
const hashOf = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
// The same length and alphabet, and not the secret.
const other = (s: string): string => (s[0] === "A" ? "B" : "A") + s.slice(1);

const files = () => ({ firstStart: join(chief, "first-start.json"), state: join(chief, "claim-link.json") });
function firstStart(body: unknown): void {
  mkdirSync(chief, { recursive: true, mode: 0o700 });
  writeFileSync(files().firstStart, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
}
const fileFor = (secret: string, o: { expiresAt?: number; server?: string | null } = {}) => ({
  v: 1, ...(o.server === null ? {} : { server: o.server ?? "srv42" }),
  claim: { sha256: hashOf(secret), expiresAt: o.expiresAt ?? now + CLAIM_LIFE_MS },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claimlink-"));
  chief = join(dir, "chief");
  now = 1_795_000_000_000;
  logs = [];
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function build(): Promise<void> {
  await app?.close();
  devices = new DeviceStore(join(chief, "user-devices.json"), { now: () => now });
  const agents = { load: async (id: string) => (id === MASTER.id ? MASTER : null) };
  app = Fastify();
  registerFirstRun(app, {
    devices, codes: new BoxCodes(join(chief, "pair-code.json"), { now: () => now }),
    links: new ClaimLinks(files(), { now: () => now, log: (s) => logs.push(s) }),
    caller: (req) => callerOf(req.headers, { devices, agents }), pageRoute: "/*",
  });
  app.get("/api/agents", async () => ({ agents: [] }));
  app.all("/*", async (req) => ({ page: req.raw.url }));
  await app.ready();
}

const view = async () => (await app.inject({ method: "GET", url: FIRST_RUN_ROUTE })).json();
const claim = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: FIRST_RUN_ROUTE, headers, payload: body });
const stateText = () => (existsSync(files().state) ? readFileSync(files().state, "utf8") : "");

describe("the first-start file", () => {
  it("version 1: the hash, the end time and the id of the server; keys it does not name stay unread", () => {
    const s = newSecret();
    expect(parseFirstStart(JSON.stringify({ ...fileFor(s), updateKey: "later", health: { url: "x" } }), now))
      .toEqual({ server: "srv42", sha256: hashOf(s), expiresAt: now + CLAIM_LIFE_MS });
  });
  it("with no end time the claim lives 24 hours; with no server id it is not a hosted console", () => {
    expect(parseFirstStart(JSON.stringify({ v: 1, claim: { sha256: hashOf("x") } }), now))
      .toEqual({ server: null, sha256: hashOf("x"), expiresAt: now + CLAIM_LIFE_MS });
  });
  it("refuses each field that does not match, and names the field, never its value", () => {
    const h = hashOf("x");
    const bad: [unknown, string][] = [
      ["{", "not JSON"], [[], "not an object"], [{ v: 2, claim: { sha256: h } }, "v is not 1"],
      [{ v: "1", claim: { sha256: h } }, "v is not 1"], [{ v: 1, server: "Srv_1", claim: { sha256: h } }, "server"],
      [{ v: 1, claim: "x" }, "claim"], [{ v: 1, claim: { sha256: h.toUpperCase() } }, "claim.sha256"],
      [{ v: 1, claim: { sha256: h.slice(1) } }, "claim.sha256"], [{ v: 1, claim: { sha256: h, expiresAt: "1" } }, "claim.expiresAt"],
      [{ v: 1, claim: { sha256: h, expiresAt: 1.5 } }, "claim.expiresAt"],
      [{ v: 1, claim: { sha256: h, expiresAt: now + CLAIM_MAX_LIFE_MS + 1 } }, "claim.expiresAt is more than 7 days away"],
    ];
    for (const [body, why] of bad) {
      const r = parseFirstStart(typeof body === "string" ? body : JSON.stringify(body), now);
      expect([body, r]).toEqual([body, { refused: why }]);
      expect(why).not.toContain(h);
    }
  });
});

describe("the console reads the first-start file once", () => {
  beforeEach(build);

  it("keeps only the hash (0600), removes the file, and says in the log until when the link works", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    expect(await view()).toEqual({ locked: true, link: "open", hosted: true });
    expect(existsSync(files().firstStart)).toBe(false);
    expect(JSON.parse(stateText())).toEqual({ sha256: hashOf(s), expiresAt: now + CLAIM_LIFE_MS, tries: 0, hosted: true });
    expect(statSync(files().state).mode & 0o777).toBe(0o600);
    expect(logs).toEqual([`[chief] first-start file read: a claim link works until ${new Date(now + CLAIM_LIFE_MS).toISOString()}`]);
  });

  it("the answer of the screen holds no hash and no end time", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    const body = (await app.inject({ method: "GET", url: FIRST_RUN_ROUTE })).body;
    expect(body).not.toContain(hashOf(s));
    expect(body).not.toContain(String(now + CLAIM_LIFE_MS));
  });

  it("a file that is refused is removed, the log names only the field, and the console stays locked with no link", async () => {
    firstStart({ v: 1, claim: { sha256: "nothex" } });
    expect(await view()).toEqual({ locked: true, link: "none", hosted: false });
    expect(existsSync(files().firstStart)).toBe(false);
    expect(logs).toEqual(["[chief] first-start file refused (claim.sha256); it is removed"]);
  });

  it("a symbolic link in place of the file is not followed", async () => {
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify(fileFor(newSecret())));
    mkdirSync(chief, { recursive: true });
    symlinkSync(target, files().firstStart);
    expect(await view()).toEqual({ locked: true, link: "none", hosted: false });
    expect(existsSync(target)).toBe(true);
    expect(logs).toEqual(["[chief] first-start file refused (not a plain file); it is removed"]);
  });

  it("a file whose end time is past gives an ended link, and the screen knows it is hosted", async () => {
    firstStart(fileFor(newSecret(), { expiresAt: now - 1 }));
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
  });

  it("a new file while no device is paired replaces the link before it (a new link from the dashboard)", async () => {
    const first = newSecret();
    const second = newSecret();
    firstStart(fileFor(first));
    await view();
    firstStart(fileFor(second));
    expect((await claim({ claim: first })).statusCode).toBe(403);
    expect((await claim({ claim: second, label: "laptop" })).statusCode).toBe(200);
  });
});

describe("the claim of the first device with the link", () => {
  beforeEach(build);

  it("the right secret pairs this device with its name; the link ends, and nothing of it stays", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    const res = await claim({ claim: s, label: "mira-laptop" });
    expect(res.statusCode).toBe(200);
    const { token, label } = res.json() as { token: string; label: string };
    expect(label).toBe("mira-laptop");
    expect(await devices.verify(token)).toMatchObject({ label: "mira-laptop" });
    expect(JSON.parse(stateText())).toEqual({ ended: "used", hosted: true });
    expect(stateText()).not.toContain(hashOf(s));
    expect(logs.join("\n")).not.toContain(s);
    expect(logs.join("\n")).not.toContain(hashOf(s));
  });

  it("one use: after the last device is revoked, the same link does not work again", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    expect((await claim({ claim: s })).statusCode).toBe(200);
    expect((await claim({ claim: s })).statusCode).toBe(404);   // a device is paired: the route is closed
    for (const d of await devices.list()) await devices.revoke(d.label);
    const res = await claim({ claim: s });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: FIRST_RUN_ERR.goneLink });
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
  });

  it("refuses a wrong secret and one of another shape, and says nothing of the link", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    for (const wrong of [other(s), s.slice(1), `${s}=`, s.replace(/.$/, "+"), ""]) {
      const res = await claim({ claim: wrong });
      expect([wrong, res.statusCode]).toEqual([wrong, 403]);
      expect(res.json()).toEqual({ error: FIRST_RUN_ERR.wrongLink });
      expect(res.body).not.toContain(hashOf(s));
    }
    expect(await devices.list()).toEqual([]);
    expect(JSON.parse(stateText()).tries).toBe(5);
  });

  it("the end time: after it the right secret is refused, and the screen says the link ended", async () => {
    const s = newSecret();
    firstStart(fileFor(s, { expiresAt: now + 60_000 }));
    await view();
    now += 60_000;
    expect((await claim({ claim: s })).statusCode).toBe(410);
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
    expect(stateText()).not.toContain(hashOf(s));
  });

  it("the try limit: the last wrong try ends the link, also for the right secret after it", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    for (let i = 1; i < CLAIM_TRIES; i++) expect((await claim({ claim: other(s) })).statusCode).toBe(403);
    const last = await claim({ claim: other(s) });
    expect(last.statusCode).toBe(429);
    expect(last.json()).toEqual({ error: FIRST_RUN_ERR.spentLink });
    expect((await claim({ claim: s })).statusCode).toBe(410);
    expect(logs).toContain("[chief] claim link: too many wrong tries; the link does not work any more");
  });

  it("the tries are in the file, so a restart gives no new ones", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    for (let i = 1; i < CLAIM_TRIES; i++) await claim({ claim: other(s) });
    await build();
    expect((await claim({ claim: other(s) })).statusCode).toBe(429);
  });

  it("an agent header never claims, also with the right secret and a valid agent; the link stays unused", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    const marked: Record<string, string>[] = [
      { [AGENT_HEADER]: MASTER.id, [AGENT_TOKEN_HEADER]: MASTER.hookToken }, { [AGENT_HEADER]: "x" }, { [AGENT_TOKEN_HEADER]: "x" },
    ];
    for (const headers of marked) {
      const res = await claim({ claim: s }, headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: FIRST_RUN_ERR.agentHeaders });
    }
    expect(await devices.list()).toEqual([]);
    expect((await claim({ claim: s })).statusCode).toBe(200);
  });

  it("a code and a link in one request: refused, and no try is counted for either", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    const { code } = await mintBoxCode(join(chief, "pair-code.json"), { now: () => now });
    expect((await claim({ claim: s, code })).statusCode).toBe(403);
    expect((await claim({ claim: s, code: undefined, label: "a" })).statusCode).toBe(200);
  });

  it("two claims at the same time: one device", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    const both = await Promise.all([claim({ claim: s }), claim({ claim: s })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    expect(await devices.list()).toHaveLength(1);
  });

  it("with no link on this console, a claim is gone, and the screen says there is none", async () => {
    expect((await claim({ claim: newSecret() })).statusCode).toBe(410);
    expect(await view()).toEqual({ locked: true, link: "none", hosted: false });
  });
});

describe("the link ends when a device is paired in another way", () => {
  it("the code of the box pairs the first device: the link ends with it", async () => {
    await build();
    const s = newSecret();
    firstStart(fileFor(s));
    await view();
    const { code } = await mintBoxCode(join(chief, "pair-code.json"), { now: () => now });
    expect((await claim({ code })).statusCode).toBe(200);
    expect(JSON.parse(stateText())).toEqual({ ended: "used", hosted: true });
    for (const d of await devices.list()) await devices.revoke(d.label);
    expect((await claim({ claim: s })).statusCode).toBe(410);
  });

  it("a console that starts with a paired device ends an open link, and removes a first-start file that waits", async () => {
    const s = newSecret();
    firstStart(fileFor(s));
    // An open link in the file, from before; then a device is paired outside the route.
    mkdirSync(chief, { recursive: true });
    writeFileSync(files().state, JSON.stringify({ sha256: hashOf(s), expiresAt: now + CLAIM_LIFE_MS, tries: 0, hosted: true }));
    await new DeviceStore(join(chief, "user-devices.json")).add("laptop");
    await build();
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(200);
    expect(JSON.parse(stateText())).toEqual({ ended: "used", hosted: true });
    expect(existsSync(files().firstStart)).toBe(false);
    await devices.revoke("laptop");
    expect((await claim({ claim: s })).statusCode).toBe(410);
  });

  it("a self-hosted console (no server id in the file): the screen gets hosted false", async () => {
    await build();
    firstStart(fileFor(newSecret(), { server: null }));
    expect(await view()).toEqual({ locked: true, link: "open", hosted: false });
  });
});
