// server/agents/headless/wiring.test.ts — the headless workers in the product (wiring.ts), with the
// fake stream claude (../testdata/headless/fake-stream-claude.mjs) in real systemd user scopes.
// Each test has its own temp folder and its own unit names. After each test the wiring goes, a
// new host closes every worker of the test with remove(), and the test fails if a unit is left.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostOf } from "../host.js";
import { typeIntoAgentWhy, type ReplyTerminals } from "../../issues/reply.js";
import { HEADLESS_MAX_BYTES, HeadlessHost } from "./host.js";
import {
  HEADLESS_HELD, HeadlessWiring, STREAM_FLAGS, acceptInbound, endHeadless, headless, headlessArgs, headlessWanted,
  hookPoster, initHeadless, removeHeadless, setHeadlessOffHost, startHeadless, streamEnv, type WiringDeps,
} from "./wiring.js";
import { SessionStore, type AgentRecord } from "../store.js";
import { EventHub, type ConsoleEvent } from "../../events.js";
import { spawnAgent, type SpawnDeps } from "../spawn.js";
import { resumeAgent, switchAccount, type RecoveryCtx } from "../recovery.js";
import { agentExitHandler } from "../exit.js";
import { registerAgentApi } from "../api.js";
import type { LimitLogin as LoginInfo } from "../../chief/limit/service.js";

const FAKE = fileURLToPath(new URL("../testdata/headless/fake-stream-claude.mjs", import.meta.url));
const PREFIX = `headless-wiring-${process.pid}-${randomBytes(3).toString("hex")}-`;
const SYSTEMCTL = existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "/bin/systemctl";
const noTerminal = new Proxy({}, { get: () => () => { throw new Error("the terminal was used"); } }) as unknown as ReplyTerminals;

function userSystemd(): boolean {
  try { execFileSync(SYSTEMCTL, ["--user", "list-units", "--type=scope", "--no-legend"], { stdio: "ignore" }); return true; } catch { return false; }
}
function ourUnits(): string[] {
  const out = execFileSync(SYSTEMCTL, ["--user", "list-units", "--type=scope", "--all", "--plain", "--no-legend"], { encoding: "utf8" });
  return out.split("\n").map((l) => l.split(/\s+/).find((t) => t.startsWith(PREFIX))).filter((u): u is string => !!u);
}
function stopOurUnits(): void {
  const units = ourUnits();
  if (units.length === 0) return;
  try { execFileSync(SYSTEMCTL, ["--user", "stop", ...units], { stdio: "ignore" }); } catch { /* gone already */ }
  try { execFileSync(SYSTEMCTL, ["--user", "reset-failed", ...units], { stdio: "ignore" }); } catch { /* not failed */ }
}

// The tests that start a program need a user systemd (as host.test.ts).
const SYSTEMD = userSystemd();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

let tmp: string;
let wirings: HeadlessWiring[] = [];

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "headless-wiring-")); });
afterEach(async () => {
  endHeadless();
  for (const w of wirings) w.shutdown();
  wirings = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  let leaked: string[] = [];
  if (SYSTEMD) {
    const closer = new HeadlessHost({ runDir: join(tmp, "run"), stateDir: join(tmp, "state"), unitPrefix: PREFIX });
    let ids: string[] = [];
    try { ids = readdirSync(join(tmp, "run")); } catch { /* no worker */ }
    for (const id of ids) await closer.remove(id);
    closer.shutdown();
    const end = Date.now() + 3_000;
    while ((leaked = ourUnits()).length > 0 && Date.now() < end) await sleep(50);
    stopOurUnits();
  }
  rmSync(tmp, { recursive: true, force: true });
  expect(leaked).toEqual([]);
}, 30_000);

// The fake as an executable (the wiring puts the stream flags first: `node -p` would be node's).
// Written once per test: a write over a program that runs fails (ETXTBSY).
function program(name: string, body: string): string {
  const p = join(tmp, name);
  if (existsSync(p)) return p;
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const fakeClaude = () => program("fake-claude", `exec "${process.execPath}" "${FAKE}" "$@"`);
// A program that reads its input and never answers (a claude whose stream changed).
const silent = () => program("silent-claude", "exec cat > /dev/null");

type Rig = {
  w: HeadlessWiring; exits: Array<[string, number, boolean]>; posts: Array<[string, string, Record<string, unknown>]>;
  told: Array<[string, string]>; logs: string[]; recs: Map<string, AgentRecord>;
};

function rig(over: Partial<WiringDeps> = {}, recs = new Map<string, AgentRecord>()): Rig {
  const exits: Rig["exits"] = [];
  const posts: Rig["posts"] = [];
  const told: Rig["told"] = [];
  const logs: string[] = [];
  const w = new HeadlessWiring(deps({ exits, posts, told, logs, recs }, over));
  wirings.push(w);
  return { w, exits, posts, told, logs, recs };
}

// The wiring of this console, as index.ts makes it (headless() and hostOf() find it).
function consoleRig(over: Partial<WiringDeps> = {}, recs = new Map<string, AgentRecord>()): Rig {
  const r = { exits: [], posts: [], told: [], logs: [], recs } as Omit<Rig, "w">;
  return { ...r, w: initHeadless(deps(r, over)) };
}

function deps(r: Omit<Rig, "w">, over: Partial<WiringDeps> = {}): WiringDeps {
  return {
    agentEnv: (id, extra) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmp, FAKE_LOG: join(tmp, `${id}.fake.log`), ...extra }),
    onExit: (id, code, killed) => { r.exits.push([id, code, killed]); },
    load: async (id) => r.recs.get(id) ?? null,
    postHook: async (id, token, body) => { r.posts.push([id, token, body]); },
    tellUser: (id, text) => { r.told.push([id, text]); },
    log: (l) => { r.logs.push(l); },
    host: { runDir: join(tmp, "run"), stateDir: join(tmp, "state"), unitPrefix: PREFIX, tickMs: 30 },
    settleMs: 60, checkMs: 600,
    ...over,
  };
}

const record = (id: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "", worktree: tmp, cwd: tmp, branch: "", baseBranch: "", sessionId: null,
  hookToken: `tok-${id}`, status: "running", createdAt: 1, host: "headless", ...over,
});

function settingsFile(name = "settings.json", body: unknown = { hooks: { Stop: [] } }): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

async function launchFake(w: HeadlessWiring, id: string, prompt?: string, extra: string[] = []): Promise<void> {
  await w.launch(id, { cwd: tmp, command: fakeClaude(), args: ["--model", "haiku", ...extra], settingsPath: settingsFile(`${id}.settings.json`) });
  await w.first(id, prompt);
}

function fakeGot(id: string): string[] {
  let raw = "";
  try { raw = readFileSync(join(tmp, `${id}.fake.log`), "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: Array<{ text: string }> } })
    .filter((m) => m.type === "user").map((m) => m.message!.content[0]!.text);
}
const pidOf = (id: string) => Number(readFileSync(join(tmp, "run", id, "pid"), "utf8").split(" ")[0]);
const argvOf = (id: string) => readFileSync(`/proc/${pidOf(id)}/cmdline`, "utf8").split("\0").filter(Boolean);
const idlePosts = (r: Rig, id: string) => r.posts.filter(([x, , b]) => x === id && b.hook_event_name === "Notification");

describe("the flag", () => {
  it("is on only for AGENT_HEADLESS=1; with no wiring, no host answers and headless() is null", () => {
    expect(headlessWanted({ AGENT_HEADLESS: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) expect(headlessWanted({ AGENT_HEADLESS: v })).toBe(false);
    expect(headless()).toBeNull();
    mkdirSync(join(tmp, "run", "w1"), { recursive: true });
    expect(hostOf("w1")).toBeNull();
  });

  it("initHeadless registers the seam once; endHeadless takes it away", () => {
    const r = { exits: [], posts: [], told: [], logs: [], recs: new Map() };
    const w = initHeadless(deps(r));
    expect(headless()).toBe(w);
    expect(() => initHeadless(deps(r))).toThrow(/set already/);
    mkdirSync(join(tmp, "run", "w1"), { recursive: true });
    expect(hostOf("w1")).toBe(w.seam);
    expect(hostOf("w2")).toBeNull();                   // no folder: the terminal holds it
    endHeadless();
    expect(headless()).toBeNull();
    expect(hostOf("w1")).toBeNull();
  });
});

describe("args, settings and env", () => {
  it("the stream flags come first, then the args of a terminal worker", () => {
    expect(STREAM_FLAGS).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"]);
    expect(headlessArgs(["--model", "haiku", "--settings", "/s.json"])).toEqual([...STREAM_FLAGS, "--model", "haiku", "--settings", "/s.json"]);
  });

  it("acceptInbound adds crossSessionInbound accept and keeps the hooks; it refuses what is not a settings object or a link", async () => {
    const p = settingsFile("s.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } });
    await acceptInbound(p);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] }, crossSessionInbound: "accept" });
    await acceptInbound(p);
    expect(JSON.parse(readFileSync(p, "utf8")).crossSessionInbound).toBe("accept");
    await expect(acceptInbound(settingsFile("a.json", []))).rejects.toThrow(/not a settings object/);
    await expect(acceptInbound(settingsFile("n.json", null))).rejects.toThrow(/not a settings object/);
    const target = settingsFile("target.json", { a: 1 });
    symlinkSync(target, join(tmp, "link.json"));
    await expect(acceptInbound(join(tmp, "link.json"))).rejects.toThrow();
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 1 });
  });

  it("streamEnv drops the names that a shell reads as code", () => {
    expect(streamEnv({ PATH: "/bin", BASH_ENV: "x", ENV: "y", SHELLOPTS: "z", BASHOPTS: "q", PS4: "p", "BASH_FUNC_f%%": "() { :; }", HOME: "/h" }))
      .toEqual({ env: { PATH: "/bin", HOME: "/h" }, dropped: ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "BASH_FUNC_f%%"] });
  });

  it("eligible: a Claude worker (no kind or issue) with no own clone; never after a failed stream check", () => {
    const { w } = rig();
    expect(w.eligible({})).toBe(true);
    expect(w.eligible({ runtime: "claude", kind: "issue" })).toBe(true);
    for (const kind of ["lead", "fleet-master", "coordinator", "master"] as const) expect(w.eligible({ kind: kind as never })).toBe(false);
    expect(w.eligible({ runtime: "codex" as never })).toBe(false);
    expect(w.eligible({ clone: true })).toBe(false);
  });
});

describe.skipIf(!SYSTEMD)("a headless worker", () => {
  it("start, first message, ack, result: the console posts the idle hook only when the record still says running", async () => {
    const r = rig();
    r.recs.set("w1", record("w1"));
    await launchFake(r.w, "w1", "hello");
    expect(r.w.host.has("w1")).toBe(true);
    // The stream flags first, the args of the worker after, no positional prompt.
    const argv = argvOf("w1");
    expect(argv.slice(2)).toEqual([...STREAM_FLAGS, "--model", "haiku"]);
    expect(JSON.parse(readFileSync(join(tmp, "w1.settings.json"), "utf8")).crossSessionInbound).toBe("accept");
    await until("the idle hook", () => idlePosts(r, "w1").length === 1);
    expect(fakeGot("w1")).toEqual(["hello"]);
    const [, token, body] = idlePosts(r, "w1")[0]!;
    expect(token).toBe("tok-w1");
    expect(body).toMatchObject({ hook_event_name: "Notification", session_id: expect.any(String) });
    // Claude's Stop hook said idle already: no post.
    r.recs.set("w1", record("w1", { status: "idle" }));
    expect(await r.w.seam.send("w1", "again")).toBe("sent");
    await until("the fake got it", () => fakeGot("w1").includes("again"));
    await sleep(400);
    expect(idlePosts(r, "w1")).toHaveLength(1);
    // A message during a turn: no idle post between the two results of one turn.
    r.recs.set("w1", record("w1"));
    expect(await r.w.seam.send("w1", "[fake sleep=500] long")).toBe("sent");
    await sleep(100);
    expect(await r.w.seam.send("w1", "joins")).toBe("sent");
    await until("the idle hook of the long turn", () => idlePosts(r, "w1").length === 2, 5_000);
    await sleep(300);
    expect(idlePosts(r, "w1")).toHaveLength(2);
    expect(r.w.streamCheckFailed()).toBe(false);
    expect(r.logs.filter((l) => l.includes("stream check"))).toEqual([]);
    expect(r.exits).toEqual([]);
  });

  it("the seam: a message from another agent goes through the same send; too large is a result, never written", async () => {
    const r = consoleRig();
    r.recs.set("w1", record("w1", { status: "idle" }));
    await launchFake(r.w, "w1");
    expect(hostOf("w1")).toBe(r.w.seam);
    expect(await typeIntoAgentWhy(noTerminal, "w1", "from agent-x: please check")).toBe("sent");
    await until("the fake got it", () => fakeGot("w1").includes("from agent-x: please check"));
    const big = "x".repeat(HEADLESS_MAX_BYTES + 1);
    expect(await typeIntoAgentWhy(noTerminal, "w1", big)).toBe("too-large");
    await expect(r.w.first("w1", big)).rejects.toThrow(/too long for this agent/);
    await sleep(200);
    expect(fakeGot("w1")).toEqual(["from agent-x: please check"]);
  });

  it("the stream check: no init and no ack within the limit of a send → one log line, and new workers start in a terminal", async () => {
    const r = rig({ checkMs: 400 });
    await r.w.launch("w1", { cwd: tmp, command: silent(), args: [] });
    // A command is not checked (a local command can have no init).
    expect(await r.w.seam.send("w1", "/model haiku")).toBe("sent");
    await sleep(700);
    expect(r.w.streamCheckFailed()).toBe(false);
    expect(r.w.eligible({})).toBe(true);
    await r.w.first("w1", "hello");
    await until("the failure", () => r.w.streamCheckFailed(), 3_000);
    expect(r.logs.filter((l) => l.includes("stream check"))).toEqual([
      "[headless] the stream check failed for w1 (claude version unknown): no init and no ack within 0 s of a send. New workers start in a terminal.",
    ]);
    expect(r.w.eligible({})).toBe(false);
    // One line only.
    expect(await r.w.seam.send("w1", "more")).toBe("sent");
    await sleep(700);
    expect(r.logs.filter((l) => l.includes("stream check"))).toHaveLength(1);
  });

  it("the stream check: a program that ended is not a failure (its exit says it)", async () => {
    const r = rig({ checkMs: 400 });
    await r.w.launch("w1", { cwd: tmp, command: program("one-line", "head -c 1 > /dev/null; exit 3"), args: [] });
    await r.w.first("w1", "hello");
    await until("the exit", () => r.exits.length === 1);
    expect(r.exits).toEqual([["w1", 3, false]]);
    await sleep(600);
    expect(r.w.streamCheckFailed()).toBe(false);
    // The check's limit comes before the host's next read of its programs: the ended program is
    // still not a failure.
    const slow = rig({ checkMs: 300, host: { runDir: join(tmp, "run2"), stateDir: join(tmp, "state2"), unitPrefix: PREFIX, tickMs: 5000 } });
    await slow.w.launch("w2", { cwd: tmp, command: program("one-line-2", "head -c 1 > /dev/null; exit 3"), args: [] });
    await slow.w.first("w2", "hello");
    await sleep(700);
    expect(slow.exits).toEqual([]);
    expect(slow.w.streamCheckFailed()).toBe(false);
    expect(slow.logs.filter((l) => l.includes("stream check failed"))).toEqual([]);
  });

  it("notResent of a start and onNotResent of a reattach go to the user, in one short line", async () => {
    const r = rig();
    r.recs.set("w1", record("w1"));
    await launchFake(r.w, "w1", "[fake sleep=5000] slow");
    await until("the fake got slow", () => fakeGot("w1").length === 1);
    expect(await r.w.seam.send("w1", "/clear")).toBe("sent");
    await until("the relay passed it", () => fakeGot("w1").includes("/clear"));
    // The program dies with /clear passed and not done.
    process.kill(pidOf("w1"), "SIGKILL");
    await until("the exit", () => r.exits.length === 1);
    await launchFake(r.w, "w1");
    expect(r.told).toEqual([["w1", 'Not sent again after a restart: "/clear". Send it again if it is still needed.']]);
    // The reattach's callback (host.test.ts proves when the host calls it).
    const opts = (r.w.host as unknown as { opts: { onNotResent: (id: string, items: Array<{ uuid: string; text: string }>) => void } }).opts;
    opts.onNotResent("w1", [{ uuid: "u1", text: "/compact\n  keep   the plan " }, { uuid: "u2", text: `/x ${"y".repeat(200)}` }]);
    expect(r.told[1]).toEqual(["w1", `Not sent again after a restart: "/compact keep the plan", "/x ${"y".repeat(76)}…". Send it again if it is still needed.`]);
    opts.onNotResent("w1", []);
    expect(r.told).toHaveLength(2);
  });

  it("boot: each owned worker is taken back, also one whose program ended (hasSession false); a folder goes only when its record file is gone", async () => {
    const a = rig();
    for (const id of ["w1", "w2", "w3", "w4"]) await launchFake(a.w, id);
    a.w.shutdown();                                    // the console stops; the programs live on
    const p2 = pidOf("w2");
    process.kill(p2, "SIGTERM");                       // ended while the console was down
    await until("w2 ended", () => { try { process.kill(p2, 0); return false; } catch { return true; } });
    const store = new SessionStore(join(tmp, "store"));
    for (const id of ["w1", "w2"]) await store.save(record(id));
    // w3 has no record (deleted while down); the record file of w4 was cut by a crash: list()
    // drops it, but the record is there.
    writeFileSync(join(tmp, "store", "w4.json"), '{"id": "w4", "lab');
    expect((await store.list()).map((r) => r.id)).toEqual(["w1", "w2"]);
    const b = rig();
    expect(await b.w.host.hasSession("w2")).toBe(false);
    await b.w.boot(store);
    expect(b.w.host.has("w1")).toBe(true);
    expect(b.w.host.has("w4")).toBe(true);
    expect(b.exits.map(([id, , killed]) => [id, killed])).toEqual([["w2", false]]);
    expect(existsSync(join(tmp, "run", "w3"))).toBe(false);
    expect(existsSync(join(tmp, "run", "w4"))).toBe(true);
    expect(b.logs).toEqual(["[headless] w3: no record; its worker folder: removed"]);
    expect(await b.w.seam.send("w1", "after the restart")).toBe("sent");
    await until("the fake got it", () => fakeGot("w1").includes("after the restart"));
    expect(a.exits).toEqual([]);
  });

  it("close and delete: removed (no exit, no folder); held by another console: HEADLESS_HELD, the worker lives on", async () => {
    const a = rig();
    await launchFake(a.w, "w1");
    await launchFake(a.w, "w2");
    const b = rig();
    await expect(removeHeadless(b.w, "w1")).rejects.toThrow(HEADLESS_HELD);
    expect(a.w.host.has("w1")).toBe(true);
    await removeHeadless(a.w, "w1");
    expect(existsSync(join(tmp, "run", "w1"))).toBe(false);
    expect(a.w.host.has("w1")).toBe(false);
    await sleep(200);
    expect(a.exits).toEqual([]);
    vi.spyOn(a.w.host, "remove").mockResolvedValue("failed");
    await expect(removeHeadless(a.w, "w2")).rejects.toThrow(/was not removed/);
    expect(a.logs).toContain("[headless] w2: remove failed");
  });
});

// The go-on after a usage limit: the same read as the limit ticket (chief/limit/service.ts).
describe("the auto-continue", () => {
  const limitRec = (id: string, at: number, over: Partial<AgentRecord> = {}) =>
    record(id, { status: "idle", stop: { why: "limit", at, text: "limit" } as AgentRecord["stop"], ...over });
  const login = (id: string, full: boolean, over: Partial<LoginInfo> = {}): LoginInfo =>
    ({ id, name: id, loggedIn: true, signedOut: false, use: { session: full ? 100 : 10, week: 10, atLimit: full, until: full ? Date.now() + 3_600_000 : null, models: [] }, ...over });

  function ops(recs: AgentRecord[], logins: LoginInfo[] | (() => Promise<LoginInfo[]>)) {
    const goOn: string[] = [];
    return {
      goOn,
      ops: {
        list: async () => recs,
        logins: typeof logins === "function" ? logins : async () => logins,
        stopRead: vi.fn(async (r: AgentRecord) => ({ ok: true as const, stop: r.stop })),
        goOn: vi.fn(async (id: string) => { goOn.push(id); return "sent" as const; }),
      },
    };
  }

  it("one worker per call, the oldest stop first; a worker is tried again only after 10 min", async () => {
    let now = 1_000_000;
    const r = rig({ now: () => now });
    vi.spyOn(r.w.host, "has").mockReturnValue(true);
    const o = ops([limitRec("w2", 20), limitRec("w1", 10), limitRec("w3", 10, { account: "work" })], [login("default", false), login("work", false)]);
    expect(await r.w.continueOne(o.ops as never)).toBe("w1");
    expect(await r.w.continueOne(o.ops as never)).toBe("w3");
    expect(await r.w.continueOne(o.ops as never)).toBe("w2");
    expect(await r.w.continueOne(o.ops as never)).toBeNull();
    now += 10 * 60_000;
    expect(await r.w.continueOne(o.ops as never)).toBe("w1");
    expect(o.goOn).toEqual(["w1", "w3", "w2", "w1"]);
    expect(r.logs).toContain("[headless] w1: its login has room again; go-on: sent");
  });

  it("skips: a terminal worker, running, closed, not live, no limit mark, a login with no room or signed out, a read that says the limit ended", async () => {
    const r = rig();
    const live = new Set(["a", "b", "c", "e", "f", "g", "h", "i"]);
    vi.spyOn(r.w.host, "has").mockImplementation((id) => live.has(id));
    const recs = [
      limitRec("a", 1, { host: undefined }),                 // a terminal worker: Claude's own continue
      limitRec("b", 1, { status: "running" }),
      limitRec("c", 1, { closedAt: 5 }),
      limitRec("d", 1),                                      // not live
      record("e", { status: "idle" }),                       // no mark
      limitRec("f", 1, { account: "full" }),
      limitRec("g", 1, { account: "out" }),
      limitRec("h", 1, { account: "gone" }),                 // no such login
      limitRec("i", 1),                                      // its session no longer ends at the limit
    ];
    const o = ops(recs, [login("default", false), login("full", true), login("out", false, { signedOut: true })]);
    o.ops.stopRead.mockImplementation(async (x: AgentRecord) => (x.id === "i" ? { ok: true, stop: undefined } : { ok: true, stop: x.stop }));
    expect(await r.w.continueOne(o.ops as never)).toBeNull();
    expect(o.goOn).toEqual([]);
    // A read that failed counts as the limit (as the ticket keeps its row).
    o.ops.stopRead.mockImplementation(async () => ({ ok: false }) as never);
    expect(await r.w.continueOne(o.ops as never)).toBe("i");
    // The logins could not be read: nothing.
    const r2 = rig();
    vi.spyOn(r2.w.host, "has").mockReturnValue(true);
    const o2 = ops([limitRec("x", 1)], async () => { throw new Error("no usage"); });
    expect(await r2.w.continueOne(o2.ops as never)).toBeNull();
  });

  it("startAutoContinue: one go-on per tick, never two ticks at once; the stop ends it", async () => {
    const r = rig();
    vi.spyOn(r.w.host, "has").mockReturnValue(true);
    const o = ops([limitRec("w1", 1), limitRec("w2", 2), limitRec("w3", 3)], [login("default", false)]);
    let inFlight = 0, most = 0;
    o.ops.goOn.mockImplementation(async (id: string) => {
      inFlight++; most = Math.max(most, inFlight);
      await sleep(120);
      inFlight--; o.goOn.push(id);
      return "sent";
    });
    const stop = r.w.startAutoContinue(o.ops as never, 20);
    await until("three go-ons", () => o.goOn.length === 3, 3_000);
    expect(o.goOn).toEqual(["w1", "w2", "w3"]);
    expect(most).toBe(1);
    stop();
    o.ops.list = async () => [limitRec("w4", 4)];
    await sleep(150);
    expect(o.goOn).toEqual(["w1", "w2", "w3"]);
  });

  it("the guard: a go-on of the console blocks a second one for 60 s", () => {
    let now = 5_000;
    const r = rig({ now: () => now });
    expect(r.w.wentOnLately("w1")).toBe(false);
    r.w.noteGoOn("w1");
    expect(r.w.wentOnLately("w1")).toBe(true);
    expect(r.w.wentOnLately("w2")).toBe(false);
    now += 59_999;
    expect(r.w.wentOnLately("w1")).toBe(true);
    now += 1;
    expect(r.w.wentOnLately("w1")).toBe(false);
  });
});


describe.skipIf(!SYSTEMD)("the product paths (flag on)", () => {
  async function spawnSetup() {
    const workspaceDir = join(tmp, "ws");
    mkdirSync(workspaceDir, { recursive: true });
    const store = new SessionStore(join(tmp, "store"));
    const hub = new EventHub();
    const events: ConsoleEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const spawned: Array<{ id: string; args: string[] }> = [];
    const killed: string[] = [];
    const terminals = { spawn: (o: { id: string; args: string[] }) => { spawned.push(o); }, kill: (id: string) => { killed.push(id); } };
    // Port 1: the hooks of the settings file never reach a console (the fake runs no hook).
    const d: SpawnDeps = { terminals: terminals as unknown as SpawnDeps["terminals"], store, hub, workspaceDir, worktreeRoot: join(tmp, ".wt"), port: 1 };
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", fakeClaude());
    return { d, store, events, spawned, killed };
  }

  it("spawn: a worker starts headless with its prompt as the first message; a lead keeps its terminal", async () => {
    const t = await spawnSetup();
    const r = consoleRig({}, new Map());
    const res = await spawnAgent(t.d, { prompt: "do the task" });
    if (!res.ok) throw new Error(res.error);
    const rec = (await t.store.load(res.id))!;
    expect(rec.host).toBe("headless");
    // No kept first message (store.ts firstPrompt): it went as the first message of the stream.
    expect([rec.firstPrompt, rec.firstPromptAt]).toEqual([undefined, undefined]);
    expect(t.spawned).toEqual([]);
    expect(hostOf(res.id)).toBe(r.w.seam);
    await until("the first message", () => fakeGot(res.id).includes("do the task"));
    const argv = argvOf(res.id);
    expect(argv.slice(2, 2 + STREAM_FLAGS.length)).toEqual(STREAM_FLAGS);
    expect(argv).not.toContain("do the task");      // never an arg
    const settings = argv[argv.indexOf("--settings") + 1]!;
    expect(JSON.parse(readFileSync(settings, "utf8")).crossSessionInbound).toBe("accept");
    // A message of the user goes through the seam.
    expect(await typeIntoAgentWhy(noTerminal, res.id, "a second message")).toBe("sent");
    await until("the second message", () => fakeGot(res.id).includes("a second message"));
    // A persistent agent is not a worker: its terminal, as before.
    const lead = await spawnAgent(t.d, { prompt: "lead", kind: "lead", area: "a" } as never);
    if (lead.ok) {
      expect((await t.store.load(lead.id))?.host).toBeUndefined();
      expect(t.spawned.map((x) => x.id)).toEqual([lead.id]);
    }
    // After a failed stream check: a terminal.
    (r.w as unknown as { failed: unknown }).failed = { version: null, at: 1 };
    const later = await spawnAgent(t.d, { prompt: "later" });
    if (!later.ok) throw new Error(later.error);
    expect((await t.store.load(later.id))?.host).toBeUndefined();
    expect((await t.store.load(later.id))?.firstPrompt).toBe("later");
    expect(t.spawned.map((x) => x.id)).toContain(later.id);
  });

  it("spawn: a start that fails leaves no record and no worker folder", async () => {
    const t = await spawnSetup();
    consoleRig();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", join(tmp, "no-such-claude"));
    const res = await spawnAgent(t.d, { prompt: "x" });
    expect(res.ok).toBe(false);
    expect(await t.store.list()).toEqual([]);
    let left: string[] = [];
    try { left = readdirSync(join(tmp, "run")); } catch { /* none */ }
    expect(left).toEqual([]);
    expect(t.killed).toEqual([]);                    // the terminal was not used
  });

  it("with the flag off (no wiring): a worker starts in a terminal, as on main", async () => {
    const t = await spawnSetup();
    const res = await spawnAgent(t.d, { prompt: "do it" });
    if (!res.ok) throw new Error(res.error);
    expect((await t.store.load(res.id))?.host).toBeUndefined();
    expect(t.spawned.map((x) => x.id)).toEqual([res.id]);
    expect(t.spawned[0]!.args.at(-1)).toBe("do it");
    expect(t.spawned[0]!.args).not.toContain("-p");
  });

  it("resume: a headless worker starts again headless, with its prompt as the first message; with the flag off it refuses", async () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", fakeClaude());
    // A kept first message on a headless record (none is written now): a resume never sends it.
    const rec = record("aaaaaaaa-1111-4111-8111-111111111111", { status: "done", firstPrompt: "old task" });
    const patches: Array<Partial<AgentRecord>> = [];
    const spawned: string[] = [];
    const ctx = {
      port: 1, workspaceDir: tmp,
      claudeHooksPathFor: (r: AgentRecord) => join(tmp, `${r.id}.hooks.json`),
      writeClaudeHookSettings: async (_r: AgentRecord, p: string) => { writeFileSync(p, "{}"); },
      store: { list: async () => [rec], load: async () => rec, patch: async (_id: string, p: Partial<AgentRecord>) => { patches.push(p); } },
      terminals: { has: () => false, reattach: async () => null, spawn: (o: { id: string }) => { spawned.push(o.id); }, kill: () => {} },
    } as unknown as RecoveryCtx;
    await expect(resumeAgent(rec, ctx, { prompt: "go on" })).rejects.toThrow(/headless workers are off/);
    expect(spawned).toEqual([]);
    expect(existsSync(join(tmp, `${rec.id}.hooks.json`))).toBe(false);
    const r = consoleRig();
    expect(await resumeAgent(rec, ctx, { prompt: "go on" })).toBe("cold");
    expect(spawned).toEqual([]);
    expect(r.w.host.has(rec.id)).toBe(true);
    await until("the first message", () => fakeGot(rec.id).includes("go on"));
    expect(fakeGot(rec.id)).not.toContain("old task");
    expect(patches.at(-1)).toMatchObject({ status: "idle" });
    expect(patches.some((p) => "firstPromptAt" in p)).toBe(false);
    // Live: a second resume finds it.
    expect(await resumeAgent(rec, ctx)).toBe("alive");
  });

  it("the api: close and delete of a headless worker remove its program; held by another console: 409", async () => {
    const store = new SessionStore(join(tmp, "store"));
    const killed: string[] = [];
    const terminals = { spawn() {}, kill: (id: string) => { killed.push(id); }, has: () => false, write() {}, resize() {}, attach() { return null; } };
    const app = Fastify();
    registerAgentApi(app, { terminals: terminals as never, store, hub: new EventHub(), workspaceDir: join(tmp, "ws") });
    const W1 = "aaaaaaaa-1111-4111-8111-111111111111", W2 = "bbbbbbbb-1111-4111-8111-111111111111";
    try {
      const other = rig();                         // another console holds W1 and W2
      await launchFake(other.w, W1);
      await launchFake(other.w, W2);
      const r = consoleRig();
      for (const id of [W1, W2]) await store.save(record(id, { status: "idle" }));
      for (const url of [`/api/agents/${W1}/close`, `/api/agents/${W2}/delete`]) {
        const res = await app.inject({ method: "POST", url });
        expect([res.statusCode, res.json().error]).toEqual([409, HEADLESS_HELD]);
      }
      expect((await store.load(W1))?.closedAt).toBeUndefined();
      expect(await store.load(W2)).not.toBeNull();
      // The other console stops: this one takes them back, and the close and the delete go.
      other.w.shutdown();
      await r.w.boot(store);
      expect(r.w.host.has(W1)).toBe(true);
      expect((await app.inject({ method: "POST", url: `/api/agents/${W1}/close` })).statusCode).toBeLessThan(300);
      expect((await app.inject({ method: "POST", url: `/api/agents/${W2}/delete` })).statusCode).toBe(202);
      expect((await store.load(W1))?.closedAt).toEqual(expect.any(Number));
      expect(await store.load(W2)).toBeNull();
      expect(existsSync(join(tmp, "run", W1))).toBe(false);
      expect(existsSync(join(tmp, "run", W2))).toBe(false);
      expect(r.w.host.has(W1) || r.w.host.has(W2)).toBe(false);
      expect(r.exits).toEqual([]);
    } finally { await app.close(); }
  });
});

// Review round 2: a move, the hook route, the boot of index.ts, and the flag off.
describe.skipIf(!SYSTEMD)("round 2", () => {
  const W = "aaaaaaaa-1111-4111-8111-111111111111";
  // Ended: no such process, or one that only waits to be reaped.
  const ended = (pid: number) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z"); } catch { return true; } };
  const statusOf = async (store: SessionStore, id: string, want: string) => {
    for (let i = 0; i < 400 && (await store.load(id))?.status !== want; i++) await sleep(25);
    return (await store.load(id))?.status;
  };
  const apiTerminals = (killed: string[] = []) => ({ spawn() {}, kill: (id: string) => { killed.push(id); }, has: () => false, write() {}, resize() {}, attach() { return null; } });
  const ctxOf = (store: SessionStore) => ({
    port: 1, workspaceDir: tmp,
    accounts: { root: join(tmp, "accounts"), defaultDir: join(tmp, "default"), defaultClaudeJson: join(tmp, "default", ".claude.json") },
    claudeHooksPathFor: (x: AgentRecord) => join(tmp, `${x.id}.hooks.json`),
    writeClaudeHookSettings: async (_x: AgentRecord, p: string) => { writeFileSync(p, "{}"); },
    store,
    terminals: { has: () => false, hasSession: async () => false, reattach: async () => null, spawn: () => { throw new Error("the terminal was used"); }, kill: () => {} },
  }) as unknown as RecoveryCtx;

  it("a move to another login (the limit ticket's Move): the old program's end says killed; no error status, no error event", async () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", fakeClaude());
    const store = new SessionStore(join(tmp, "store"));
    const hub = new EventHub();
    const events: ConsoleEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const exitHandler = agentExitHandler({ services: () => ({ handleExit: () => false }), store, hub, relaunching: new Set() });
    const exits: Array<[string, number, boolean]> = [];
    const r = consoleRig({ load: (id) => store.load(id), onExit: (id, code, killed) => { exits.push([id, code, killed]); exitHandler(id, code, killed); } });
    await store.save(record(W, { status: "idle" }));
    const ctx = ctxOf(store);
    expect(await resumeAgent((await store.load(W))!, ctx, { prompt: "the task" })).toBe("cold");
    await until("the first message", () => fakeGot(W).includes("the task"));
    const before = pidOf(W);
    expect(await switchAccount((await store.load(W))!, "work", ctx)).toBe("cold");
    expect(r.w.host.has(W)).toBe(true);
    expect(pidOf(W)).not.toBe(before);
    await sleep(1_500);                                // the poll of the old program had its time too
    expect(exits.map(([id, , killed]) => [id, killed])).toEqual([[W, true]]);
    expect(await statusOf(store, W, "idle")).toBe("idle");
    expect((await store.load(W))?.account).toBe("work");
    const statuses = events.flatMap((e) => (e.type === "agent-status" ? [(e as { status: string }).status] : []));
    expect(statuses).toEqual(["done"]);                // as the move of a terminal worker; never "error"
  });

  it("the resume writes runModel, as the terminal path", async () => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", fakeClaude());
    const store = new SessionStore(join(tmp, "store"));
    consoleRig({ load: (id) => store.load(id) });
    await store.save(record(W, { status: "done", model: "sonnet" } as Partial<AgentRecord>));
    expect(await resumeAgent((await store.load(W))!, ctxOf(store))).toBe("cold");
    const rec = (await store.load(W))!;
    expect(rec.runModel).toEqual(expect.any(String));
    expect(argvOf(W)).toContain(rec.runModel);
  });

  it("postHook through the console's own hook route: the idle hook sets the record idle; a refusal of the route is one log line", async () => {
    const store = new SessionStore(join(tmp, "store"));
    const app = Fastify();
    registerAgentApi(app, { terminals: apiTerminals() as never, store, hub: new EventHub(), workspaceDir: join(tmp, "ws") });
    const W2 = "bbbbbbbb-1111-4111-8111-111111111111";
    try {
      const r = consoleRig({
        // W2: a token that the route refuses.
        load: async (id) => { const x = await store.load(id); return x && id === W2 ? { ...x, hookToken: "not-its-token" } : x; },
        postHook: hookPoster(app),
      });
      for (const id of [W, W2]) await store.save(record(id, { status: "running" }));
      await launchFake(r.w, W, "the task");
      await launchFake(r.w, W2, "the task");
      expect(await statusOf(store, W, "idle")).toBe("idle");
      await until("the refusal", () => r.logs.find((l) => l.startsWith(`[headless] ${W2}: the idle hook failed: the hook route answered 401`)));
      expect((await store.load(W2))?.status).toBe("running");
    } finally { await app.close(); }
  });

  it("startHeadless (index.ts): the boot first, so the first tick of the auto-continue finds the worker live; a failed boot: no auto-continue; the flag off: one line", async () => {
    const store = new SessionStore(join(tmp, "store"));
    const a = rig();
    await launchFake(a.w, W);
    a.w.shutdown();                                    // the console stops; the program lives on
    await store.save(record(W, { status: "idle", stop: { why: "limit", at: 1, text: "limit" } as AgentRecord["stop"] }));
    const seen: boolean[] = [];
    const room = { id: "default", name: "default", loggedIn: true, signedOut: false, use: { session: 10, week: 10, atLimit: false, until: null, models: [] } } as LoginInfo;
    let w: HeadlessWiring | null = null;
    const ops = {
      list: async () => { seen.push(!!w?.host.has(W)); return store.list(); },
      logins: async () => [room],
      stopRead: async (x: AgentRecord) => ({ ok: true as const, stop: x.stop }),
      goOn: vi.fn(async () => "sent" as const),
    };
    // The flag off: no wiring.
    const offLogs: string[] = [];
    expect(await startHeadless(store, ops as never, (l) => offLogs.push(l), 20)).toBeNull();
    expect(offLogs).toEqual(["[headless] 1 headless worker(s) and AGENT_HEADLESS is off: the console does not resume them (stop, close and delete still end them)"]);
    // A slow boot (each exists() 150 ms): a tick before its end would see the worker not live.
    w = consoleRig().w;
    const slow = { list: () => store.list(), exists: async (id: string) => { await sleep(150); return store.exists(id); } };
    const stop = await startHeadless(slow, ops as never, () => {}, 20);
    try {
      await until("a go-on", () => ops.goOn.mock.calls.length > 0, 3_000);
    } finally { stop?.(); }
    expect(seen[0]).toBe(true);
    expect(ops.goOn).toHaveBeenCalledWith(W);
    // A boot that fails: no auto-continue.
    endHeadless();
    w = consoleRig().w;
    const logs: string[] = [];
    const broken = { list: () => store.list(), exists: async () => { throw new Error("EIO"); } };
    const calls = seen.length;
    expect(await startHeadless(broken, ops as never, (l) => logs.push(l), 20)).toBeNull();
    await sleep(100);
    expect(seen.length).toBe(calls);
    expect(logs).toEqual(["[headless] boot skipped: EIO"]);
  });

  it("the flag off: stop, close and delete end the program of a worker of an earlier run with the flag on; held by a live console: 409", async () => {
    const store = new SessionStore(join(tmp, "store"));
    const app = Fastify();
    registerAgentApi(app, { terminals: apiTerminals() as never, store, hub: new EventHub(), workspaceDir: join(tmp, "ws") });
    const S = W, C = "bbbbbbbb-1111-4111-8111-111111111111", D = "cccccccc-1111-4111-8111-111111111111", H = "dddddddd-1111-4111-8111-111111111111";
    try {
      const earlier = rig();                           // the run with the flag on; then a restart with it off
      for (const id of [S, C, D]) { await launchFake(earlier.w, id); await store.save(record(id, { status: "idle" })); }
      earlier.w.shutdown();
      const live = rig();                              // another console that runs H now
      await launchFake(live.w, H);
      await store.save(record(H, { status: "idle" }));
      const pids = new Map([S, C, D, H].map((id) => [id, pidOf(id)]));
      expect(headless()).toBeNull();
      setHeadlessOffHost({ runDir: join(tmp, "run"), stateDir: join(tmp, "state"), unitPrefix: PREFIX });
      const post = (id: string, act: string) => app.inject({ method: "POST", url: `/api/agents/${id}/${act}` });
      // Stop: the program ends before the answer; the record and the folder stay; its end is taken.
      expect((await post(S, "stop")).statusCode).toBe(202);
      expect(ended(pids.get(S)!)).toBe(true);
      expect((await store.load(S))?.status).toBe("done");
      expect(existsSync(join(tmp, "run", S))).toBe(true);
      expect(existsSync(join(tmp, "run", S, "pid"))).toBe(false);
      // Close and delete: the program ends before the answer (a delete removes the worktree after it).
      expect((await post(C, "close")).statusCode).toBe(202);
      expect(ended(pids.get(C)!)).toBe(true);
      expect(existsSync(join(tmp, "run", C))).toBe(false);
      expect((await store.load(C))?.closedAt).toEqual(expect.any(Number));
      expect((await post(D, "delete")).statusCode).toBe(202);
      expect(ended(pids.get(D)!)).toBe(true);
      expect(existsSync(join(tmp, "run", D))).toBe(false);
      expect(await store.load(D)).toBeNull();
      // Held by the console that runs it: 409, nothing changes.
      for (const act of ["close", "delete"]) {
        const res = await post(H, act);
        expect([res.statusCode, res.json().error]).toEqual([409, HEADLESS_HELD]);
      }
      expect(live.w.host.has(H)).toBe(true);
      expect(ourUnits().filter((u) => !u.includes(H))).toEqual([]);
      // The flag on again: the stopped worker's end is not reported a second time.
      live.w.shutdown();
      const later = consoleRig();
      await later.w.boot(store);
      expect(later.exits).toEqual([]);
      expect(later.w.host.has(H)).toBe(true);
    } finally { await app.close(); }
  });
});
