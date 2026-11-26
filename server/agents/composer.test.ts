import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { ComposerGate, registerComposerApi, DEDUP_KEEP, MAX_TEXT, type ComposerCapture, type ComposerDeps } from "./composer.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";
import { captureUserLine, composerLineOf, type CaptureDeps } from "../chief/brain/capture.js";
import { DecisionLog, RuleStore, type Rule } from "../chief/brain/store.js";

function fakeTerms(o: { live?: boolean; session?: boolean; ready?: boolean; ids?: string[] } = {}) {
  const live = new Set<string>(o.live ? (o.ids ?? ["a1"]) : []);
  const writes: string[] = [];
  const state = { ready: o.ready ?? true, reattached: 0 };
  return {
    writes, state,
    has: (id: string) => live.has(id),
    hasSession: async (id: string) => live.has(id) || !!o.session,
    reattach: async (id: string) => { if (o.session) { state.reattached++; live.add(id); } return null; },
    write: (_id: string, d: string) => { writes.push(d); },
    inputReady: (id: string) => live.has(id) && state.ready,
  };
}

function setup(o: {
  terms?: ReturnType<typeof fakeTerms>; exists?: boolean; onTyped?: ComposerDeps["onTyped"]; resumeClosed?: ComposerDeps["resumeClosed"];
  onUserLine?: ComposerDeps["onUserLine"];
} = {}) {
  const terms = o.terms ?? fakeTerms({ live: true });
  const gate = new ComposerGate({
    terminals: terms, agentExists: async () => o.exists ?? true,
    onTyped: o.onTyped, onUserLine: o.onUserLine, resumeClosed: o.resumeClosed, sleep: async () => {},
  });
  return { terms, gate };
}

const msg = (msgId: string, text = "hello") => ({ msgId, text });

describe("ComposerGate.input", () => {
  it("types one bracketed paste and Enter, multi-line kept", async () => {
    const { gate, terms } = setup();
    const r = await gate.input("a1", msg("msg-00001", "line one\nline two"));
    expect(r).toEqual({ code: 200, body: { delivered: true } });
    expect(terms.writes).toEqual(["\x1b[200~line one\nline two\x1b[201~", "\r"]);
  });

  it("a dialog on the agent's screen: nothing is typed, the answer is 409 starting, and the line can go later", async () => {
    const dialog = { on: true };
    const terms = { ...fakeTerms({ live: true }), dialogOn: async () => dialog.on };
    const { gate } = setup({ terms });
    expect(await gate.input("a1", msg("msg-00009"))).toEqual({ code: 409, body: { reason: "starting", dialog: true } });
    expect(terms.writes).toEqual([]);
    dialog.on = false;
    expect(await gate.input("a1", msg("msg-00009"))).toEqual({ code: 200, body: { delivered: true } });
  });

  it("a dialog at the start of the session (the input box is not up yet): the same answer, not a plain `starting`", async () => {
    const terms = { ...fakeTerms({ live: true, ready: false }), dialogOn: async () => true };
    const { gate } = setup({ terms });
    expect(await gate.input("a1", msg("msg-00010"))).toEqual({ code: 409, body: { reason: "starting", dialog: true } });
    const plain = setup({ terms: fakeTerms({ live: true, ready: false }) });
    expect(await plain.gate.input("a1", msg("msg-00011"))).toEqual({ code: 409, body: { reason: "starting" } });
  });

  it("says that the agent was busy, asked before the line is typed", async () => {
    const terms = fakeTerms({ live: true });
    const order: string[] = [];
    const write = terms.write.bind(terms);
    terms.write = (id: string, data: string) => { order.push("write"); write(id, data); };
    let running = true;
    const gate = new ComposerGate({
      terminals: terms, agentExists: async () => true, sleep: async () => {},
      isBusy: async () => { order.push("asked"); return running; },
    });
    expect(await gate.input("a1", msg("msg-00001"))).toEqual({ code: 200, body: { delivered: true, busy: true } });
    expect(order[0]).toBe("asked");
    running = false;
    expect(await gate.input("a1", msg("msg-00002"))).toEqual({ code: 200, body: { delivered: true } });
    // A line the console types itself (a queue answer) has no such word, and a failed question is "not busy".
    running = true;
    expect(await gate.inputInternal("a1", msg("msg-00003"))).toEqual({ code: 200, body: { delivered: true } });
    const broken = new ComposerGate({ terminals: fakeTerms({ live: true }), agentExists: async () => true, sleep: async () => {}, isBusy: async () => { throw new Error("store"); } });
    expect(await broken.input("a1", msg("msg-00004"))).toEqual({ code: 200, body: { delivered: true } });
  });

  it("rejects a bad msgId, empty text and text over the limit", async () => {
    const { gate, terms } = setup();
    expect((await gate.input("a1", { msgId: "x", text: "hi" })).code).toBe(400);
    expect((await gate.input("a1", { msgId: "../../etc", text: "hi" })).code).toBe(400);
    expect((await gate.input("a1", msg("msg-00001", "  \n "))).code).toBe(400);
    expect((await gate.input("a1", msg("msg-00001", "x".repeat(MAX_TEXT + 1)))).code).toBe(400);
    expect((await gate.input("a1", null)).code).toBe(400);
    expect(terms.writes).toEqual([]);
  });

  it("404 agent-gone for an unknown agent", async () => {
    const { gate } = setup({ exists: false });
    expect(await gate.input("a1", msg("msg-00001"))).toEqual({ code: 404, body: { reason: "agent-gone" } });
  });

  it("409 not-live when there is no session", async () => {
    const { gate, terms } = setup({ terms: fakeTerms() });
    expect(await gate.input("a1", msg("msg-00001"))).toEqual({ code: 409, body: { reason: "not-live" } });
    expect(terms.writes).toEqual([]);
  });

  it("reattaches a surviving session and counts it ready", async () => {
    const { gate, terms } = setup({ terms: fakeTerms({ session: true, ready: false }) });
    expect((await gate.input("a1", msg("msg-00001"))).code).toBe(200);
    expect(terms.state.reattached).toBe(1);
    expect(terms.writes).toHaveLength(2);
  });

  it("a PTY spawned here waits until its TUI takes a paste", async () => {
    const terms = fakeTerms({ live: true, ready: false });
    const { gate } = setup({ terms });
    expect(await gate.input("a1", msg("msg-00001"))).toEqual({ code: 409, body: { reason: "starting" } });
    expect(terms.writes).toEqual([]);
    terms.state.ready = true;
    expect((await gate.input("a1", msg("msg-00001"))).code).toBe(200);
  });

  it("resumes a stopped closed agent with the text as its first turn", async () => {
    const calls: [string, string][] = [];
    const { gate, terms } = setup({ terms: fakeTerms(), resumeClosed: async (id, text) => { calls.push([id, text]); return true; } });
    expect(await gate.input("a1", msg("msg-00001", "go on"))).toEqual({ code: 200, body: { delivered: true } });
    expect(await gate.input("a1", msg("msg-00001", "go on"))).toEqual({ code: 200, body: { delivered: true, duplicate: true } });
    expect(calls).toEqual([["a1", "go on"]]);
    expect(terms.writes).toEqual([]);
  });

  it("not-live when the agent is stopped and not closed", async () => {
    const { gate } = setup({ terms: fakeTerms(), resumeClosed: async () => false });
    expect(await gate.input("a1", msg("msg-00001"))).toEqual({ code: 409, body: { reason: "not-live" } });
  });

  it("types a msgId once, also for two concurrent requests", async () => {
    const { gate, terms } = setup();
    const [a, b] = await Promise.all([gate.input("a1", msg("msg-00001")), gate.input("a1", msg("msg-00001"))]);
    expect(a).toEqual({ code: 200, body: { delivered: true } });
    expect(b).toEqual({ code: 200, body: { delivered: true, duplicate: true } });
    expect((await gate.input("a1", msg("msg-00001"))).body).toEqual({ delivered: true, duplicate: true });
    expect(terms.writes).toHaveLength(2);
  });

  it("does not record a msgId that was not typed", async () => {
    const terms = fakeTerms();
    const { gate } = setup({ terms });
    expect((await gate.input("a1", msg("msg-00001"))).code).toBe(409);
    terms.has = () => true;
    terms.inputReady = () => true;
    expect(await gate.input("a1", msg("msg-00001"))).toEqual({ code: 200, body: { delivered: true } });
  });

  it("keeps a bounded dedup window", async () => {
    const { gate, terms } = setup();
    for (let i = 0; i <= DEDUP_KEEP; i++) await gate.input("a1", msg(`msg-${String(i).padStart(5, "0")}`));
    terms.writes.length = 0;
    await gate.input("a1", msg("msg-00000")); // fell out of the window
    expect(terms.writes).toHaveLength(2);
  });

  it("feeds the typed bytes to onTyped before the paste", async () => {
    const order: string[] = [];
    const terms = fakeTerms({ live: true });
    const write = terms.write;
    terms.write = (id, d) => { order.push("write"); write(id, d); };
    const { gate } = setup({ terms, onTyped: (_id, data) => order.push(`typed:${JSON.stringify(data)}`) });
    await gate.input("a1", msg("msg-00001", "hi"));
    expect(order).toEqual([`typed:${JSON.stringify("\x1b[200~hi\x1b[201~\r")}`, "write", "write"]);
  });
});

// The master's quiet policy (server/master/quiet.ts): only the user's own composer line is "the user typed to this agent".
describe("ComposerGate onUserLine", () => {
  it("fires for a composer line, also one that resumes a closed agent", async () => {
    const users: string[] = [];
    const { gate } = setup({ onUserLine: (id) => users.push(id) });
    await gate.input("a1", msg("msg-00001"));
    expect(users).toEqual(["a1"]);
    const closed = setup({ terms: fakeTerms(), resumeClosed: async () => true, onUserLine: (id) => users.push(id) });
    expect((await closed.gate.input("a2", msg("msg-00002"))).code).toBe(200);
    expect(users).toEqual(["a1", "a2"]);
  });
  it("never fires for inputInternal (a queue answer, a reminder), a duplicate or a line that is not delivered", async () => {
    const users: string[] = [];
    const typed: string[] = [];
    const { gate } = setup({ onUserLine: (id) => users.push(id), onTyped: (id) => typed.push(id) });
    expect((await gate.inputInternal("a1", msg("msg-00001", "[queue q0000000a] B"))).code).toBe(200);
    expect(typed).toEqual(["a1"]); // the inbox tracker still sees the bytes, as before
    expect(users).toEqual([]);
    await gate.input("a1", msg("msg-00001", "[queue q0000000a] B")); // the same msgId: a duplicate
    expect(users).toEqual([]);
    const dead = setup({ terms: fakeTerms(), onUserLine: (id) => users.push(id) });
    expect((await dead.gate.input("a1", msg("msg-00003"))).code).toBe(409);
    expect(users).toEqual([]);
  });
});

describe("POST /api/agents/:id/input", () => {
  it("maps the gate result to the reply", async () => {
    const { gate } = setup({ terms: fakeTerms() });
    const app = Fastify();
    registerComposerApi(app, gate);
    const r = await app.inject({ method: "POST", url: "/api/agents/a1/input", payload: msg("msg-00001") });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ reason: "not-live" });
  });
});

// Spec §6.2 source 2: a delivered, non-duplicate composer line of a USER
// caller goes to brain/decisions.jsonl; a `rule:` line also makes a candidate.
describe("POST /api/agents/:id/input with capture (chief)", () => {
  const PR = "https://github.com/acme/choibot/pull/7";
  const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
    id, label: id, repo: "/ws/choibot", worktree: "/w", branch: "agent/x", baseBranch: "main",
    sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
  });

  let dir: string;
  let app: FastifyInstance;
  let terms: ReturnType<typeof fakeTerms>;
  let decisions: DecisionLog;
  let rules: RuleStore;
  let cards: Rule[];
  let logs: string[];
  let captureDeps: CaptureDeps;
  let capture: ComposerCapture;
  let user: Record<string, string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "composer-capture-"));
    const agents = new SessionStore(join(dir, "agents"));
    await agents.save(rec("a1", { prUrl: PR }));
    await agents.save(rec("a2"));
    await agents.save(rec("fleet-master", { kind: "fleet-master", repo: "" }));
    const devices = new DeviceStore(join(dir, "user-devices.json"));
    user = { [USER_HEADER]: await devices.add("laptop") };
    const chiefGate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents } });
    decisions = new DecisionLog(join(dir, "decisions.jsonl"));
    rules = new RuleStore(join(dir, "rules.jsonl"));
    cards = [];
    logs = [];
    captureDeps = { decisions, rules, onCandidate: async (r) => { cards.push(r); }, log: (s) => logs.push(s) };
    capture = {
      isUser: async (req) => (await chiefGate.caller(req)).level === "user",
      lineFor: (id) => composerLineOf(agents, id),
      capture: (line) => captureUserLine(captureDeps, line),
    };
    terms = fakeTerms({ live: true, ids: ["a1", "a2", "fleet-master"] });
    app = Fastify();
    registerComposerApi(app, new ComposerGate({ terminals: terms, agentExists: async () => true, sleep: async () => {} }), capture);
  });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

  const post = (id: string, body: unknown, headers: Record<string, string> = user) =>
    app.inject({ method: "POST", url: `/api/agents/${id}/input`, payload: body as object, headers });
  const lines = async () => (await decisions.read()).map(({ at: _at, ...rest }) => rest);

  it("a USER worker line → one composer line with the record's prUrl and repo", async () => {
    const r = await post("a1", msg("msg-00001", "use pnpm here"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true });
    expect(await lines()).toEqual([
      { by: "user", correction: null, via: "composer", agentId: "a1", prUrl: PR, repo: "choibot", text: "use pnpm here" },
    ]);
    const r2 = await post("a2", msg("msg-00002", "and here"));
    expect(r2.json()).toEqual({ delivered: true });
    expect((await lines())[1]).toEqual({ by: "user", correction: null, via: "composer", agentId: "a2", repo: "choibot", text: "and here" });
  });

  it("a USER fleet-master line → via master-tab", async () => {
    expect((await post("fleet-master", msg("msg-00001", "merge it"))).json()).toEqual({ delivered: true });
    expect(await lines()).toEqual([
      { by: "user", correction: null, via: "master-tab", agentId: "fleet-master", repo: "workspace", text: "merge it" },
    ]);
  });

  it("a headerless or agent line is delivered unchanged and neither logged nor a candidate", async () => {
    const a = await post("a1", msg("msg-00001", "rule: always run tests"), {});
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ delivered: true });
    const b = await post("a1", msg("msg-00002", "rule: never push"), { [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "tok-a1" });
    expect(b.json()).toEqual({ delivered: true });
    const c = await post("a1", msg("msg-00003", "rule: bad token"), { [USER_HEADER]: "not-a-token" });
    expect(c.json()).toEqual({ delivered: true });
    expect(terms.writes).toEqual([
      "\x1b[200~rule: always run tests\x1b[201~", "\r",
      "\x1b[200~rule: never push\x1b[201~", "\r",
      "\x1b[200~rule: bad token\x1b[201~", "\r",
    ]);
    expect(await decisions.read()).toEqual([]);
    expect(await rules.all()).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("a duplicate msgId is logged once", async () => {
    expect((await post("a1", msg("msg-00001", "once"))).json()).toEqual({ delivered: true });
    expect((await post("a1", msg("msg-00001", "once"))).json()).toEqual({ delivered: true, duplicate: true });
    expect(await lines()).toHaveLength(1);
  });

  it("a line that is not delivered is not logged", async () => {
    expect((await post("gone", msg("msg-00001", "hello"))).statusCode).toBe(409);
    expect(await decisions.read()).toEqual([]);
  });

  it("rule: always run tests → user-line candidate, onCandidate called, line typed unchanged", async () => {
    const r = await post("a1", msg("msg-00001", "rule: always run tests"));
    expect(r.json()).toEqual({ delivered: true });
    expect(terms.writes).toEqual(["\x1b[200~rule: always run tests\x1b[201~", "\r"]);
    const all = await rules.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      text: "always run tests", state: "candidate", kind: "preference", scope: { area: "*", audience: "all" },
      source: { origin: "user-line", via: "composer", agentId: "a1", prUrl: PR },
    });
    await vi.waitFor(() => expect(cards.map((c) => c.id)).toEqual([all[0]!.id]));
    expect((await lines())[0]!.text).toBe("rule: always run tests");
  });

  it("an onCandidate that never resolves does not delay the 200", async () => {
    captureDeps.onCandidate = () => new Promise<void>(() => {});
    const r = await post("a1", msg("msg-00001", "rule: always run tests"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true });
    expect(await rules.all()).toHaveLength(1);
  });

  it("a duplicate rule: → hint in the 200 body, line still typed", async () => {
    await post("a1", msg("msg-00001", "rule: always run tests"));
    const [first] = await rules.all();
    terms.writes.length = 0;
    const r = await post("fleet-master", msg("msg-00002", "RULE: Always run tests."));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true, hint: `Already a rule (${first!.id}).` });
    expect(first!.id).toMatch(/^r_[0-9a-z]{5}$/);
    expect(terms.writes).toEqual(["\x1b[200~RULE: Always run tests.\x1b[201~", "\r"]);
    expect(await rules.all()).toHaveLength(1);
  });

  it("Review Focus 4: rule: alone → no candidate, line delivered and logged", async () => {
    const r = await post("a1", msg("msg-00001", "rule:"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true });
    expect(terms.writes).toEqual(["\x1b[200~rule:\x1b[201~", "\r"]);
    expect(await rules.all()).toEqual([]);
    expect(cards).toEqual([]);
    expect(await lines()).toHaveLength(1);
  });

  it("a throwing decisions.append → still 200 delivered, error logged", async () => {
    vi.spyOn(decisions, "append").mockRejectedValue(new Error("disk full"));
    const r = await post("a1", msg("msg-00001", "hello"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true });
    expect(terms.writes).toHaveLength(2);
    expect(logs.join("\n")).toContain("disk full");
  });

  it("a throwing isUser, lineFor or capture → still 200 delivered, no hint, error logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    capture.isUser = async () => { throw new Error("verify broke"); };
    expect((await post("a1", msg("msg-00001"))).json()).toEqual({ delivered: true });
    capture.isUser = async () => true;
    capture.lineFor = async () => { throw new Error("load broke"); };
    expect((await post("a1", msg("msg-00002"))).json()).toEqual({ delivered: true });
    capture.lineFor = async () => ({ via: "composer" });
    capture.capture = () => { throw new Error("capture broke"); };
    const r = await post("a1", msg("msg-00003"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true });
    expect(terms.writes).toHaveLength(6);
    const out = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const m of ["verify broke", "load broke", "capture broke"]) expect(out).toContain(m);
    warn.mockRestore();
  });

  it("flag off (no capture): same status, same body, no decision line", async () => {
    const off = Fastify();
    const offTerms = fakeTerms({ live: true });
    registerComposerApi(off, new ComposerGate({ terminals: offTerms, agentExists: async () => true, sleep: async () => {} }));
    for (const text of ["hello", "rule: always run tests"]) {
      const id = text === "hello" ? "msg-00001" : "msg-00002";
      const r = await off.inject({ method: "POST", url: "/api/agents/a1/input", payload: msg(id, text), headers: user });
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(JSON.stringify({ delivered: true }));
    }
    const dup = await off.inject({ method: "POST", url: "/api/agents/a1/input", payload: msg("msg-00001"), headers: user });
    expect(dup.body).toBe(JSON.stringify({ delivered: true, duplicate: true }));
    expect(existsSync(join(dir, "decisions.jsonl"))).toBe(false);
    expect(await rules.all()).toEqual([]);
    await off.close();
  });
});

describe("ComposerGate.inputInternal", () => {
  it("types the paste and Enter like input", async () => {
    const { gate, terms } = setup();
    const r = await gate.inputInternal("a1", msg("q7k2m9x1a-1", "[queue q7k2m9x1a] choice: B (X)"));
    expect(r).toEqual({ code: 200, body: { delivered: true } });
    expect(terms.writes).toEqual(["\x1b[200~[queue q7k2m9x1a] choice: B (X)\x1b[201~", "\r"]);
  });

  it("never reaches the route capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "composer-internal-"));
    const app = Fastify();
    const capture = { isUser: vi.fn(async () => true), lineFor: vi.fn(async () => ({ via: "composer" as const })), capture: vi.fn(async () => ({})) };
    const gate = new ComposerGate({ terminals: fakeTerms({ live: true }), agentExists: async () => true, sleep: async () => {} });
    registerComposerApi(app, gate, capture);
    try {
      expect((await gate.inputInternal("a1", msg("q7k2m9x1a-1"))).code).toBe(200);
      expect(capture.isUser).not.toHaveBeenCalled();
      expect(capture.lineFor).not.toHaveBeenCalled();
      expect(capture.capture).not.toHaveBeenCalled();
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("shares dedup with input; -1 and -w1 are distinct", async () => {
    const { gate, terms } = setup();
    expect((await gate.input("a1", msg("q7k2m9x1a-1"))).code).toBe(200);
    expect(await gate.inputInternal("a1", msg("q7k2m9x1a-1"))).toEqual({ code: 200, body: { delivered: true, duplicate: true } });
    expect(await gate.inputInternal("a1", msg("q7k2m9x1a-w1"))).toEqual({ code: 200, body: { delivered: true } });
    expect(terms.writes).toHaveLength(4);
  });

  it("validates like input", async () => {
    const { gate } = setup();
    expect((await gate.inputInternal("a1", { msgId: "x", text: "hi" })).code).toBe(400);
    expect((await gate.inputInternal("a1", msg("q7k2m9x1a-1", " "))).code).toBe(400);
    expect((await gate.inputInternal("a1", msg("q7k2m9x1a-1", "x".repeat(MAX_TEXT + 1)))).code).toBe(400);
  });

  it("409 starting, 409 not-live, 404 agent-gone", async () => {
    const a = setup({ terms: fakeTerms({ live: true, ready: false }) });
    expect(await a.gate.inputInternal("a1", msg("q7k2m9x1a-1"))).toEqual({ code: 409, body: { reason: "starting" } });
    const b = setup({ terms: fakeTerms() });
    expect(await b.gate.inputInternal("a1", msg("q7k2m9x1a-1"))).toEqual({ code: 409, body: { reason: "not-live" } });
    const c = setup({ exists: false });
    expect(await c.gate.inputInternal("a1", msg("q7k2m9x1a-1"))).toEqual({ code: 404, body: { reason: "agent-gone" } });
  });

  it("resumes a closed agent", async () => {
    const resumeClosed = vi.fn(async () => true);
    const { gate } = setup({ terms: fakeTerms(), resumeClosed });
    expect(await gate.inputInternal("a1", msg("q7k2m9x1a-1", "hi"))).toEqual({ code: 200, body: { delivered: true } });
    expect(resumeClosed).toHaveBeenCalledWith("a1", "hi");
  });

  // The reminder deliverer's two options; the queue Deliverer passes neither.
  it("noResume: a stopped closed agent is not-live, never resumed with the line", async () => {
    const resumeClosed = vi.fn(async () => true);
    const { gate } = setup({ terms: fakeTerms(), resumeClosed });
    expect(await gate.inputInternal("a1", msg("r_aaaaaaa1"), { noResume: true })).toEqual({ code: 409, body: { reason: "not-live" } });
    expect(resumeClosed).not.toHaveBeenCalled();
  });

  it("hold: checked inside the typing lock on a ready PTY; true answers 409 busy and types nothing", async () => {
    const { gate, terms } = setup();
    let busy = true;
    const hold = vi.fn(async () => busy);
    expect(await gate.inputInternal("a1", msg("r_aaaaaaa1"), { hold })).toEqual({ code: 409, body: { reason: "busy" } });
    expect(terms.writes).toEqual([]);
    busy = false;
    expect(await gate.inputInternal("a1", msg("r_aaaaaaa1"), { hold })).toEqual({ code: 200, body: { delivered: true } });
    expect(hold).toHaveBeenCalledTimes(2);
    // A delivered msgId is a duplicate before any hold check.
    busy = true;
    expect(await gate.inputInternal("a1", msg("r_aaaaaaa1"), { hold })).toEqual({ code: 200, body: { delivered: true, duplicate: true } });
  });

  it("hold is not asked while the PTY is starting", async () => {
    const { gate } = setup({ terms: fakeTerms({ live: true, ready: false }) });
    const hold = vi.fn(async () => false);
    expect(await gate.inputInternal("a1", msg("r_aaaaaaa1"), { hold })).toEqual({ code: 409, body: { reason: "starting" } });
    expect(hold).not.toHaveBeenCalled();
  });
});
