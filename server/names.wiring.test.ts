// The names at their use sites, in a real process. A child process starts with a HOME of its own,
// loads the modules that build paths, keys and prompts, and prints what they give: every value
// is one of the names table (server/names.mjs).
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Prints one JSON object. HOME is /h in every path that takes an env, so the table has no temp dir.
const PROBE = `(async () => {
const env = { HOME: "/h" };
const rec = { id: "a1", kind: "agent", repo: "/ws/demo", worktree: "/wt/a1", hookToken: "t" };
const [units, cronspec, defaults, client, terminal, paths, claude, codexHome, runner, agentEnv, chiefCron, argv, queuePrompt, deploy] = await Promise.all([
  import("./bin/lib/units.ts"), import("./bin/lib/cronspec.ts"), import("./server/defaults.ts"), import("./bin/lib/client.ts"),
  import("./server/agents/terminal.ts"), import("./server/chief/paths.ts"), import("./server/agents/runtimes/claude.ts"),
  import("./server/agents/runtimes/codex-home.ts"), import("./server/widgets/runner.ts"), import("./bin/lib/agent-env.mjs"),
  import("./bin/lib/chief-cron.mjs"), import("./server/agents/argv.ts"), import("./server/chief/queue/prompt.ts"),
  import("./server/chief/deploy/config.ts"),
]);
const cut = (s) => s.replaceAll(process.env.HOME, "~");
console.log("TABLE " + JSON.stringify({
  unit: units.UNIT_NAMES,
  deployUnit: deploy.deployUnit({}),
  cronUnits: cronspec.jobUnitNames("nightly"),
  dataRoot: defaults.resolveAppDataDir({ XDG_DATA_HOME: "/x" }),
  cronData: cronspec.resolveCronDataDir({ XDG_DATA_HOME: "/x" }),
  chiefData: paths.resolveChiefDataDir({ XDG_DATA_HOME: "/x" }),
  chiefDataOfCronRunner: chiefCron.chiefDataDir(env),
  userToken: client.userTokenPath(env),
  socket: terminal.agentSessionName("a1") + ".sock",
  serviceSocket: terminal.agentSessionName("svc-web") + ".sock",
  dtachDir: cut(terminal.AGENT_DTACH_DIR_RESOLVED).replace(/^\\/tmp\\b/, "<tmp>"),
  sudoEnvKeep: terminal.SUDO_ENV_KEEP,
  spoolEnv: Object.keys(terminal.helperAgentEnv("/homes", "/cron")),
  identityEnv: Object.keys(paths.agentIdentityEnv(rec)),
  widgetScriptEnv: Object.keys(runner.scriptEnv("/w", "a1", {})),
  cronJobEnv: Object.keys(chiefCron.chiefCronEnv({ CHIEF_ENABLED: "1", CHOIBOT_USER_TOKEN: "u" }, "nightly")),
  agentEnvAllowTail: agentEnv.AGENT_ENV_ALLOW.slice(-4),
  neverPass: agentEnv.NEVER_PASS,
  cli: paths.chiefCli("/repo"),
  hooksFile: claude.claudeHooksPath(rec, "/ws"),
  hooksFileNoRepo: claude.claudeHooksPath({ ...rec, repo: null, worktree: "/ws" }, "/ws"),
  codexHome: codexHome.codexHomeFor(rec, "/ws"),
  codexHomeNoRepo: codexHome.codexHomeFor({ ...rec, repo: null, worktree: "/ws" }, "/ws"),
  docsPrompt: argv.SHARED_DOCS_PROMPT.match(/\`[^\`]*docs[^\`]*\`/g),
  queuePrompt: queuePrompt.queueAgentPrompt("CLI").match(/[.\\w-]+\\/previews\\/<topic>-<n>\\.png/)[0],
}));
})().catch((e) => { console.error(e); process.exit(1); });
`;

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function probe(): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), "names-wiring-"));
  homes.push(home);
  const env = { PATH: process.env.PATH ?? "", HOME: home } as unknown as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    execFile(join(ROOT, "node_modules", ".bin", "tsx"), ["-e", PROBE], { cwd: ROOT, env, timeout: 60_000 }, (err, stdout, stderr) => {
      const line = stdout.split("\n").find((l) => l.startsWith("TABLE "));
      if (err || !line) return reject(new Error(`probe failed: ${err?.message ?? ""}\n${stderr}`));
      resolve(JSON.parse(line.slice(6)) as Record<string, unknown>);
    });
  });
}

const NEW = {
  unit: ["choibot.service"],
  deployUnit: "choibot.service",
  cronUnits: { service: "choibot-cron-nightly.service", timer: "choibot-cron-nightly.timer" },
  dataRoot: "/x/choibot",
  cronData: "/x/choibot/cron",
  chiefData: "/x/choibot/chief",
  chiefDataOfCronRunner: "/h/.local/share/choibot/chief",
  userToken: "/h/.config/choibot/user-token",
  socket: "choibot-a1.sock",
  serviceSocket: "choibot-svc-web.sock",
  dtachDir: "<tmp>/choibot-dtach",
  sudoEnvKeep: ["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TERM", "LANG", "CHOIBOT_WIDGET_DIR", "CHOIBOT_CRON_SPOOL", "CRON_DATA_DIR", "TZ"],
  spoolEnv: ["CHOIBOT_CRON_SPOOL", "CRON_DATA_DIR"],
  identityEnv: ["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS"],
  widgetScriptEnv: ["CHOIBOT_WIDGET_DIR", "CHOIBOT_AGENT_ID"],
  cronJobEnv: ["CHIEF_ENABLED", "CHOIBOT_AGENT_ID"],
  agentEnvAllowTail: ["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "CHOIBOT_WIDGET_DIR", "CHOIBOT_CRON_SPOOL"],
  neverPass: ["CONSOLE_COOKIE_SECRET", "TELEGRAM_BOT_TOKEN", "CHOIBOT_USER_TOKEN", "ANTHROPIC_API_KEY"],
  cli: "/repo/node_modules/.bin/tsx /repo/bin/choibot.ts",
  hooksFile: "/wt/a1/.choibot-hooks.json",
  hooksFileNoRepo: "/ws/.choibot-agents/a1/.choibot-hooks.json",
  codexHome: "/wt/a1/.choibot/codex-home",
  codexHomeNoRepo: "/ws/.choibot-agents/a1/codex-home",
  docsPrompt: ["`.choibot/docs.json`", "`.choibot/docs/`"],
  queuePrompt: ".choibot/previews/<topic>-<n>.png",
};

describe("the names at their use sites", () => {
  it("every value is one of the names table", async () => {
    expect(await probe()).toEqual(NEW);
  }, 70_000);
});

// A technical name written as a literal would skip the names table. Each one lives in names.mjs only.
describe("no technical name outside server/names.mjs", () => {
  const NAME = /choibot\.service|choibot-cron-|CHOIBOT_(AGENT_ID|AGENT_PASS|WIDGET_DIR|CRON_SPOOL|USER_TOKEN)|\.choibot-hooks\.json|\.choibot-agents|choibot-dtach|"\.choibot"|\.choibot\/|\.config\/choibot|"choibot-"/;
  const COMMENT = /^\s*(\/\/|\*|\/\*)/;
  // The file explorer refuses the token dir; one doc comment of a key.
  const ALLOWED = new Set(["server/files/refused.ts", "bin/lib/env.ts"]);

  it("holds for every shipped .ts, .tsx and .mjs code line in server, bin and src", () => {
    const files = execFileSync("git", ["ls-files", "-z", "server", "bin", "src"], { cwd: ROOT, encoding: "utf8" }).split("\0")
      .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("testdata") && f !== "server/names.mjs" && !ALLOWED.has(f));
    const found: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/\s\/\/ .*$/, "");
        if (!COMMENT.test(line) && NAME.test(code)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found).toEqual([]);
  });
});
