import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../server/chief/files.js";
import { BRAIN_PROMPT_HEAD as TS_HEAD, NO_MERGE_RULE as TS_RULE, readBrain, renderRules } from "../../server/chief/brain/prompt.js";
import { RuleStore, foldRules, type RuleEvent } from "../../server/chief/brain/store.js";
import { claudeConfigProblem as tsClaudeConfigProblem, hardenedDeployment } from "../../server/chief/hardened.js";
import {
  BRAIN_PROMPT_HEAD, NO_MERGE_RULE, activeRuleIds, activeRules, alwaysSection, chiefCronArgs, chiefCronEnv, chiefDataDir,
  claudeConfigProblem, hardenedCron, hardenedCronArgs, hardenedRunRefusal,
} from "./chief-cron.mjs";
import { BRAIN_FIXTURE, RULES_FIXTURE } from "./chief-cron.fixtures.js";

const tmp = () => mkdtemp(join(tmpdir(), "chief-cron-"));

describe("chief-cron", () => {
  it("JS merge rule equals the TS constant", () => {
    expect(NO_MERGE_RULE).toBe(TS_RULE);
  });
  it("flag off: no args, same env object", () => {
    expect(chiefCronArgs({})).toEqual([]);
    expect(chiefCronArgs({ CHIEF_ENABLED: "0" })).toEqual([]);
    const e = { CHOIBOT_USER_TOKEN: "u" };
    expect(chiefCronEnv(e, "j1")).toBe(e);
  });
  it("flag on, no brain files: merge rule args only", async () => {
    const env = { CHIEF_ENABLED: "1", CHIEF_DATA_DIR: await tmp() };
    expect(chiefCronArgs(env)).toEqual(["--append-system-prompt", NO_MERGE_RULE]);
  });
  it("flag on, unreadable brain (rules.jsonl is a directory): merge rule only, no throw", async () => {
    const d = await tmp();
    await mkdir(join(d, "brain", "rules.jsonl"), { recursive: true });
    expect(chiefCronArgs({ CHIEF_ENABLED: "1", CHIEF_DATA_DIR: d })).toEqual(["--append-system-prompt", NO_MERGE_RULE]);
  });
  it("flag on with brain files: rule + head + Always section", async () => {
    const d = await tmp();
    await mkdir(join(d, "brain"), { recursive: true });
    await writeFile(join(d, "brain", "rules.jsonl"), RULES_FIXTURE);
    await writeFile(join(d, "brain", "BRAIN.md"), BRAIN_FIXTURE);
    const [flag, text] = chiefCronArgs({ CHIEF_ENABLED: "1", CHIEF_DATA_DIR: d });
    expect(flag).toBe("--append-system-prompt");
    expect(text).toBe(NO_MERGE_RULE + "\n\n" + BRAIN_PROMPT_HEAD + "## Always\n- always keep it short [r_aaaaa]\n- edited text [r_eeeee]");
  });
  it("flag off: argv unchanged even with brain files", async () => {
    const d = await tmp();
    await mkdir(join(d, "brain"), { recursive: true });
    await writeFile(join(d, "brain", "rules.jsonl"), RULES_FIXTURE);
    await writeFile(join(d, "brain", "BRAIN.md"), BRAIN_FIXTURE);
    expect(chiefCronArgs({ CHIEF_DATA_DIR: d })).toEqual([]);
    expect(chiefCronArgs({ CHIEF_ENABLED: "0", CHIEF_DATA_DIR: d })).toEqual([]);
  });
  it("chiefDataDir precedence", () => {
    expect(chiefDataDir({ CHIEF_DATA_DIR: "/a", XDG_DATA_HOME: "/x" })).toBe("/a");
    expect(chiefDataDir({ XDG_DATA_HOME: "/x" })).toBe("/x/choibot/chief");
    expect(chiefDataDir({ HOME: "/h" })).toMatch(/choibot\/chief$/);
  });
  it("parity: BRAIN_PROMPT_HEAD equals TS", () => {
    expect(BRAIN_PROMPT_HEAD).toBe(TS_HEAD);
  });
  it("parity: activeRuleIds equals TS foldRules active ids (hard cases)", () => {
    const ts = [...foldRules(parseJsonl<RuleEvent>(RULES_FIXTURE)).values()].filter((r) => r.state === "active").map((r) => r.id);
    expect([...activeRuleIds(RULES_FIXTURE)].sort()).toEqual(ts.sort());
    expect(ts.sort()).toEqual(["r_aaaaa", "r_ddddd", "r_eeeee"]);
  });
  it("parity: activeRules and alwaysSection equal TS foldRules and renderRules always", () => {
    const ts = [...foldRules(parseJsonl<RuleEvent>(RULES_FIXTURE)).values()].filter((r) => r.state === "active");
    expect(activeRules(RULES_FIXTURE)).toEqual(ts.map(({ id, text, scope }) => ({ id, text, scope })));
    expect(alwaysSection(activeRules(RULES_FIXTURE))).toBe(renderRules(ts, "always"));
    expect(alwaysSection(activeRules(RULES_FIXTURE))).not.toBe("");
    const odd = [
      { id: "r_1", text: "a\n## x", scope: { area: "*" } }, { id: "r_2", text: "b", scope: { area: "always" } },
      { id: "r_3", text: "c", scope: { area: "a b" } }, { id: "r_4", text: " ", scope: { area: "*" } },
      { id: "r_5", text: "d", scope: { area: "*", audience: "master" as const } },
    ];
    expect(alwaysSection(odd)).toBe(renderRules(odd, "always"));
    expect(alwaysSection([])).toBe("");
  });
  it("parity: a brain over 4000 chars is cut on a line boundary as TS readBrain does", async () => {
    const d = await tmp();
    await mkdir(join(d, "brain"), { recursive: true });
    const store = new RuleStore(join(d, "brain", "rules.jsonl"));
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      const text = `rule ${i} ${"word ".repeat(20).trim()}`;
      const { rule } = await store.add({ text, scope: { area: "*" }, kind: "preference", source: { origin: "panel" }, state: "active" });
      lines.push(`- ${text} [${rule.id}]`);
    }
    const ts = await readBrain(d, "always");
    expect(ts.length).toBeLessThanOrEqual(4000);
    expect(ts.length).toBeGreaterThan(3000);
    const [, text] = chiefCronArgs({ CHIEF_ENABLED: "1", CHIEF_DATA_DIR: d });
    expect(text).toBe(NO_MERGE_RULE + "\n\n" + BRAIN_PROMPT_HEAD + ts);
  });
  it("flag on: agent id set, user token removed, input untouched", () => {
    const e = { CHIEF_ENABLED: "1", CHOIBOT_USER_TOKEN: "u", X: "y" };
    const out = chiefCronEnv(e, "j1");
    expect(out).toMatchObject({ CHOIBOT_AGENT_ID: "cron:j1", X: "y" });
    expect(out).not.toHaveProperty("CHOIBOT_USER_TOKEN");
    expect(e.CHOIBOT_USER_TOKEN).toBe("u");
  });
});

// Ruling 2c-8-a (b): the runner's copy of hardenedDeployment (P4), the only
// non-TS reader. Parity on the cases that decide it.
describe("hardenedCron", () => {
  const LOG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
  const TG = {
    CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_ISSUES_USER_ID: "42", TELEGRAM_MASTER_CHAT_ID: "-100123", TELEGRAM_MASTER_THREAD_ID: "7",
  };
  const CASES: Record<string, string | undefined>[] = [
    {}, { CHIEF_AGENT_UID: "1001" }, { ...LOG }, { ...LOG, CHIEF_AGENT_UID: "1001" }, { ...LOG, CHIEF_AGENT_UID: " 1001 " },
    { ...LOG, CHIEF_AGENT_UID: "0" }, { ...LOG, CHIEF_AGENT_UID: "-1" }, { ...LOG, CHIEF_AGENT_UID: "01001" },
    { ...LOG, CHIEF_AGENT_UID: "4294967294" }, { ...LOG, CHIEF_AGENT_UID: "4294967295" }, { ...LOG, CHIEF_AGENT_UID: "1e3" },
    { ...LOG, CHIEF_AGENT_UID: "12345678901" }, { ...LOG, CHIEF_ENABLED: "0", CHIEF_AGENT_UID: "1001" },
    { ...LOG, CHIEF_ENABLED: "true", CHIEF_AGENT_UID: "1001" }, { ...LOG, CHIEF_CONSOLE_URL: "", CHIEF_AGENT_UID: "1001" },
    { ...LOG, CHIEF_USER_AUTH: "magic", CHIEF_AGENT_UID: "1001" }, { ...LOG, CHIEF_USER_AUTH: "", CHIEF_AGENT_UID: "1001" },
    { ...TG, CHIEF_USER_AUTH: "log", CHIEF_AGENT_UID: "1001" }, { ...TG, CHIEF_AGENT_UID: "1001" },
    { ...TG, CHIEF_USER_AUTH: "telegram", CHIEF_AGENT_UID: "1001" }, { ...TG, TELEGRAM_MASTER_THREAD_ID: "0", CHIEF_AGENT_UID: "1001" },
    { ...TG, TELEGRAM_MASTER_CHAT_ID: "100", CHIEF_AGENT_UID: "1001" }, { ...TG, TELEGRAM_ISSUES_USER_ID: "x", CHIEF_AGENT_UID: "1001" },
    { ...TG, TELEGRAM_BOT_TOKEN: "", CHIEF_AGENT_UID: "1001" }, { ...TG, TELEGRAM_MASTER_CHAT_ID: " -100123 ", CHIEF_AGENT_UID: "1001" },
    { ...TG, TELEGRAM_MASTER_THREAD_ID: "99999999999999999999", CHIEF_AGENT_UID: "1001" },
  ];
  it("equals the server's hardenedDeployment on every case", () => {
    for (const env of CASES) expect(hardenedCron(env), JSON.stringify(env)).toBe(hardenedDeployment(env));
    expect(CASES.filter((e) => hardenedCron(e)).length).toBeGreaterThan(2);
    expect(CASES.filter((e) => !hardenedCron(e)).length).toBeGreaterThan(10);
  });
  it("hardenedCronArgs: the two flags when hardened, else none", () => {
    expect(hardenedCronArgs({ ...LOG, CHIEF_AGENT_UID: "1001" })).toEqual(["--setting-sources", "user", "--strict-mcp-config"]);
    expect(hardenedCronArgs({ ...LOG })).toEqual([]);
    expect(hardenedCronArgs({})).toEqual([]);
  });
});

// Ruling F1: the runner's port of the server's claudeConfigProblem.
describe("claudeConfigProblem (runner port)", () => {
  it("equals the server's on every fixture", async () => {
    const self = process.getuid!();
    const d = await tmp();
    const cases: [string, () => Promise<void>][] = [
      ["0700, no settings", async () => { await chmod(d, 0o700); }],
      ["0770 dir", async () => { await chmod(d, 0o770); }],
      ["0755 dir, 0600 settings", async () => { await chmod(d, 0o755); await writeFile(join(d, "settings.json"), "{}"); await chmod(join(d, "settings.json"), 0o600); }],
      ["0664 settings", async () => { await chmod(join(d, "settings.json"), 0o664); }],
      ["0646 settings", async () => { await chmod(join(d, "settings.json"), 0o646); }],
    ];
    for (const [what, set] of cases) {
      await set();
      for (const uid of [self, self + 1]) {
        expect(claudeConfigProblem(d, uid), what).toBe(tsClaudeConfigProblem(d, uid));
      }
    }
    expect(claudeConfigProblem(join(d, "missing"), self)).toBeNull();
    expect(tsClaudeConfigProblem(join(d, "missing"), self)).toBeNull();
  });
  it("hardenedRunRefusal: hardened only; CLAUDE_CONFIG_DIR, else HOME/.claude", async () => {
    const LOG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };
    const d = await tmp();
    await chmod(d, 0o770);
    const cwd = await tmp(); // mkdtemp: 0700, ours
    expect(hardenedRunRefusal({ ...LOG, CLAUDE_CONFIG_DIR: d }, cwd)).toBe(`claude config ${d} mode 0770 is group- or other-writable`);
    expect(hardenedRunRefusal({ ...LOG, CHIEF_AGENT_UID: "", CLAUDE_CONFIG_DIR: d }, cwd)).toBeNull();
    const home = await tmp();
    await mkdir(join(home, ".claude"));
    await chmod(join(home, ".claude"), 0o777);
    expect(hardenedRunRefusal({ ...LOG, HOME: home }, cwd)).toBe(`claude config ${join(home, ".claude")} mode 0777 is group- or other-writable`);
    await chmod(join(home, ".claude"), 0o700);
    expect(hardenedRunRefusal({ ...LOG, HOME: home }, cwd)).toBeNull();
    await chmod(cwd, 0o770);
    expect(hardenedRunRefusal({ ...LOG, HOME: home }, cwd)).toMatch(/^job cwd .* mode 0770 lets a group or others write it/);
  });
});

// Strong protection with the agents' login (pick A): the runner's copies of the server's helper
// call. The keep list and the defaults must equal server/agents/terminal.ts and agentlogin.ts.
describe("strong task: parity with the server's helper call", () => {
  const STRONG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "1001", AGENT_CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude" };
  it("the keep list is SUDO_ENV_KEEP", async () => {
    const { SUDO_ENV_KEEP } = await import("../../server/agents/terminal.js");
    const { STRONG_ENV_KEEP } = await import("./chief-cron.mjs");
    expect([...STRONG_ENV_KEEP]).toEqual([...SUDO_ENV_KEEP]);
  });
  it("on and off as the server's agentAuthOf, with the same sudo, helper, uid and folder", async () => {
    const { agentAuthOf } = await import("../../server/agents/agentlogin.js");
    const { strongTask } = await import("./chief-cron.mjs");
    for (const env of [
      STRONG, { ...STRONG, AGENT_SUDO_BIN: "/x/sudo", AGENT_EXEC_HELPER: "/x/helper" }, { ...STRONG, CHIEF_AGENT_UID: undefined },
      { ...STRONG, CHIEF_ENABLED: undefined }, { ...STRONG, AGENT_CLAUDE_CONFIG_DIR: "rel" }, { ...STRONG, AGENT_CLAUDE_CONFIG_DIR: "" },
    ]) {
      const a = agentAuthOf(env);
      expect([env, strongTask(env)]).toEqual([env, a ? { ...a.exec, configDir: a.configDir } : null]);
    }
  });
  it("the call: sudo argv of claude-task, and an env of the keep list only, with the agents' folder", async () => {
    const { strongTask, strongTaskCall, STRONG_ENV_KEEP } = await import("./chief-cron.mjs");
    const c = strongTaskCall(strongTask(STRONG)!, "/srv/w/repo", 30, ["-p", "x"], { CHOIBOT_AGENT_ID: "cron:j", TELEGRAM_BOT_TOKEN: "t", CLAUDE_CONFIG_DIR: "/home/choibot/.claude", PATH: "/usr/bin" });
    expect(c.bin).toBe("/usr/bin/sudo");
    // The same form as the server's helperArgv: no --preserve-env (sudo would log each value).
    expect(c.args).toEqual(["-n", "-u", "#1001", "/usr/local/bin/choibot-agent-exec", "claude-task", "/srv/w/repo", "30", "--", "-p", "x"]);
    const { helperArgv } = await import("../../server/agents/terminal.js");
    expect([c.bin, ...c.args.slice(0, 4)]).toEqual(helperArgv({ sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 1001 }, "claude-task", []).slice(0, 5));
    expect(c.env).toEqual({ CHOIBOT_AGENT_ID: "cron:j", CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude" });
  });
});
