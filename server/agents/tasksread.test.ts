// server/agents/tasksread.test.ts — the Plan rail with strong protection (tasksread.ts). Claude
// Code keeps one JSON file per task in <its Claude folder>/tasks/<session id>/, which is in the
// agent's own 0700 home: the console cannot read it, so the route reads it through the helper
// (deploy/choibot-agent-exec read-tasks), AS the account of the session. Here the fake sudo runs the
// REAL helper as the test's own uid (the workers' account and the second account are two confs of
// it), and the older helper is main's own file before read-tasks. The helper's own checks (a
// link, a cap, the time limit) are in server/chief/agent-exec.test.ts ("read-tasks").
import Fastify, { type FastifyInstance } from "fastify";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGate } from "../chief/gate.js";
import { setAgentHelper } from "../chief/hardened.js";
import { registerAgentApi } from "./api.js";
import { setTranscriptReaders, type ThreadRun } from "./sessionread.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { forgetPlanReads, PLAN_AFTER_CHANGE_MS, PLAN_IDLE_MS, PLAN_OLD_HELPER_MS, PLAN_RUNNING_MS, parseTaskFrames } from "./tasksread.js";

const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));
const INSTALLED = "/usr/local/bin/choibot-agent-exec";
const ME = process.getuid!();
const AGENT_UID = ME + 1;
const CHIEF_UID = ME + 2;
const SID = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";

let dir = "";      // the test's folder in this user's home (the helper wants a Claude folder in its home)
let agentClaude = "";
let chiefClaude = "";
let oldHelper = "";
let app: FastifyInstance | null = null;
let store: SessionStore;
type Call = { uid: number; verb: string; args: string[]; claudeDir: string | undefined };
let calls: Call[] = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(userInfo().homedir, ".hct-tasks-")));
  agentClaude = join(dir, "agent-home", ".claude");
  chiefClaude = join(dir, "chief-home", ".claude");
  for (const d of [agentClaude, chiefClaude, join(dir, "dtach"), join(dir, "dtach-chief"), join(dir, "homes", "chief")]) mkdirSync(d, { recursive: true });
  const conf = (extra: string[]) => [`DTACH_DIR=${join(dir, "dtach")}`, "DTACH_BIN=/bin/true", `WORKTREE_ROOT=${dir}`, `WORKSPACE_DIR=${dir}`, `AGENT_HOME_ROOT=${join(dir, "homes")}`, ...extra, ""].join("\n");
  writeFileSync(join(dir, "agent.conf"), conf([]));
  writeFileSync(join(dir, "chief.conf"), conf([`CHIEF_UID=${ME}`, `CHIEF_DTACH_DIR=${join(dir, "dtach-chief")}`]));
  // The installed helper of an older console, with no read-tasks (testdata).
  oldHelper = join(dir, "old-choibot-agent-exec");
  writeFileSync(oldHelper, readFileSync(fileURLToPath(new URL("./testdata/agent-exec-before-read-tasks.sh", import.meta.url))));
  chmodSync(oldHelper, 0o755);
  store = new SessionStore(join(dir, "agents"));
  calls = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  forgetPlanReads();
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
  setAgentHelper(false);
  setTranscriptReaders({ agent: null, chief: null });
  forgetPlanReads();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const strong = () => {
  for (const [k, v] of Object.entries({
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: String(AGENT_UID),
    AGENT_HOME_ROOT: join(dir, "homes"), AGENT_CLAUDE_CONFIG_DIR: agentClaude, AGENT_DTACH_DIR: join(dir, "dtach"),
    CHIEF_PERSISTENT_UID: String(CHIEF_UID), AGENT_CHIEF_CLAUDE_CONFIG_DIR: chiefClaude, AGENT_CHIEF_DTACH_DIR: join(dir, "dtach-chief"),
    // The console's own Claude folder: where main's route reads (and finds nothing).
    CLAUDE_CONFIG_DIR: join(dir, "console-claude"),
  })) vi.stubEnv(k, v);
  setAgentHelper(true);
};

// The fake sudo: the helper of `-u #<uid>` with the args after its path, as that account (here:
// the test's own uid, with the conf of that account). `old`: the installed helper is the older one.
// `answer`: a made-up helper answer (the parse tests).
function sudo(o: { old?: boolean; answer?: string } = {}): void {
  const run: ThreadRun = (_bin, args, opt, cb) => {
    const uid = Number(args[args.indexOf("-u") + 1].slice(1));
    const at = args.indexOf(INSTALLED);
    calls.push({ uid, verb: args[at + 1], args: args.slice(at + 2), claudeDir: opt.env.CLAUDE_CONFIG_DIR });
    if (o.answer !== undefined) { cb(null, Buffer.from(o.answer), Buffer.alloc(0)); return; }
    execFile(o.old ? oldHelper : HELPER, args.slice(at + 1), {
      env: { PATH: "/usr/bin:/bin", CHOIBOT_AGENT_EXEC_CONF: join(dir, uid === CHIEF_UID ? "chief.conf" : "agent.conf"), CLAUDE_CONFIG_DIR: opt.env.CLAUDE_CONFIG_DIR ?? "" } as unknown as NodeJS.ProcessEnv,
      encoding: "buffer", timeout: opt.timeout, maxBuffer: opt.maxBuffer,
    }, (err, stdout, stderr) => cb(err, stdout as Buffer, stderr as Buffer));
  };
  const x = (uid: number) => ({ sudo: "/usr/bin/sudo", helper: INSTALLED, uid });
  setTranscriptReaders({ agent: x(AGENT_UID), chief: x(CHIEF_UID), run });
}

const task = (id: number, subject: string, status = "pending") => JSON.stringify({ id: String(id), subject, description: "", status, blocks: [], blockedBy: [] }, null, 2);
function tasksIn(claude: string, files: Record<string, string>): void {
  const d = join(claude, "tasks", SID);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const [n, body] of Object.entries(files)) writeFileSync(join(d, n), body, { mode: 0o600 });
}

async function agent(id: string, extra: Partial<AgentRecord> = {}): Promise<void> {
  await store.save({ id, label: "", repo: "/r", worktree: "/w/tree", branch: "b", baseBranch: "m", sessionId: SID, hookToken: "t", status: "running", createdAt: 1, ...extra } as AgentRecord);
}
async function rail(id: string): Promise<{ status: number; tasks: unknown }> {
  if (!app) {
    app = Fastify();
    registerAgentApi(app, { terminals: { has: () => false } as never, store, hub: { emitEvent: () => {} } as never, workspaceDir: dir });
    await app.ready();
  }
  const r = await app.inject({ method: "GET", url: `/api/agents/${id}/tasks` });
  return { status: r.statusCode, tasks: r.json().tasks };
}
const subjects = (t: unknown) => (t as { subject: string }[]).map((x) => x.subject);
const warned = (re: RegExp) => warn.mock.calls.filter((c) => re.test(String(c[0]))).length;

describe("the Plan rail with strong protection: the task files through the helper, as the session's account", () => {
  it("a worker: one read-tasks as the workers' account, in its Claude folder; the route's JSON as before", async () => {
    strong();
    sudo();
    tasksIn(agentClaude, { "2.json": task(2, "Second", "in_progress"), "1.json": task(1, "First", "completed"), "10.json": task(10, "Tenth"), ".lock": "", ".highwatermark": "10" });
    await agent("w1");
    const r = await rail("w1");
    expect(r.status).toBe(200);
    expect(r.tasks).toEqual([
      { id: "1", subject: "First", status: "completed" },
      { id: "2", subject: "Second", status: "in_progress" },
      { id: "10", subject: "Tenth", status: "pending" },
    ]);
    expect(calls).toEqual([{ uid: AGENT_UID, verb: "read-tasks", args: [SID], claudeDir: agentClaude }]);
  });

  it("a persistent agent (a lead, the fleet master): as the second account, in its own Claude folder", async () => {
    strong();
    sudo();
    tasksIn(chiefClaude, { "1.json": task(1, "Lead's task") });
    // The same session id in the workers' folder: never read for a persistent agent.
    tasksIn(agentClaude, { "1.json": task(1, "A worker's task") });
    await agent("lead-web", { kind: "lead" } as Partial<AgentRecord>);
    await agent("fleet-master", { kind: "fleet-master" } as Partial<AgentRecord>);
    expect(subjects((await rail("lead-web")).tasks)).toEqual(["Lead's task"]);
    expect(subjects((await rail("fleet-master")).tasks)).toEqual(["Lead's task"]);
    expect(calls.map((c) => [c.uid, c.claudeDir])).toEqual([[CHIEF_UID, chiefClaude], [CHIEF_UID, chiefClaude]]);
  });

  it("no tasks folder, no session id, or a session id of another shape: an empty rail; no call without a session uuid", async () => {
    strong();
    sudo();
    await agent("w1");
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    expect(calls).toHaveLength(1);
    await agent("w2", { sessionId: null });
    await agent("w3", { sessionId: "sess-1" });
    expect(await rail("w2")).toEqual({ status: 200, tasks: [] });
    expect(await rail("w3")).toEqual({ status: 200, tasks: [] });
    expect(calls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a refusal of the helper (a link): an empty rail and one log line per agent and reason", async () => {
    strong();
    sudo();
    mkdirSync(join(agentClaude, "tasks", SID), { recursive: true });
    execFileSync("ln", ["-s", join(agentClaude, ".credentials.json"), join(agentClaude, "tasks", SID, "1.json")]);
    await agent("w1", { status: "idle" });
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    vi.setSystemTime(Date.now() + PLAN_IDLE_MS);
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    expect(calls).toHaveLength(2);
    expect(warned(/w1: the Plan rail could not be read through the helper \(choibot-agent-exec: read-tasks: a link: 1\.json\)/)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("an older installed helper (no read-tasks)", () => {
  it("an empty rail and ONE clear log line; no call for 10 min, then one try again", async () => {
    strong();
    sudo({ old: true });
    tasksIn(agentClaude, { "1.json": task(1, "First") });
    await agent("w1");
    await agent("lead-web", { kind: "lead" } as Partial<AgentRecord>);
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    expect(calls).toHaveLength(1);
    // Other agents and later polls: no call while the 10 min last.
    vi.setSystemTime(Date.now() + PLAN_RUNNING_MS);
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    expect(await rail("lead-web")).toEqual({ status: 200, tasks: [] });
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + PLAN_OLD_HELPER_MS);
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[chief\] the installed helper has no read-tasks verb \(it is older than this console\): the Plan rail stays empty until strong-setup installs the new helper$/);
  });
});

// The page polls the rail every 2 s (5 s when the agent is done or in error), from each open tab.
describe("the cost: helper calls of one open agent", () => {
  async function ticks(id: string, seconds: number, every = 2): Promise<void> {
    for (let t = 0; t < seconds; t += every) {
      await rail(id);
      vi.setSystemTime(Date.now() + every * 1000);
    }
  }

  it("running: at most one read in 5 s (after the two reads of a status change)", async () => {
    strong();
    sudo();
    tasksIn(agentClaude, { "1.json": task(1, "First") });
    await agent("w1");
    vi.useFakeTimers({ toFake: ["Date"] });
    await ticks("w1", 60);
    // The first sight is a change: at once and once more 3 s later; then one in 5 s.
    expect(calls.length).toBeLessThanOrEqual(13);
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it("idle or done: after a status change, a read at once and one about 3 s later; then at most one in 60 s", async () => {
    strong();
    sudo();
    tasksIn(agentClaude, { "1.json": task(1, "First", "in_progress") });
    await agent("w1");
    vi.useFakeTimers({ toFake: ["Date"] });
    await ticks("w1", 10);
    calls = [];
    // The agent stops; its last task write lands after the status event.
    await agent("w1", { status: "idle" });
    expect(subjects((await rail("w1")).tasks)).toEqual(["First"]);
    expect(calls).toHaveLength(1);
    tasksIn(agentClaude, { "1.json": task(1, "First", "completed") });
    vi.setSystemTime(Date.now() + 2000);
    await rail("w1");
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + PLAN_AFTER_CHANGE_MS - 2000);
    expect((await rail("w1")).tasks).toEqual([{ id: "1", subject: "First", status: "completed" }]);
    expect(calls).toHaveLength(2);
    // Then a minute of polls: at most one more read.
    calls = [];
    await ticks("w1", 60);
    expect(calls.length).toBeLessThanOrEqual(1);
    // A status that the hooks missed never freezes the rail: one read in 60 s still sees a change.
    tasksIn(agentClaude, { "2.json": task(2, "Later") });
    calls = [];
    await ticks("w1", PLAN_IDLE_MS / 1000);
    expect(calls).toHaveLength(1);
    expect(subjects((await rail("w1")).tasks)).toEqual(["First", "Later"]);
  });

  it("requests at the same time share one call (two tabs)", async () => {
    strong();
    sudo();
    tasksIn(agentClaude, { "1.json": task(1, "First") });
    await agent("w1");
    await rail("w1"); // the app is ready
    calls = [];
    forgetPlanReads();
    const [a, b, c] = await Promise.all([rail("w1"), rail("w1"), rail("w1")]);
    expect(calls).toHaveLength(1);
    for (const r of [a, b, c]) expect(subjects(r.tasks)).toEqual(["First"]);
  });
});

describe("the parse of the helper's answer", () => {
  const frame = (name: string, body: string) => `${name} ${Buffer.byteLength(body)}\n${body}\n`;

  it("frames: name, length, the bytes (with newlines and UTF-8 in them)", () => {
    const one = '{"id":"1",\n"subject":"ü — x"}';
    expect(parseTaskFrames(Buffer.from(`tasks 2\n${frame("1.json", one)}${frame("2.json", "")}`))).toEqual([
      { name: "1.json", bytes: Buffer.from(one) }, { name: "2.json", bytes: Buffer.alloc(0) },
    ]);
    expect(parseTaskFrames(Buffer.from("absent\n"))).toBe("absent");
    expect(parseTaskFrames(Buffer.from("tasks 0\n"))).toEqual([]);
  });

  it("an answer of another shape is refused (whole), never guessed", () => {
    for (const out of ["", "tasks\n", "tasks 1\n", "tasks 1\n1.json 5\nab\n", "tasks 1\n1.json 2\nabc\n", "tasks 1\n1.json 2\nab", "tasks 0\nextra", "tasks 1\n1.json x\nab\n", "tasks 1001\n", "absent\nx", "tasks 1\n1.json 262145\n"]) {
      expect(() => parseTaskFrames(Buffer.from(out)), JSON.stringify(out)).toThrow(/read-tasks: an answer of another shape/);
    }
  });

  it("a frame with a name it does not expect is skipped with one log line; the other tasks stay", async () => {
    strong();
    const body = `tasks 3\n${frame("1.json", task(1, "First"))}${frame("task-x.json", task(7, "Odd"))}${frame("2.json", task(2, "Second"))}`;
    sudo({ answer: body });
    await agent("w1", { status: "idle" });
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(subjects((await rail("w1")).tasks)).toEqual(["First", "Second"]);
    vi.setSystemTime(Date.now() + PLAN_IDLE_MS);
    expect(subjects((await rail("w1")).tasks)).toEqual(["First", "Second"]);
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/w1: a task file of a name that the console does not expect is skipped \("task-x\.json"\)/);
  });

  it("an answer of another shape: an empty rail and one log line", async () => {
    strong();
    sudo({ answer: "tasks 1\n1.json 99\nshort\n" });
    await agent("w1", { status: "idle" });
    expect(await rail("w1")).toEqual({ status: 200, tasks: [] });
    expect(warned(/w1: the Plan rail could not be read through the helper \(read-tasks: an answer of another shape\)/)).toBe(1);
  });
});

// The thread route's gate (api.ts): with strong protection a persistent agent's files are read as
// the second account, so its task list is for the paired user alone, as its thread is. A worker
// agent on the same server must not get the fleet master's or a lead's list.
describe("the gate: a persistent agent's task list is for the paired user (strong protection)", () => {
  const USER = { "x-choibot-user": "device-ok" };
  async function gated(): Promise<FastifyInstance> {
    const a = Fastify();
    registerAgentApi(a, {
      terminals: { has: () => false } as never, store, hub: { emitEvent: () => {} } as never, workspaceDir: dir,
      chief: makeGate({ misconfigured: null, userAuth: "log", strong: true, deps: { devices: { verify: async (t: string) => (t === "device-ok" ? { label: "phone" } : null) } as never, agents: store } }),
    });
    await a.ready();
    return a;
  }
  const get = (a: FastifyInstance, id: string, headers: Record<string, string> = {}) => a.inject({ method: "GET", url: `/api/agents/${id}/tasks`, headers });

  it("no pairing, a wrong user token, a worker's or a lead's agent header: 403 pair-required, and no helper call", async () => {
    strong();
    sudo();
    tasksIn(chiefClaude, { "1.json": task(1, "Lead's task") });
    await agent("w1", { hookToken: "tok-w1" });
    await agent("lead-web", { kind: "lead", hookToken: "tok-lead" } as Partial<AgentRecord>);
    await agent("fleet-master", { kind: "fleet-master", hookToken: "tok-fm" } as Partial<AgentRecord>);
    const a = await gated();
    try {
      for (const id of ["lead-web", "fleet-master"]) {
        for (const h of [{}, { "x-choibot-user": "device-bad" }, { "x-choibot-agent": "w1", "x-choibot-agent-token": "tok-w1" }, { "x-choibot-agent": "lead-web", "x-choibot-agent-token": "tok-lead" }] as Record<string, string>[]) {
          const r = await get(a, id, h);
          expect([id, h, r.statusCode, r.json()]).toEqual([id, h, 403, { error: "pair-required", userAuth: "log" }]);
        }
      }
      expect(calls).toEqual([]);
      // The paired user: the list, read as the second account.
      const ok = await get(a, "lead-web", USER);
      expect([ok.statusCode, subjects(ok.json().tasks)]).toEqual([200, ["Lead's task"]]);
      expect(calls.map((c) => c.uid)).toEqual([CHIEF_UID]);
    } finally { await a.close(); }
  });

  it("a worker's own rail: open as before (no pairing needed)", async () => {
    strong();
    sudo();
    tasksIn(agentClaude, { "1.json": task(1, "A worker's task") });
    await agent("w1", { hookToken: "tok-w1" });
    const a = await gated();
    try {
      for (const h of [{}, { "x-choibot-agent": "w1", "x-choibot-agent-token": "tok-w1" }, USER] as Record<string, string>[]) {
        const r = await get(a, "w1", h);
        expect([h, r.statusCode, subjects(r.json().tasks)]).toEqual([h, 200, ["A worker's task"]]);
      }
    } finally { await a.close(); }
  });

  it("basic protection: a lead's rail is open as before", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "console-claude"));
    tasksIn(join(dir, "console-claude"), { "1.json": task(1, "Lead's task") });
    await agent("lead-web", { kind: "lead" } as Partial<AgentRecord>);
    const a = await gated();
    try {
      const r = await get(a, "lead-web");
      expect([r.statusCode, subjects(r.json().tasks)]).toEqual([200, ["Lead's task"]]);
    } finally { await a.close(); }
  });
});

describe("basic protection: no helper, the direct read as before", () => {
  it("the console reads the tasks folder itself; no helper call", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "console-claude"));
    sudo();
    tasksIn(join(dir, "console-claude"), { "1.json": task(1, "First"), "junk.json": "not json" });
    await agent("w1");
    expect(subjects((await rail("w1")).tasks)).toEqual(["First"]);
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "console-claude", "tasks", SID))).toBe(true);
  });
});
