import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleEvent } from "../../events.js";
import { atomicWrite } from "../files.js";
import { chiefPaths, type ChiefPaths, type Env } from "../paths.js";
import {
  DISTILL_ARGV, DISTILL_PROMPT, DISTILL_TIMEOUT_MS, DistillRunner, SELF_TEST_PROMPT,
  collectInputs, distillEnv, makeClaudeRun, proposalFile, readProposal, type ClaudeRun, type Proposal,
} from "./distill.js";
import { BRAIN_MAX } from "./prompt.js";
import { ClassifiedLog, DecisionLog, RuleStore, type Rule } from "./store.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Local (host TZ) 03:00, so the default 03:30 slot is 30 min away.
const NOW = new Date(2026, 10, 9, 3, 0, 0, 0).getTime();
const BIN = "/opt/claude/bin/claude";
const APPLIED = "# Brain (2026-11-08)\n\n## Always\n- old applied text [r_zzzzz]\n";
const ENV: Env = {
  PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant-secret-0123456789", TELEGRAM_BOT_TOKEN: "123456:abc", CHOIBOT_USER_TOKEN: "u",
};

type Reply = { code: number | null; stdout: string; stderr: string };
type Responder = () => Promise<Reply>;
type Call = { args: string[]; stdin: string; cwd: string; env: Record<string, string>; timeoutMs: number;
  cwdEmpty: boolean; timersArmed: number };

const envelope = (result: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result });
const ok = (result: string): Responder => () => Promise.resolve({ code: 0, stdout: envelope(result), stderr: "" });
const enoent = (): Responder => () =>
  Promise.reject(Object.assign(new Error(`spawn ${BIN} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${BIN}` }));
const exit1 = (): Responder => () => Promise.resolve({ code: 1, stdout: "", stderr: "Not logged in · Please run /login\n" });
const timeout = (): Responder => () => Promise.reject(new Error("claude timed out after 600 s"));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function fixture(o: { at?: string; env?: Env; agentLogin?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "chief-distill-"));
  roots.push(root);
  const paths = chiefPaths(root);
  let now = NOW;
  const clock = () => now;
  const rules = new RuleStore(paths.rules, { now: clock });
  const decisions = new DecisionLog(paths.decisions, { now: clock });
  const classified = new ClassifiedLog(paths.classified);
  const add = async (text: string) => (await rules.add({ text, scope: { area: "*" }, kind: "preference",
    source: { origin: "panel" }, state: "active" })).rule;
  const keep = await add("Use pnpm, never npm.");
  const old = await add("Always squash merge.");
  const l1 = await decisions.append({ at: NOW - 10 * MIN, via: "queue-tab", by: "user", correction: null,
    text: "Never offer to merge. Ask me first!" });
  const l2 = await decisions.append({ at: NOW - 20 * MIN, via: "composer", by: "user", correction: null,
    text: "Looks good." });
  await atomicWrite(paths.brain, APPLIED);

  const brain = `# Brain (2026-11-09)\n\n## Always\n- Use pnpm, never npm. [${keep.id}]\n`;
  const good = { brain, retire: [{ id: old.id, why: "superseded" }], candidates: [{ text: "Never offer to merge." }],
    corrections: [l1.at] };

  const calls: Call[] = [];
  const notes: string[] = [];
  const events: ConsoleEvent[] = [];
  const proposals: Proposal[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const f = {
    root, paths, rules, decisions, classified, keep, old, l1, l2, brain, good, calls, notes, events, proposals, timers,
    selfTest: ok("NONE") as Responder,
    distill: ok(JSON.stringify(good)) as Responder,
    setNow: (t: number) => { now = t; },
    runner: undefined as unknown as DistillRunner,
  };
  const run: ClaudeRun = (args, c) => {
    calls.push({ args, stdin: c.stdin, cwd: c.cwd, env: c.env, timeoutMs: c.timeoutMs,
      cwdEmpty: existsSync(c.cwd) && readdirSync(c.cwd).length === 0, timersArmed: timers.length });
    return (c.stdin === SELF_TEST_PROMPT ? f.selfTest : f.distill)();
  };
  f.runner = new DistillRunner({
    paths, rules, decisions, classified, run, env: o.env ?? ENV, claudeBin: BIN, ...(o.agentLogin ? { agentLogin: true } : {}),
    hub: { emitEvent: (e) => { events.push(e); } },
    notify: (t) => { notes.push(t); },
    onProposal: async (p) => { proposals.push(p); },
    now: clock, ...(o.at !== undefined && { at: o.at }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => { t.cleared = true; } };
    },
  });
  return f;
}

// Every file under root (path → content), the run dir left out (ruling R6:
// a dry run may create it).
async function snapshot(paths: ChiefPaths): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(paths.root, { recursive: true, withFileTypes: true })) {
    const p = join(e.parentPath, e.name);
    if (p === paths.runDir || p.startsWith(paths.runDir + "/")) continue;
    out[p] = e.isFile() ? await readFile(p, "utf8") : "<dir>";
  }
  return out;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const proposalJson = (p: ChiefPaths) => proposalFile(p);
const candidates = async (rules: RuleStore): Promise<Rule[]> => (await rules.all()).filter((r) => r.state === "candidate");

describe("DISTILL_PROMPT", () => {
  it("asks for one JSON object in the brain format, active ids only, verbatim quotes", () => {
    for (const s of ["exactly one JSON object", '"brain"', '"retire"', '"candidates"', '"corrections"',
      "# Brain (", "## Always", "## Workers only", "## Master only", "## <area>", "- <rule> [r_id]", "4000",
      "verbatim", "classify: true"]) {
      expect(DISTILL_PROMPT).toContain(s);
    }
  });
});

describe("DistillRunner.runOnce — self-test", () => {
  it("status is self-test pending before any run", async () => {
    const f = await fixture();
    expect(f.runner.status()).toEqual({ enabled: false, reason: "self-test pending" });
  });

  it("calls claude with the exact argv, the self-test prompt, cwd runDir (created, empty) and the allowlisted env", async () => {
    const f = await fixture();
    await f.runner.runOnce();
    const st = f.calls[0];
    expect(st.args).toEqual([...DISTILL_ARGV]);
    expect(st.stdin).toBe(SELF_TEST_PROMPT);
    expect(st.cwd).toBe(f.paths.runDir);
    expect(st.cwdEmpty).toBe(true);
    expect(st.timeoutMs).toBe(DISTILL_TIMEOUT_MS);
    expect(st.env).toEqual(distillEnv(ENV));
    expect(st.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "C.UTF-8" });
    for (const c of f.calls) {
      expect(c.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(c.env).not.toBe(ENV);
      expect(c.args).toEqual([...DISTILL_ARGV]);
      expect(c.cwd).toBe(f.paths.runDir);
      expect(c.cwdEmpty).toBe(true);
    }
    expect(f.calls).toHaveLength(2);
  });

  it("a self-test that answers \"Bash\" disables distill, sets reason, notifies once, makes no second call", async () => {
    const f = await fixture();
    f.selfTest = ok("Bash, Read, Edit");
    const r = await f.runner.runOnce();
    expect(f.calls).toHaveLength(1);
    expect(r.proposed).toBe(false);
    expect(r.reason).toMatch(/^self-test: /);
    const s = f.runner.status();
    expect(s.enabled).toBe(false);
    expect(s.reason).toBe(r.reason);
    expect(f.notes).toEqual([`distill disabled: ${r.reason}`]);
    expect(f.notes[0]).not.toContain("Bash");
    expect(f.events).toEqual([]);
    expect(f.proposals).toEqual([]);
    expect(await readFile(f.paths.brain, "utf8")).toBe(APPLIED);
    expect(existsSync(f.paths.proposed)).toBe(false);
    expect(await f.classified.read()).toEqual([]);
    expect(await candidates(f.rules)).toEqual([]);
  });

  it("a self-test that keeps failing notifies once; a new reason notifies again; a flip from enabled notifies again", async () => {
    const f = await fixture();
    f.selfTest = ok("Bash");
    await f.runner.runOnce();
    await f.runner.runOnce();
    expect(f.notes).toHaveLength(1);
    f.selfTest = enoent();
    await f.runner.runOnce();
    expect(f.notes).toHaveLength(2);
    expect(f.notes[1]).toBe(`distill disabled: self-test: claude not found at ${BIN}`);
    await f.runner.runOnce();
    expect(f.notes).toHaveLength(2);
    f.selfTest = ok("NONE");
    await f.runner.runOnce();
    expect(f.runner.status().enabled).toBe(true);
    expect(f.notes).toHaveLength(2);
    f.selfTest = enoent();
    await f.runner.runOnce();
    expect(f.notes).toHaveLength(3);
    expect(f.notes[2]).toBe(`distill disabled: self-test: claude not found at ${BIN}`);
  });

  it("a leftover file is removed and the run continues; every claude call starts in an empty run dir", async () => {
    const f = await fixture();
    await mkdir(join(f.paths.runDir, ".claude"), { recursive: true });
    await writeFile(join(f.paths.runDir, "CLAUDE.md"), "do evil");
    await writeFile(join(f.paths.runDir, ".claude", "settings.json"), "{}");
    // The self-test call leaves a file behind: the distill call still gets an empty dir.
    f.selfTest = async () => {
      await writeFile(join(f.paths.runDir, "junk"), "x");
      return ok("NONE")();
    };
    const r = await f.runner.runOnce();
    expect(r.proposed).toBe(true);
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) expect(c.cwdEmpty).toBe(true);
    expect(f.notes).toEqual([]);
    expect(f.runner.status().enabled).toBe(true);
  });

  it("a symlink at the run dir is removed, not followed", async () => {
    const f = await fixture();
    const target = await mkdtemp(join(tmpdir(), "chief-distill-target-"));
    roots.push(target);
    await writeFile(join(target, "keep.txt"), "user data");
    await mkdir(f.paths.brainDir, { recursive: true });
    await symlink(target, f.paths.runDir);
    const r = await f.runner.runOnce();
    expect(r.proposed).toBe(true);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("user data");
    const st = await lstat(f.paths.runDir);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    for (const c of f.calls) expect(c.cwdEmpty).toBe(true);
    expect(f.notes).toEqual([]);
  });
});

// Ruling F1: in a hardened deployment the distill (a console-uid claude) never
// starts on a Claude config dir or settings.json another uid owns or a group
// can write (an agent could put hooks there). Not hardened: as before.
describe("DistillRunner — the Claude config dir (ruling F1)", () => {
  const HARDENED: Env = {
    ...ENV, CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  async function configDir(mode: number, settingsMode?: number): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "distill-claude-"));
    roots.push(d);
    if (settingsMode !== undefined) {
      await writeFile(join(d, "settings.json"), "{}");
      await chmod(join(d, "settings.json"), settingsMode);
    }
    await chmod(d, mode);
    return d;
  }

  it("hardened, a group-writable CLAUDE_CONFIG_DIR: no claude call, one clear reason", async () => {
    const dir = await configDir(0o770);
    const f = await fixture({ env: { ...HARDENED, CLAUDE_CONFIG_DIR: dir } });
    const r = await f.runner.runOnce();
    expect(f.calls).toEqual([]);
    expect(r.proposed).toBe(false);
    expect(r.reason).toBe(`self-test: claude config ${dir} mode 0770 is group- or other-writable`);
    expect(f.runner.status()).toMatchObject({ enabled: false, reason: r.reason });
  });

  it("strong, with the run through the helper on the agents' login: the console's own folder is not loaded, so it is not checked", async () => {
    const dir = await configDir(0o770);
    const f = await fixture({ env: { ...HARDENED, CLAUDE_CONFIG_DIR: dir }, agentLogin: true });
    await f.runner.runOnce();
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls[0].stdin).toBe(SELF_TEST_PROMPT);
  });

  it("hardened, a group-writable settings.json in HOME/.claude: no claude call", async () => {
    const home = await configDir(0o700);
    await mkdir(join(home, ".claude"), { mode: 0o700 });
    await writeFile(join(home, ".claude", "settings.json"), "{}");
    await chmod(join(home, ".claude", "settings.json"), 0o664);
    const f = await fixture({ env: { ...HARDENED, HOME: home } });
    const r = await f.runner.runOnce();
    expect(f.calls).toEqual([]);
    expect(r.reason).toBe(`self-test: claude config ${join(home, ".claude", "settings.json")} mode 0664 is group- or other-writable`);
  });

  it("hardened, an own 0700 dir with a 0600 settings.json: the run goes on", async () => {
    const dir = await configDir(0o700, 0o600);
    const f = await fixture({ env: { ...HARDENED, CLAUDE_CONFIG_DIR: dir } });
    await f.runner.runOnce();
    expect(f.calls).toHaveLength(2);
  });

  it("not hardened: a group-writable dir changes nothing", async () => {
    const dir = await configDir(0o770, 0o666);
    const f = await fixture({ env: { ...ENV, CHIEF_AGENT_UID: "1001", CLAUDE_CONFIG_DIR: dir } });
    await f.runner.runOnce();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].env.CLAUDE_CONFIG_DIR).toBe(dir);
  });
});

describe("DistillRunner.runOnce — proposal", () => {
  it("a good run writes the proposal, the classification and distill candidates, calls onProposal, emits brain", async () => {
    const f = await fixture();
    const lines = await f.decisions.read();
    const rulesBefore = await f.rules.all();
    const r = await f.runner.runOnce();

    // stdin of the distill call: the prompt, a blank line, the inputs.
    const input = collectInputs({ brain: APPLIED, rules: rulesBefore, lines, classified: [], now: NOW });
    expect(f.calls[1].stdin).toBe(DISTILL_PROMPT + "\n\n" + JSON.stringify(input));

    expect(r).toEqual({ proposed: true, size: f.brain.length, retire: 1, candidates: 1 });
    expect(await readFile(f.paths.proposed, "utf8")).toBe(f.brain);
    const meta = JSON.parse(await readFile(proposalJson(f.paths), "utf8"));
    const want: Proposal = { text: f.brain, sha256: sha(f.brain),
      retire: [{ id: f.old.id, why: "superseded", text: "Always squash merge." }], createdAt: NOW };
    expect(meta).toEqual({ sha256: want.sha256, retire: want.retire, createdAt: NOW });
    expect(await readProposal(f.paths)).toEqual(want);
    expect(f.proposals).toEqual([want]);
    expect(f.events).toEqual([{ type: "brain", updatedAt: NOW, proposed: true }]);
    // The applied brain is never touched by a run.
    expect(await readFile(f.paths.brain, "utf8")).toBe(APPLIED);

    expect(await f.classified.read()).toEqual([
      { at: f.l1.at, correction: true, by: "distill", runAt: NOW },
      { at: f.l2.at, correction: false, by: "distill", runAt: NOW },
    ]);
    const cands = await candidates(f.rules);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ text: "Never offer to merge.", state: "candidate", kind: "preference",
      scope: { area: "*", audience: "all" }, source: { origin: "distill", decisionAt: f.l1.at }, confidence: 0.6 });
    // No retire event yet: Apply (Task 1b-12) writes them.
    expect((await f.rules.get(f.old.id))?.state).toBe("active");

    expect(f.runner.status()).toEqual({ enabled: true, lastRun: NOW, droppedCandidates: 0, droppedCorrections: 0 });
    expect(f.notes).toEqual([]);
  });

  it("counts a dropped candidate and a dropped correction in status", async () => {
    const f = await fixture();
    f.distill = ok(JSON.stringify({ ...f.good, candidates: [{ text: "Never offer" }, { text: "Never offer to merge." }],
      corrections: [f.l1.at, 12345] }));
    const r = await f.runner.runOnce();
    expect(r.candidates).toBe(1);
    expect(f.runner.status()).toMatchObject({ droppedCandidates: 1, droppedCorrections: 1 });
  });

  it("a line classified by master-chat while the model runs keeps that entry", async () => {
    const f = await fixture();
    const good = f.distill;
    f.distill = async () => {
      await f.classified.append([{ at: f.l2.at, correction: true, by: "master-chat" }]);
      return good();
    };
    await f.runner.runOnce();
    const entries = await f.classified.read();
    expect(entries.filter((e) => e.at === f.l2.at)).toEqual([{ at: f.l2.at, correction: true, by: "master-chat" }]);
    expect(entries.filter((e) => e.at === f.l1.at)).toEqual([{ at: f.l1.at, correction: true, by: "distill", runAt: NOW }]);
  });

  it("a brain equal to the applied one with no retire is no change: no proposal, card, event or notify", async () => {
    const f = await fixture();
    f.distill = ok("nothing");
    await f.runner.runOnce();
    expect(f.runner.status().reason).toBeDefined();
    f.notes.length = 0;
    await atomicWrite(f.paths.brain, f.brain);
    f.distill = ok(JSON.stringify({ ...f.good, retire: [] }));
    const r = await f.runner.runOnce();
    expect(r).toEqual({ proposed: false, size: f.brain.length, retire: 0, candidates: 1, reason: "no change" });
    expect(existsSync(f.paths.proposed)).toBe(false);
    expect(existsSync(proposalJson(f.paths))).toBe(false);
    expect(f.proposals).toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.notes).toEqual([]);
    // The classification and the candidates are still written.
    expect(await f.classified.read()).toHaveLength(2);
    expect(await candidates(f.rules)).toHaveLength(1);
    expect(f.runner.status()).toEqual({ enabled: true, lastRun: NOW, droppedCandidates: 0, droppedCorrections: 0 });
  });

  it("no change ignores the dated first line: the same body under a new date is no change", async () => {
    const f = await fixture();
    await atomicWrite(f.paths.brain, f.brain.replace("# Brain (2026-11-09)", "# Brain (2026-11-01)"));
    f.distill = ok(JSON.stringify({ ...f.good, retire: [] }));
    expect(await f.runner.runOnce()).toEqual({ proposed: false, size: f.brain.length, retire: 0, candidates: 1, reason: "no change" });
    expect(existsSync(f.paths.proposed)).toBe(false);
    expect(f.proposals).toEqual([]);
    // dry run too
    expect(await f.runner.runOnce({ dryRun: true })).toMatchObject({ proposed: false, reason: "no change" });
    // A changed body under the same date is a proposal.
    f.distill = ok(JSON.stringify({ ...f.good, retire: [], brain: f.brain + "Prose.\n" }));
    expect(await f.runner.runOnce()).toMatchObject({ proposed: true });
  });

  it("the same brain with a retire list is still a proposal", async () => {
    const f = await fixture();
    await atomicWrite(f.paths.brain, f.brain);
    const r = await f.runner.runOnce();
    expect(r).toMatchObject({ proposed: true, retire: 1 });
    expect(f.proposals).toHaveLength(1);
  });

  it("no change compares the full applied text, not a cut copy", async () => {
    const f = await fixture();
    // A valid brain of exactly BRAIN_MAX chars; the applied file is that text plus one more line.
    const head = `${f.brain}\n`;
    const pad = "ab ".repeat(BRAIN_MAX).slice(0, BRAIN_MAX - head.length - 1).trimEnd();
    const full = (head + pad).padEnd(BRAIN_MAX - 1, "c") + "\n";
    expect(full).toHaveLength(BRAIN_MAX);
    await atomicWrite(f.paths.brain, `${full}- Use pnpm, never npm. [${f.keep.id}]\n`);
    f.distill = ok(JSON.stringify({ ...f.good, brain: full, retire: [] }));
    const r = await f.runner.runOnce();
    expect(r).toMatchObject({ proposed: true, size: BRAIN_MAX, retire: 0 });
  });

  it("dryRun: no change reports it and writes nothing", async () => {
    const f = await fixture();
    await atomicWrite(f.paths.brain, f.brain);
    f.distill = ok(JSON.stringify({ ...f.good, retire: [] }));
    const before = await snapshot(f.paths);
    const r = await f.runner.runOnce({ dryRun: true });
    expect(r).toEqual({ proposed: false, size: f.brain.length, retire: 0, candidates: 1, reason: "no change" });
    expect(await snapshot(f.paths)).toEqual(before);
    expect(f.proposals).toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.notes).toEqual([]);
  });

  it("prose and a fence around the JSON are ignored", async () => {
    const f = await fixture();
    f.distill = ok("Here you go:\n```json\n" + JSON.stringify(f.good) + "\n```\nDone.");
    const r = await f.runner.runOnce();
    expect(r.proposed).toBe(true);
  });

  it("dryRun returns the proposal text and writes nothing", async () => {
    const f = await fixture();
    const before = await snapshot(f.paths);
    const r = await f.runner.runOnce({ dryRun: true });
    expect(r).toEqual({ proposed: false, size: f.brain.length, retire: 1, candidates: 1, proposal: f.brain });
    expect(await snapshot(f.paths)).toEqual(before);
    expect(existsSync(f.paths.proposed)).toBe(false);
    expect(existsSync(proposalJson(f.paths))).toBe(false);
    expect(await candidates(f.rules)).toEqual([]);
    expect(await f.classified.read()).toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.proposals).toEqual([]);
    expect(f.notes).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(f.runner.status()).toEqual({ enabled: true });
  });

  it("dryRun with an invalid brain reports the reason and writes nothing", async () => {
    const f = await fixture();
    f.distill = ok(JSON.stringify({ ...f.good, brain: "no header" }));
    const before = await snapshot(f.paths);
    const r = await f.runner.runOnce({ dryRun: true });
    expect(r.proposed).toBe(false);
    expect(r.reason).toMatch(/does not start with/);
    expect(r).not.toHaveProperty("proposal");
    expect(await snapshot(f.paths)).toEqual(before);
    expect(f.notes).toEqual([]);
  });

  it("an invalid brain writes the classification and candidates, no proposal, and notifies distill failed", async () => {
    const f = await fixture();
    f.distill = ok(JSON.stringify({ ...f.good, brain: `# Brain (x)\n\n## Always\n- invented [r_nope0]\n` }));
    const r = await f.runner.runOnce();
    expect(r.proposed).toBe(false);
    expect(r.reason).toBe("line 4: cites an unknown rule id");
    expect(r.candidates).toBe(1);
    expect(f.notes).toEqual(["distill failed: line 4: cites an unknown rule id"]);
    expect(existsSync(f.paths.proposed)).toBe(false);
    expect(existsSync(proposalJson(f.paths))).toBe(false);
    expect(await readProposal(f.paths)).toBeNull();
    expect(f.proposals).toEqual([]);
    expect(f.events).toEqual([]);
    expect(await f.classified.read()).toHaveLength(2);
    expect(await candidates(f.rules)).toHaveLength(1);
    expect(f.runner.status()).toMatchObject({ enabled: true, lastRun: NOW, reason: "line 4: cites an unknown rule id" });
  });

  it("output with no JSON object fails without writes", async () => {
    const f = await fixture();
    f.distill = ok("I cannot help with that.");
    const r = await f.runner.runOnce();
    expect(r).toMatchObject({ proposed: false, reason: "no JSON object in the output" });
    expect(f.notes).toEqual(["distill failed: no JSON object in the output"]);
    expect(await f.classified.read()).toEqual([]);
  });

  it("a later good run clears the reason", async () => {
    const f = await fixture();
    f.distill = ok("nothing");
    await f.runner.runOnce();
    expect(f.runner.status().reason).toBeDefined();
    f.distill = ok(JSON.stringify(f.good));
    await f.runner.runOnce();
    expect(f.runner.status().reason).toBeUndefined();
  });

  it("onProposal failing still leaves the proposal and the run reports proposed", async () => {
    const f = await fixture();
    const runner = new DistillRunner({ paths: f.paths, rules: f.rules, decisions: f.decisions, classified: f.classified,
      run: (_a, c) => (c.stdin === SELF_TEST_PROMPT ? f.selfTest : f.distill)(), env: ENV, claudeBin: BIN,
      hub: { emitEvent: (e) => { f.events.push(e); } }, notify: (t) => { f.notes.push(t); },
      onProposal: () => Promise.reject(new Error("telegram down")), now: () => NOW });
    const r = await runner.runOnce();
    expect(r.proposed).toBe(true);
    expect(await readProposal(f.paths)).not.toBeNull();
    expect(f.events).toEqual([{ type: "brain", updatedAt: NOW, proposed: true }]);
  });

  it("an onProposal that never settles does not hold the run", async () => {
    const f = await fixture();
    const runner = new DistillRunner({ paths: f.paths, rules: f.rules, decisions: f.decisions, classified: f.classified,
      run: (_a, c) => (c.stdin === SELF_TEST_PROMPT ? f.selfTest : f.distill)(), env: ENV, claudeBin: BIN,
      hub: { emitEvent: (e) => { f.events.push(e); } }, notify: (t) => { f.notes.push(t); },
      onProposal: () => new Promise<void>(() => {}), now: () => NOW });
    const hung = new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000));
    const r = await Promise.race([runner.runOnce(), hung]);
    expect(r).toMatchObject({ proposed: true });
    expect(f.events).toEqual([{ type: "brain", updatedAt: NOW, proposed: true }]);
    // The next run is not queued behind the hung card post.
    expect(await Promise.race([runner.runOnce({ dryRun: true }), hung])).toMatchObject({ proposed: false });
  });

  it("two runs at once never call claude at the same time", async () => {
    const f = await fixture();
    let active = 0;
    let peak = 0;
    const slow = (inner: Responder): Responder => async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return inner();
    };
    f.selfTest = slow(ok("NONE"));
    f.distill = slow(ok(JSON.stringify(f.good)));
    await Promise.all([f.runner.runOnce(), f.runner.runOnce({ dryRun: true })]);
    expect(f.calls).toHaveLength(4);
    expect(peak).toBe(1);
  });
});

describe("DistillRunner — failure paths (Review Focus 3)", () => {
  const cases: [string, () => Responder, RegExp][] = [
    ["a missing claude (ENOENT)", enoent, new RegExp(`claude not found at ${BIN}`)],
    ["a non-zero exit", exit1, /claude exited with code 1: Not logged in/],
    ["a timeout", timeout, /timed out after 600 s/],
  ];

  for (const [name, make, re] of cases) {
    it(`${name} at the self-test: proposed false, reason, BRAIN.md unchanged, one notify`, async () => {
      const f = await fixture();
      f.selfTest = make();
      const r = await f.runner.runOnce();
      expect(r.proposed).toBe(false);
      expect(r.reason).toMatch(re);
      expect(f.runner.status()).toMatchObject({ enabled: false, reason: r.reason });
      expect(f.notes).toHaveLength(1);
      expect(f.notes[0]).toMatch(/^distill disabled: /);
      expect(await readFile(f.paths.brain, "utf8")).toBe(APPLIED);
      expect(existsSync(f.paths.proposed)).toBe(false);
      expect(await f.classified.read()).toEqual([]);
      expect(await candidates(f.rules)).toEqual([]);
    });

    it(`${name} at the distill call: proposed false, reason, nothing written, one notify`, async () => {
      const f = await fixture();
      f.distill = make();
      const r = await f.runner.runOnce();
      expect(r.proposed).toBe(false);
      expect(r.reason).toMatch(re);
      expect(f.runner.status()).toMatchObject({ enabled: true, lastRun: NOW, reason: r.reason });
      expect(f.notes).toEqual([`distill failed: ${r.reason}`]);
      expect(await readFile(f.paths.brain, "utf8")).toBe(APPLIED);
      expect(existsSync(f.paths.proposed)).toBe(false);
      expect(await f.classified.read()).toEqual([]);
      expect(await candidates(f.rules)).toEqual([]);
      expect(f.events).toEqual([]);
    });

    it(`${name}: the start() timer callback does not throw`, async () => {
      const f = await fixture();
      f.selfTest = make();
      f.runner.start();
      await vi.waitFor(() => expect(f.timers).toHaveLength(1));
      expect(() => f.timers[0].fn()).not.toThrow();
      await vi.waitFor(() => expect(f.calls).toHaveLength(2));
      await vi.waitFor(() => expect(f.timers).toHaveLength(2));
      await f.runner.runOnce({ dryRun: true });   // drains the slot's run (chained)
      expect(f.notes).toHaveLength(1);
    });
  }

  it("a stub that throws synchronously, a throwing notify and a throwing hub never escape", async () => {
    const f = await fixture();
    const runner = new DistillRunner({ paths: f.paths, rules: f.rules, decisions: f.decisions, classified: f.classified,
      run: (_a, c) => { if (c.stdin === SELF_TEST_PROMPT) return f.selfTest(); throw new Error("sync boom"); },
      env: ENV, claudeBin: BIN, hub: { emitEvent: () => { throw new Error("hub"); } },
      notify: () => { throw new Error("notify"); }, onProposal: async () => {}, now: () => NOW,
      setTimer: (fn, ms) => { f.timers.push({ fn, ms, cleared: false }); return { clear: () => {} }; } });
    const r = await runner.runOnce();
    expect(r).toMatchObject({ proposed: false, reason: "claude run failed: sync boom" });
    runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    expect(() => f.timers[0].fn()).not.toThrow();
    await vi.waitFor(() => expect(f.timers).toHaveLength(2));
    // Runs are chained: this one ends after the slot's run, so no run is
    // still writing the run dir when the test removes its root.
    expect(await runner.runOnce({ dryRun: true })).toMatchObject({ reason: "claude run failed: sync boom" });
  });

  it("a notify that returns a rejected promise causes no unhandled rejection", async () => {
    const f = await fixture();
    const runner = new DistillRunner({ paths: f.paths, rules: f.rules, decisions: f.decisions, classified: f.classified,
      run: () => Promise.resolve({ code: 2, stdout: "", stderr: "" }), env: ENV, claudeBin: BIN,
      hub: { emitEvent: () => {} }, notify: () => Promise.reject(new Error("bridge down")) as unknown as void,
      onProposal: async () => {}, now: () => NOW });
    const r = await runner.runOnce();
    expect(r.reason).toBe("self-test: claude exited with code 2");
    await new Promise((res) => setTimeout(res, 10));
  });
});

describe("DistillRunner.start", () => {
  it("runs the self-test before any timer is armed, then arms the next 03:30 in host TZ", async () => {
    const f = await fixture();
    const stop = f.runner.start();
    expect(f.timers).toHaveLength(0);
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].stdin).toBe(SELF_TEST_PROMPT);
    expect(f.calls[0].timersArmed).toBe(0);
    expect(f.timers[0].ms).toBe(30 * MIN);
    expect(f.runner.status()).toEqual({ enabled: true });
    stop();
    expect(f.timers[0].cleared).toBe(true);
  });

  it("CHIEF_DISTILL_AT already past today → tomorrow; then the next day's slot", async () => {
    const f = await fixture({ at: "02:15" });
    f.runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    const want = new Date(2026, 10, 10, 2, 15, 0, 0).getTime() - NOW;
    expect(f.timers[0].ms).toBe(want);
    f.setNow(NOW + want);
    f.timers[0].fn();
    expect(f.timers).toHaveLength(2);
    expect(f.timers[1].ms).toBe(DAY);
    await vi.waitFor(() => expect(f.proposals).toHaveLength(1));
  });

  it("each slot re-arms for the next at in host TZ: a DST change does not shift it; an early fire still waits a day", async () => {
    const saved = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const f = await fixture();
      // 03:30 EDT on the night before the fall-back (2026-11-01 02:00 EDT → 01:00 EST).
      const slotAt = new Date(2026, 9, 31, 3, 30, 0, 0).getTime();
      f.setNow(slotAt - 30 * MIN);
      f.runner.start();
      await vi.waitFor(() => expect(f.timers).toHaveLength(1));
      expect(f.timers[0].ms).toBe(30 * MIN);
      f.setNow(slotAt);
      f.timers[0].fn();
      expect(f.timers[1].ms).toBe(25 * 60 * MIN);
      await vi.waitFor(() => expect(f.proposals).toHaveLength(1));
      // A timer that fires 5 ms early arms the day after, not a second run in 5 ms.
      f.setNow(slotAt + 25 * 60 * MIN - 5);
      f.timers[1].fn();
      expect(f.timers[2].ms).toBe(DAY + 5);
      // start self-test, then self-test + distill for each of the two slots.
      await vi.waitFor(() => expect(f.proposals).toHaveLength(2));
      expect(f.calls).toHaveLength(5);
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  it("an invalid at falls back to 03:30", async () => {
    const f = await fixture({ at: "25:00" });
    f.runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    expect(f.timers[0].ms).toBe(30 * MIN);
  });

  it("a failing start self-test leaves enabled false; the next slot self-tests again and runs when it passes", async () => {
    const f = await fixture();
    f.selfTest = exit1();
    f.runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    expect(f.runner.status()).toMatchObject({ enabled: false, reason: "self-test: claude exited with code 1: Not logged in · Please run /login" });
    expect(f.notes).toHaveLength(1);

    f.selfTest = ok("NONE");
    f.setNow(NOW + 30 * MIN);
    f.timers[0].fn();
    await vi.waitFor(() => expect(f.proposals).toHaveLength(1));
    expect(f.calls.map((c) => c.stdin === SELF_TEST_PROMPT)).toEqual([true, true, false]);
    expect(f.runner.status()).toMatchObject({ enabled: true, lastRun: NOW + 30 * MIN });
    expect(f.runner.status().reason).toBeUndefined();
    expect(f.events).toEqual([{ type: "brain", updatedAt: NOW + 30 * MIN, proposed: true }]);
  });

  it("a slot that fires while a run is still going is skipped (no overlap) and the next slot is armed", async () => {
    const f = await fixture();
    f.runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    let release!: () => void;
    f.selfTest = () => new Promise((res) => { release = () => res({ code: 0, stdout: envelope("NONE"), stderr: "" }); });
    f.timers[0].fn();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    f.timers[1].fn();
    expect(f.timers).toHaveLength(3);
    await new Promise((res) => setTimeout(res, 10));
    expect(f.calls).toHaveLength(2);
    release();
    await vi.waitFor(() => expect(f.proposals).toHaveLength(1));
    await new Promise((res) => setTimeout(res, 20));
    expect(f.calls).toHaveLength(3);
    expect(f.proposals).toHaveLength(1);
  });

  it("a slot that fires while a route run is going queues behind it on the chain", async () => {
    const f = await fixture();
    f.runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    let release!: () => void;
    f.selfTest = () => new Promise((res) => { release = () => res({ code: 0, stdout: envelope("NONE"), stderr: "" }); });
    const route = f.runner.runOnce();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    f.selfTest = ok("NONE");
    f.timers[0].fn();
    expect(f.timers).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 10));
    expect(f.calls).toHaveLength(2);
    release();
    expect((await route).proposed).toBe(true);
    await vi.waitFor(() => expect(f.proposals).toHaveLength(2));
    expect(f.calls.map((c) => c.stdin === SELF_TEST_PROMPT)).toEqual([true, true, false, true, false]);
  });

  it("stop() clears the armed timer and a slot after stop does nothing", async () => {
    const f = await fixture();
    const stop = f.runner.start();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    stop();
    f.timers[0].fn();
    await new Promise((res) => setTimeout(res, 10));
    expect(f.calls).toHaveLength(1);
    expect(f.timers).toHaveLength(1);
  });

  it("start() never throws, even when the stub throws synchronously at the start self-test", async () => {
    const f = await fixture();
    f.selfTest = () => { throw new Error("sync"); };
    expect(() => f.runner.start()).not.toThrow();
    await vi.waitFor(() => expect(f.timers).toHaveLength(1));
    expect(f.runner.status()).toMatchObject({ enabled: false, reason: "self-test: claude run failed: sync" });
  });
});

describe("readProposal", () => {
  it("is null with no proposal, a corrupt proposal.json, or a hand-edited BRAIN.proposed.md", async () => {
    const f = await fixture();
    expect(await readProposal(f.paths)).toBeNull();
    await f.runner.runOnce();
    expect(await readProposal(f.paths)).not.toBeNull();
    await atomicWrite(f.paths.proposed, f.brain + "- sneaky [r_zzzzz]\n");
    expect(await readProposal(f.paths)).toBeNull();
    await atomicWrite(f.paths.proposed, f.brain);
    expect(await readProposal(f.paths)).not.toBeNull();
    await atomicWrite(proposalJson(f.paths), "{not json");
    expect(await readProposal(f.paths)).toBeNull();
    await atomicWrite(proposalJson(f.paths), JSON.stringify({ sha256: sha(f.brain), retire: [{ id: 1 }], createdAt: NOW }));
    expect(await readProposal(f.paths)).toBeNull();
  });
});

describe("makeClaudeRun", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chief-fakeclaude-"));
    roots.push(dir);
  });
  const script = async (name: string, body: string) => {
    const p = join(dir, name);
    await writeFile(p, `#!/bin/sh\n${body}\n`);
    await chmod(p, 0o755);
    return p;
  };
  const env = { PATH: "/usr/bin:/bin", ONLY_ME: "1" };

  it("passes args, writes stdin then closes it, runs in cwd with exactly the given env", async () => {
    const bin = await script("echo", 'cat; for a in "$@"; do printf "[%s]" "$a" >&2; done; printf "\\nPWD:%s\\n" "$(pwd)" >&2; env >&2');
    const cwd = join(dir, "run");
    await mkdir(cwd);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-from-parent";
    try {
      const r = await makeClaudeRun(bin)(["-p", "--tools", ""], { stdin: "héllo\nworld", cwd, env, timeoutMs: 5000 });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("héllo\nworld");
      expect(r.stderr).toContain("[-p][--tools][]\n");
      expect(r.stderr).toContain(`PWD:${cwd}\n`);
      expect(r.stderr).toContain("ONLY_ME=1");
      expect(r.stderr).not.toContain("ANTHROPIC_API_KEY");
      expect(r.stderr).not.toContain("sk-from-parent");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("a non-zero exit resolves with the code and the output", async () => {
    const bin = await script("fail", 'echo out; echo err >&2; exit 3');
    const r = await makeClaudeRun(bin)([], { stdin: "", cwd: dir, env, timeoutMs: 5000 });
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("a timeout kills the child with SIGKILL and rejects at once", async () => {
    const bin = await script("slow", "trap '' TERM; sleep 5; echo late");
    const t0 = Date.now();
    await expect(makeClaudeRun(bin)([], { stdin: "", cwd: dir, env, timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a timeout SIGKILLs the whole process group (a child that ignores TERM too)", async () => {
    const pids = join(dir, "pids");
    const bin = await script("group", `trap '' TERM; sleep 30 & echo "$$ $!" > ${pids}; wait`);
    await expect(makeClaudeRun(bin)([], { stdin: "", cwd: dir, env, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    const ids = (await readFile(pids, "utf8")).trim().split(" ").map(Number);
    expect(ids).toHaveLength(2);
    // Dead = gone from /proc or a zombie waiting to be reaped.
    const dead = (pid: number) => {
      try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").startsWith("Z"); } catch { return true; }
    };
    await vi.waitFor(() => expect(ids.map(dead)).toEqual([true, true]), { timeout: 2000 });
  });

  it("a missing binary rejects with ENOENT", async () => {
    await expect(makeClaudeRun(join(dir, "nope"))([], { stdin: "x", cwd: dir, env, timeoutMs: 5000 }))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("output over the cap is a failure with a reason, not a throw", async () => {
    const bin = await script("loud", "head -c 200000 /dev/zero; sleep 5");
    const t0 = Date.now();
    await expect(makeClaudeRun(bin, { maxOutput: 1000 })([], { stdin: "", cwd: dir, env, timeoutMs: 5000 }))
      .rejects.toThrow(/output over 1000 bytes/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a child that exits without reading a large stdin resolves (no EPIPE crash)", async () => {
    const bin = await script("deaf", "exit 0");
    const r = await makeClaudeRun(bin)([], { stdin: "x".repeat(2_000_000), cwd: dir, env, timeoutMs: 5000 });
    expect(r.code).toBe(0);
  });
});

describe("DistillRunner.runOnce — capped input log", () => {
  const capped = (w: ReturnType<typeof vi.spyOn>) =>
    w.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("distill input capped"));

  it("logs exactly one capped line and keeps the dropped counts out of stdin", async () => {
    const f = await fixture();
    for (let i = 0; i < 120; i++) {
      await f.rules.add({ text: `Candidate number ${i}.`, scope: { area: "*" }, kind: "preference",
        source: { origin: "user-line", decisionAt: NOW - i }, state: "candidate" });
    }
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.runner.runOnce();
      expect(capped(w)).toEqual(["[chief] distill input capped: dropped 0 decisions, 0 rules, 20 candidates"]);
    } finally {
      w.mockRestore();
    }
    const stdin = f.calls[1].stdin;
    expect(stdin).not.toContain("dropped");
    const input = JSON.parse(stdin.slice(DISTILL_PROMPT.length + 2));
    expect(Object.keys(input).sort()).toEqual(["brain", "candidates", "decisions", "rules"]);
    expect(input.candidates).toHaveLength(100);
  });

  it("logs nothing when no list is cut", async () => {
    const f = await fixture();
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.runner.runOnce();
      expect(capped(w)).toEqual([]);
    } finally {
      w.mockRestore();
    }
  });
});
