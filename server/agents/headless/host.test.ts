// server/agents/headless/host.test.ts — the contract of the headless host, with the fake stream
// claude (../testdata/headless/fake-stream-claude.mjs) in real systemd user scopes. Each test has
// its own temp folder (FIFOs, out.jsonl, state) and its own unit names.
// After each test (also after a failing one): a new host closes every worker of the test with
// remove() (the product's close), then the test fails if a unit of this file is left. A last
// sweep stops what is left, so a leak fails one test and never reaches the next one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawn as spawnChild, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { addHost, hostOf } from "../host.js";
import { typeIntoAgentWhy, type ReplyTerminals } from "../../issues/reply.js";
import { HEADLESS_MAX_BYTES, HOLDER_SCRIPT, HeadlessHost, type HeadlessOpts } from "./host.js";
import { SendLog } from "./sendlog.js";
import { frame, userLine, type StreamEvent } from "./stream.js";

const FAKE = fileURLToPath(new URL("../testdata/headless/fake-stream-claude.mjs", import.meta.url));
const CHILD_CONSOLE = fileURLToPath(new URL("../testdata/headless/child-console.mts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PREFIX = `headless-test-${process.pid}-${randomBytes(3).toString("hex")}-`;
const SYSTEMCTL = existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "/bin/systemctl";
const BASH = existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "/bin/bash";
const BOOT_ID = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const SELF_START = (() => { const s = readFileSync("/proc/self/stat", "utf8"); return s.slice(s.lastIndexOf(") ") + 2).split(" ")[19]!; })();
const OK = { ok: true, notResent: [] };
// fallocate --punch-hole works in the temp folder (the trim tests need it; some filesystems lack it).
const PUNCH = (() => {
  const d = mkdtempSync(join(tmpdir(), "headless-punch-"));
  try {
    const f = join(d, "f");
    writeFileSync(f, Buffer.alloc(65536, 1));
    const bin = existsSync("/usr/bin/fallocate") ? "/usr/bin/fallocate" : "/bin/fallocate";
    execFileSync(bin, ["--punch-hole", "--offset", "0", "--length", "32768", f], { stdio: "ignore" });
    return true;
  } catch { return false; } finally { rmSync(d, { recursive: true, force: true }); }
})();
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

// The processes of a worker's scope: the program (its pid file), the holder (the program's
// parent) and the rest (the relay).
function scopePids(h: HeadlessHost, id: string): { all: number[]; program: number; holder: number; relay: number[] } {
  const cg = execFileSync(SYSTEMCTL, ["--user", "show", "-p", "ControlGroup", "--value", h.unit(id)], { encoding: "utf8" }).trim();
  const all = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number);
  const program = Number(readFileSync(join(tmp, "run", id, "pid"), "utf8").split(" ")[0]);
  const holder = Number(/^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${program}/status`, "utf8"))?.[1]);
  return { all, program, holder, relay: all.filter((p) => p !== program && p !== holder) };
}

// SIGKILL to every process of the scope at once (as the OOM killer or a crash of the machine
// would end them): the holder writes no exit file.
function sigkillScope(h: HeadlessHost, id: string): number[] {
  const { all } = scopePids(h, id);
  expect(all.length).toBeGreaterThanOrEqual(3); // holder, relay, program
  for (const pid of all) process.kill(pid, "SIGKILL");
  return all;
}

// No process with this pid (a zombie that its parent did not reap yet counts as gone).
function gone(pid: number): boolean {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(") ") + 2)[0] === "Z";
  } catch { return true; }
}
const sessionOf = (pid: number) => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(s.slice(s.lastIndexOf(") ") + 2).split(" ")[3]);
};
const umaskOf = (status: string) => /^Umask:\s*(\d+)/m.exec(status)?.[1] ?? null;

let tmp: string;
let hosts: HeadlessHost[] = [];
let removeHost: (() => void) | null = null;
let children: ChildProcess[] = [];
let stopped: number[] = [];

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "headless-host-")); });
afterEach(async () => {
  removeHost?.();
  removeHost = null;
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    const exited = new Promise((r) => c.once("exit", r));
    c.kill("SIGKILL");
    await exited;
  }
  children = [];
  for (const pid of stopped) try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
  stopped = [];
  for (const h of hosts) h.shutdown();
  hosts = [];
  let leaked: string[] = [];
  if (userSystemd()) {
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
  expect(leaked).toEqual([]); // remove() left no unit
}, 30_000);

type Rig = { h: HeadlessHost; events: StreamEvent[]; exits: Array<[number | null, boolean]> };

function rig(extra: Partial<HeadlessOpts> = {}): Rig {
  const events: StreamEvent[] = [];
  const exits: Array<[number | null, boolean]> = [];
  const h = new HeadlessHost({
    runDir: join(tmp, "run"), stateDir: join(tmp, "state"), unitPrefix: PREFIX, tickMs: 30,
    onEvent: (_id, e) => events.push(e), onExit: (_id, code, killed) => exits.push([code, killed]), ...extra,
  });
  hosts.push(h);
  return { h, events, exits };
}

const env = (id: string) => ({ PATH: process.env.PATH, HOME: process.env.HOME, FAKE_LOG: join(tmp, `${id}.fake.log`) });
const spawnFake = (h: HeadlessHost, id: string) => h.spawn({
  id, cwd: tmp, command: process.execPath,
  args: [FAKE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"],
  env: env(id),
});
async function startFake(h: HeadlessHost, id: string): Promise<void> {
  expect(await spawnFake(h, id)).toEqual(OK);
}
const bashProgram = (h: HeadlessHost, id: string, script: string) =>
  h.spawn({ id, cwd: tmp, command: "bash", args: ["-c", script], env: env(id) });

// The interrupts that the fake read.
const fakeControls = (id: string) => {
  try { return hits(readFileSync(join(tmp, `${id}.fake.log`), "utf8"), /"type":"control_request"/g); } catch { return 0; }
};
// The messages that the fake read, in order.
function fakeGot(id: string): string[] {
  let raw = "";
  try { raw = readFileSync(join(tmp, `${id}.fake.log`), "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: Array<{ text: string }> } })
    .filter((m) => m.type === "user").map((m) => m.message!.content[0]!.text);
}
const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;
const results = (r: Rig) => r.events.filter((e): e is Extract<StreamEvent, { kind: "result" }> => e.kind === "result");
const acks = (r: Rig, text: string) => r.events.filter((e) => e.kind === "ack" && e.text === text).length;
const openTexts = (h: HeadlessHost, id: string) => h.pending(id).map((e) => e.text);
const errLog = (id: string) => { try { return readFileSync(join(tmp, "run", id, "err.log"), "utf8"); } catch { return ""; } };
const hits = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// Bytes into the FIFO, as a writer that is not the host (latin1: one byte per char).
async function rawWrite(id: string, bytes: string | Buffer): Promise<void> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes;
  const fd = openSync(join(tmp, "run", id, "in.fifo"), constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    let done = 0;
    while (done < buf.length) {
      try { done += writeSync(fd, buf, done, buf.length - done); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
        await sleep(5);
      }
    }
  } finally { closeSync(fd); }
}
// "\n<bytes> <id> <json>\n", with any bytes as the JSON.
const rawFrame = (id: string, json: string) => Buffer.concat([
  Buffer.from(`\n${Buffer.byteLength(json, "latin1")} ${id} `), Buffer.from(json, "latin1"), Buffer.from("\n"),
]);
const userJson = (text: string) => `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${text}"}]},"uuid":"u"}`;

describe.skipIf(!userSystemd())("HeadlessHost with the fake stream claude", { timeout: 40_000 }, () => {
  it("a send through the seam: typeIntoAgentWhy goes to the host; Claude takes it; the log closes it", async () => {
    const r = rig();
    removeHost = addHost(r.h); // only here: the product registers no headless host
    await startFake(r.h, "w1");
    expect(hostOf("w1")).toBe(r.h);
    expect(hostOf("w2")).toBeNull();
    expect(await typeIntoAgentWhy(noTerminal, "w1", "hello\nthere", async () => {})).toBe("sent");
    await until("the result", () => results(r).length === 1);
    expect(results(r)[0]).toMatchObject({ subtype: "success", isError: false, text: "echo: hello\nthere" });
    expect(fakeGot("w1")).toEqual(["hello\nthere"]);
    expect(r.h.pending("w1")).toEqual([]);
    expect(await r.h.send("w2", "x")).toBe("not-live");
  });

  it("restart mid-turn: the new console takes the program back; each message goes once", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    await a.h.send("w1", "[fake sleep=1500] long");
    await until("the ack of long", () => acks(a, "[fake sleep=1500] long") === 1);
    await a.h.send("w1", "after");                       // Claude takes it into the turn
    await until("the relay passed it", () => fakeGot("w1").includes("after"));
    a.h.shutdown();
    expect(results(a)).toEqual([]);
    expect(a.exits).toEqual([]);

    const b = rig();
    expect(b.h.has("w1")).toBe(false);
    expect(await b.h.hasSession("w1")).toBe(true);
    expect(await b.h.reattach("w1")).toBe(true);
    await until("the result", () => results(b).length === 1);
    await sleep(300);
    expect(results(b).map((e) => [e.text, e.turns])).toEqual([["echo: after", 2]]); // one turn, as claude
    expect(fakeGot("w1")).toEqual(["[fake sleep=1500] long", "after"]);
    expect(b.h.pending("w1")).toEqual([]);
    expect(b.exits).toEqual([]);
  });

  it("SIGKILL mid-turn: onExit with no code, no process or scope left; the next start sends again only the messages that Claude did not take, never a passed command (round 3, 1)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "[fake sleep=5000] slow");
    await until("the ack of slow", () => acks(r, "[fake sleep=5000] slow") === 1);
    await r.h.send("w1", "/clear");                      // a local command waits for the turn
    await r.h.send("w1", "after");                       // queued behind it
    await until("the relay passed both", () => fakeGot("w1").includes("after"));
    const pids = sigkillScope(r.h, "w1");
    await until("onExit", () => r.exits.length === 1);
    expect(r.exits).toEqual([[null, false]]);
    expect(pids.filter((p) => !gone(p))).toEqual([]);
    await until("no unit", () => ourUnits().length === 0, 3_000);
    expect(r.h.has("w1")).toBe(false);
    expect(await r.h.send("w1", "x")).toBe("not-live");
    expect(openTexts(r.h, "w1")).toEqual(["/clear", "after"]);

    // The killed program can have run /clear with no line about it: a second one would wipe the
    // resumed session. It is not sent again, and the start says so.
    expect(await spawnFake(r.h, "w1")).toEqual({ ok: true, notResent: [{ uuid: expect.any(String), text: "/clear" }] });
    await until("the result of after", () => results(r).some((e) => e.text === "echo: after"));
    const got = fakeGot("w1");
    expect([count(got, "[fake sleep=5000] slow"), count(got, "/clear"), count(got, "after")]).toEqual([1, 1, 2]);
    expect(r.h.pending("w1")).toEqual([]);
  });

  it("a slash re-read: a console that reads its lines again acks no other command (finding 4)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    await a.h.send("w1", "[fake sleep=800] work");
    await until("the relay passed it", () => fakeGot("w1").length === 1);
    await a.h.send("w1", "/model a");
    await a.h.send("w1", "[fake sleep=8000] slow");      // queued behind /model a
    await a.h.send("w1", "/model b");
    // /model a ran; slow runs; /model b waits in Claude's queue.
    await until("only /model b open", () => JSON.stringify(openTexts(a.h, "w1")) === JSON.stringify(["/model b"]));
    a.h.shutdown();
    // The console stopped before it saved its place: the next one reads out.jsonl from 0.
    const readFile = join(tmp, "state", "w1", "read.json");
    writeFileSync(readFile, JSON.stringify({ ...JSON.parse(readFileSync(readFile, "utf8")) as object, off: 0 }));

    const b = rig();
    expect(await b.h.reattach("w1")).toBe(true);
    expect(results(b).map((e) => e.text)).toContain("Set model to `a` for this session only"); // read again
    expect(openTexts(b.h, "w1")).toEqual(["/model b"]);
    sigkillScope(b.h, "w1");                              // the program dies before it runs /model b
    await until("onExit", () => b.exits.length === 1);
    expect(openTexts(b.h, "w1")).toEqual(["/model b"]);

    expect(await spawnFake(b.h, "w1")).toEqual({ ok: true, notResent: [{ uuid: expect.any(String), text: "/model b" }] });
    await b.h.send("w1", "next");
    await until("its result", () => results(b).some((e) => e.text === "echo: next"));
    const got = fakeGot("w1");
    expect([count(got, "/model a"), count(got, "[fake sleep=8000] slow"), count(got, "/model b")]).toEqual([1, 1, 1]);
    expect(b.h.pending("w1")).toEqual([]);
  });

  it("a cut output line: the reader waits for its end, and gives the line once, whole", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "[fake split=600] é cut");
    const out = join(tmp, "run", "w1", "out.jsonl");
    await until("a cut last line", () => { const b = readFileSync(out); return b.length > 0 && b[b.length - 1] !== 0x0a; });
    await sleep(150); // a few ticks of the reader
    expect(results(r)).toEqual([]);
    await until("the result", () => results(r).length === 1);
    await sleep(150);
    expect(results(r).map((e) => e.text)).toEqual(["echo: [fake split=600] é cut"]);
  });

  it("a cut last output line, then a new start: the new program's lines are read whole (finding 13)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "[fake split=8000] cut");
    const out = join(tmp, "run", "w1", "out.jsonl");
    await until("a cut last line", () => { const b = readFileSync(out); return b.length > 0 && b[b.length - 1] !== 0x0a; });
    await r.h.stop("w1");
    await until("onExit", () => r.exits.length === 1);
    expect(r.exits).toEqual([[null, true]]);

    const before = r.events.length;
    await startFake(r.h, "w1");
    const old = readFileSync(join(tmp, "run", "w1", "out.1.jsonl"));
    expect(old[old.length - 1]).not.toBe(0x0a);           // the cut line stays in the last file
    await r.h.send("w1", "after");
    await until("its result", () => results(r).length === 1);
    expect(results(r).map((e) => e.text)).toEqual(["echo: after"]);
    expect(r.events.slice(before).map((e) => e.kind === "lifecycle" ? e.state : e.kind)).toEqual(["queued", "started", "init", "ack", "result", "completed"]);
    expect(readFileSync(out, "utf8").startsWith("\n")).toBe(true); // the holder's "\n" before a start
  });

  it("the relay drops each line that is not a whole frame of the console's 2 shapes; the worker lives (findings 5, 11)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await rawWrite("w1", `\n80 half-1 {"type":"user","message":{"role":"us`); // a console that stopped mid-write
    await rawWrite("w1", "\nnot a frame at all");
    await rawWrite("w1", rawFrame("g-1", "{garbage}"));                        // the right length, not a message
    await rawWrite("w1", rawFrame("g-2", "[1]"));
    await rawWrite("w1", rawFrame("c-1", userJson("a\u0001b")));               // a control byte
    await rawWrite("w1", rawFrame("c-2", userJson("a\u007fb")));               // DEL
    await rawWrite("w1", rawFrame("c-3", userJson("a\u00ffb")));               // a byte above 0x7f
    await rawWrite("w1", rawFrame("c-4", userJson("a\u0000b")));               // NUL: bash drops it, so the length is wrong
    await rawWrite("w1", Buffer.concat([Buffer.from("\n"), Buffer.alloc(1_100_000, 0x61), Buffer.from("\n")])); // above the limit
    await r.h.send("w1", "after the drops");
    await until("its result", () => results(r).length === 1, 25_000);
    expect(fakeGot("w1")).toEqual(["after the drops"]);
    expect(r.h.has("w1")).toBe(true);
    const log = errLog("w1");
    expect([
      hits(log, /relay: dropped a cut line/g), hits(log, /relay: dropped a line that is not a frame/g),
      hits(log, /relay: dropped a frame that is not a message/g), hits(log, /relay: dropped a frame with a byte that is not printable ASCII/g),
      hits(log, /relay: dropped a line above 1048576 bytes/g),
    ]).toEqual([2, 1, 2, 3, 1]);
  });

  it("(control) with no relay, the program ends at the half line, as claude does", () => {
    const p = spawnSync(process.execPath, [FAKE], { input: `{"type":"user","message":{"role":"us\n`, encoding: "utf8", timeout: 10_000 });
    expect(p.status).toBe(1);
    expect(p.stderr).toMatch(/^Error parsing streaming input line/);
  });

  it("(control) the fake splits input lines at \"\\n\" only, as claude; not at U+2028 or U+2029", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "a\u2028b\u2029c" }, uuid: "u-1" }).replace(/\\u202[89]/g, (m) => JSON.parse(`"${m}"`) as string);
    expect(line).toContain("\u2028");
    const log = join(tmp, "control.log");
    const p = spawnSync(process.execPath, [FAKE], { input: `${line}\n`, encoding: "utf8", timeout: 10_000, env: { ...process.env, FAKE_LOG: log } });
    expect(p.status).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { message: { content: string } }).message.content))
      .toEqual(["a\u2028b\u2029c"]);
  });

  it("the holder refuses a relative folder, an in.fifo that is not a FIFO, and a link (finding 14)", () => {
    const d = join(tmp, "h1");
    mkdirSync(d);
    writeFileSync(join(d, "env"), "");
    writeFileSync(join(d, "in.fifo"), "plain");
    const holder = (dir: string) => spawnSync(BASH, ["-p", HOLDER_SCRIPT, dir, "/usr/bin/true"], { encoding: "utf8", timeout: 5_000 });
    expect(holder(d).status).toBe(70);
    expect(readFileSync(join(d, "in.fifo"), "utf8")).toBe("plain");
    rmSync(join(d, "in.fifo"));
    execFileSync("mkfifo", [join(tmp, "elsewhere.fifo")]);
    symlinkSync(join(tmp, "elsewhere.fifo"), join(d, "in.fifo"));
    expect(holder(d).status).toBe(70);
    expect(holder("relative/folder").status).toBe(70);
    expect(existsSync(join(d, "out.jsonl"))).toBe(false);
  });

  it("a repeat has no double effect: a frame given twice, an output read twice", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    const once = frame("dup-1", userLine("dup-1", "twice"));
    await rawWrite("w1", Buffer.concat([once, once]));
    await until("its result", () => results(a).length === 1);
    await a.h.send("w1", "same");
    await until("two results", () => results(a).length === 2);
    a.h.shutdown();

    // The next console reads out.jsonl from 0 (it stopped before it saved its place).
    const readFile = join(tmp, "state", "w1", "read.json");
    writeFileSync(readFile, JSON.stringify({ ...JSON.parse(readFileSync(readFile, "utf8")) as object, off: 0 }));
    const b = rig();
    expect(await b.h.reattach("w1")).toBe(true);
    expect(results(b)).toHaveLength(2);                // onEvent: at least once
    await b.h.send("w1", "dup-check");                 // a new message still goes
    await until("its result", () => results(b).length === 3);
    await sleep(300);
    expect(fakeGot("w1")).toEqual(["twice", "same", "dup-check"]);
    expect(b.h.pending("w1")).toEqual([]);
  });

  it("a resend with no ack: a message logged but not written goes after the restart, once", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    await a.h.send("w1", "first");
    await until("its result", () => results(a).length === 1);
    a.h.shutdown();
    // The console logged "late" and stopped before its write.
    new SendLog(join(tmp, "state", "w1", "sendlog.json")).add("late");

    const b = rig();
    expect(await b.h.reattach("w1")).toBe(true);
    await until("the result of late", () => results(b).some((e) => e.text === "echo: late"));
    await sleep(300);
    expect(fakeGot("w1")).toEqual(["first", "late"]);
    expect(b.h.pending("w1")).toEqual([]);
  });

  it("a write that stalls: send() returns in time; the resend timer gives the frame again, whole, once (findings 15, 16)", async () => {
    const r = rig({ sendWaitMs: 100, writeStallMs: 200, resendMs: 500 });
    await startFake(r.h, "w1");
    const { relay } = scopePids(r.h, "w1");
    expect(relay).toHaveLength(1);
    process.kill(relay[0]!, "SIGSTOP");                 // the relay reads no input: the FIFO fills
    stopped.push(relay[0]!);
    const big = `big ${"x".repeat(300_000)}`;
    const t0 = Date.now();
    expect(await r.h.send("w1", big)).toBe("sent");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await r.h.interrupt("w1")).toBe(false);     // waits for the write before it, not for ever
    expect(Date.now() - t0).toBeLessThan(2_000);
    await sleep(1_500);                                 // writes stall; the timer gives the frame again
    expect(fakeGot("w1")).toEqual([]);
    expect(openTexts(r.h, "w1")).toEqual([big]);
    process.kill(relay[0]!, "SIGCONT");
    await until("its result", () => results(r).some((e) => e.text === "echo: big xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), 20_000);
    await sleep(600);
    expect(fakeGot("w1")).toEqual([big]);
    expect(r.h.pending("w1")).toEqual([]);
    expect(errLog("w1")).toMatch(/relay: dropped a cut line/); // the stalled write's part
    expect(fakeControls("w1")).toBe(0);
  });

  it("an interrupt behind a stalled write: false in time, and never written after its wait ended (round 3, 6)", async () => {
    const r = rig({ sendWaitMs: 100, writeStallMs: 10_000 });
    await startFake(r.h, "w1");
    const { relay } = scopePids(r.h, "w1");
    process.kill(relay[0]!, "SIGSTOP");                 // the FIFO fills; the write waits, it does not stop
    stopped.push(relay[0]!);
    const big = `big ${"x".repeat(300_000)}`;
    expect(await r.h.send("w1", big)).toBe("sent");
    const t0 = Date.now();
    expect(await r.h.interrupt("w1")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
    process.kill(relay[0]!, "SIGCONT");                 // the write before it goes on, whole
    await until("its result", () => results(r).length === 1, 20_000);
    await sleep(500);
    expect(results(r).map((e) => [e.subtype, e.text])).toEqual([["success", `echo: ${big.slice(0, 40)}`]]);
    expect(fakeControls("w1")).toBe(0);                 // a later turn is safe from it
    expect(r.events.filter((e) => e.kind === "control")).toEqual([]);
    expect(fakeGot("w1")).toEqual([big]);
  });

  it("the close removes the program and both folders, with no onExit (finding 9)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "x");
    await until("its result", () => results(r).length === 1);
    expect(ourUnits()).toEqual([r.h.unit("w1")]);
    const { all } = scopePids(r.h, "w1");
    expect(await r.h.remove("w1")).toBe("removed");
    expect(existsSync(join(tmp, "run", "w1"))).toBe(false);
    expect(existsSync(join(tmp, "state", "w1"))).toBe(false);
    await until("no unit", () => ourUnits().length === 0, 3_000);
    expect(all.filter((p) => !gone(p))).toEqual([]);
    expect(r.h.owns("w1")).toBe(false);
    expect(r.h.has("w1")).toBe(false);
    await sleep(200);
    expect(r.exits).toEqual([]);
  });

  it("kill: onExit says killed, and the holder, the relay, the program and the scope are gone; a program that ends by itself gives its code", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    const s = scopePids(r.h, "w1");
    expect([s.all.length, s.relay.length, s.all.includes(s.holder)]).toEqual([3, 1, true]);
    r.h.kill("w1");
    await until("onExit", () => r.exits.length === 1);
    expect(r.exits[0]).toEqual([null, true]);
    expect([s.holder, s.program, ...s.relay].filter((p) => !gone(p))).toEqual([]);
    await until("no unit", () => ourUnits().length === 0, 3_000);

    expect(await bashProgram(r.h, "w2", "sleep 0.3; exit 3")).toEqual(OK);
    await until("onExit", () => r.exits.length === 2);
    expect(r.exits[1]).toEqual([3, false]);
    expect(await bashProgram(r.h, "w3", "exit 4")).toEqual(OK);
    await until("onExit", () => r.exits.length === 3);
    expect(r.exits[2]).toEqual([4, false]);
    await until("no unit", () => ourUnits().length === 0, 3_000);
  });

  it("a program that ends by itself and leaves a child in its own session: the child and the scope go (finding 1)", async () => {
    const r = rig();
    const childPid = join(tmp, "child.pid");
    expect(await bashProgram(r.h, "w1", `setsid bash -c 'echo $$ > ${childPid}; exec sleep 300' & sleep 0.5; exit 3`)).toEqual(OK);
    const pid = Number(await until("the child's pid", () => { try { return readFileSync(childPid, "utf8").trim() || null; } catch { return null; } }));
    await until("the child sleeps", () => readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep"));
    expect(sessionOf(pid)).toBe(pid);                   // its own session: the holder's `kill 0` misses it
    await until("onExit", () => r.exits.length === 1);
    expect(r.exits).toEqual([[3, false]]);
    expect(gone(pid)).toBe(true);                       // onExit comes after the stop of the scope
    await until("no unit", () => ourUnits().length === 0, 3_000);
  });

  it("a program that ended while the console was down: its last lines and its code arrive at the reattach, once (finding 7)", async () => {
    const a = rig();
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "the last words", session_id: "s-1" });
    expect(await bashProgram(a.h, "w1", `sleep 0.5; printf '%s\\n' '${line}'; exit 5`)).toEqual(OK);
    a.h.shutdown();
    await until("the exit file", () => existsSync(join(tmp, "run", "w1", "exit")));
    expect(a.exits).toEqual([]);

    const b = rig();
    expect(await b.h.hasSession("w1")).toBe(false);
    expect(await b.h.reattach("w1")).toBe(false);
    expect(results(b).map((e) => e.text)).toEqual(["the last words"]);
    expect(b.exits).toEqual([[5, false]]);
    await until("no unit", () => ourUnits().length === 0, 3_000);
    expect(await b.h.reattach("w1")).toBe(false);
    const c = rig();
    expect(await c.h.reattach("w1")).toBe(false);
    await sleep(200);
    expect([b.exits, c.exits, results(c)]).toEqual([[[5, false]], [], []]);
  });

  it("a line above the FIFO's atomic size (4096 bytes) arrives whole, once", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    const big = `big ${"é😀 abc ".repeat(20_000)}end`; // ~260 KB of UTF-8, ~400 KB as escaped JSON
    expect(Buffer.byteLength(big)).toBeGreaterThan(200_000);
    await r.h.send("w1", big);
    await until("its result", () => results(r).length === 1, 20_000);
    expect(fakeGot("w1")).toEqual([big]);
    expect(acks(r, big)).toBe(1);
    expect(r.h.pending("w1")).toEqual([]);
  });

  it("a message above the limit: a too-large result with the limit, no rejection, nothing logged or written; the seam's caller gets too-large (PR 3); a message at the limit goes (round 3, 2)", async () => {
    const r = rig();
    removeHost = addHost(r.h);
    await startFake(r.h, "w1");
    const over = await r.h.send("w1", "a".repeat(HEADLESS_MAX_BYTES));
    expect(over).toEqual({ refused: "too-large", bytes: userLine(randomUUID(), "a".repeat(HEADLESS_MAX_BYTES)).length, limit: 1_048_576 });
    expect(await typeIntoAgentWhy(noTerminal, "w1", "é".repeat(HEADLESS_MAX_BYTES / 4), async () => {})).toBe("too-large");
    expect(r.h.pending("w1")).toEqual([]);
    const just = "b".repeat(HEADLESS_MAX_BYTES - 200);
    expect(await r.h.send("w1", just)).toBe("sent");
    await until("its result", () => results(r).length === 1, 30_000);
    expect(fakeGot("w1")).toEqual([just]);
    expect(errLog("w1")).not.toMatch(/dropped/);
  });

  it("a message keeps every char; a lone surrogate becomes U+FFFD (finding 12)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    const text = "nul\u0000 ctl\u0001\u001b del\u007f ls\u2028 ps\u2029 cr\r\nlf tab\t emoji😀 é lone\ud800 low\udc00 end";
    expect(await r.h.send("w1", text)).toBe("sent");
    await until("its result", () => results(r).length === 1);
    expect(fakeGot("w1")).toEqual([text.replace("\ud800", "\ufffd").replace("\udc00", "\ufffd")]);
    expect(r.h.pending("w1")).toEqual([]);
  });

  it("two sends at once: both lines arrive whole, in order, with no mix", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    const one = `one ${"a".repeat(100_000)}`;
    const two = `two ${"b".repeat(100_000)}`;
    expect(await Promise.all([r.h.send("w1", one), r.h.send("w1", two)])).toEqual(["sent", "sent"]);
    await until("both taken", () => r.h.pending("w1").length === 0 && fakeGot("w1").length === 2, 20_000);
    expect(fakeGot("w1")).toEqual([one, two]);
    expect(errLog("w1")).not.toMatch(/dropped/);
  });

  it("an interrupt ends the turn: a control answer, then an error result", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "[fake sleep=5000] long");
    await until("the ack", () => acks(r, "[fake sleep=5000] long") === 1);
    expect(await r.h.interrupt("w1")).toBe(true);
    await until("the result", () => results(r).length === 1);
    expect(r.events.find((e) => e.kind === "control")).toMatchObject({ ok: true });
    expect(results(r)[0]).toMatchObject({ subtype: "error_during_execution", isError: true, text: null });
    expect(r.h.pending("w1")).toEqual([]);
  });

  it("a local command closes at the result of its own turn, not at the turn before", async () => {
    const atResult: string[][] = [];
    let host: HeadlessHost | null = null;
    const r = rig({ onEvent: (_id, e) => { if (e.kind === "result") atResult.push(openTexts(host!, "w1")); } });
    host = r.h;
    await startFake(r.h, "w1");
    await r.h.send("w1", "[fake sleep=600] work");
    await until("the relay passed it", () => fakeGot("w1").length === 1);
    await r.h.send("w1", "/model sonnet");
    await r.h.send("w1", "/compact");
    await until("three results", () => atResult.length === 3);
    expect(atResult).toEqual([["/model sonnet", "/compact"], ["/compact"], []]);
  });

  it("SIGKILL of the relay: the program reads the end of its input, ends its turn and exits; the scope goes; a new start works", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "[fake sleep=800] during");
    await until("its ack", () => acks(r, "[fake sleep=800] during") === 1);
    const s = scopePids(r.h, "w1");
    expect(s.relay).toHaveLength(1);
    process.kill(s.relay[0]!, "SIGKILL");
    await until("onExit", () => r.exits.length === 1);
    expect(r.exits).toEqual([[0, false]]);
    expect(results(r).map((e) => e.text)).toEqual(["echo: [fake sleep=800] during"]);
    expect(s.all.filter((p) => !gone(p))).toEqual([]);
    await until("no unit", () => ourUnits().length === 0, 3_000);

    await startFake(r.h, "w1");
    await r.h.send("w1", "next");
    await until("its result", () => results(r).length === 2);
    expect(fakeGot("w1")).toEqual(["[fake sleep=800] during", "next"]);
  });

  it("SIGKILL of the console process: no other console writes while it lives; then its lock is taken over and the reply arrives (finding 11)", async () => {
    const msg = "[fake sleep=1500] from the child console";
    const child = spawnChild(process.execPath, [
      "--import", "tsx", CHILD_CONSOLE, join(tmp, "run"), join(tmp, "state"), PREFIX, "w1", tmp, join(tmp, "w1.fake.log"),
    ], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    await until("the child console's worker took the message", () => /ready|failed/.test(out), 25_000);
    expect(out).toContain("ready");

    const b = rig();
    expect(await b.h.reattach("w1")).toBe(false);       // the child console holds the worker
    expect(await b.h.send("w1", "x")).toBe("not-live");
    expect(await b.h.spawn({ id: "w1", cwd: tmp, command: process.execPath, args: [FAKE], env: env("w1") })).toMatchObject({ ok: false });
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    expect(await b.h.reattach("w1")).toBe(true);        // the lock of a console that ended: taken over
    await until("the result", () => results(b).length === 1);
    expect(results(b)[0]!.text).toBe(`echo: ${msg.slice(0, 40)}`);
    expect(fakeGot("w1")).toEqual([msg]);
    expect(b.h.pending("w1")).toEqual([]);
  });

  it("a second host in the same process is refused: one writer per worker (finding 10, 11)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    const b = rig();
    expect(await b.h.reattach("w1")).toBe(false);
    expect(await b.h.send("w1", "x")).toBe("not-live");
    expect(await b.h.spawn({ id: "w1", cwd: tmp, command: process.execPath, args: [FAKE], env: env("w1") }))
      .toEqual({ ok: false, why: "another console holds the worker w1" });
    expect(await b.h.remove("w1")).toBe("held");        // refused: the worker stays
    expect(existsSync(join(tmp, "run", "w1"))).toBe(true);
    expect(a.h.has("w1")).toBe(true);
    await a.h.send("w1", "still here");
    await until("its result", () => results(a).length === 1);
    expect(fakeGot("w1")).toEqual(["still here"]);
  });

  it("two spawns of one worker at once give one program; a kill during a spawn ends it, killed (finding 10)", async () => {
    const r = rig();
    expect(await Promise.all([spawnFake(r.h, "w1"), spawnFake(r.h, "w1")])).toEqual([OK, OK]);
    await sleep(300);
    expect(r.exits).toEqual([]);                         // the second start stopped the first, with no onExit
    expect(ourUnits()).toEqual([r.h.unit("w1")]);
    expect(scopePids(r.h, "w1").all).toHaveLength(3);
    await r.h.send("w1", "one program");
    await until("its result", () => results(r).length === 1);
    expect(fakeGot("w1")).toEqual(["one program"]);

    const p = spawnFake(r.h, "w2");
    r.h.kill("w2");
    expect(await p).toEqual(OK);
    await until("onExit", () => r.exits.length === 1);
    expect(r.exits).toEqual([[null, true]]);
    expect(r.h.has("w2")).toBe(false);
  });

  it("hostile ids: refused or not live; nothing outside the folders (finding 8)", async () => {
    const r = rig();
    for (const id of ["", ".", "..", "../x", "a/b", "a b", "a\nb", "é", "x".repeat(65), "w1.scope", "-v\u0000"]) {
      expect(await r.h.spawn({ id, cwd: tmp, command: process.execPath, args: [FAKE], env: env("x") })).toMatchObject({ ok: false });
      expect(await r.h.send(id, "x")).toBe("not-live");
      expect(await r.h.reattach(id)).toBe(false);
      expect(await r.h.hasSession(id)).toBe(false);
      expect(await r.h.interrupt(id)).toBe(false);
      expect([r.h.has(id), r.h.owns(id), r.h.inputReady(id), r.h.pending(id)]).toEqual([false, false, false, []]);
      expect(() => r.h.kill(id)).not.toThrow();
      await r.h.stop(id);
      expect(await r.h.remove(id)).toBe("failed");
    }
    expect(existsSync(join(tmp, "x"))).toBe(false);
    expect(existsSync(join(tmp, "run"))).toBe(false);
  });

  it("a hostile environment: refused for the program; the console's own reaches neither the holder nor the program (findings 2, 3)", async () => {
    const r = rig();
    const bad: Array<[string, string]> = [
      ["BASH_ENV", "/x"], ["ENV", "/x"], ["SHELLOPTS", "xtrace"], ["BASHOPTS", "extdebug"], ["PS4", "$(id)"],
      ["BASH_FUNC_mv%%", "() { :; }"], ["A=B", "x"], ["", "x"], ["X", "a\u0000b"],
    ];
    for (const [k, v] of bad) {
      expect(await r.h.spawn({ id: "w2", cwd: tmp, command: process.execPath, args: [FAKE], env: { PATH: "/usr/bin", [k]: v } }), k).toMatchObject({ ok: false });
    }
    for (const command of ["-x", "A=1", "a\u0000b"]) {
      expect(await r.h.spawn({ id: "w2", cwd: tmp, command, args: [], env: {} })).toMatchObject({ ok: false });
    }
    expect(r.h.owns("w2")).toBe(false);

    // The console's own environment holds traps: programs of the same name first on its PATH,
    // BASH_ENV, ENV, functions and shell options.
    const evil = join(tmp, "evil");
    const marks = join(tmp, "marks");
    mkdirSync(evil);
    mkdirSync(marks);
    for (const b of ["systemd-run", "systemctl", "setsid", "bash", "mv", "mkfifo", "env", "sh"]) {
      writeFileSync(join(evil, b), `#!/bin/sh\n: > ${marks}/${b}\nexit 1\n`, { mode: 0o755 });
    }
    writeFileSync(join(evil, "rc"), `: > ${marks}/rc\n`);
    const saved = { ...process.env };
    Object.assign(process.env, {
      PATH: `${evil}:${process.env.PATH}`, BASH_ENV: join(evil, "rc"), ENV: join(evil, "rc"),
      "BASH_FUNC_mv%%": `() { : > ${marks}/func-mv; }`, "BASH_FUNC_printf%%": `() { : > ${marks}/func-printf; }`,
      "BASH_FUNC_read%%": `() { : > ${marks}/func-read; }`, SHELLOPTS: "xtrace", PS4: `$(: > ${marks}/ps4)`,
      LC_ALL: "C", LANG: "C",
    });
    const envLog = join(tmp, "env.log");
    const want = {
      PATH: "/usr/bin:/bin", HOME: saved.HOME ?? "/", LANG: "en_US.UTF-8", FAKE_LOG: join(tmp, "w1.fake.log"), FAKE_ENV_LOG: envLog,
      ODD: `a\nb c'"$(: > ${marks}/odd)\``,
    };
    try {
      expect(await r.h.spawn({ id: "w1", cwd: tmp, command: process.execPath, args: [FAKE], env: want })).toEqual(OK);
      await r.h.send("w1", "hi");
      await until("its result", () => results(r).length === 1);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(readdirSync(marks)).toEqual([]);
    const got = JSON.parse(readFileSync(envLog, "utf8").trim()) as { env: Record<string, string>; umask: string };
    expect(got.env).toEqual(want);                       // exactly its env: no LC_ALL, nothing of the console
    expect(got.umask).toBe(umaskOf(readFileSync("/proc/self/status", "utf8"))); // the console's umask
    expect(fakeGot("w1")).toEqual(["hi"]);
  });

  it("the folders are 0700 and the files 0600; relative folders work; the env file is gone after the start (finding 14)", async () => {
    const r = rig({ runDir: relative(process.cwd(), join(tmp, "run")), stateDir: relative(process.cwd(), join(tmp, "state")) });
    await startFake(r.h, "w1");
    await r.h.send("w1", "x");
    await until("its result", () => results(r).length === 1);
    await startFake(r.h, "w1");                          // a second start: out.1.jsonl
    const run = join(tmp, "run", "w1");
    const state = join(tmp, "state", "w1");
    const mode = (p: string) => (lstatSync(p).mode & 0o777).toString(8);
    expect([mode(run), mode(state)]).toEqual(["700", "700"]);
    const files = [
      ...["in.fifo", "out.jsonl", "out.1.jsonl", "err.log", "passed", "pid", "gen", "writer.lock"].map((f) => join(run, f)),
      ...["read.json", "sendlog.json"].map((f) => join(state, f)),
    ];
    expect(files.map((f) => [f, mode(f)])).toEqual(files.map((f) => [f, "600"]));
    expect(existsSync(join(run, "env"))).toBe(false);
  });

  it("no call of the seam rejects for an I/O fault (finding 8)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    a.h.shutdown();
    rmSync(join(tmp, "run", "w1", "in.fifo"));
    const b = rig();
    expect(await b.h.reattach("w1")).toBe(false);       // the FIFO is gone
    expect(b.h.has("w1")).toBe(false);
    expect(await b.h.send("w1", "x")).toBe("not-live");
    expect(await b.h.interrupt("w1")).toBe(false);

    writeFileSync(join(tmp, "run", "w1", "pid"), "garbage");
    expect(await b.h.reattach("w1")).toBe(false);
    expect(await b.h.hasSession("w1")).toBe(false);

    expect(await b.h.spawn({ id: "w2", cwd: join(tmp, "none"), command: process.execPath, args: [FAKE], env: env("w2") })).toMatchObject({ ok: false });
    writeFileSync(join(tmp, "a-file"), "");
    const c = rig({ stateDir: join(tmp, "a-file") });
    expect(await c.h.spawn({ id: "w3", cwd: tmp, command: process.execPath, args: [FAKE], env: env("w3") })).toMatchObject({ ok: false });
    expect(await c.h.reattach("w3")).toBe(false);

    await startFake(b.h, "w4");
    rmSync(join(tmp, "state", "w4"), { recursive: true });
    expect(await b.h.send("w4", "x")).toBe("not-live"); // the send log cannot be written
  });

  it("out.jsonl: a truncate reads again from 0; a line above 16 MiB and lines that are not events are skipped (finding 6)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    await r.h.send("w1", "one");
    await until("its result", () => results(r).length === 1);
    truncateSync(join(tmp, "run", "w1", "out.jsonl"), 0);
    await sleep(200);                                     // the reader sees the shorter file
    await r.h.send("w1", "two");
    await until("its result", () => results(r).length === 2);
    expect(results(r).map((e) => e.text)).toEqual(["echo: one", "echo: two"]);

    const q = rig();
    const prog = join(tmp, "long-line.cjs");
    const last = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "after the long line", session_id: "s-2" });
    writeFileSync(prog, [
      `const fs = require("fs");`,
      `fs.writeSync(1, Buffer.alloc(${17 << 20}, 0x78));`,
      `fs.writeSync(1, "\\nnot json\\n[1]\\nnull\\n{\\"type\\":\\"result\\"\\n");`,
      `fs.writeSync(1, ${JSON.stringify(`${last}\n`)});`,
      `setInterval(() => {}, 1 << 30);`,
    ].join("\n"));
    expect(await q.h.spawn({ id: "w2", cwd: tmp, command: process.execPath, args: [prog], env: env("w2") })).toEqual(OK);
    await until("the line after the long one", () => results(q).length === 1, 20_000);
    expect(results(q).map((e) => e.text)).toEqual(["after the long line"]);
    expect(q.events.map((e) => e.kind)).toEqual(["result"]);
    expect(JSON.parse(readFileSync(join(tmp, "state", "w2", "read.json"), "utf8"))).toMatchObject({ skip: false });
  });

  it("an input with no replay: its command_lifecycle closes it; an unknown command and a text with a slash go once; a new start sends none again (round 3, 1)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    const sent = ["/fake-noreplay", "/nosuchcmd now", "/tmp/x is full"];
    for (const t of sent) expect(await r.h.send("w1", t)).toBe("sent");
    await until("three results", () => results(r).length === 3);
    await until("the log is empty", () => r.h.pending("w1").length === 0, 3_000);
    expect(results(r).map((e) => e.text)).toEqual(["Ran /fake-noreplay", "echo: /nosuchcmd now", "echo: /tmp/x is full"]);
    expect(sent.map((t) => acks(r, t))).toEqual([0, 1, 1]); // the first: no replay, only its lifecycle
    expect(await spawnFake(r.h, "w1")).toEqual(OK);
    await r.h.send("w1", "after");
    await until("its result", () => results(r).length === 4);
    expect(fakeGot("w1")).toEqual([...sent, "after"]);
  });

  it("a lock of another boot with our pid and start time is taken over; a lock of this boot is refused (round 3, 4)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    a.h.shutdown();
    const lock = join(tmp, "run", "w1", "writer.lock");
    expect(existsSync(lock)).toBe(false);               // the shutdown let it go
    writeFileSync(lock, `${BOOT_ID} ${process.pid} ${SELF_START} other\n`); // the control
    const b = rig();
    expect(await b.h.reattach("w1")).toBe(false);
    expect(await b.h.send("w1", "x")).toBe("not-live");
    writeFileSync(lock, `another-boot ${process.pid} ${SELF_START} other\n`);
    expect(await b.h.reattach("w1")).toBe(true);
    expect(readFileSync(lock, "utf8").startsWith(`${BOOT_ID} ${process.pid} ${SELF_START} `)).toBe(true);
    expect(readFileSync(lock, "utf8")).not.toMatch(/ other\n$/);
    await b.h.send("w1", "x");
    await until("its result", () => results(b).length === 1);
  });

  it("a pid file of another boot is no session: the reattach ends it at once, with no code (round 3, 4)", async () => {
    const a = rig();
    expect(await bashProgram(a.h, "w1", "sleep 30")).toEqual(OK);
    a.h.shutdown();
    const file = join(tmp, "run", "w1", "pid");
    const [pid, start, boot] = readFileSync(file, "utf8").trim().split(" ");
    expect(boot).toBe(BOOT_ID);
    const b = rig();
    expect(await b.h.hasSession("w1")).toBe(true);      // the control: the program lives
    writeFileSync(file, `${pid} ${start} another-boot\n`);
    expect(await b.h.hasSession("w1")).toBe(false);
    expect(await b.h.reattach("w1")).toBe(false);
    expect(b.exits).toEqual([[null, false]]);
    await until("no unit", () => ourUnits().length === 0, 3_000);
    expect(gone(Number(pid))).toBe(true);
  });

  it("a start that fails after the env file is written: the file is gone, the lock too; the next start works (round 3, 5)", async () => {
    const r = rig();
    await startFake(r.h, "w1");
    r.h.kill("w1");
    await until("onExit", () => r.exits.length === 1);
    const run = join(tmp, "run", "w1");
    rmSync(join(run, "err.log"));
    mkdirSync(join(run, "err.log"));                    // openSync(err.log) throws after the env file
    const res = await spawnFake(r.h, "w1");
    expect(res).toMatchObject({ ok: false, why: expect.stringMatching(/EISDIR/) });
    expect([existsSync(join(run, "env")), existsSync(join(run, "writer.lock"))]).toEqual([false, false]);
    rmSync(join(run, "err.log"), { recursive: true });
    await startFake(r.h, "w1");
    expect(existsSync(join(run, "env"))).toBe(false);
  });

  it("a left env file goes when a host is made; one under a live lock stays (round 3, 5)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    await startFake(a.h, "w2");
    await startFake(a.h, "w3");
    a.h.shutdown();
    const run = (id: string, f: string) => join(tmp, "run", id, f);
    for (const id of ["w1", "w2", "w3"]) writeFileSync(run(id, "env"), "SECRET=1\0", { mode: 0o600 });
    writeFileSync(run("w2", "writer.lock"), `${BOOT_ID} 999999999 1 dead\n`);         // a console that ended
    writeFileSync(run("w3", "writer.lock"), `${BOOT_ID} ${process.pid} ${SELF_START} live\n`); // one in its start
    rig();
    expect(["w1", "w2", "w3"].map((id) => existsSync(run(id, "env")))).toEqual([false, false, true]);
    // Under the lock: taken (w1 free, w2 of a console that ended), then let go; w3's stays (round 4, 4).
    expect(["w1", "w2"].map((id) => existsSync(run(id, "writer.lock")))).toEqual([false, false]);
    expect(readFileSync(run("w3", "writer.lock"), "utf8")).toBe(`${BOOT_ID} ${process.pid} ${SELF_START} live\n`);
    rmSync(run("w3", "writer.lock"));                   // so that the close after the test can take it
  });

  it.skipIf(!PUNCH)("one long run: the read part of out.jsonl is freed each outTrimBytes; every line arrives once; a new console goes on at its place (round 3, 7; round 4, 7)", async () => {
    const a = rig({ outTrimBytes: 256 << 10 });
    const prog = join(tmp, "many.cjs");
    writeFileSync(prog, [
      `const fs = require("fs");`,
      `const pad = "x".repeat(4000);`,
      `let i = 0;`,
      `const t = setInterval(() => {`,
      `  for (let k = 0; k < 64; k++, i++) fs.writeSync(1, JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "r" + i, pad, session_id: "s" }) + "\\n");`,
      `  if (i >= 1024) clearInterval(t);`,
      `}, 20);`,
      `process.stdin.on("data", () => fs.writeSync(1, JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "late", session_id: "s" }) + "\\n"));`,
    ].join("\n"));
    expect(await a.h.spawn({ id: "w1", cwd: tmp, command: process.execPath, args: [prog], env: env("w1") })).toEqual(OK);
    await until("every line", () => results(a).length === 1024, 20_000);
    const want = Array.from({ length: 1024 }, (_, i) => `r${i}`);
    expect(results(a).map((e) => e.text)).toEqual(want);
    const out = join(tmp, "run", "w1", "out.jsonl");
    const st = statSync(out);
    expect(st.size).toBeGreaterThan(4 << 20);            // the size stays (the program appends)
    expect(st.blocks * 512).toBeLessThan(1 << 20);       // the read part is freed
    a.h.shutdown();
    const b = rig({ outTrimBytes: 256 << 10 });
    expect(await b.h.reattach("w1")).toBe(true);
    await b.h.send("w1", "x");
    await until("the late line", () => results(b).length === 1);
    expect(results(b).map((e) => e.text)).toEqual(["late"]);
  });

  it("a passed command that a stopped start left open: the reattach closes it (onNotResent) and never writes it; a failed close keeps it open and unwritten (round 4, 1)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    a.h.shutdown();
    // As start() leaves it when the console stops between markPassed and closePassedCommands.
    const log = join(tmp, "state", "w1", "sendlog.json");
    const inject = (text: string) => {
      const uuid = randomUUID();
      let es: unknown[] = [];
      try { es = JSON.parse(readFileSync(log, "utf8")) as unknown[]; } catch { /* none yet */ }
      es.push({ uuid, text, at: Date.now(), acked: false, slash: true, passed: true });
      writeFileSync(log, JSON.stringify(es));
      return uuid;
    };
    const got: Array<[string, Array<{ uuid: string; text: string }>]> = [];
    const onNotResent = (id: string, items: Array<{ uuid: string; text: string }>) => { got.push([id, items]); };
    const clear = inject("/clear");
    const b = rig({ resendMs: 50, onNotResent });
    expect(await b.h.reattach("w1")).toBe(true);
    expect(got).toEqual([["w1", [{ uuid: clear, text: "/clear" }]]]);
    expect(b.h.pending("w1")).toEqual([]);
    b.h.shutdown();
    const compact = inject("/compact");
    mkdirSync(`${log}.tmp`);                            // the close's save fails
    const c = rig({ resendMs: 50, onNotResent });
    expect(await c.h.reattach("w1")).toBe(true);
    expect(openTexts(c.h, "w1")).toEqual(["/compact"]); // open, with passed
    await sleep(400);                                   // many resend periods
    c.h.shutdown();
    rmSync(`${log}.tmp`, { recursive: true });
    const d = rig({ onNotResent });
    expect(await d.h.reattach("w1")).toBe(true);
    expect(got).toEqual([["w1", [{ uuid: clear, text: "/clear" }]], ["w1", [{ uuid: compact, text: "/compact" }]]]);
    await d.h.send("w1", "after");
    await until("its result", () => results(d).length === 1);
    expect(fakeGot("w1")).toEqual(["after"]);           // neither command went to the program
  });

  it.skipIf(!PUNCH)("a failed trim stops the trim of that worker only, until its next start (round 4, 2)", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const n = new Map<string, number>();
      const r = rig({ outTrimBytes: 256 << 10, onEvent: (id, e) => { if (e.kind === "result") n.set(id, (n.get(id) ?? 0) + 1); } });
      // 512 lines of 4 KB (2 MiB) at once, when its go file is there.
      const prog = join(tmp, "burst.cjs");
      writeFileSync(prog, [
        `const fs = require("fs");`,
        `const pad = "x".repeat(4000);`,
        `const t = setInterval(() => {`,
        `  if (!fs.existsSync(process.argv[2])) return;`,
        `  clearInterval(t);`,
        `  for (let i = 0; i < 512; i++) fs.writeSync(1, JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "r" + i, pad, session_id: "s" }) + "\\n");`,
        `  setInterval(() => {}, 1 << 30);`,
        `}, 10);`,
      ].join("\n"));
      const burst = (id: string, go: string) => r.h.spawn({ id, cwd: tmp, command: process.execPath, args: [prog, join(tmp, go)], env: env(id) });
      const out = (id: string) => join(tmp, "run", id, "out.jsonl");
      const used = (id: string) => statSync(out(id)).blocks * 512;
      const trimWarns = () => warns.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("the trim of out.jsonl"));
      expect(await burst("w1", "go1")).toEqual(OK);
      expect(await burst("w2", "go2")).toEqual(OK);
      chmodSync(out("w1"), 0o444);                      // fallocate cannot open it; the program writes on (its fd)
      expect(() => closeSync(openSync(out("w1"), "r+"))).toThrow(); // the control (not root)
      writeFileSync(join(tmp, "go1"), "");
      await until("w1's lines", () => n.get("w1") === 512);
      expect(used("w1")).toBeGreaterThan(1 << 20);      // not freed
      writeFileSync(join(tmp, "go2"), "");
      await until("w2's lines", () => n.get("w2") === 512);
      expect(used("w2")).toBeLessThan(512 << 10);       // freed: w1's failure does not stop w2
      expect(trimWarns()).toHaveLength(1);
      expect(trimWarns()[0]).toMatch(/^\[headless\] w1: .*until the next start/);
      expect(await burst("w1", "go3")).toEqual(OK);     // a new out.jsonl
      writeFileSync(join(tmp, "go3"), "");
      await until("w1's new lines", () => n.get("w1") === 1024);
      expect(used("w1")).toBeLessThan(512 << 10);       // freed again
      expect(trimWarns()).toHaveLength(1);
    } finally { warns.mockRestore(); }
  });

  it("a shutdown during a spawn or a reattach: it stops at its next step; no lock, no program, no write after it (round 4, 3)", async () => {
    const a = rig();
    await startFake(a.h, "w1");
    a.h.kill("w1");
    await until("onExit", () => a.exits.length === 1);
    const run = join(tmp, "run", "w1");
    const lock = join(run, "writer.lock");
    const read = join(tmp, "state", "w1", "read.json");
    // Many lines that the next start reads first: its drain takes many turns of the event loop.
    appendFileSync(join(run, "out.jsonl"), `${JSON.stringify({ type: "x" })}\n`.repeat(3_000_000));
    const b = rig();
    const p = spawnFake(b.h, "w1");
    await until("the claim", () => existsSync(lock));
    b.h.shutdown();
    expect(await p).toEqual({ ok: false, why: "the worker w1 did not start: the console stops" });
    expect(existsSync(lock)).toBe(false);
    expect(ourUnits()).toEqual([]);
    const seen = readFileSync(read, "utf8");
    await sleep(300);
    expect(readFileSync(read, "utf8")).toBe(seen);      // no poll wrote it
    const c = rig();
    await startFake(c.h, "w1");
    c.h.shutdown();
    const d = rig();
    const q = d.h.reattach("w1");
    d.h.shutdown();
    expect(await q).toBe(false);
    expect(existsSync(lock)).toBe(false);
    const e = rig();
    expect(await e.h.reattach("w1")).toBe(true);        // the program lived on
    await e.h.send("w1", "x");
    await until("its result", () => results(e).length === 1);
  });

  it("a read from 0 through the freed part: its NULs are skipped with no warning; the line after them arrives (round 4, 6)", async () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = rig();
      expect(await bashProgram(a.h, "w1", "sleep 30")).toEqual(OK);
      a.h.shutdown();
      const out = join(tmp, "run", "w1", "out.jsonl");
      truncateSync(out, 20 << 20);                      // as a trim leaves it: NULs above MAX_LINE (a hole)
      appendFileSync(out, `\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "after the hole", session_id: "s" })}\n`);
      rmSync(join(tmp, "state", "w1", "read.json"));    // its place is lost: a read from 0
      const b = rig();
      expect(await b.h.reattach("w1")).toBe(true);
      await until("the line", () => results(b).length === 1);
      expect(results(b).map((e) => e.text)).toEqual(["after the hole"]);
      expect(warns.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("above"))).toEqual([]);
    } finally { warns.mockRestore(); }
  });
});
