import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { KEY_GAP_MS, MAX_KEYS, readPrompt, readScreen, registerPromptApi, sendKeys, type PromptApiDeps } from "./prompt-api.js";
import { PromptWatcher } from "./prompt-watch.js";
import { TerminalManager } from "./terminal.js";
import { typeIntoAgent, withTypingLock } from "../issues/reply.js";
import type { AgentPromptEvent } from "../events.js";

const file = (name: string): string => readFileSync(fileURLToPath(new URL(`./testdata/screens/${name}`, import.meta.url)), "utf8");
const TRUST = file("trust-2.1.322.raw");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await sleep(20);
  }
}

// Terminals with no PTY: `live` ids are attached here, `session` ids have a
// session that a reattach brings in.
function fakeTerms(o: { live?: string[]; session?: string[] } = {}) {
  const live = new Set(o.live ?? ["a1"]);
  const session = new Set(o.session ?? []);
  const writes: string[] = [];
  const log: string[] = [];
  return {
    live, writes, log,
    has: (id: string) => live.has(id),
    hasSession: async (id: string) => live.has(id) || session.has(id),
    reattach: async (id: string) => { if (session.has(id)) { log.push(`reattach ${id}`); live.add(id); } return null; },
    write: (id: string, d: string) => { writes.push(d); log.push(`write ${JSON.stringify(d)}`); },
    inputReady: () => true,
  };
}

let watcher: PromptWatcher | undefined;
let app: FastifyInstance | undefined;
let mgr: TerminalManager | undefined;
afterEach(async () => {
  watcher?.dispose(); watcher = undefined;
  await app?.close(); app = undefined;
  mgr?.shutdown(); mgr = undefined;
});

function setup(o: { terms?: ReturnType<typeof fakeTerms>; exists?: boolean; screen?: string } = {}) {
  const terms = o.terms ?? fakeTerms();
  const events: AgentPromptEvent[] = [];
  watcher = new PromptWatcher({ emit: (e) => events.push(e), settleMs: 10 });
  const typed: string[] = [];
  const sleeps: number[] = [];
  const d: PromptApiDeps = {
    terminals: terms, prompts: watcher, agentExists: async () => o.exists ?? true,
    onTyped: (id, data) => typed.push(`${id}:${JSON.stringify(data)}`),
    sleep: async (ms) => { sleeps.push(ms); },
  };
  for (const id of terms.live) {
    watcher.open(id, { cols: 120, rows: 30 });
    if (o.screen !== undefined) watcher.data(id, o.screen);
  }
  return { d, terms, typed, sleeps, events, w: watcher };
}

describe("sendKeys", () => {
  it("writes each key as its own write, with a gap between keys, and reports them as typed", async () => {
    const { d, terms, typed, sleeps } = setup();
    const r = await sendKeys(d, "a1", { keys: ["down", "down", "enter"] });
    expect(r).toEqual({ code: 200, body: { sent: true } });
    expect(terms.writes).toEqual(["\x1b[B", "\x1b[B", "\r"]);
    expect(sleeps).toEqual([KEY_GAP_MS, KEY_GAP_MS]);
    expect(typed).toEqual(['a1:"\\u001b[B"', 'a1:"\\u001b[B"', 'a1:"\\r"']);
  });

  it("takes every key of the allow-list", async () => {
    const { d, terms } = setup();
    const keys = ["up", "down", "enter", "esc", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    expect((await sendKeys(d, "a1", { keys })).code).toBe(200);
    expect(terms.writes).toEqual(["\x1b[A", "\x1b[B", "\r", "\x1b", "\t", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("refuses anything outside the allow-list and writes nothing", async () => {
    const { d, terms, typed } = setup();
    const bad: unknown[] = [
      null, {}, { keys: [] }, { keys: "enter" }, { keys: ["left"] }, { keys: ["enter", "0"] }, { keys: ["a"] },
      { keys: ["\r"] }, { keys: ["\x1b[A"] }, { keys: ["rm -rf /\r"] }, { keys: [1] }, { keys: [["up"]] }, { keys: ["ctrl-c"] },
      { keys: Array(MAX_KEYS + 1).fill("down") }, { keys: ["enter"], rev: 5 }, { keys: ["enter"], rev: "not hex" },
    ];
    for (const body of bad) {
      const r = await sendKeys(d, "a1", body);
      expect(r.code, JSON.stringify(body)).toBe(400);
    }
    expect((await sendKeys(d, "a1", { keys: Array(MAX_KEYS).fill("down") })).code).toBe(200);
    expect(terms.writes).toHaveLength(MAX_KEYS);
    expect(typed).toHaveLength(MAX_KEYS);
  });

  it("404 for an unknown agent and an id that is not an agent id", async () => {
    expect(await sendKeys(setup({ exists: false }).d, "a1", { keys: ["enter"] })).toEqual({ code: 404, body: { reason: "agent-gone" } });
    watcher?.dispose();
    const { d, terms } = setup();
    expect((await sendKeys(d, "svc:x", { keys: ["enter"] })).code).toBe(404);
    expect((await sendKeys(d, "../a1", { keys: ["enter"] })).code).toBe(404);
    expect(terms.writes).toEqual([]);
  });

  it("409 not-live with no terminal and no session", async () => {
    const { d, terms } = setup({ terms: fakeTerms({ live: [] }) });
    expect(await sendKeys(d, "a1", { keys: ["enter"] })).toEqual({ code: 409, body: { reason: "not-live" } });
    expect(terms.writes).toEqual([]);
  });

  it("reattaches a session that survived a restart, then writes", async () => {
    const { d, terms } = setup({ terms: fakeTerms({ live: [], session: ["a1"] }) });
    expect((await sendKeys(d, "a1", { keys: ["esc"] })).code).toBe(200);
    expect(terms.log).toEqual(["reattach a1", 'write "\\u001b"']);
  });

  it("with rev: sends only while that exact prompt is on screen", async () => {
    const { d, terms, w } = setup({ screen: TRUST });
    const p = (await w.state("a1"))!;
    expect(p.options[1]).toEqual({ label: "Yes, I trust this folder", keys: ["down", "enter"] });
    const ok = await sendKeys(d, "a1", { keys: p.options[1].keys, rev: p.rev });
    expect(ok.code).toBe(200);
    expect(terms.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("with a rev that is not the prompt on screen: 409 stale with the current prompt, nothing written", async () => {
    const { d, terms, typed, w } = setup({ screen: TRUST });
    const p = (await w.state("a1"))!;
    const r = await sendKeys(d, "a1", { keys: ["enter"], rev: "0123456789abcdef" });
    expect(r).toEqual({ code: 409, body: { reason: "stale", prompt: p } });
    // The dialog went away: a card that still shows it cannot press Enter.
    w.data("a1", "\x1b[2J\x1b[H" + file("idle-input-2.1.322.txt").replace(/\n$/, "").split("\n").join("\r\n"));
    expect(await sendKeys(d, "a1", { keys: ["enter"], rev: p.rev })).toEqual({ code: 409, body: { reason: "stale", prompt: null } });
    expect(terms.writes).toEqual([]);
    expect(typed).toEqual([]);
  });

  it("stops with not-live when the terminal ends between two keys", async () => {
    const terms = fakeTerms();
    const { d } = setup({ terms });
    d.sleep = async () => { terms.live.delete("a1"); };
    expect(await sendKeys(d, "a1", { keys: ["enter", "enter"] })).toEqual({ code: 409, body: { reason: "not-live" } });
    expect(terms.writes).toEqual(["\r"]);
  });

  it("shares the typing lock: keys never land inside another writer's paste and Enter", async () => {
    const terms = fakeTerms();
    const { d } = setup({ terms });
    let release!: () => void;
    const gap = new Promise<void>((r) => { release = r; });
    const paste = withTypingLock("a1", () => typeIntoAgent(terms, "a1", "hello", () => gap));
    const keys = sendKeys(d, "a1", { keys: ["esc"] });
    await sleep(20);
    expect(terms.writes).toEqual(["\x1b[200~hello\x1b[201~"]);
    release();
    await Promise.all([paste, keys]);
    expect(terms.writes).toEqual(["\x1b[200~hello\x1b[201~", "\r", "\x1b"]);
  });
});

describe("readPrompt and readScreen", () => {
  it("a live agent with a dialog: the prompt with its rev", async () => {
    const { d } = setup({ screen: TRUST });
    const r = await readPrompt(d, "a1");
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({
      live: true,
      prompt: { kind: "folder-trust", question: "Is this a project you created or one you trust?", selected: 0, rev: expect.stringMatching(/^[0-9a-f]{16}$/) },
    });
  });

  it("a live agent with no dialog: prompt null", async () => {
    expect(await readPrompt(setup({ screen: "hello" }).d, "a1")).toEqual({ code: 200, body: { live: true, prompt: null } });
  });

  it("no terminal and no session: live false; an unknown agent: 404", async () => {
    const { d } = setup({ terms: fakeTerms({ live: [] }) });
    expect(await readPrompt(d, "a1")).toEqual({ code: 200, body: { live: false, prompt: null } });
    expect(await readScreen(d, "a1")).toEqual({ code: 200, body: { live: false } });
    watcher?.dispose();
    const gone = setup({ exists: false }).d;
    expect(await readPrompt(gone, "a1")).toEqual({ code: 404, body: { reason: "agent-gone" } });
    expect(await readScreen(gone, "a1")).toEqual({ code: 404, body: { reason: "agent-gone" } });
    expect((await readPrompt(gone, "svc:x")).code).toBe(404);
  });

  it("reattaches a session that survived a restart before it reads", async () => {
    const terms = fakeTerms({ live: [], session: ["a1"] });
    const { d } = setup({ terms });
    expect((await readPrompt(d, "a1")).body).toEqual({ live: true, prompt: null });
    expect(terms.log).toEqual(["reattach a1"]);
  });

  it("the screen as text lines", async () => {
    const r = await readScreen(setup({ screen: TRUST }).d, "a1");
    expect(r.body).toMatchObject({ live: true, cols: 120, rows: 30 });
    const lines = (r.body as { lines: string[] }).lines;
    expect(lines).toHaveLength(30);
    expect(lines[14]).toBe(" ❯ No, exit");
  });
});

describe("routes", () => {
  async function build(o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o);
    app = Fastify();
    registerPromptApi(app, s.d);
    // The existing parametric route: /api/agents/prompts must not land here.
    app.get("/api/agents/:id", async (req) => ({ record: (req.params as { id: string }).id }));
    await app.ready();
    return { ...s, app };
  }

  it("GET /api/agents/prompts lists the agents that show a prompt", async () => {
    const { app, w } = await build({ terms: fakeTerms({ live: ["a1", "a2"] }) });
    w.data("a1", TRUST);
    const p = (await w.state("a1"))!;
    const res = await app.inject({ method: "GET", url: "/api/agents/prompts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prompts: [{ agentId: "a1", kind: "folder-trust", rev: p.rev }] });
    expect((await app.inject({ method: "GET", url: "/api/agents/a1" })).json()).toEqual({ record: "a1" });
  });

  it("GET prompt, GET screen and POST keys answer with the bodies above", async () => {
    const { app, terms } = await build({ screen: TRUST });
    const prompt = (await app.inject({ method: "GET", url: "/api/agents/a1/prompt" })).json();
    expect(prompt.prompt.kind).toBe("folder-trust");
    expect((await app.inject({ method: "GET", url: "/api/agents/a1/screen" })).json().lines).toHaveLength(30);
    const ok = await app.inject({ method: "POST", url: "/api/agents/a1/keys", payload: { keys: ["down"], rev: prompt.prompt.rev } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ sent: true });
    expect(terms.writes).toEqual(["\x1b[B"]);
    const bad = await app.inject({ method: "POST", url: "/api/agents/a1/keys", payload: { keys: ["x"] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "key not allowed: x" });
    const stale = await app.inject({ method: "POST", url: "/api/agents/a1/keys", payload: { keys: ["enter"], rev: "ffff" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().reason).toBe("stale");
    expect(terms.writes).toEqual(["\x1b[B"]);
  });

  it("POST keys refuses a body over its small limit", async () => {
    const { app, terms } = await build();
    const res = await app.inject({ method: "POST", url: "/api/agents/a1/keys", payload: { keys: ["enter"], pad: "x".repeat(8000) } });
    expect(res.statusCode).toBe(413);
    expect(terms.writes).toEqual([]);
  });
});

// A real PTY from the TerminalManager to the keys route: a stand-in TUI draws
// the captured trust dialog and then reports every byte it receives.
describe("end to end over a real PTY", () => {
  const FAKE_TUI = `
    const fs = require("fs");
    process.stdout.write(fs.readFileSync(process.argv[1], "utf8"));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let got = "";
    process.stdin.on("data", (d) => {
      got += d.toString();
      process.stdout.write("\\x1b[2J\\x1b[HGOT " + JSON.stringify(got));
      if (got.endsWith("\\r")) setTimeout(() => process.exit(0), 300);
    });
  `;

  it("the watcher sees the dialog, the card's keys reach the process, and the exit clears the prompt", async () => {
    const events: AgentPromptEvent[] = [];
    watcher = new PromptWatcher({ emit: (e) => events.push(e), settleMs: 20 });
    mgr = new TerminalManager({ observer: watcher });
    const d: PromptApiDeps = { terminals: mgr, prompts: watcher, agentExists: async () => true };
    const raw = fileURLToPath(new URL("./testdata/screens/trust-2.1.322.raw", import.meta.url));
    mgr.spawn({ id: "e2e-agent", cwd: process.cwd(), command: process.execPath, args: ["-e", FAKE_TUI, raw] });

    await waitFor(() => events.some((e) => e.kind === "folder-trust"));
    const got = await readPrompt(d, "e2e-agent");
    const prompt = (got.body as { prompt: { rev: string; options: { label: string; keys: string[] }[] } }).prompt;
    expect(prompt.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);

    const yes = prompt.options[1];
    expect(await sendKeys(d, "e2e-agent", { keys: yes.keys, rev: prompt.rev })).toEqual({ code: 200, body: { sent: true } });
    // The process echoes what it read: Down, then Enter, as two keys.
    await waitFor(async () => ((await readScreen(d, "e2e-agent")).body as { lines?: string[] }).lines?.[0] === 'GOT "\\u001b[B\\r"' || !mgr!.has("e2e-agent"));
    await waitFor(() => !mgr!.has("e2e-agent"));
    expect(events.map((e) => e.kind)).toEqual(["folder-trust", null]);
    expect(watcher.has("e2e-agent")).toBe(false);
    expect(await readPrompt(d, "e2e-agent")).toEqual({ code: 200, body: { live: false, prompt: null } });
  });

  it("the observer gets the PTY size, a resize and the end; a throwing observer does not break the terminal", async () => {
    const seen: string[] = [];
    mgr = new TerminalManager({
      observer: {
        open: (id, size) => { seen.push(`open ${id} ${size.cols}x${size.rows}`); },
        data: () => { throw new Error("boom"); },
        resize: (id, c, r) => { seen.push(`resize ${id} ${c}x${r}`); },
        close: (id) => { seen.push(`close ${id}`); },
      },
    });
    mgr.spawn({ id: "obs1", cwd: process.cwd(), command: "bash", args: ["-lc", "echo OBSERVED; sleep 0.4"] });
    await waitFor(() => (mgr!.attach("obs1")?.snapshot ?? "").includes("OBSERVED"));
    mgr.resize("obs1", 90, 20);
    mgr.resize("nobody", 90, 20);
    await waitFor(() => !mgr!.has("obs1"));
    expect(seen).toEqual(["open obs1 120x30", "resize obs1 90x20", "close obs1"]);
  });
});
