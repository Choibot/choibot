// server/agents/sessionread.test.ts — the one reader of an agent's session files (sessionread.ts).
// With strong protection the console cannot open them (the agent's home is 0700; Claude Code makes
// the files 0600), so every reader goes through the helper's read-thread, as the agent. The fake
// helper here reads a MIRROR of the agent's Claude folder: the path the console names does not
// exist for the console itself, so a read that did not go through the helper would find nothing.
// The helper's own checks (a link, a fifo, a path of another account) are in
// server/chief/agent-exec.test.ts ("read-thread").
import Fastify from "fastify";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentHelper } from "../chief/hardened.js";
import { canResumeAsAgent } from "./runtimes/claude.js";
import { registerAgentApi } from "./api.js";
import { openProven } from "./nofollow.js";
import { openTranscript, READ_CALLS_MAX, setTranscriptReaders, transcriptAccount, type ThreadRun } from "./sessionread.js";
import { readStop } from "./stopwhy.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { clearSubagentSummaries, FIRST_LOOK_BUDGET, hasLaterSubagents, META_KEEP_MS, subagentStates } from "./subagents.js";
import { readThreadAfter, readThreadBefore, sessionFileFor } from "./threadfile.js";

const ME = process.getuid!();
const AGENT_UID = ME + 1;
const CHIEF_UID = ME + 2;
let dir = "";
let claude = "";  // the agents' Claude folder, as the console names it (not there for the console)
let mirror = "";  // where the fake helper reads it
const locked: string[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sessionread-")));
  claude = join(dir, "agent-home", ".claude");
  mirror = join(dir, "mirror");
  mkdirSync(join(mirror, "projects", "-w-tree"), { recursive: true });
});
afterEach(() => {
  for (const d of locked.splice(0)) chmodSync(d, 0o700);
  setAgentHelper(false);
  setTranscriptReaders({ agent: null, chief: null });
  clearSubagentSummaries();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const strong = (extra: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: String(AGENT_UID),
    AGENT_HOME_ROOT: join(dir, "homes"), AGENT_CLAUDE_CONFIG_DIR: claude, ...extra,
  })) vi.stubEnv(k, v);
  setAgentHelper(true);
};

// The helper's read-thread on the mirror: the facts line, then the bytes; "absent" for none.
type Call = { uid: string; path: string; pos: number; len: number; claudeDir: string | undefined };
function fakeHelper(o: { swapAfter?: number } = {}): { calls: Call[] } {
  const calls: Call[] = [];
  const run: ThreadRun = (_bin, args, opt, cb) => {
    const verbAt = args.indexOf("read-thread");
    const [path, pos, len] = args.slice(verbAt + 1);
    calls.push({ uid: args[args.indexOf("-u") + 1], path, pos: Number(pos), len: Number(len), claudeDir: opt.env.CLAUDE_CONFIG_DIR });
    const base = opt.env.CLAUDE_CONFIG_DIR!;
    const real = join(mirror, path.slice(base.length));
    if (o.swapAfter !== undefined && calls.length === o.swapAfter + 1) {
      // Another file at the path since the last call: a new inode.
      const t = `${real}.new`;
      writeFileSync(t, readFileSync(real));
      renameSync(t, real);
    }
    if (!existsSync(real)) { cb(null, Buffer.from("absent\n"), Buffer.alloc(0)); return; }
    const st = statSync(real, { bigint: true });
    const ms = Number(st.mtimeNs / 1000000n);
    const head = `${st.size} ${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")} ${st.dev} ${st.ino}\n`;
    const bytes = readFileSync(real).subarray(Number(pos), Number(pos) + Number(len));
    cb(null, Buffer.concat([Buffer.from(head), bytes]), Buffer.alloc(0));
  };
  setTranscriptReaders({ agent: { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: AGENT_UID }, chief: { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: CHIEF_UID }, run });
  return { calls };
}

const stamp = "2026-11-24T20:00:00.000Z";
const L = (o: object): string => JSON.stringify({ parentUuid: null, isSidechain: false, timestamp: stamp, ...o });
const userLine = (uuid: string, text: string): string => L({ type: "user", uuid, message: { role: "user", content: text }, origin: { kind: "human" } });
const sayLine = (uuid: string, text: string): string => L({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const session = () => join(claude, "projects", "-w-tree", "sess-1.jsonl");
const inMirror = (p: string) => join(mirror, p.slice(claude.length));
const texts = (items: unknown[]) => items.flatMap((i) => (i && typeof i === "object" && "text" in i ? [(i as { text: string }).text] : []));

describe("the cause: the console cannot open a file in a folder it cannot enter (strong protection)", () => {
  it.skipIf(ME === 0)("EACCES: main's strong path (openProven) and the console's own open both give nothing", async () => {
    const home = join(dir, "closed-home");
    mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
    const f = join(home, ".claude", "projects", "p", "s.jsonl");
    writeFileSync(f, userLine("u1", "hello") + "\n", { mode: 0o600 });
    // The home of another account is 0700: for the console it is as a folder with no rights.
    chmodSync(home, 0o000);
    locked.push(home);
    expect(await openProven(f, { root: home, uid: ME })).toBeNull();
    await expect(open(f)).rejects.toMatchObject({ code: "EACCES" });
    // The basic reader, too: so with strong protection the helper must be the one reader.
    expect(await openTranscript(f)).toBeNull();
  });
});

describe("with strong protection every read goes through the helper, as the agent", () => {
  it("the thread route: the first page and the live poll; the poll is one helper call", async () => {
    strong();
    const { calls } = fakeHelper();
    writeFileSync(inMirror(session()), [userLine("u1", "run the tests"), sayLine("a1", "All tests pass.")].join("\n") + "\n");
    const store = new SessionStore(join(dir, "agents"));
    await store.save({ id: "a1", label: "", repo: "/r", worktree: "/w/tree", cwd: "/w/tree", branch: "b", baseBranch: "m", sessionId: "sess-1", hookToken: "t", status: "running", createdAt: 1 } as AgentRecord);
    process.env.CONSOLE_COOKIE_SECRET = "x".repeat(32);
    const app = Fastify();
    registerAgentApi(app, { terminals: { has: () => false } as never, store, hub: { emitEvent: () => {} } as never, workspaceDir: dir });
    await app.ready();
    try {
      const first = (await app.inject({ method: "GET", url: "/api/agents/a1/thread" })).json();
      expect(first.ok).toBe(true);
      expect(texts(first.items)).toEqual(["run the tests", "All tests pass."]);
      expect(calls.every((c) => c.uid === `#${AGENT_UID}` && c.claudeDir === claude && c.path === session())).toBe(true);
      calls.length = 0;
      writeFileSync(inMirror(session()), sayLine("a2", "And the build.") + "\n", { flag: "a" });
      const poll = (await app.inject({ method: "GET", url: `/api/agents/a1/thread?after=${first.end}&session=sess-1` })).json();
      expect(texts(poll.items)).toEqual(["And the build."]);
      // The cost of one poll tick of one open thread: one sudo call (facts + the new bytes).
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ pos: first.end, len: 1 << 20 });
    } finally {
      await app.close();
    }
  });

  it("no session file yet: the route says no-file, as before", async () => {
    strong();
    fakeHelper();
    const rec = { id: "a1", cwd: "/w/tree", sessionId: "sess-9", runtime: "claude" } as unknown as AgentRecord;
    const f = await sessionFileFor(rec, { workspaceDir: dir });
    expect(f).toEqual({ ok: true, path: join(claude, "projects", "-w-tree", "sess-9.jsonl"), sessionId: "sess-9" });
    expect(await readThreadBefore((f as { path: string }).path, null)).toBeNull();
  });

  it("the stop reason (stopwhy.ts)", async () => {
    strong();
    const { calls } = fakeHelper();
    writeFileSync(inMirror(session()), [
      userLine("u1", "go"),
      L({ type: "assistant", uuid: "e1", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "Claude AI usage limit reached|1764000000" }] } }),
    ].join("\n") + "\n");
    expect(await readStop(session())).toMatchObject({ why: "limit" });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("the subagent list (subagents.ts): a running subagent costs at most two calls in 3 s (its file and its meta file, each kept 3 s)", async () => {
    strong();
    const { calls } = fakeHelper();
    const id = "a0123456789abcdef";
    const sub = join(mirror, "projects", "-w-tree", "sess-1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(inMirror(session()), userLine("u1", "go") + "\n");
    writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ description: "Find the files", agentType: "Explore" }));
    writeFileSync(join(sub, `agent-${id}.jsonl`), L({ type: "assistant", uuid: "s1", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "x" } }] } }) + "\n");
    const now = Date.now();
    const a = await subagentStates(session(), [id], { alive: true, now });
    expect(a[id]).toMatchObject({ description: "Find the files", agentType: "Explore", state: "running", steps: 1 });
    calls.length = 0;
    // The next polls within 3 s: no call.
    expect((await subagentStates(session(), [id], { alive: true, now }))[id]).toMatchObject({ state: "running", steps: 1 });
    expect(calls).toEqual([]);
    // 3 s later, with one more step: one call for the file (facts + the new bytes), one for the meta file.
    writeFileSync(join(sub, `agent-${id}.jsonl`), L({ type: "assistant", uuid: "s2", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } }] } }) + "\n", { flag: "a" });
    const later = Date.now() + META_KEEP_MS;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const b = await subagentStates(session(), [id], { alive: true, now: later });
    expect(b[id]).toMatchObject({ state: "running", steps: 2 });
    expect(calls.map((c) => c.path.slice(claude.length)).sort()).toEqual([`/projects/-w-tree/sess-1/subagents/agent-${id}.jsonl`, `/projects/-w-tree/sess-1/subagents/agent-${id}.meta.json`]);
  });

  it("a file replaced while it was read: the live read says reset (the cursor means nothing in the new file)", async () => {
    strong();
    fakeHelper({ swapAfter: 1 });
    // More than one chunk after the cursor: a second call, which meets the new file.
    const big = Array.from({ length: 30 }, (_, i) => sayLine(`a${i}`, "x".repeat(50_000))).join("\n") + "\n";
    writeFileSync(inMirror(session()), big);
    expect(await readThreadAfter(session(), 0)).toBe("reset");
  });

  it("each account's files go to its own helper; a path of no account's Claude folder is not read", async () => {
    const chiefClaude = join(dir, "chief-home", ".claude");
    strong({ CHIEF_PERSISTENT_UID: String(CHIEF_UID), AGENT_CHIEF_CLAUDE_CONFIG_DIR: chiefClaude, AGENT_CHIEF_DTACH_DIR: join(dir, "dtach-chief"), AGENT_DTACH_DIR: join(dir, "dtach") });
    const { calls } = fakeHelper();
    expect(transcriptAccount(join(chiefClaude, "projects", "x", "s.jsonl"))).toMatchObject({ exec: { uid: CHIEF_UID }, claudeDir: chiefClaude });
    expect(transcriptAccount(join(claude, "projects", "x", "s.jsonl"))).toMatchObject({ exec: { uid: AGENT_UID }, claudeDir: claude });
    // A name that only starts like a Claude folder is in none.
    for (const p of [`${chiefClaude}2/projects/s.jsonl`, join(dir, "console", "s.jsonl"), "/etc/passwd"]) {
      expect(transcriptAccount(p)).toBeNull();
      expect(await openTranscript(p)).toBeNull();
    }
    expect(calls).toEqual([]);
    // No helper set (its probe failed): nothing is read.
    setTranscriptReaders({ agent: null, chief: null });
    expect(await openTranscript(session())).toBeNull();
  });

  it("an answer of another shape is refused", async () => {
    strong();
    for (const out of ["", "12 34\nxx", "12 1.5 1 2\nab", "2 1764000000.123 1 2\nabc"]) {
      setTranscriptReaders({ agent: { sudo: "s", helper: "h", uid: AGENT_UID }, chief: null, run: (_b, _a, _o, cb) => { cb(null, Buffer.from(out), Buffer.alloc(0)); } });
      expect([out, await openTranscript(session(), { pos: 0, len: 2 })]).toEqual([out, null]);
    }
  });
});

describe("basic mode: the console's own open, as before", () => {
  it("reads a regular file; never a link at the last part; a fifo is no file", async () => {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, "abcdef");
    const t = await openTranscript(p);
    expect(t?.facts.size).toBe(6);
    expect((await t!.read(2, 3)).toString()).toBe("cde");
    expect((await t!.read(4, 10)).toString()).toBe("ef");
    await t!.close();
    const { symlinkSync } = await import("node:fs");
    symlinkSync(p, join(dir, "link.jsonl"));
    expect(await openTranscript(join(dir, "link.jsonl"))).toBeNull();
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(dir, "fifo.jsonl")]);
    expect(await openTranscript(join(dir, "fifo.jsonl"))).toBeNull();
  });
});

describe("the limits on the helper calls (a hosted console is one small server)", () => {
  it("at most 4 calls at one time in the whole console; the others wait their turn, and all end", async () => {
    strong();
    writeFileSync(inMirror(session()), "x\n");
    const held: (() => void)[] = [];
    let now = 0;
    let most = 0;
    // A helper that answers only when the test lets it: the calls in flight can be counted.
    setTranscriptReaders({
      agent: { sudo: "/usr/bin/sudo", helper: "h", uid: AGENT_UID }, chief: null,
      run: (_b, args, o, cb) => {
        now++;
        most = Math.max(most, now);
        held.push(() => { now--; const st = statSync(inMirror(session()), { bigint: true }); cb(null, Buffer.from(`${st.size} 1764000000.000 ${st.dev} ${st.ino}\n`), Buffer.alloc(0)); });
      },
    });
    const all = Array.from({ length: 20 }, () => openTranscript(session()));
    // Let the calls in flight end, a few at a time, until all 20 have run.
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 1));
      while (held.length) held.shift()!();
    }
    const got = await Promise.all(all);
    expect(got.every((t) => t !== null && t.facts.size === 2)).toBe(true);
    expect(most).toBe(READ_CALLS_MAX);
    expect(READ_CALLS_MAX).toBe(4);
  });

  it("48 subagents at a first look: at most 12 calls in the first answer; later polls of the session fill the rest", async () => {
    strong();
    const { calls } = fakeHelper();
    writeFileSync(inMirror(session()), userLine("u1", "go") + "\n");
    const sub = join(mirror, "projects", "-w-tree", "sess-1", "subagents");
    mkdirSync(sub, { recursive: true });
    const ids = Array.from({ length: 48 }, (_, i) => `a${String(i).padStart(16, "0")}`);
    for (const id of ids) {
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ description: `Task ${id}`, agentType: "Explore" }));
      writeFileSync(join(sub, `agent-${id}.jsonl`), L({ type: "assistant", uuid: `s-${id}`, isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
    }
    const seen = new Set<string>();
    const first = await subagentStates(session(), ids, { alive: false, now: Date.now() });
    expect(calls.length).toBeLessThanOrEqual(FIRST_LOOK_BUDGET);
    expect(Object.keys(first)).toHaveLength(4);
    for (const id of Object.keys(first)) seen.add(id);
    expect(hasLaterSubagents(session())).toBe(true);
    // The next polls name no subagent (the page holds none as running): the left ones come in turn.
    for (let round = 0; round < 20 && seen.size < 48; round++) {
      calls.length = 0;
      const got = await subagentStates(session(), [], { alive: false, now: Date.now() });
      expect(calls.length).toBeLessThanOrEqual(FIRST_LOOK_BUDGET);
      for (const id of Object.keys(got)) seen.add(id);
    }
    expect(seen.size).toBe(48);
    expect(hasLaterSubagents(session())).toBe(false);
  });

  it("basic mode: no budget (the console's own reads are cheap): all 48 in the first answer", async () => {
    const proj = join(dir, "p");
    const sub = join(proj, "sess", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(proj, "sess.jsonl"), userLine("u1", "go") + "\n");
    const ids = Array.from({ length: 48 }, (_, i) => `b${String(i).padStart(16, "0")}`);
    for (const id of ids) writeFileSync(join(sub, `agent-${id}.jsonl`), L({ type: "assistant", uuid: `s-${id}`, isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
    expect(Object.keys(await subagentStates(join(proj, "sess.jsonl"), ids, { alive: false, now: Date.now() }))).toHaveLength(48);
  });
});

// The real helper (deploy/choibot-agent-exec), run as this uid with no sudo: a session that Claude
// filed under another project folder is linked by session-ensure, and then its thread AND its
// subagent list are read through read-thread (the side folder is a link inside projects/).
describe("a session linked from another project folder, with the real helper", () => {
  const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));
  const SID = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";
  const SUB = "a0123456789abcdef";
  let cfg = "";
  let conf = "";
  beforeEach(() => {
    cfg = realpathSync(mkdtempSync(join(userInfo().homedir, ".hct-claude-")));
    for (const d of ["dtach", "wt", "ws", "homes"]) mkdirSync(join(dir, d));
    conf = join(dir, "agent-exec.conf");
    writeFileSync(conf, ["DTACH_DIR", "WORKTREE_ROOT", "WORKSPACE_DIR", "AGENT_HOME_ROOT"].map((k, i) => `${k}=${join(dir, ["dtach", "wt", "ws", "homes"][i])}`).concat("DTACH_BIN=/usr/bin/true", "").join("\n"));
  });
  afterEach(() => { rmSync(cfg, { recursive: true, force: true }); });

  it("resume: linked; then the thread and the subagent list of the new path come through read-thread", async () => {
    strong({ AGENT_CLAUDE_CONFIG_DIR: cfg });
    const verbs: string[] = [];
    setTranscriptReaders({
      agent: { sudo: "/usr/bin/sudo", helper: HELPER, uid: AGENT_UID }, chief: null,
      run: (_bin, args, o, cb) => {
        const rest = args.slice(args.indexOf(HELPER) + 1);
        verbs.push(rest[0]);
        execFile(HELPER, rest, { env: { ...o.env, CHOIBOT_AGENT_EXEC_CONF: conf, PATH: "/usr/bin:/bin" }, encoding: "buffer", maxBuffer: o.maxBuffer, timeout: o.timeout },
          (err, stdout, stderr) => cb(err, stdout as Buffer, stderr as Buffer));
      },
    });
    const old = join(cfg, "projects", "-srv-old");
    mkdirSync(join(old, SID, "subagents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(old, `${SID}.jsonl`), [userLine("u1", "plan the week"), sayLine("a1", "Here is the plan.")].join("\n") + "\n", { mode: 0o600 });
    writeFileSync(join(old, SID, "subagents", `agent-${SUB}.meta.json`), JSON.stringify({ description: "Read the calendar", agentType: "Explore" }));
    writeFileSync(join(old, SID, "subagents", `agent-${SUB}.jsonl`), L({ type: "assistant", uuid: "s1", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }] } }) + "\n");
    const rec = { id: "w1", cwd: "/srv/new", sessionId: SID, runtime: "claude" } as unknown as AgentRecord;
    expect(await canResumeAsAgent(rec, "/srv/new")).toBe(true);
    expect(verbs).toEqual(["session-ensure"]);
    const file = await sessionFileFor(rec, { workspaceDir: dir });
    expect(file).toEqual({ ok: true, path: join(cfg, "projects", "-srv-new", `${SID}.jsonl`), sessionId: SID });
    const path = (file as { path: string }).path;
    const page = await readThreadBefore(path, null);
    expect(texts(page!.items)).toEqual(["plan the week", "Here is the plan."]);
    const subs = await subagentStates(path, [SUB], { alive: true, now: Date.now() });
    expect(subs[SUB]).toMatchObject({ description: "Read the calendar", agentType: "Explore", steps: 1 });
    expect(new Set(verbs.slice(1))).toEqual(new Set(["read-thread"]));
    // A second resume: present.
    expect(await canResumeAsAgent(rec, "/srv/new")).toBe(true);
  });
});
