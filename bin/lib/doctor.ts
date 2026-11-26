// bin/lib/doctor.ts — the preflight checks behind `pnpm choibot doctor`. Every OS
// probe goes through ./exec.js so tests can mock the seam instead of the host.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { run, which } from "./exec.js";
import { ENV_SCHEMA, isMissing, parseEnv } from "./env.js";
import { CLI_NAME, DISPLAY_NAME } from "../../server/brand.js";
import { deployUnit } from "../../server/chief/deploy/config.js";
import { boxProbes } from "../../server/setup/probes.js";
import { cli, plain, runSteps, stepOf, type BoxFacts, type StepStatus } from "../../server/setup/steps.js";
import { AGENT_ENV_ALLOW, NEVER_PASS, agentEnvPass } from "./agent-env.mjs";
import { checkoutInWorkspace } from "./layout.js";
import { resolveCronDataDir } from "./cronspec.js";
import { CONSOLE_UNIT_TEMPLATE } from "./units.js";
import { envKeys, names } from "../../server/names.mjs";
import { chiefFlag, chiefMisconfigured, chiefPaths, chiefUserAuth, resolveChiefDataDir } from "../../server/chief/paths.js";
import { CONSOLE_HEADER } from "../../server/chief/auth.js";
import { readConsoleToken } from "../../server/chief/consoletoken.js";
import {
  agentSessionUids, checkHardened, hardenedDeployment, parseAgentUid, type HardenedFacts,
} from "../../server/chief/hardened.js";
import { agentHomeRoot } from "../../server/chief/homes.js";
import { chiefFacts, chiefWanted } from "../../server/chief/chiefaccount.js";
import { checkRepoProtection } from "../../server/agents/git.js";
import { settingsFile } from "../../server/layout.js";

export type CheckResult = { name: string; ok: boolean; required: boolean; detail: string; hint?: string };

type CheckOutcome = { ok: boolean; detail: string; hint?: string };
type Check = { name: string; required: boolean; check: () => Promise<CheckOutcome> };
// procRoot: the /proc the chief check scans (tests pass a fixture tree).
// env: the settings to check in place of the .env file's (the running console gives its own).
// requiredOnly: skip the advisory checks (the step list asks for the required ones only).
export type DoctorOpts = { procRoot?: string; env?: Map<string, string>; requiredOnly?: boolean };

// The two keys with no server-side default: everything else in ENV_SCHEMA
// either has a code default (PORT/HOST/…) or is optional, so a hand-rolled
// .env without them is still a healthy install.
const REQUIRED_ENV_KEYS = ["CONSOLE_COOKIE_SECRET", "WORKSPACE_DIR"];

async function checkBin(bin: string, hint: string): Promise<CheckOutcome> {
  const path = await which(bin);
  return path ? { ok: true, detail: path } : { ok: false, detail: "not found", hint };
}

function readDotEnv(repoDir: string): Map<string, string> {
  const path = settingsFile(repoDir);
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : new Map();
}

// `<label> <owner uid> <mode octal>` of a dir (followed), or why it cannot be read.
function dirFact(label: string, dir: string): string {
  try {
    const st = statSync(dir);
    return `${label} ${st.uid} ${(st.mode & 0o7777).toString(8).padStart(4, "0")}`;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return `${label} unreadable (${typeof code === "string" ? code : String(e)})`;
  }
}

// One `repo <name>: <problem>` line per checkRepoProtection problem
// (checklist C1, Ruling P8) for each direct child of WORKSPACE_DIR with a .git
// directory, names sorted; a .git file (a worktree) is skipped. None when
// .env has no WORKSPACE_DIR (the env check reports that).
function repoLines(workspaceDir: string | undefined, selfUid: number): string[] {
  if (!workspaceDir) return [];
  let names: string[];
  try {
    names = readdirSync(workspaceDir).sort();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return [`repos: ${workspaceDir} unreadable (${typeof code === "string" ? code : String(e)})`];
  }
  const lines: string[] = [];
  for (const name of names) {
    const repo = join(workspaceDir, name);
    try {
      if (!statSync(join(repo, ".git")).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const p of checkRepoProtection(repo, selfUid)) lines.push(`repo ${name}: ${p}`);
  }
  return lines;
}

// The chief check's hardening report (spec Appendix B step 5, Ruling P12):
// the server's own checkHardened on facts computed here (real /proc, the data
// and cron dirs, this checkout's .env, AGENT_HOME_ROOT and the
// AGENT_DTACH_DIR the server would use: the same check (1) as the server,
// ruling F6). The server arms the code-route gate in exactly this
// configuration once its helper probe passed, so check (4) takes both as on
// ("gate assumed"; the console log names a failed probe). The repo lines
// come last.
function hardenedReport(env: Record<string, string>, repoDir: string, procRoot = "/proc"): string[] {
  const selfUid = process.getuid?.() ?? -1;
  const cronDir = resolveCronDataDir(env);
  const homes = agentHomeRoot(env);
  const facts: HardenedFacts = {
    dataDir: resolveChiefDataDir(env), cronDir, envFile: settingsFile(repoDir), homeRoot: homes,
    selfUid, agentUid: parseAgentUid(env.CHIEF_AGENT_UID),
    // The server's default (server/agents/terminal.ts DTACH_DIR).
    dtachDir: env.AGENT_DTACH_DIR ?? join(tmpdir(), names().dtachDir),
    procRoot, agentExec: true, codeRouteGate: true,
    // The second account of the persistent agents, when it is asked for (its probe assumed, as
    // the gate's; the console log names a failed one).
    ...(chiefWanted(env) ? { chief: chiefFacts(true, env) } : {}),
  };
  const reasons = checkHardened(facts).reasons;
  // Ruling F1: the one Claude dir hardened claude agents run with.
  const agentClaude = env.AGENT_CLAUDE_CONFIG_DIR?.trim() ?? "";
  const agents = agentSessionUids(facts).map((a) => `${a.id}=${a.uids.join("+")}`);
  return [
    reasons.length === 0 ? "mode: strong (gate assumed)" : `mode: weak (gate assumed): ${reasons[0]}`,
    dirFact("data dir", facts.dataDir),
    dirFact("cron dir", cronDir),
    homes ? dirFact("homes", homes) : "homes: AGENT_HOME_ROOT not set",
    agentClaude !== "" && isAbsolute(agentClaude)
      ? dirFact("agent claude dir", agentClaude)
      : "agent claude dir: AGENT_CLAUDE_CONFIG_DIR not set (claude agents are refused)",
    // The dir scanned for sessions: the service's TMPDIR may differ from this shell's.
    `dtach dir ${facts.dtachDir}`,
    ...(facts.chief
      ? [facts.chief.problem !== null
        ? `persistent agents' account: ${facts.chief.problem}`
        : `persistent agents' account: uid ${facts.chief.uid}, dtach dir ${facts.chief.dtachDir}, homes ${facts.chief.homeRoot ?? "AGENT_HOME_ROOT not set"}`]
      : []),
    `agents: ${agents.length > 0 ? agents.join(", ") : "none"}`,
    ...repoLines(env.WORKSPACE_DIR, selfUid),
  ];
}

function checks(repoDir: string, opts: DoctorOpts): Check[] {
  const dotEnv = (): Map<string, string> => opts.env ?? readDotEnv(repoDir);
  return [
    {
      name: "platform",
      required: true,
      check: async () => ({
        ok: process.platform === "linux",
        detail: process.platform,
        hint: `${DISPLAY_NAME} supports Linux with systemd only`,
      }),
    },
    {
      name: "systemd (user)",
      required: true,
      check: async () => {
        const r = await run("systemctl", ["--user", "is-system-running"]);
        // A degraded/starting bus still answers, so the exit code alone is not a
        // verdict: what matters is whether we could reach the user bus at all.
        const ok = r.code !== -1 && !r.stderr.includes("Failed to connect");
        return {
          ok,
          detail: ok ? r.stdout.trim() || "running" : r.stderr.trim() || "unavailable",
          hint: "no user systemd bus; are you in an SSH session with a proper login? (loginctl show-user $USER)",
        };
      },
    },
    {
      name: "node",
      required: true,
      check: async () => {
        const major = Number(process.versions.node.split(".")[0]);
        return {
          ok: major >= 22,
          detail: `v${process.versions.node}`,
          hint: "install Node 22+ (e.g. via nvm)",
        };
      },
    },
    { name: "git", required: true, check: () => checkBin("git", "install git") },
    // pnpm is trivially present when invoked via `pnpm choibot`, but its resolved
    // path feeds PNPM_BIN in the unit templates — so we still want the value.
    { name: "pnpm", required: true, check: () => checkBin("pnpm", "corepack enable") },
    {
      name: "git repo",
      required: true,
      check: async () => {
        // In a git worktree `.git` is a FILE, not a directory — existsSync only.
        const path = join(repoDir, ".git");
        if (existsSync(path)) return { ok: true, detail: repoDir };
        // An install from an archive file (install.sh) has no .git. The unit template and the
        // CLI show that the folder is the console's.
        return existsSync(join(repoDir, "deploy", CONSOLE_UNIT_TEMPLATE)) && existsSync(join(repoDir, names().cliEntry))
          ? { ok: true, detail: `${repoDir} (from an archive, no git history)` }
          : { ok: false, detail: `no .git in ${repoDir}`, hint: `run from a clone of the ${DISPLAY_NAME} repo` };
      },
    },
    { name: "dtach", required: true, check: () => checkBin("dtach", "sudo apt-get install -y dtach") },
    { name: "claude", required: true, check: () => checkBin("claude", "install Claude Code: https://claude.com/claude-code") },
    // Optional: the console runs fine on Claude alone — only Codex agents need
    // this — so a missing codex warns rather than fails, exactly like `gh`.
    { name: "codex", required: false,
      check: () => checkBin("codex", "optional — needed only for Codex agents: npm i -g @openai/codex, then `codex login`") },
    {
      // Remote access runs over the tailnet: not required (a host without
      // Tailscale still serves loopback / SSH forwards), but worth surfacing.
      name: "tailscale",
      required: false,
      check: async () => {
        const path = await which("tailscale");
        if (!path) return { ok: false, detail: "not found", hint: "install Tailscale for remote access: https://tailscale.com/download" };
        const port = dotEnv().get("PORT") ?? "3100";
        const r = await run("tailscale", ["serve", "status"]);
        if (r.code !== 0) {
          return { ok: false, detail: "tailscaled not reachable", hint: "sudo systemctl enable --now tailscaled && sudo tailscale up" };
        }
        return r.stdout.includes(`127.0.0.1:${port}`)
          ? { ok: true, detail: r.stdout.trim().split("\n")[0] || "serving" }
          : { ok: false, detail: `no serve proxy for :${port}`, hint: `tailscale serve --bg --https=443 ${port} (needs \`sudo tailscale set --operator=$USER\` once)` };
      },
    },
    {
      name: "build tools",
      required: true,
      check: async () => {
        const tools = ["make", "g++", "python3"];
        const found = await Promise.all(tools.map((t) => which(t)));
        const missing = tools.filter((_, i) => !found[i]);
        return missing.length === 0
          ? { ok: true, detail: tools.join(", ") }
          : {
              ok: false,
              detail: `missing: ${missing.join(", ")}`,
              hint: "sudo apt-get install -y build-essential python3",
            };
      },
    },
    {
      name: ".env",
      required: true,
      check: async () => {
        const path = settingsFile(repoDir);
        const hint = `run \`pnpm ${CLI_NAME} setup\``;
        if (!opts.env && !existsSync(path)) return { ok: false, detail: `not found at ${path}`, hint };
        const values = dotEnv();
        const bad = ENV_SCHEMA.filter((k) => REQUIRED_ENV_KEYS.includes(k.key) && isMissing(k, values)).map((k) => k.key);
        return bad.length === 0
          ? { ok: true, detail: path }
          : { ok: false, detail: `unset or placeholder: ${bad.join(", ")}`, hint };
      },
    },
    {
      // Same predicate as the server (server/chief/paths.ts), fed from .env.
      name: "chief",
      required: true,
      check: async () => {
        const env = Object.fromEntries(dotEnv());
        if (!chiefFlag(env)) return { ok: true, detail: "off" };
        const bad = chiefMisconfigured(env);
        if (bad) return { ok: false, detail: bad, hint: "see CHIEF_* in .env.example" };
        const on = `on (${chiefUserAuth(env)} mode)`;
        if (hardenedDeployment(env)) return { ok: true, detail: [on, ...hardenedReport(env, repoDir, opts.procRoot)].join("\n") };
        // Set but not a valid uid: the server runs as not hardened; say why.
        const uid = env.CHIEF_AGENT_UID ?? "";
        return uid.trim() === ""
          ? { ok: true, detail: on }
          : { ok: true, detail: `${on}\nCHIEF_AGENT_UID "${uid}" is not a valid uid` };
      },
    },
    {
      name: "user token in .env",
      required: false,
      check: async () =>
        envKeys("USER_TOKEN").some((k) => dotEnv().has(k))
          ? { ok: false, detail: `${envKeys("USER_TOKEN").find((k) => dotEnv().has(k))} is set in .env`,
              hint: `remove it from .env; the user token lives in ~/.config/${names().configDir}/user-token` }
          : { ok: true, detail: "not set" },
    },
    {
      // Item 4 of the secrets work: a warning, never an error. The owner's box
      // keeps its checkout in the workspace on purpose (agents work on it).
      name: "workspace",
      required: false,
      check: async () => {
        const ws = dotEnv().get("WORKSPACE_DIR");
        if (!ws) return { ok: true, detail: "WORKSPACE_DIR not set (the .env check reports it)" };
        return checkoutInWorkspace(repoDir, ws)
          ? { ok: false, detail: `the console checkout ${repoDir} is inside WORKSPACE_DIR ${ws}: agents work next to its .env and data`,
              hint: "fine when your agents work on the console repo itself; else set WORKSPACE_DIR to a dir that does not hold the checkout" }
          : { ok: true, detail: ws };
      },
    },
    {
      // Names only, never a value (bin/lib/agent-env.mjs has the rule).
      name: "agent env",
      required: false,
      check: async () => {
        const values = dotEnv();
        const pass = agentEnvPass(Object.fromEntries(values));
        if (pass !== null) {
          return { ok: true, detail: `agents get only what they need to run${pass.length ? `, plus ${pass.join(", ")}` : ""}` };
        }
        const extra = [...values.keys()]
          .filter((k) => !AGENT_ENV_ALLOW.includes(k) && !NEVER_PASS.includes(k) && !/^LC_[A-Z]+$/.test(k)).sort();
        return {
          ok: false,
          detail: `AGENT_ENV_PASS is not set: agents get every key of the console env but its secrets${extra.length ? `, from .env: ${extra.join(", ")}` : ""}`,
          hint: "add AGENT_ENV_PASS=KEY1,KEY2 to .env with the keys your agents need (empty: none), then restart the console",
        };
      },
    },
    {
      name: "linger",
      required: true,
      check: async () => {
        const r = await run("sh", ["-c", "loginctl show-user $USER --property=Linger"]);
        const ok = r.stdout.includes("Linger=yes");
        return {
          ok,
          detail: ok ? "enabled" : "disabled (services stop when you log out)",
          hint: "loginctl enable-linger $USER (may need sudo)",
        };
      },
    },
    {
      name: "gh",
      required: false,
      check: async () => {
        const hint = "install gh + `gh auth login` for the GitHub tab";
        const path = await which("gh");
        if (!path) return { ok: false, detail: "not found", hint };
        const r = await run("gh", ["auth", "status"]);
        return r.code === 0 ? { ok: true, detail: `${path} (authenticated)` } : { ok: false, detail: "not authenticated", hint };
      },
    },
    {
      name: "code-server",
      required: false,
      check: () => checkBin("code-server", "optional; Editor surface is deprecated"),
    },
  ];
}

export async function runChecks(repoDir: string, opts: DoctorOpts = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of checks(repoDir, opts)) {
    if (opts.requiredOnly && !c.required) continue;
    const r = await c.check();
    out.push({ name: c.name, required: c.required, ok: r.ok, detail: r.detail, ...(r.ok ? {} : { hint: r.hint }) });
  }
  return out;
}

export function formatChecks(results: CheckResult[]): string {
  const width = Math.max(0, ...results.map((r) => r.name.length));
  return results
    .map((r) => {
      const symbol = r.ok ? "✔" : r.required ? "✖" : "⚠";
      // A multi-line detail (the chief report): later lines under the first.
      const detail = r.detail.split("\n").join(`\n${" ".repeat(width + 4)}`);
      const line = `${symbol} ${r.name.padEnd(width)}  ${detail}`;
      return r.ok || !r.hint ? line : `${line}  → ${r.hint}`;
    })
    .join("\n");
}

export function hasRequiredFailure(results: CheckResult[]): boolean {
  return results.some((r) => r.required && !r.ok);
}

// ------------------------------------------------------------ the step list
// `doctor` speaks the set-up steps of server/setup/steps.ts. The technical checks above stay:
// the first step ("Install …") is done only when every required one passes, and
// `doctor --details` prints them all.

// The required technical checks behind each fact of the box. A required check that is in
// neither list still keeps the install step open (BoxFacts.unknownFailures).
export const TOOL_CHECKS: Record<string, string> = {
  git: "git", pnpm: "pnpm", dtach: "dtach", claude: "Claude Code", "build tools": "the build tools",
};
export const FACT_CHECKS = ["platform", "systemd (user)", "node", "git repo", ".env", "chief", "linger"];

// The technical results as plain facts. `live`: does the service run, and does the console answer.
export function boxFactsOf(results: CheckResult[], live: Pick<BoxFacts, "service" | "answers">): BoxFacts {
  const failed = new Set(results.filter((r) => r.required && !r.ok).map((r) => r.name));
  return {
    linux: !failed.has("platform"),
    node: process.versions.node,
    userServices: !failed.has("systemd (user)"),
    missingTools: Object.keys(TOOL_CHECKS).filter((n) => failed.has(n)).map((n) => TOOL_CHECKS[n]),
    checkout: !failed.has("git repo"),
    settings: !failed.has(".env"),
    queue: !failed.has("chief"),
    staysOn: !failed.has("linger"),
    unknownFailures: [...failed].filter((n) => !Object.hasOwn(TOOL_CHECKS, n) && !FACT_CHECKS.includes(n)).length,
    ...live,
  };
}

// The console's unit, as the CLI sees it.
export async function serviceState(unit: string): Promise<BoxFacts["service"]> {
  if ((await run("systemctl", ["--user", "is-active", "--quiet", unit])).code === 0) return "running";
  return (await run("systemctl", ["--user", "cat", unit])).code === 0 ? "stopped" : "none";
}

const STATES: readonly string[] = ["done", "todo", "blocked"];
export const CONSOLE_DOWN = `Not checked: ${DISPLAY_NAME} does not run.`;
export const CONSOLE_OLD = `Not checked: the ${DISPLAY_NAME} that runs is an older version.`;
// A new install with no paired device answers nothing but its pairing screen (chief/firstrun.ts).
export const CONSOLE_LOCKED = "Not checked: pair your first device first.";
export const NO_DEVICE = "No device is paired yet.";

// The running console's own answer (GET /api/setup/steps, loopback). answers: it gave any HTTP
// answer. steps: null when it does not run or is older than the route.
// locked: it refused because no device is paired yet.
// With strong protection a loopback request proves nothing (server/chief/access.ts): the console's
// own account sends the token that only it can read (server/chief/consoletoken.ts). Another
// account, or a console with no strong protection, has none and sends nothing, as before.
async function askConsole(port: string, doFetch: typeof fetch, consoleToken?: string): Promise<{ answers: boolean; steps: StepStatus[] | null; locked: boolean }> {
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/api/setup/steps`, {
      signal: AbortSignal.timeout(30_000),
      ...(consoleToken ? { headers: { [CONSOLE_HEADER]: consoleToken } } : {}),
    });
    const body = res.ok || res.status === 403 ? ((await res.json().catch(() => null)) as { steps?: unknown; locked?: unknown } | null) : null;
    return { answers: true, steps: res.ok && Array.isArray(body?.steps) ? (body.steps as StepStatus[]) : null, locked: res.status === 403 && body?.locked === true };
  } catch {
    return { answers: false, steps: null, locked: false };
  }
}

// Every step with its state, for the CLI. The steps of the box are checked here, so they work
// with the console stopped. The steps only the running console knows come from its own check;
// when it does not answer they stay open, and the text says so.
export async function cliSteps(repoDir: string, results: CheckResult[], io: { fetch?: typeof fetch } = {}): Promise<StepStatus[]> {
  const env = { ...process.env, ...Object.fromEntries(readDotEnv(repoDir)) };
  const port = /^\d{1,5}$/.test(env.PORT ?? "") ? env.PORT! : "3100";
  const own = readConsoleToken(chiefPaths(resolveChiefDataDir(env)).consoleToken);
  const [con, service] = await Promise.all([askConsole(port, io.fetch ?? fetch, own), serviceState(deployUnit(env))]);
  const local = await runSteps(boxProbes({ env, box: async () => boxFactsOf(results, { service, answers: con.answers }) }));
  const remote = new Map((con.steps ?? []).map((s) => [s?.id, s]));
  return local.map((s): StepStatus => {
    // "Open … from your devices" is also done when a device is paired (the SSH tunnel). Only
    // the running console knows its devices: its "done" counts here too.
    const viaConsole = s.id === "access" && s.state !== "done" ? remote.get("access") : undefined;
    if (viaConsole?.state === "done" && typeof viaConsole.text === "string") {
      const { blockedBy: _b, error: _e, ...base } = s;
      return { ...base, state: "done", text: plain(viaConsole.text) };
    }
    if (stepOf(s.id).on === "box") return s;
    const { blockedBy: _b, error: _e, ...base } = s;
    const r = remote.get(s.id);
    if (con.locked) return { ...base, state: "todo", text: s.id === "pair" ? NO_DEVICE : CONSOLE_LOCKED };
    if (!r || !STATES.includes(r.state) || typeof r.text !== "string") {
      return { ...base, state: "todo", text: con.answers ? CONSOLE_OLD : CONSOLE_DOWN };
    }
    return {
      ...base, state: r.state, text: plain(r.text),
      ...(r.state === "blocked" && typeof r.blockedBy === "string" ? { blockedBy: r.blockedBy } : {}),
      ...(typeof r.error === "string" ? { error: plain(r.error) } : {}),
    };
  });
}

// ✔ done · ✖ open · – waits for an earlier step · ○ optional and open.
export function formatSteps(steps: StepStatus[]): string {
  const width = Math.max(0, ...steps.map((s) => s.title.length));
  const line = (s: StepStatus): string => {
    const symbol = s.state === "done" ? "✔" : s.optional ? "○" : s.state === "blocked" ? "–" : "✖";
    const under = (t: string): string => `\n${" ".repeat(width + 4)}${t}`;
    // The steps a command of this CLI completes, or starts.
    const fix = s.state !== "todo" ? ""
      : s.completes?.name === "setup" ? under(`To repair: ${cli("setup")}`)
      : s.completes?.name === "pair-device" ? under(`To pair a device: ${cli("pair")}`)
      : s.id === "claude" ? under(`To log in: open ${DISPLAY_NAME} in your browser, Set-up. Or here: ${cli("login")}`)
      : s.id === "access" ? under(`For the ways to open it: ${cli("access")}`) : "";
    return `${symbol} ${s.title.padEnd(width)}  ${s.text}${s.error ? under(`Last error: ${s.error}`) : ""}${fix}`;
  };
  const main = steps.filter((s) => !s.optional), extra = steps.filter((s) => s.optional);
  return [
    `Set-up of ${DISPLAY_NAME}: ${main.filter((s) => s.state === "done").length} of ${main.length} steps done`,
    "",
    ...main.map(line),
    ...(extra.length ? ["", "Optional, when you want", ...extra.map(line)] : []),
  ].join("\n");
}

// The protection of a console in strong mode, in plain words (the facts of the `chief` check,
// with the gate and the helper taken as on). Null when strong mode is not set up: then `doctor`
// prints what it printed before.
export function protectionLine(repoDir: string, env: Record<string, string> = Object.fromEntries(readDotEnv(repoDir)), procRoot?: string): string | null {
  if (!hardenedDeployment(env)) return null;
  return hardenedReport(env, repoDir, procRoot)[0] === "mode: strong (gate assumed)"
    ? "Protection: Strong. Your agents run under their own account on this server: they cannot read the keys of your devices, the settings or the data of the console."
    : `Protection: Strong is set up, but one of its checks fails. For the reason: ${cli("doctor --details")}`;
}

// `doctor`: the step list in plain words; `--details` adds the technical checks. The exit code
// is the technical one, as before: 1 when a required technical check fails.
export async function runDoctor(repoDir: string, opts: { details?: boolean; fetch?: typeof fetch } = {}): Promise<number> {
  const results = await runChecks(repoDir);
  const failed = hasRequiredFailure(results);
  console.log(formatSteps(await cliSteps(repoDir, results, opts)));
  const protection = protectionLine(repoDir);
  if (protection) console.log(`\n${protection}`);
  if (opts.details) console.log(`\nTechnical checks\n${formatChecks(results)}`);
  else console.log(`\n${failed ? "A technical check failed. " : ""}For the technical checks: ${cli("doctor --details")}`);
  return failed ? 1 : 0;
}
