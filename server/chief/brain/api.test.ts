// server/chief/brain/api.test.ts — the brain routes (spec §7, §6.1, §6.2
// source 3, §3, §15): a tiny Fastify app with the real gate and real stores in
// a temp dir; distill, the hub and the Telegram card poster are fakes (one test
// uses a real ChiefTelegram over a fake bot client).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import type { ConsoleEvent } from "../../events.js";
import type { InlineKeyboard, TgMessage } from "../../issues/telegram.js";
import { tgMessage, USER_ID } from "../../issues/testkit.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, PairingCodes, USER_HEADER } from "../auth.js";
import { CardIndex } from "../cards.js";
import { readJsonl } from "../files.js";
import { makeGate } from "../gate.js";
import { chiefPaths, type ChiefPaths } from "../paths.js";
import { ChiefTelegram } from "../telegram.js";
import { registerBrainApi, type BrainApiDeps } from "./api.js";
import { proposalFile, type DistillReport, type Proposal } from "./distill.js";
import { isoWeek } from "./metrics.js";
import { ClassifiedLog, DecisionLog, RULE_ID, RuleStore, type Rule, type RuleEvent } from "./store.js";

const rec = (id: string, kind?: string): AgentRecord => ({
  id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
});
const RECORDS: Record<string, AgentRecord> = {
  master: rec("master", "fleet-master"), worker: rec("worker"), cron: rec("cron", "cron-master"),
};
const master = { [AGENT_HEADER]: "master", [AGENT_TOKEN_HEADER]: "tok-master" };
const worker = { [AGENT_HEADER]: "worker", [AGENT_TOKEN_HEADER]: "tok-worker" };
const cron = { [AGENT_HEADER]: "cron", [AGENT_TOKEN_HEADER]: "tok-cron" };
const PR = "https://github.com/acme/repo/pull/12";
const NOW = Date.UTC(2026, 10, 9, 12);
const R = "/api/brain/rules";
const ADD = { text: "Always run the tests.", scope: { area: "*" }, kind: "preference" };
const REPORT: DistillReport = { proposed: true, size: 42, retire: 0, candidates: 1 };
const STATUS = { enabled: true, lastRun: 7 };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Poster = NonNullable<BrainApiDeps["telegram"]>;
type Opts = {
  misconfigured?: string | null; userAuth?: "telegram" | "log"; phase1a?: boolean; hardened?: boolean; editorOff?: boolean;
  distill?: boolean; telegram?: (rules: RuleStore, paths: ChiefPaths) => Poster | undefined; rulesNow?: () => number;
};

let dir: string;
let app: FastifyInstance;
let paths: ChiefPaths;
let devices: DeviceStore;
let decisions: DecisionLog;
let rules: RuleStore;
let classified: ClassifiedLog;
let userHdr: Record<string, string>;
let surface: "tab" | "telegram";
let events: ConsoleEvent[];
let logs: string[];
let tg: { postRuleCard: ReturnType<typeof vi.fn<(r: Rule) => Promise<void>>>; postProposalCard: ReturnType<typeof vi.fn<(p: Proposal) => Promise<void>>> };
let runOnce: ReturnType<typeof vi.fn<(o?: { dryRun?: boolean }) => Promise<DistillReport>>>;
let onCandidate: ReturnType<typeof vi.fn<() => void>>;

async function build(o: Opts = {}) {
  dir = mkdtempSync(join(tmpdir(), "chief-brain-api-"));
  paths = chiefPaths(dir);
  devices = new DeviceStore(paths.devices);
  decisions = new DecisionLog(paths.decisions);
  rules = new RuleStore(paths.rules, o.rulesNow ? { now: o.rulesNow } : {});
  classified = new ClassifiedLog(paths.classified);
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  surface = "tab";
  events = [];
  logs = [];
  tg = { postRuleCard: vi.fn(async () => {}), postProposalCard: vi.fn(async () => {}) };
  runOnce = vi.fn(async () => REPORT);
  onCandidate = vi.fn(() => {});
  const gate = makeGate({
    misconfigured: o.misconfigured ?? null, userAuth: o.userAuth ?? "log",
    deps: { devices, agents: { load: async (id) => RECORDS[id] ?? null } },
  });
  app = Fastify();
  const base: BrainApiDeps = { gate, devices, decisions, surface: () => surface };
  const telegram = o.telegram ? o.telegram(rules, paths) : tg;
  registerBrainApi(app, o.phase1a ? base : {
    ...base, rules, classified, paths, hub: { emitEvent: (e) => { events.push(e); } },
    ...(o.distill === false ? {} : { distill: { runOnce, status: () => ({ ...STATUS }) } }),
    ...(o.hardened === undefined ? {} : { hardened: () => o.hardened! }),
    ...(o.editorOff === undefined ? {} : { editorOff: o.editorOff }),
    ...(telegram ? { telegram } : {}),
    onCandidate,
    now: () => NOW, log: (s) => { logs.push(s); },
  });
}
async function rebuild(o: Opts) {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  await build(o);
}
beforeEach(async () => { await build(); });
afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const ruleEvents = () => readJsonl<RuleEvent>(paths.rules);
const addId = async (headers: Record<string, string>, body: unknown): Promise<string> => {
  const res = await post(R, headers, body);
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
};
async function propose(text: string, retire: { id: string; why: string; text: string }[] = []) {
  await mkdir(paths.brainDir, { recursive: true });
  await writeFile(paths.proposed, text);
  await writeFile(proposalFile(paths), JSON.stringify({ sha256: sha(text), retire, createdAt: 1 }));
}

describe("devices", () => {
  it("lists devices without sha256", async () => {
    const res = await app.inject({ method: "GET", url: "/api/brain/devices", headers: userHdr });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]!).sort()).toEqual(["createdAt", "label", "lastUsedAt"]);
    expect(body[0]!.label).toBe("laptop");
  });
  it("403s a headerless list", async () => {
    expect((await app.inject({ method: "GET", url: "/api/brain/devices" })).statusCode).toBe(403);
  });
  it("revokes a device, then 404s the same and unknown or malformed labels", async () => {
    await devices.add("phone");
    const ok = await app.inject({ method: "POST", url: "/api/brain/devices/phone/revoke", headers: userHdr });
    expect(ok.json()).toEqual({ ok: true });
    expect((await devices.list()).map((x) => x.label)).toEqual(["laptop"]);
    for (const l of ["phone", "nope", "bad%20label"]) {
      expect((await app.inject({ method: "POST", url: `/api/brain/devices/${l}/revoke`, headers: userHdr })).statusCode).toBe(404);
    }
  });
  it("403s a headerless revoke", async () => {
    expect((await app.inject({ method: "POST", url: "/api/brain/devices/laptop/revoke" })).statusCode).toBe(403);
  });
});

describe("decisions", () => {
  const postD = (headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/brain/decisions", headers, payload: payload as object });

  it("master writes one line; via follows surface()", async () => {
    expect((await postD(master, { value: "merge", text: "merge it", agent: "a1", pr: PR })).json()).toEqual({ ok: true });
    surface = "telegram";
    await postD(master, { value: "merge", text: "again" });
    await postD(master, { value: "merge", text: "explicit", via: "master-tab" });
    const lines = await decisions.read();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ by: "master", reason: "master-chat", correction: null, value: "merge", text: "merge it", agentId: "a1", prUrl: PR, via: "master-tab" });
    expect(lines[1]!.via).toBe("master-telegram");
    expect(lines[2]!.via).toBe("master-tab");
  });
  it("400s a bad body", async () => {
    for (const p of [{ text: "x" }, { value: "", text: "x" }, { value: "v".repeat(101), text: "x" }, { value: "v", text: "x", pr: "http://x" }, { value: "v", text: "x", via: "composer" }, { value: "v" }]) {
      expect((await postD(master, p)).statusCode).toBe(400);
    }
    expect(await decisions.read()).toHaveLength(0);
  });
  it("400s an agent that is not an agent id; accepts a 64-char id", async () => {
    for (const agent of ["", "../x", "-a", "a".repeat(65), "a\nb", "a b", "a/b"]) {
      expect((await postD(master, { value: "v", text: "x", agent })).statusCode).toBe(400);
    }
    expect(await decisions.read()).toHaveLength(0);
    expect((await postD(master, { value: "v", text: "x", agent: "a".repeat(64) })).statusCode).toBe(200);
    expect((await decisions.read())[0]!.agentId).toBe("a".repeat(64));
  });
  it("403s a user, a worker and a headerless caller", async () => {
    for (const h of [userHdr, worker, {}]) {
      const res = await postD(h, { value: "v", text: "x" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "master only" });
    }
    expect(await decisions.read()).toHaveLength(0);
  });
});

describe("POST /api/brain/rules from USER", () => {
  it("a direct add writes add + confirm (via tab), origin panel, and posts no card", async () => {
    const res = await post(R, userHdr, ADD);
    expect(res.statusCode).toBe(200);
    const { id, state } = res.json() as { id: string; state: string };
    expect(id).toMatch(RULE_ID);
    expect(state).toBe("active");
    const evs = await ruleEvents();
    expect(evs.map((e) => e.ev)).toEqual(["add", "confirm"]);
    expect(evs[0]).toMatchObject({ id, state: "active", text: ADD.text, scope: { area: "*" }, kind: "preference", source: { origin: "panel" } });
    expect(evs[1]).toMatchObject({ id, by: "user", via: "tab", confidence: 0.9 });
    expect(tg.postRuleCard).not.toHaveBeenCalled();
  });

  it("with via cli the confirm says cli", async () => {
    const id = await addId(userHdr, { ...ADD, via: "cli" });
    expect((await ruleEvents()).filter((e) => e.ev === "confirm")).toEqual([expect.objectContaining({ id, via: "cli" })]);
  });

  it("state candidate writes only add and posts no card; memoryFile gives origin memory, stored as a basename", async () => {
    const mem = await post(R, userHdr, { ...ADD, state: "candidate", source: { memoryFile: "/home/u/.local/share/choibot/master/memory/merge-prs-self.md" } });
    expect(mem.json()).toEqual({ id: expect.stringMatching(RULE_ID), state: "candidate" });
    const plain = await addId(userHdr, { ...ADD, text: "Prefer rebase.", state: "candidate" });
    const evs = await ruleEvents();
    expect(evs.map((e) => e.ev)).toEqual(["add", "add"]);
    expect(evs[0]).toMatchObject({ state: "candidate", confidence: 0.6, source: { origin: "memory", memoryFile: "merge-prs-self.md" } });
    expect(evs[1]).toMatchObject({ id: plain, state: "candidate", source: { origin: "panel" } });
    expect(tg.postRuleCard).not.toHaveBeenCalled();
  });

  it("via telegram → 400 and nothing is written", async () => {
    const res = await post(R, userHdr, { ...ADD, via: "telegram" });
    expect(res.statusCode).toBe(400);
    expect(existsSync(paths.rules)).toBe(false);
  });

  it("ignores source.origin user-line in the body (stored panel) and strips unknown keys", async () => {
    await addId(userHdr, {
      ...ADD, scope: { area: "*", audience: "all", extra: 1 }, source: { origin: "user-line", itemId: "q1" }, origin: "distill", confidence: 0.1,
    });
    const [add] = await ruleEvents();
    expect(add).toMatchObject({ ev: "add", confidence: 0.9 });
    expect((add as Extract<RuleEvent, { ev: "add" }>).source).toEqual({ origin: "panel" });
    expect((add as Extract<RuleEvent, { ev: "add" }>).scope).toEqual({ area: "*", audience: "all" });
  });

  it("keeps agent and pr in the source and normalizes scope.repo to a basename", async () => {
    await addId(userHdr, { ...ADD, agent: "a1", pr: PR, scope: { area: "app-shop", repo: "/home/dev/workspace/app-shop/", kind: "pr" } });
    const [add] = (await ruleEvents()) as Extract<RuleEvent, { ev: "add" }>[];
    expect(add.scope).toEqual({ area: "app-shop", repo: "app-shop", kind: "pr" });
    expect(add.source).toEqual({ origin: "panel", agentId: "a1", prUrl: PR });
  });

  it("a duplicate answers 409 {error: duplicate, id} — also of a candidate, so the caller can confirm that id", async () => {
    const cand = await addId(userHdr, { ...ADD, state: "candidate" });
    const res = await post(R, userHdr, { ...ADD, text: "  always RUN the tests!  " });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "duplicate", id: cand });
    expect(await ruleEvents()).toHaveLength(1);
  });

  it("400s every out-of-bounds field and writes nothing", async () => {
    const bad: unknown[] = [
      {}, { ...ADD, text: "" }, { ...ADD, text: "   " }, { ...ADD, text: "x".repeat(201) }, { ...ADD, text: 5 },
      { text: "x", kind: "preference" }, { ...ADD, scope: {} }, { ...ADD, scope: { area: "" } },
      { ...ADD, scope: { area: "a".repeat(65) } }, { ...ADD, scope: { area: "a b" } }, { ...ADD, scope: { area: "x\n## Always" } },
      { ...ADD, scope: { area: "*", kind: "nope" } }, { ...ADD, scope: { area: "*", audience: "everyone" } },
      { ...ADD, scope: { area: "*", repo: "" } }, { ...ADD, scope: { area: "*", repo: "/x/.." } }, { ...ADD, scope: { area: "*", repo: "a b" } },
      { ...ADD, scope: { area: "*", repo: "r".repeat(257) } }, { ...ADD, kind: "rule" },
      { ...ADD, agent: "../x" }, { ...ADD, agent: "a".repeat(65) }, { ...ADD, agent: "" },
      { ...ADD, pr: "http://github.com/a/b/pull/1" }, { ...ADD, pr: `${PR}x` }, { ...ADD, pr: `${PR}\n` },
      { ...ADD, state: "active" }, { ...ADD, state: "retired" },
      { ...ADD, source: { memoryFile: "" } }, { ...ADD, source: { memoryFile: "m".repeat(257) } },
      { ...ADD, source: { memoryFile: "a\nb.md" } }, { ...ADD, source: { memoryFile: "/x/.." } }, { ...ADD, source: "memory" },
      { ...ADD, via: "telegram" }, { ...ADD, via: "composer" },
    ];
    for (const b of bad) {
      for (const h of [userHdr, master]) {
        const res = await post(R, h, b);
        expect(res.statusCode, JSON.stringify(b)).toBe(400);
        expect(res.json()).toEqual({ error: "invalid body" });
      }
    }
    expect(existsSync(paths.rules)).toBe(false);
    expect(tg.postRuleCard).not.toHaveBeenCalled();
  });

  it("maps a RuleError (text blank after normalizing) to its code and message", async () => {
    const res = await post(R, userHdr, { ...ADD, text: "..." });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "blank rule text" });
  });
});

describe("POST /api/brain/rules from MASTER", () => {
  it("adds a candidate with origin master and posts no Telegram card; state, source and via in the body are ignored", async () => {
    await rebuild({ userAuth: "telegram" });
    const res = await post(R, master, { ...ADD, agent: "a1", pr: PR, state: "candidate", source: { memoryFile: "x.md" }, via: "cli" });
    expect(res.statusCode).toBe(200);
    const { id } = res.json() as { id: string };
    expect(res.json()).toEqual({ id: expect.stringMatching(RULE_ID), state: "candidate" });
    const evs = await ruleEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ ev: "add", id, state: "candidate", confidence: 0.6 });
    expect((evs[0] as Extract<RuleEvent, { ev: "add" }>).source).toEqual({ origin: "master", agentId: "a1", prUrl: PR });
    expect(onCandidate).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(tg.postRuleCard).not.toHaveBeenCalled();
    expect(await decisions.read()).toEqual([]);   // not a correction
  });

  it("refuses a question or a one-time answer (400), writes nothing", async () => {
    for (const text of ["A", "done merge", "should we still merge this?", "tldr of what it does?", "What is the risk of this"]) {
      const res = await post(R, master, { ...ADD, text });
      expect(res.statusCode, text).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/^not a standing rule: /);
    }
    expect(existsSync(paths.rules)).toBe(false);
    expect(onCandidate).not.toHaveBeenCalled();
  });

  it("a duplicate answers 200 {id, state, duplicate: true}, makes no second candidate and still counts the correction", async () => {
    await rebuild({ userAuth: "telegram" });
    const body = { text: "Never offer to merge.", scope: { area: "*" }, kind: "correction", agent: "a1" };
    const first = await post(R, master, body);
    expect(first.json()).toEqual({ id: expect.stringMatching(RULE_ID), state: "candidate" });
    surface = "telegram";
    const dup = await post(R, master, { ...body, text: "never offer to merge" });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toEqual({ id: (first.json() as { id: string }).id, state: "candidate", duplicate: true });
    expect(await ruleEvents()).toHaveLength(1);
    expect(onCandidate).toHaveBeenCalledTimes(1);
    const lines = await decisions.read();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ by: "master", reason: "master-chat", correction: true, via: "master-tab", text: "Never offer to merge.", agentId: "a1" });
    expect(lines[1]).toMatchObject({ by: "master", correction: true, via: "master-telegram", text: "never offer to merge" });
  });

  it("a correction count that throws after the rule is written still answers 200, logged; a retry is a duplicate", async () => {
    vi.spyOn(decisions, "countMasterCorrection").mockRejectedValueOnce(new Error("disk full"));
    const body = { text: "Never offer to merge.", scope: { area: "*" }, kind: "correction" };
    const res = await post(R, master, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: expect.stringMatching(RULE_ID), state: "candidate" });
    expect(logs.some((l) => l.includes("disk full"))).toBe(true);
    expect(await ruleEvents()).toHaveLength(1);
    expect((await post(R, master, body)).json()).toMatchObject({ duplicate: true });
    expect(await ruleEvents()).toHaveLength(1);
  });

  it("a duplicate of an active rule answers its state", async () => {
    const id = await addId(userHdr, ADD);
    expect((await post(R, master, ADD)).json()).toEqual({ id, state: "active", duplicate: true });
  });

  it("a correction that quotes the user's master-tab line marks that line instead of adding one", async () => {
    const user = await decisions.append({ by: "user", via: "master-tab", correction: null, text: "No. Never offer to merge, I merge." });
    await addId(master, { text: "never offer to merge", scope: { area: "*" }, kind: "correction" });
    expect(await classified.read()).toEqual([{ at: user.at, correction: true, by: "master-chat" }]);
    expect(await decisions.read()).toHaveLength(1);
  });

  it("an onCandidate that throws never fails the add", async () => {
    onCandidate.mockImplementationOnce(() => { throw new Error("sync throw"); });
    await addId(master, ADD);
    expect(logs.join("\n")).toContain("sync throw");
  });
});

describe("POST /api/brain/rules: other callers", () => {
  it("403s a worker and a cron master (agent headers) and a headerless caller (pair-required), writing nothing", async () => {
    for (const h of [worker, cron]) {
      const res = await post(R, h, ADD);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "user or master only" });
    }
    const none = await post(R, {}, ADD);
    expect(none.statusCode).toBe(403);
    expect(none.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(existsSync(paths.rules)).toBe(false);
  });
});

describe("GET /api/brain", () => {
  it("any session: text, updatedAt, size, hardened, editorOff, userAuth and distill status; no proposed without a proposal", async () => {
    expect((await get("/api/brain")).json()).toEqual({ text: "", updatedAt: 0, size: 0, hardened: false, editorOff: false, userAuth: "log", distill: STATUS });
    const text = "# Brain (2026-11-09)\n## Always\n- Run the tests [r_aaaaa]\n";
    await mkdir(paths.brainDir, { recursive: true });
    await writeFile(paths.brain, text);
    const res = await get("/api/brain", worker);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text, updatedAt: Math.floor(statSync(paths.brain).mtimeMs), size: text.length, hardened: false, editorOff: false, userAuth: "log", distill: STATUS,
    });
  });

  it("proposed carries text, sha256 and retire", async () => {
    const p = "# Brain (2026-11-10)\n## Always\n- x [r_bbbbb]\n";
    const retire = [{ id: "r_aaaaa", why: "repeats r_bbbbb", text: "old" }];
    await propose(p, retire);
    expect((await get("/api/brain", userHdr)).json()).toMatchObject({ proposed: { text: p, sha256: sha(p), retire } });
  });

  it("carries userAuth telegram and hardened from the deps", async () => {
    await rebuild({ userAuth: "telegram", hardened: true });
    expect((await get("/api/brain")).json()).toMatchObject({ userAuth: "telegram", hardened: true });
  });

  it("editorOff comes from the deps (true only in a hardened deployment, overview decision 45)", async () => {
    await rebuild({ editorOff: true });
    expect((await get("/api/brain")).json()).toMatchObject({ editorOff: true });
    await rebuild({ editorOff: false });
    expect((await get("/api/brain")).json()).toMatchObject({ editorOff: false });
  });

  it("without distill the status says it is unavailable", async () => {
    await rebuild({ distill: false });
    expect((await get("/api/brain")).json()).toMatchObject({ distill: { enabled: false, reason: "distill unavailable" } });
  });
});

describe("GET /api/brain/rules", () => {
  it("any session; filters by state (default all) and returns the view fields only", async () => {
    const a = await addId(userHdr, ADD);
    const c = await addId(userHdr, { ...ADD, text: "Prefer rebase.", state: "candidate" });
    const all = await get(R);
    expect(all.statusCode).toBe(200);
    const body = all.json() as Array<Record<string, unknown>>;
    expect(body.map((r) => r.id)).toEqual([a, c]);
    expect(Object.keys(body[0]!).sort()).toEqual(["confidence", "createdAt", "hits", "id", "kind", "scope", "source", "state", "strikes", "text"]);
    expect(body[0]).toMatchObject({ text: ADD.text, state: "active", confidence: 0.9, hits: 0, strikes: 0, source: { origin: "panel" } });
    expect((await get(`${R}?state=active`, worker)).json().map((r: Rule) => r.id)).toEqual([a]);
    expect((await get(`${R}?state=candidate`, master)).json().map((r: Rule) => r.id)).toEqual([c]);
    expect((await get(`${R}?state=all`)).json()).toHaveLength(2);
    for (const q of ["retired", "", "x"]) expect((await get(`${R}?state=${q}`)).statusCode).toBe(400);
  });

  it("an unexpected store error is a fixed 500: no message, no stack", async () => {
    vi.spyOn(rules, "all").mockRejectedValueOnce(new Error("EACCES /secret/path"));
    const res = await get(R);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
    expect(logs.join("\n")).toContain("EACCES /secret/path");
  });
});

describe("POST /api/brain/rules/:id", () => {
  it("confirm writes one confirm line: via tab by default, cli and a confidence when given", async () => {
    const id = await addId(userHdr, { ...ADD, state: "candidate" });
    const res = await post(`${R}/${id}`, userHdr, { confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, state: "active", confidence: 0.9 });
    await post(`${R}/${id}`, userHdr, { confirm: true, via: "cli", confidence: 0.95 });
    const evs = await ruleEvents();
    expect(evs.map((e) => e.ev)).toEqual(["add", "confirm", "confirm"]);
    expect(evs[1]).toMatchObject({ via: "tab", confidence: 0.9 });
    expect(evs[2]).toMatchObject({ via: "cli", confidence: 0.95 });
  });

  it("edits text and scope (repo normalized), then retires with a redacted reason", async () => {
    const id = await addId(userHdr, ADD);
    const ed = await post(`${R}/${id}`, userHdr, { text: "Run the tests first.", scope: { area: "*", repo: "/ws/indexer" } });
    expect(ed.json()).toMatchObject({ id, text: "Run the tests first.", scope: { area: "*", repo: "indexer" } });
    const ret = await post(`${R}/${id}`, userHdr, { retire: { why: "old sk-abcdefghijklmnop" }, via: "cli" });
    expect(ret.statusCode).toBe(200);
    expect(ret.json()).toMatchObject({ id, state: "retired" });
    const last = (await ruleEvents()).at(-1);
    expect(last).toMatchObject({ ev: "retire", id, by: "user", why: "old [redacted]" });
  });

  it("404s an unknown or malformed id, 409s a retired rule, 400s via telegram and bad fields", async () => {
    const id = await addId(userHdr, ADD);
    for (const u of ["r_zzzzz", "nope", "r_ABCDE"]) {
      const res = await post(`${R}/${u}`, userHdr, { confirm: true });
      expect(res.statusCode, u).toBe(404);
    }
    const bad: unknown[] = [
      { via: "telegram", confirm: true }, { text: "" }, { text: "x".repeat(201) }, { scope: { area: "a b" } },
      { confidence: 1.5 }, { confidence: -0.1 }, { confidence: "0.9" }, { confirm: "yes" }, { retire: {} },
      { retire: { why: "" } }, { retire: { why: "   " } }, { retire: { why: "w".repeat(201) } },
      { retire: { why: "x" }, text: "y" }, { retire: { why: "x" }, confirm: true },
    ];
    for (const b of bad) expect((await post(`${R}/${id}`, userHdr, b)).statusCode, JSON.stringify(b)).toBe(400);
    expect(await ruleEvents()).toHaveLength(2);
    await rules.retire(id, { by: "user", why: "gone" });
    const res = await post(`${R}/${id}`, userHdr, { confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: `rule ${id} is retired` });
  });

  it("403s a master and a headerless caller", async () => {
    const id = await addId(userHdr, { ...ADD, state: "candidate" });
    expect((await post(`${R}/${id}`, master, { confirm: true })).statusCode).toBe(403);
    expect((await post(`${R}/${id}`, {}, { confirm: true })).json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(await ruleEvents()).toHaveLength(1);
  });
});

describe("POST /api/brain/rules/:id/telegram-card", () => {
  it("409 in log mode", async () => {
    const id = await addId(userHdr, ADD);
    const res = await post(`${R}/${id}/telegram-card`, userHdr);
    expect(res.statusCode).toBe(409);
    expect(tg.postRuleCard).not.toHaveBeenCalled();
  });

  it("telegram mode: starts postRuleCard with the rule and answers 202; 404 unknown; 409 retired; 403 master", async () => {
    await rebuild({ userAuth: "telegram" });
    const id = await addId(userHdr, ADD);
    const res = await post(`${R}/${id}/telegram-card`, userHdr);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(tg.postRuleCard).toHaveBeenCalledTimes(1);
    expect(tg.postRuleCard.mock.calls[0]![0]).toMatchObject({ id, state: "active" });
    expect((await post(`${R}/r_zzzzz/telegram-card`, userHdr)).statusCode).toBe(404);
    expect((await post(`${R}/bad/telegram-card`, userHdr)).statusCode).toBe(404);
    expect((await post(`${R}/${id}/telegram-card`, master)).statusCode).toBe(403);
    await rules.retire(id, { by: "user", why: "gone" });
    expect((await post(`${R}/${id}/telegram-card`, userHdr)).statusCode).toBe(409);
    expect(tg.postRuleCard).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a hanging poster, and logs a rejection", async () => {
    await rebuild({ userAuth: "telegram" });
    const id = await addId(userHdr, ADD);
    tg.postRuleCard.mockImplementationOnce(() => new Promise<void>(() => {}));
    expect((await post(`${R}/${id}/telegram-card`, userHdr)).statusCode).toBe(202);
    tg.postRuleCard.mockImplementationOnce(async () => { throw new Error("rule and proposal cards are off"); });
    expect((await post(`${R}/${id}/telegram-card`, userHdr)).statusCode).toBe(202);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("rule and proposal cards are off"));
  });

  it("Confirm on Telegram on a panel-added rule posts a q:k: card whose [Confirm] writes via telegram", async () => {
    const CFG = { chatId: -1001, threadId: 7, userId: USER_ID };
    const forum = { id: -1001, type: "supergroup" as const, is_forum: true };
    const sent: { text: string; keyboard?: InlineKeyboard; messageId: number }[] = [];
    let mid = 500;
    let chief!: ChiefTelegram;
    await rebuild({
      userAuth: "telegram", rulesNow: () => 1_000,
      telegram: (rs, ps) => (chief = new ChiefTelegram({
        tg: {
          sendMessage: vi.fn(async (chatId: number, text: string, o?: { keyboard?: InlineKeyboard }) => {
            const messageId = mid++;
            sent.push({ text, keyboard: o?.keyboard, messageId });
            return { message_id: messageId, date: 0, chat: { id: chatId, type: "supergroup" }, text } as TgMessage;
          }),
          deleteMessage: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}), editMessageText: vi.fn(async () => {}),
        },
        cfg: CFG, consoleUrl: "https://console.example.ts.net", misconfigured: null,
        pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: vi.fn(async () => false) },
        rules: rs, cards: new CardIndex(ps.cards), paths: ps, log: (s) => { logs.push(s); },
      })),
    });
    const id = await addId(userHdr, ADD);
    expect((await post(`${R}/${id}/telegram-card`, userHdr)).statusCode).toBe(202);
    await chief.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.keyboard!.inline_keyboard[0]).toEqual([{ text: "Confirm", callback_data: `q:k:${id}` }]);
    const tap = {
      update_id: 1,
      callback_query: {
        id: "cq1", from: { id: USER_ID, first_name: "Me" }, data: `q:k:${id}`,
        message: tgMessage(sent[0]!.messageId, { chat: forum, message_thread_id: 7, is_topic_message: true }),
      },
    };
    expect(chief.route(tap)).toBe("handled");
    await chief.idle();
    expect((await ruleEvents()).filter((e) => e.ev === "confirm").map((e) => (e as { via: string }).via)).toEqual(["tab", "telegram"]);
  });
});

describe("POST /api/brain/distill", () => {
  it("USER: awaits runOnce with dryRun and answers its report", async () => {
    const res = await post("/api/brain/distill", userHdr, { dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPORT);
    expect(runOnce).toHaveBeenCalledWith({ dryRun: true });
    await post("/api/brain/distill", userHdr);
    expect(runOnce).toHaveBeenLastCalledWith({ dryRun: false });
  });

  it("400s a non-boolean dryRun and 403s a master", async () => {
    expect((await post("/api/brain/distill", userHdr, { dryRun: "yes" })).statusCode).toBe(400);
    expect((await post("/api/brain/distill", master, {})).statusCode).toBe(403);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("without distill: 503 distill unavailable", async () => {
    await rebuild({ distill: false });
    const res = await post("/api/brain/distill", userHdr);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "distill unavailable" });
  });
});

describe("POST /api/brain/apply", () => {
  const P = "# Brain (2026-11-10)\n## Always\n- x [r_aaaaa]\n";

  it("telegram mode, user token, not hardened → 403 apply from Telegram, nothing applied", async () => {
    await rebuild({ userAuth: "telegram" });
    await propose(P);
    const res = await post("/api/brain/apply", userHdr);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "apply from Telegram" });
    expect(existsSync(paths.brain)).toBe(false);
    expect(existsSync(paths.proposed)).toBe(true);
  });

  it("telegram mode, hardened → applies", async () => {
    await rebuild({ userAuth: "telegram", hardened: true });
    await propose(P);
    const res = await post("/api/brain/apply", userHdr);
    expect(res.statusCode).toBe(200);
    expect(await readFile(paths.brain, "utf8")).toBe(P);
  });

  it("log mode → applies, answers {version}, emits brain", async () => {
    await propose(P);
    const res = await post("/api/brain/apply", userHdr);
    expect(res.statusCode).toBe(200);
    // No BRAIN.md before: no previous brain saved.
    expect(res.json()).toEqual({ version: null });
    expect(await readFile(paths.brain, "utf8")).toBe(P);
    expect(existsSync(paths.proposed)).toBe(false);
    expect(events).toEqual([{ type: "brain", updatedAt: NOW, proposed: false }]);
    await propose("# Brain (2026-11-11)\n## Always\n- y [r_bbbbb]\n");
    expect((await post("/api/brain/apply", userHdr)).json()).toEqual({ version: String(NOW) });
  });

  it("sha256: a mismatch → 409 changed, malformed → 400, a match applies; no proposal → 404", async () => {
    await propose(P);
    const changed = await post("/api/brain/apply", userHdr, { sha256: sha("other") });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: "changed" });
    for (const s of ["abc", sha(P).toUpperCase(), 5]) expect((await post("/api/brain/apply", userHdr, { sha256: s })).statusCode).toBe(400);
    expect(existsSync(paths.brain)).toBe(false);
    expect((await post("/api/brain/apply", userHdr, { sha256: sha(P) })).statusCode).toBe(200);
    const none = await post("/api/brain/apply", userHdr);
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: "no proposal" });
  });

  it("403s a master", async () => {
    await propose(P);
    expect((await post("/api/brain/apply", master)).statusCode).toBe(403);
    expect(existsSync(paths.brain)).toBe(false);
  });
});

describe("POST /api/brain/proposal/telegram-card", () => {
  it("409 in log mode", async () => {
    await propose("# Brain\n");
    expect((await post("/api/brain/proposal/telegram-card", userHdr)).statusCode).toBe(409);
    expect(tg.postProposalCard).not.toHaveBeenCalled();
  });

  it("telegram mode: postProposalCard once with the current proposal (202); no proposal → 404", async () => {
    await rebuild({ userAuth: "telegram" });
    expect((await post("/api/brain/proposal/telegram-card", userHdr)).statusCode).toBe(404);
    const text = "# Brain (2026-11-10)\n";
    const retire = [{ id: "r_aaaaa", why: "old", text: "x" }];
    await propose(text, retire);
    const res = await post("/api/brain/proposal/telegram-card", userHdr);
    expect(res.statusCode).toBe(202);
    expect(tg.postProposalCard).toHaveBeenCalledTimes(1);
    expect(tg.postProposalCard).toHaveBeenCalledWith({ text, sha256: sha(text), retire, createdAt: 1 });
  });

  it("a hanging or rejecting poster still answers 202", async () => {
    await rebuild({ userAuth: "telegram" });
    await propose("# Brain\n");
    tg.postProposalCard.mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockImplementationOnce(async () => { throw new Error("proposal card boom"); });
    expect((await post("/api/brain/proposal/telegram-card", userHdr)).statusCode).toBe(202);
    expect((await post("/api/brain/proposal/telegram-card", userHdr)).statusCode).toBe(202);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("proposal card boom"));
  });
});

describe("POST /api/brain/discard-proposal and /rollback", () => {
  it("discard removes the proposal; a sha256 mismatch → 409 changed; no proposal → 404", async () => {
    await propose("# Brain\n");
    const changed = await post("/api/brain/discard-proposal", userHdr, { sha256: sha("other") });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: "changed" });
    expect(existsSync(paths.proposed)).toBe(true);
    const ok = await post("/api/brain/discard-proposal", userHdr, { sha256: sha("# Brain\n") });
    expect(ok.json()).toEqual({ ok: true });
    expect(existsSync(paths.proposed)).toBe(false);
    expect(events).toEqual([{ type: "brain", updatedAt: NOW, proposed: false }]);
    expect((await post("/api/brain/discard-proposal", userHdr)).statusCode).toBe(404);
  });

  it("rollback restores the newest version by default; 404 unknown, 400 malformed, 403 master", async () => {
    await mkdir(paths.versionsDir, { recursive: true });
    await writeFile(join(paths.versionsDir, "100.md"), "v-old");
    await writeFile(paths.brain, "v-cur");
    expect((await post("/api/brain/rollback", master)).statusCode).toBe(403);
    for (const version of ["../x", "1.5", 100, ""]) expect((await post("/api/brain/rollback", userHdr, { version })).statusCode).toBe(400);
    const unknown = await post("/api/brain/rollback", userHdr, { version: "999" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "unknown version" });
    const res = await post("/api/brain/rollback", userHdr);
    expect(res.json()).toEqual({ version: "100" });
    expect(await readFile(paths.brain, "utf8")).toBe("v-old");
  });
});

describe("GET /api/brain/metrics", () => {
  it("any session; 8 weeks by default, weeks=1..52, 400 otherwise", async () => {
    await decisions.append({ by: "user", via: "queue-tab", correction: true, text: "x", at: NOW - 1000, prUrl: PR, agentId: "a1" });
    const res = await get("/api/brain/metrics");
    expect(res.statusCode).toBe(200);
    const m = res.json() as { weeks: { week: string }[]; byPr: unknown[]; byAgent: unknown[] };
    expect(m.weeks).toHaveLength(8);
    expect(m.weeks[0]).toEqual({ week: isoWeek(NOW), decisions: 1, corrections: 1 });
    expect(m.byPr).toEqual([{ prUrl: PR, decisions: 1, corrections: 1 }]);
    expect(m.byAgent).toEqual([{ agentId: "a1", decisions: 1, corrections: 1 }]);
    expect((await get("/api/brain/metrics?weeks=3", worker)).json().weeks).toHaveLength(3);
    expect((await get("/api/brain/metrics?weeks=52")).json().weeks).toHaveLength(52);
    for (const w of ["0", "53", "abc", "1.5", "-1", ""]) expect((await get(`/api/brain/metrics?weeks=${w}`)).statusCode, w).toBe(400);
  });
});

describe("gating", () => {
  const ROUTES: Array<["GET" | "POST", string]> = [
    ["GET", "/api/brain"], ["GET", R], ["POST", R], ["POST", `${R}/r_aaaaa`], ["POST", `${R}/r_aaaaa/telegram-card`],
    ["POST", "/api/brain/distill"], ["POST", "/api/brain/apply"], ["POST", "/api/brain/proposal/telegram-card"],
    ["POST", "/api/brain/discard-proposal"], ["POST", "/api/brain/rollback"], ["GET", "/api/brain/metrics"],
    ["GET", "/api/brain/devices"], ["POST", "/api/brain/devices/laptop/revoke"], ["POST", "/api/brain/decisions"],
  ];

  it("misconfigured → 503 on every brain route, for every caller", async () => {
    await rebuild({ misconfigured: "no token" });
    for (const [method, url] of ROUTES) {
      for (const headers of [userHdr, master, {}]) {
        const res = await app.inject({ method, url, headers, ...(method === "POST" ? { payload: ADD } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(503);
        expect(res.json()).toEqual({ error: "chief-misconfigured" });
      }
    }
    expect(existsSync(paths.rules)).toBe(false);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("without the Phase 1b deps only the devices and decisions routes exist", async () => {
    await rebuild({ phase1a: true });
    for (const [method, url] of ROUTES.slice(0, -3)) {
      expect((await app.inject({ method, url, headers: userHdr })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await get("/api/brain/devices", userHdr)).statusCode).toBe(200);
  });

  it("flag off: no brain route exists (server/index.ts never calls registerBrainApi)", async () => {
    const bare = Fastify();
    try {
      for (const [method, url] of ROUTES) expect((await bare.inject({ method, url, headers: userHdr })).statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
