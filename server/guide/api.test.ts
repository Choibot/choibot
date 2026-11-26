// server/guide/api.test.ts — the routes of the guide: for the paired user only; none of them
// runs an action of a step; and an install with the old names has no guide at all.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { newInstall } from "../chief/firstrun.js";
import { CHIEF_ERR, makeGate } from "../chief/gate.js";
import { NEEDS_PAIRING, registerSetupActions } from "../setup/actions.js";
import type { LoginState } from "../setup/ghlogin.js";
import { guideDir, guideOn, registerGuideApi } from "./api.js";
import { Guide } from "./guide.js";
import { BOX_DONE, FAKE, fakeModel, list } from "./testkit.js";
import type { GuideView } from "./types.js";

const USER = "user-token";
const HOOK = "hook-token";
type H = Record<string, string>;
const user: H = { [USER_HEADER]: USER };
const agent = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK });

const ROUTES: [method: "GET" | "POST", url: string, body?: object][] = [
  ["GET", "/api/guide"],
  ["POST", "/api/guide/sync", {}],
  ["POST", "/api/guide/message", { text: "start the first agent now" }],
  ["POST", "/api/guide/stopped", { secret: "telegram" }],
];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "guide-api-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// The guide and the actions of the Set-up page in one console, as server/index.ts wires them.
function app(o: { gate?: boolean; guide?: boolean; answers?: string[] } = {}) {
  const a = Fastify();
  const did: string[] = [];
  const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
    ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
  const gate = o.gate === false ? undefined : makeGate({
    misconfigured: null, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
  });
  let state: LoginState = { state: "idle" };
  const VIEW = { task: "t", repo: "shop", repos: ["shop"], agent: null, ticket: null, now: 2 };
  registerSetupActions(a, {
    gate,
    login: { state: () => state, start: async () => { did.push("login"); state = { state: "waiting", code: "7F2A-9C41", url: "https://github.com/login/device", expiresAt: 5 }; return state; }, stop: () => {} } as never,
    repos: { page: async () => ({ repos: [] }), cloneState: () => ({ state: "idle" }), clone: async () => { did.push("clone"); return { state: "done", repo: "acme/shop" }; }, forget: () => {} } as never,
    first: { view: async () => VIEW, start: async () => { did.push("first"); return { ok: true, view: VIEW }; } } as never,
    commitName: undefined,
    changed: () => { did.push("changed"); },
    log: () => {},
  });
  const model = fakeModel(o.answers);
  const logs: string[] = [];
  if (o.guide !== false) {
    registerGuideApi(a, { gate, guide: new Guide({
      dir: guideDir(dir),
      steps: async () => list(BOX_DONE),
      facts: async () => ({ login: state, clone: { state: "idle" }, first: VIEW }),
      model, log: (s) => logs.push(s),
    }) });
  }
  const call = (method: "GET" | "POST", url: string, headers: H, body?: object) => a.inject({ method, url, headers, payload: body });
  const settle = async (): Promise<GuideView> => {
    for (let n = 0; n < 200; n++) {
      const v = (await call("GET", "/api/guide", user)).json() as GuideView;
      if (!v.busy) return v;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("the turn did not end");
  };
  return { a, did, model, logs, call, settle };
}

describe("rule 5 and the gate: the guide is for the paired user only", () => {
  it("refuses an agent, a lead, the fleet master and a caller with no pairing on every route", async () => {
    const t = app();
    for (const [method, url, body] of ROUTES) {
      for (const headers of [agent("w1"), agent("lead-app"), agent("fleet-master"), {}, { [USER_HEADER]: "wrong" }]) {
        const r = await t.call(method, url, headers, body);
        expect(r.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(403);
        expect(r.json().error).toBe(CHIEF_ERR.pairRequired);
      }
    }
    // Nothing happened: no thread, no model, no action.
    expect(existsSync(guideDir(dir))).toBe(false);
    expect(t.model.calls).toHaveLength(0);
    expect(t.did).toEqual([]);
  });

  it("answers 403 on a console with no device pairing", async () => {
    const t = app({ gate: false });
    for (const [method, url, body] of ROUTES) {
      const r = await t.call(method, url, user, body);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual(NEEDS_PAIRING);
    }
  });

  it("the guide proposes with a card; the action runs only on the user's own request to the action route", async () => {
    const t = app({ answers: ["I start it for you now. It is started.\n[card agent]\n[start agent]\n[card github]"] });
    await t.call("POST", "/api/guide/sync", user, {});
    expect((await t.call("POST", "/api/guide/message", user, { text: "start the first agent and connect github for me" })).statusCode).toBe(202);
    const v = await t.settle();
    expect(v.items.filter((i) => i.kind === "card").map((i) => (i.kind === "card" ? i.step : ""))).toEqual(["github", "agent", "github"]);
    // The guide said "started". Nothing started: no route of the guide reaches an action.
    expect(t.did).toEqual([]);
    // The press on the card is the route of the button of the row, with the same gate.
    expect((await t.call("POST", "/api/setup/first", agent("w1"), {})).statusCode).toBe(403);
    expect((await t.call("POST", "/api/setup/first", agent("fleet-master"), {})).statusCode).toBe(403);
    expect((await t.call("POST", "/api/setup/github/login", agent("lead-app"), {})).statusCode).toBe(403);
    expect(t.did).toEqual([]);
    expect((await t.call("POST", "/api/setup/first", user, {})).statusCode).toBe(200);
    expect((await t.call("POST", "/api/setup/github/login", user, {})).statusCode).toBe(200);
    expect(t.did).toEqual(["first", "login"]);
  });
});

describe("the routes", () => {
  it("GET gives the thread; sync writes the welcome; a message starts one turn", async () => {
    const t = app({ answers: ["A ticket is a decision that waits for you."] });
    expect((await t.call("GET", "/api/guide", user)).json()).toEqual({ items: [], busy: false });
    const synced = (await t.call("POST", "/api/guide/sync", user, {})).json() as GuideView;
    expect(synced.items.map((i) => i.kind)).toEqual(["guide", "guide", "card"]);
    const r = await t.call("POST", "/api/guide/message", user, { text: "what is a ticket?" });
    expect(r.statusCode).toBe(202);
    const v = await t.settle();
    expect(v.items.slice(-2)).toMatchObject([{ kind: "user", text: "what is a ticket?" }, { kind: "guide", text: "A ticket is a decision that waits for you." }]);
  });

  it("stops a secret with 422: the answer names the kind and the place, never the text", async () => {
    const t = app();
    const r = await t.call("POST", "/api/guide/message", user, { text: `the token is ${FAKE.telegram}` });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ secret: "telegram", step: "telegram", error: expect.stringMatching(/was not sent.*Telegram bot token.*not stored/) });
    expect(r.body).not.toContain(FAKE.telegram.slice(0, 14));
    expect(t.model.calls).toHaveLength(0);
    expect(readFileSync(join(guideDir(dir), "thread.jsonl"), "utf8") + t.logs.join("\n")).not.toContain(FAKE.telegram.slice(0, 14));
  });

  it("takes the kind of a secret the chat box stopped, and nothing of its text", async () => {
    const t = app();
    const r = await t.call("POST", "/api/guide/stopped", user, { secret: "telegram", text: FAKE.telegram });
    expect(r.statusCode).toBe(200);
    expect((r.json() as GuideView).items).toMatchObject([{ kind: "stopped", secret: "telegram" }, { kind: "card", step: "telegram" }]);
    expect((await t.call("POST", "/api/guide/stopped", user, { secret: "github" })).json().items).toHaveLength(3);
    for (const bad of [{ secret: "nothing" }, { secret: FAKE.telegram }, { secret: "__proto__" }, {}]) expect((await t.call("POST", "/api/guide/stopped", user, bad)).statusCode).toBe(400);
    expect(readFileSync(join(guideDir(dir), "thread.jsonl"), "utf8") + t.logs.join("\n")).not.toContain(FAKE.telegram.slice(0, 14));
    expect(t.model.calls).toHaveLength(0);
  });

  it("answers a plain line for a message it cannot take", async () => {
    const t = app();
    expect((await t.call("POST", "/api/guide/message", user, {})).json().error).toBe("Write a message first.");
    expect((await t.call("POST", "/api/guide/message", user, { text: 7 })).statusCode).toBe(400);
    expect((await t.call("POST", "/api/guide/message", user, { text: "x".repeat(2001) })).json().error).toMatch(/too long/);
    let free = () => {};
    t.model.hold = new Promise<void>((r) => { free = r; });
    expect((await t.call("POST", "/api/guide/message", user, { text: "one" })).statusCode).toBe(202);
    const busy = await t.call("POST", "/api/guide/message", user, { text: "two" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("The guide writes now. Wait a moment.");
    free();
    await t.settle();
  });
});

describe("the owner's console: an install with the old names has no guide", () => {
  it("guideOn is false for the old names, and for a console with no pairing", () => {
    const gate = {};
    expect(guideOn({ newInstall: newInstall({ legacy: true }), gate })).toBe(false);
    expect(guideOn({ newInstall: newInstall({ legacy: false }), gate })).toBe(true);
    expect(guideOn({ newInstall: true, gate: undefined })).toBe(false);
  });

  it("with no guide registered every route is 404, and nothing is made", async () => {
    const t = app({ guide: false });
    for (const [method, url, body] of ROUTES) expect((await t.call(method, url, user, body)).statusCode).toBe(404);
    expect(existsSync(guideDir(dir))).toBe(false);
    expect(t.model.calls).toHaveLength(0);
  });

  it("the server makes the guide only behind guideOn, and the guide touches no prompt of an agent", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const index = readFileSync(join(root, "index.ts"), "utf8");
    // One place makes a Guide and registers its routes: inside the `if (guideOn(…))` block.
    expect(index.match(/new Guide\(/g)).toHaveLength(1);
    expect(index.match(/registerGuideApi\(/g)).toHaveLength(1);
    const block = index.slice(index.indexOf("if (guideOn({ newInstall: newInstall(), gate: chief?.gate })) {"));
    expect(block.indexOf("registerGuideApi(")).toBeGreaterThan(0);
    expect(block.indexOf("registerGuideApi(")).toBeLessThan(block.indexOf("\n  }\n"));
    // No file of the fleet master, of the leads or of the agents' prompts knows the guide.
    for (const f of ["master/prompt.ts", "master/master.ts", "chief/leads/prompt.ts", "agents/argv.ts", "agents/recovery.ts"]) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/guide/i);
    }
  });
});
