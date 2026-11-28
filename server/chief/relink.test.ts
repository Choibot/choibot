// server/chief/relink.test.ts — the door's new claim link (firstrun.ts RELINK_ROUTE, claimlink.ts
// relink): the shape, who may send it, and that a console that had a paired device once never
// takes one. The real private listener with the door's token: server/frontproxy.test.ts.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { DOOR_PROOF_MAX_KEY_BYTES, doorProof, doorProofValid } from "../frontproxy.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, callerOf } from "./auth.js";
import { CLAIM_LIFE_MS, CLAIM_TRIES, ClaimLinks, RELINK_MAX_LIFE_MS, parseRelink } from "./claimlink.js";
import {
  BROWSER_HEADERS, BoxCodes, DOOR_OP_HEADER, DOOR_PROOF_HEADER, FIRST_RUN_ERR, FIRST_RUN_ROUTE, RELINK_PROOF, RELINK_ROUTE, mintBoxCode, registerFirstRun,
} from "./firstrun.js";

let dir: string;
let chief: string;
let now: number;
let app: FastifyInstance;
let devices: DeviceStore;
let logs: string[];
// Whether a request came in on the front proxy's private listener (the real check: frontproxy.ts).
let viaProxy: boolean;
// The door's token of this console: the key of the door's proof (frontproxy.ts doorProof).
const TOKEN = "t".repeat(43);

const MASTER: AgentRecord = {
  id: "fleet-master", label: "master", repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: "tok-master", status: "idle", createdAt: 1, kind: "fleet-master",
};

const newSecret = (): string => randomBytes(32).toString("base64url");
const hashOf = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const files = () => ({ firstStart: join(chief, "first-start.json"), state: join(chief, "claim-link.json") });
const stateText = () => (existsSync(files().state) ? readFileSync(files().state, "utf8") : "");
function firstStart(secret: string, expiresAt = now + CLAIM_LIFE_MS): void {
  mkdirSync(chief, { recursive: true, mode: 0o700 });
  writeFileSync(files().firstStart, JSON.stringify({ v: 1, server: "srv42", claim: { sha256: hashOf(secret), expiresAt } }), { mode: 0o600 });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "relink-"));
  chief = join(dir, "chief");
  now = 1_795_000_000_000;
  logs = [];
  viaProxy = true;
  devices = new DeviceStore(join(chief, "user-devices.json"), { now: () => now });
  const agents = { load: async (id: string) => (id === MASTER.id ? MASTER : null) };
  app = Fastify();
  registerFirstRun(app, {
    devices, codes: new BoxCodes(join(chief, "pair-code.json"), { now: () => now }),
    links: new ClaimLinks(files(), { now: () => now, log: (s) => logs.push(s) }),
    caller: (req) => callerOf(req.headers, { devices, agents }), pageRoute: "/*",
    fromProxy: () => viaProxy, now: () => now,
    doorProof: (req, message) => doorProofValid(TOKEN, message, req.headers[DOOR_PROOF_HEADER]),
  });
  app.get("/api/agents", async () => ({ agents: [] }));
  app.all("/*", async (req) => ({ page: req.raw.url }));
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const DOOR = { [DOOR_OP_HEADER]: "relink" };
// The door's own call: its proof of this body (when the body has the two fields) and its op.
const proofOf = (payload: unknown): Record<string, string> => {
  const p = payload as { sha256?: unknown; expiresAt?: unknown } | null;
  if (p === null || typeof p !== "object" || typeof p.sha256 !== "string" || typeof p.expiresAt !== "number") return {};
  return { [DOOR_PROOF_HEADER]: doorProof(TOKEN, RELINK_PROOF.make({ sha256: p.sha256, expiresAt: p.expiresAt })) };
};
const relinkRaw = (payload: unknown, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: RELINK_ROUTE, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(payload) });
const relink = (payload: unknown, headers: Record<string, string> = DOOR) => relinkRaw(payload, { ...proofOf(payload), ...headers });
const newLink = (secret: string, expiresAt = now + 3_600_000) => relink({ sha256: hashOf(secret), expiresAt });
const view = async () => (await app.inject({ method: "GET", url: FIRST_RUN_ROUTE })).json();
const READ_PROOF = { [DOOR_PROOF_HEADER]: doorProof(TOKEN, RELINK_PROOF.read) };
const doorRead = (headers: Record<string, string> = DOOR) => app.inject({ method: "GET", url: RELINK_ROUTE, headers: { ...READ_PROOF, ...headers } });
const claim = (secret: string) => app.inject({ method: "POST", url: FIRST_RUN_ROUTE, payload: { claim: secret } });
const answer = (r: { statusCode: number; json: () => unknown }) => [r.statusCode, r.json()];

describe("the shape of a new link", () => {
  it("is exactly {sha256, expiresAt}: 64 lower-case hex, an end time after now and at most 24 hours away", () => {
    const h = hashOf("x");
    expect(RELINK_MAX_LIFE_MS).toBe(CLAIM_LIFE_MS);
    expect(parseRelink({ sha256: h, expiresAt: now + 1 }, now)).toEqual({ sha256: h, expiresAt: now + 1 });
    expect(parseRelink({ expiresAt: now + RELINK_MAX_LIFE_MS, sha256: h }, now)).toEqual({ sha256: h, expiresAt: now + RELINK_MAX_LIFE_MS });
  });

  it("refuses each other shape, and names the field, never its value", () => {
    const h = hashOf("x");
    const bad: [unknown, string][] = [
      [null, "body"], [[], "body"], ["x", "body"], [7, "body"], [{}, "keys"], [{ sha256: h }, "keys"],
      [{ sha256: h, expiresAt: now + 1, hosted: false }, "keys"], [{ sha256: h, expires: now + 1 }, "keys"],
      [{ sha256: h.toUpperCase(), expiresAt: now + 1 }, "sha256"], [{ sha256: h.slice(1), expiresAt: now + 1 }, "sha256"],
      [{ sha256: `${h}0`, expiresAt: now + 1 }, "sha256"], [{ sha256: 1, expiresAt: now + 1 }, "sha256"],
      [{ sha256: h, expiresAt: String(now + 1) }, "expiresAt"], [{ sha256: h, expiresAt: now + 1.5 }, "expiresAt"],
      [{ sha256: h, expiresAt: now }, "expiresAt"], [{ sha256: h, expiresAt: now - 1 }, "expiresAt"],
      [{ sha256: h, expiresAt: Number.MAX_SAFE_INTEGER + 2 }, "expiresAt"],
      [{ sha256: h, expiresAt: now + RELINK_MAX_LIFE_MS + 1 }, "expiresAt is more than 24 hours away"],
    ];
    for (const [body, why] of bad) {
      expect([body, parseRelink(body, now)]).toEqual([body, { refused: why }]);
      expect(why).not.toContain(h);
    }
  });
});

describe("the door's new link", () => {
  it("replaces an open claim: the old link is dead at once, the new one pairs, and its tries start at 0", async () => {
    const old = newSecret();
    firstStart(old);
    expect(await view()).toEqual({ locked: true, link: "open", hosted: true });
    for (let i = 0; i < CLAIM_TRIES - 1; i++) expect((await claim(newSecret())).statusCode).toBe(403);
    const fresh = newSecret();
    const r = await newLink(fresh);
    expect(answer(r)).toEqual([200, { ok: true, expiresAt: now + 3_600_000 }]);
    // Only the hash, for the owner only; the tries start at 0.
    expect(JSON.parse(stateText())).toEqual({ sha256: hashOf(fresh), expiresAt: now + 3_600_000, tries: 0, hosted: true });
    expect(statSync(files().state).mode & 0o777).toBe(0o600);
    expect(r.body).not.toContain(hashOf(fresh));
    // The old link does not pair any more.
    expect(answer(await claim(old))).toEqual([403, { error: FIRST_RUN_ERR.wrongLink }]);
    expect(await view()).toEqual({ locked: true, link: "open", hosted: true });
    const paired = await claim(fresh);
    expect(paired.statusCode).toBe(200);
    expect(await devices.verify(paired.json().token)).not.toBeNull();
    // One use.
    expect((await claim(fresh)).statusCode).toBe(404);
  });

  it("a second new link replaces the first one", async () => {
    const a = newSecret();
    const b = newSecret();
    expect((await newLink(a)).statusCode).toBe(200);
    expect((await newLink(b)).statusCode).toBe(200);
    expect((await claim(a)).statusCode).toBe(403);
    expect((await claim(b)).statusCode).toBe(200);
  });

  it("opens again a console whose link ended: too old, or too many tries", async () => {
    // Too old.
    const old = newSecret();
    firstStart(old, now + 1000);
    now += 1000;
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
    const a = newSecret();
    expect((await newLink(a)).statusCode).toBe(200);
    expect(await view()).toEqual({ locked: true, link: "open", hosted: true });
    // Too many tries.
    for (let i = 0; i < CLAIM_TRIES; i++) await claim(newSecret());
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
    expect(answer(await claim(a))).toEqual([410, { error: FIRST_RUN_ERR.goneLink }]);
    const b = newSecret();
    expect((await newLink(b)).statusCode).toBe(200);
    expect((await claim(b)).statusCode).toBe(200);
  });

  it("a console with no link yet (a refused first-start file) gets one, and the screen says it is hosted", async () => {
    expect(await view()).toEqual({ locked: true, link: "none", hosted: false });
    const s = newSecret();
    expect((await newLink(s)).statusCode).toBe(200);
    expect(await view()).toEqual({ locked: true, link: "open", hosted: true });
    expect((await claim(s)).statusCode).toBe(200);
  });

  it("a first-start file that waits is read first, so it never replaces the new link later", async () => {
    const waiting = newSecret();
    firstStart(waiting);
    const s = newSecret();
    expect((await newLink(s)).statusCode).toBe(200);
    expect(existsSync(files().firstStart)).toBe(false);
    expect((await claim(waiting)).statusCode).toBe(403);
    expect((await claim(s)).statusCode).toBe(200);
  });

  it("stops at its end time", async () => {
    const s = newSecret();
    expect((await newLink(s, now + 5000)).statusCode).toBe(200);
    now += 5000;
    expect(answer(await claim(s))).toEqual([410, { error: FIRST_RUN_ERR.goneLink }]);
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
  });

  it("writes one log line, with the end time and no hash", async () => {
    const s = newSecret();
    await newLink(s);
    expect(logs).toEqual([`[chief] claim link: a new link from the door; it works until ${new Date(now + 3_600_000).toISOString()}`]);
    expect(logs.join("\n")).not.toContain(hashOf(s));
    expect(logs.join("\n")).not.toContain(s);
  });
});

describe("who may make a new link", () => {
  it("only the front proxy's private listener: any other listener gets no such route, and the claim stays", async () => {
    const old = newSecret();
    firstStart(old);
    await view();
    const before = stateText();
    viaProxy = false;
    expect(answer(await newLink(newSecret()))).toEqual([404, { error: "not found" }]);
    expect(stateText()).toBe(before);
    expect(logs.filter((l) => l.includes("new link"))).toEqual([]);
  });

  it("refuses agent headers, also with the secret of a real agent", async () => {
    const heads: Record<string, string>[] = [{ [AGENT_HEADER]: MASTER.id, [AGENT_TOKEN_HEADER]: MASTER.hookToken }, { [AGENT_HEADER]: "x" }, { [AGENT_TOKEN_HEADER]: "x" }];
    for (const h of heads) {
      expect(answer(await relink({ sha256: hashOf("x"), expiresAt: now + 1000 }, { ...DOOR, ...h }))).toEqual([403, { error: FIRST_RUN_ERR.agentHeaders }]);
    }
    expect(stateText()).toBe("");
  });

  it("refuses a request with no door op, and a request that a browser made (Origin, Referer, a cookie, a Sec-Fetch header)", async () => {
    const body = { sha256: hashOf("x"), expiresAt: now + 1000 };
    expect(answer(await relink(body, {}))).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    expect(answer(await relink(body, { [DOOR_OP_HEADER]: "other" }))).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    expect(BROWSER_HEADERS).toEqual(["origin", "referer", "cookie", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"]);
    for (const h of BROWSER_HEADERS) {
      expect(answer(await relink(body, { ...DOOR, [h]: h === "origin" ? "https://s1.example" : "x" })), h).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    }
    expect(stateText()).toBe("");
  });

  it("refuses a bad shape that has the door's proof with the field, and keeps the claim", async () => {
    const old = newSecret();
    firstStart(old);
    await view();
    const before = stateText();
    const shapes = [
      [{ sha256: hashOf("x"), expiresAt: now + 1, more: 1 }, "keys"], [{ sha256: "x", expiresAt: now + 1 }, "sha256"],
      [{ sha256: hashOf("x"), expiresAt: now }, "expiresAt"], [{ sha256: hashOf("x"), expiresAt: now + 1.5 }, "expiresAt"],
      [{ sha256: hashOf("x"), expiresAt: now + RELINK_MAX_LIFE_MS + 1 }, "expiresAt is more than 24 hours away"],
    ] as const;
    for (const [body, field] of shapes) {
      expect(proofOf(body)[DOOR_PROOF_HEADER]).toMatch(/^[0-9a-f]{64}$/);
      expect(answer(await relink(body))).toEqual([400, { error: FIRST_RUN_ERR.badRelink, field }]);
    }
    expect(stateText()).toBe(before);
    expect((await claim(old)).statusCode).toBe(200);
  });

  it("checks the proof before the shape: with no right proof, the same 403 whatever the body (also one that cannot be read), and the claim stays", async () => {
    const old = newSecret();
    firstStart(old);
    await view();
    const before = stateText();
    const good = { sha256: hashOf(newSecret()), expiresAt: now + 3_600_000 };
    const json = (payload: string) => ({ "content-type": "application/json", payload });
    const tries: [string, { "content-type"?: string; payload?: string }, Record<string, string>][] = [
      ["no expiresAt", json(JSON.stringify({ sha256: hashOf("x") })), {}],
      ["a bad hash", json(JSON.stringify({ sha256: "x", expiresAt: now + 1 })), {}],
      ["an end time too far", json(JSON.stringify({ sha256: hashOf("x"), expiresAt: now + RELINK_MAX_LIFE_MS + 1 })), {}],
      ["another key", json(JSON.stringify({ ...good, more: 1 })), {}],
      ["the proof of the good body on another shape", json(JSON.stringify({ ...good, sha256: "x" })), proofOf(good)],
      ["a string", json(JSON.stringify("x")), {}], ["a list", json(JSON.stringify([good])), {}], ["null", json("null"), {}], ["a number", json("42"), {}],
      ["broken JSON", json("{"), {}], ["an empty JSON body", json(""), {}], ["a __proto__ key", json(`{"__proto__":{"x":1},"sha256":"${good.sha256}","expiresAt":${good.expiresAt}}`), {}],
      ["text", { "content-type": "text/plain", payload: JSON.stringify(good) }, {}], ["another content type", { "content-type": "application/xml", payload: "<x/>" }, {}],
      ["no body", {}, {}], ["too large (2 MB)", json(JSON.stringify({ ...good, pad: "x".repeat(2_000_000) })), {}],
    ];
    for (const [why, t, proof] of tries) {
      const { payload, ...type } = t;
      const r = await app.inject({ method: "POST", url: RELINK_ROUTE, headers: { ...type, ...DOOR, ...proof }, ...(payload === undefined ? {} : { payload }) });
      expect([why, answer(r)]).toEqual([why, [403, { error: FIRST_RUN_ERR.doorOnly }]]);
    }
    expect(stateText()).toBe(before);
    expect(logs.filter((l) => l.includes("new link"))).toEqual([]);
    expect((await claim(old)).statusCode).toBe(200);
  });

  it("passes any other error of the route on to the app (a write that fails is a 500, not a 403)", async () => {
    const fail = vi.spyOn(ClaimLinks.prototype, "relink").mockRejectedValueOnce(new Error("disk full"));
    try {
      expect((await newLink(newSecret())).statusCode).toBe(500);
    } finally {
      fail.mockRestore();
    }
  });

  it("refuses after a claim: a device paired by the link", async () => {
    const s = newSecret();
    firstStart(s);
    expect((await claim(s)).statusCode).toBe(200);
    expect(answer(await newLink(newSecret()))).toEqual([409, { error: FIRST_RUN_ERR.claimed }]);
  });

  it("refuses for ever after any pairing: the box code with a link that was too old, then the last device revoked", async () => {
    firstStart(newSecret(), now + 1000);
    now += 1000;
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
    const { code } = await mintBoxCode(join(chief, "pair-code.json"), { now: () => now });
    const paired = await app.inject({ method: "POST", url: FIRST_RUN_ROUTE, payload: { code } });
    expect(paired.statusCode).toBe(200);
    // The link of the console is "used" now, not "expired".
    expect(JSON.parse(stateText())).toEqual({ ended: "used", hosted: true });
    expect((await newLink(newSecret())).statusCode).toBe(409);
    // Locked again: still no new link.
    const [d] = await devices.list();
    expect(await devices.revoke(d.label)).toBe(true);
    expect(await view()).toEqual({ locked: true, link: "ended", hosted: true });
    expect(answer(await newLink(newSecret()))).toEqual([409, { error: FIRST_RUN_ERR.claimed }]);
  });

  it("refuses for ever after a pairing on a console that never had a link", async () => {
    const { code } = await mintBoxCode(join(chief, "pair-code.json"), { now: () => now });
    expect((await app.inject({ method: "POST", url: FIRST_RUN_ROUTE, payload: { code } })).statusCode).toBe(200);
    expect(JSON.parse(stateText())).toEqual({ ended: "used", hosted: false });
    const [d] = await devices.list();
    expect(await devices.revoke(d.label)).toBe(true);
    expect(answer(await newLink(newSecret()))).toEqual([409, { error: FIRST_RUN_ERR.claimed }]);
  });

  it("a first-start file that comes after a pairing is removed unread: no link opens the console again", async () => {
    const s = newSecret();
    firstStart(s);
    expect((await claim(s)).statusCode).toBe(200);
    const [d] = await devices.list();
    expect(await devices.revoke(d.label)).toBe(true);
    const late = newSecret();
    firstStart(late);
    expect(answer(await doorRead())).toEqual([200, { claimed: true }]);
    expect(existsSync(files().firstStart)).toBe(false);
    expect(JSON.parse(stateText())).toEqual({ ended: "used", hosted: true });
    expect((await claim(late)).statusCode).toBe(410);
    firstStart(newSecret());
    expect(answer(await newLink(newSecret()))).toEqual([409, { error: FIRST_RUN_ERR.claimed }]);
    expect(existsSync(files().firstStart)).toBe(false);
    expect(logs.filter((l) => l.includes("first-start file refused (a device was paired"))).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(hashOf(late));
  });

  it("a pairing and a new link at the same time: the new link never opens the paired console", async () => {
    const old = newSecret();
    firstStart(old);
    await view();
    const fresh = newSecret();
    const [c, r] = await Promise.all([claim(old), newLink(fresh)]);
    if (c.statusCode === 200) expect(r.statusCode).toBe(409);
    else expect([c.statusCode, r.statusCode]).toEqual([403, 200]);
    if (c.statusCode === 200) expect((await claim(fresh)).statusCode).toBe(404);
  });

  it("passes the lock only for itself: the rest stays locked", async () => {
    expect((await newLink(newSecret())).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(403);
  });
});

describe("the door's proof: only the door's control path makes it", () => {
  it("is HMAC-SHA256 with the door's token, the same bytes as the door makes (the door's tests hold the same vector)", () => {
    const vector = {
      make: "1845ebd0e939363839e0fdddba195ad9aa9e8b7367341effc033fbe067b3b514",
      read: "c842217bd686e44cbbcdf4aab01e869c1ec7d553c8c64245a20355746d6a0c38",
    };
    expect(doorProof(TOKEN, RELINK_PROOF.make({ sha256: "ab".repeat(32), expiresAt: 1_795_000_000_000 }))).toBe(vector.make);
    expect(doorProof(TOKEN, RELINK_PROOF.read)).toBe(vector.read);
  });

  it("refuses a key longer than 64 bytes: HMAC-SHA256 would use its SHA-256, which is not a secret", () => {
    const m = RELINK_PROOF.read;
    const long = "t".repeat(65);
    // The fault that the limit closes: with such a key, the public hash makes the same proof.
    const byHash = createHmac("sha256", createHash("sha256").update(long, "utf8").digest()).update(m, "utf8").digest("hex");
    expect(byHash).toBe(doorProof(long, m));
    expect(DOOR_PROOF_MAX_KEY_BYTES).toBe(64);
    // 65 and 128 characters (the gate's limit), and 33 characters of 2 bytes each (66 bytes).
    for (const key of [long, "t".repeat(128), "\u00e9".repeat(33)]) {
      expect(doorProofValid(key, m, doorProof(key, m)), `${key.length}`).toBe(false);
    }
    for (const key of ["t".repeat(64), "\u00e9".repeat(32), TOKEN]) {
      expect(doorProofValid(key, m, doorProof(key, m)), `${key.length}`).toBe(true);
    }
  });

  it("refuses a new link with a missing, wrong or other proof (another hash, end time, text or token), and changes nothing", async () => {
    const old = newSecret();
    firstStart(old);
    await view();
    const before = stateText();
    const body = { sha256: hashOf(newSecret()), expiresAt: now + 3_600_000 };
    const other = { sha256: hashOf(newSecret()), expiresAt: body.expiresAt };
    const proofs: [string, Record<string, string>][] = [
      ["missing", {}],
      ["empty", { [DOOR_PROOF_HEADER]: "" }],
      ["not hex", { [DOOR_PROOF_HEADER]: "z".repeat(64) }],
      ["made up", { [DOOR_PROOF_HEADER]: "0".repeat(64) }],
      ["upper case", { [DOOR_PROOF_HEADER]: proofOf(body)[DOOR_PROOF_HEADER].toUpperCase() }],
      ["the proof of another hash (a replay)", proofOf(other)],
      ["the proof of another end time", proofOf({ ...body, expiresAt: body.expiresAt - 1 })],
      ["the read's proof", READ_PROOF],
      ["another token's proof", { [DOOR_PROOF_HEADER]: doorProof("u".repeat(43), RELINK_PROOF.make(body)) }],
      ["the token itself", { [DOOR_PROOF_HEADER]: TOKEN }],
    ];
    for (const [why, proof] of proofs) {
      expect([why, answer(await relinkRaw(body, { ...DOOR, ...proof }))]).toEqual([why, [403, { error: FIRST_RUN_ERR.doorOnly }]]);
    }
    expect(stateText()).toBe(before);
    expect(logs.filter((l) => l.includes("new link"))).toEqual([]);
    expect((await claim(old)).statusCode).toBe(200);
  });

  it("refuses the read with a missing, wrong or other proof", async () => {
    const body = { sha256: hashOf("x"), expiresAt: now + 1000 };
    for (const proof of [{}, { [DOOR_PROOF_HEADER]: "0".repeat(64) }, proofOf(body), { [DOOR_PROOF_HEADER]: doorProof("u".repeat(43), RELINK_PROOF.read) }]) {
      expect(answer(await app.inject({ method: "GET", url: RELINK_ROUTE, headers: { ...DOOR, ...proof } }))).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    }
  });

  it("is never enough alone: with the right proof, no door op, a browser header or another listener is still refused", async () => {
    const body = { sha256: hashOf(newSecret()), expiresAt: now + 3_600_000 };
    expect(answer(await relinkRaw(body, proofOf(body)))).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    expect(answer(await relinkRaw(body, { ...DOOR, ...proofOf(body), origin: "https://s1.example" }))).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    viaProxy = false;
    expect(answer(await relinkRaw(body, { ...DOOR, ...proofOf(body) }))).toEqual([404, { error: "not found" }]);
    expect(stateText()).toBe("");
  });
});

describe("the door's read: may it offer a new link?", () => {
  it("answers {claimed: false} while no device was ever paired, with or without a link, and changes nothing", async () => {
    expect(answer(await doorRead())).toEqual([200, { claimed: false }]);
    const s = newSecret();
    firstStart(s);
    expect(answer(await doorRead())).toEqual([200, { claimed: false }]);
    expect(JSON.parse(stateText())).toMatchObject({ tries: 0, hosted: true });
    const before = stateText();
    expect(answer(await doorRead())).toEqual([200, { claimed: false }]);
    expect(stateText()).toBe(before);
    expect(logs.filter((l) => l.includes("new link"))).toEqual([]);
    expect(logs.join("\n")).not.toContain(hashOf(s));
  });

  it("answers {claimed: true} when a device is paired, and for ever after (the last device revoked)", async () => {
    const s = newSecret();
    firstStart(s);
    expect((await claim(s)).statusCode).toBe(200);
    expect(answer(await doorRead())).toEqual([200, { claimed: true }]);
    const [d] = await devices.list();
    expect(await devices.revoke(d.label)).toBe(true);
    expect(await view()).toMatchObject({ locked: true });
    expect(answer(await doorRead())).toEqual([200, { claimed: true }]);
  });

  it("has the checks of the new link: the listener, agent headers, the door op, a browser", async () => {
    viaProxy = false;
    expect(answer(await doorRead())).toEqual([404, { error: "not found" }]);
    viaProxy = true;
    expect(answer(await doorRead({ ...DOOR, [AGENT_HEADER]: MASTER.id, [AGENT_TOKEN_HEADER]: MASTER.hookToken }))).toEqual([403, { error: FIRST_RUN_ERR.agentHeaders }]);
    expect(answer(await doorRead({}))).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
    for (const h of BROWSER_HEADERS) expect(answer(await doorRead({ ...DOOR, [h]: "x" })), h).toEqual([403, { error: FIRST_RUN_ERR.doorOnly }]);
  });
});
