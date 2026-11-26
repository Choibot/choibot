// bin/lib/steps.ts — the six steps behind `pnpm choibot setup` (`choibot doctor` is ./doctor.ts).
// Every step is idempotent and logs what it did or why it was skipped; a failure
// names the step, the fix, and that re-running skips completed steps.
//
// This module must stay free of TOP-LEVEL SIDE EFFECTS (no prompts, no exec, no
// process.exit): steps.test.ts imports it without mocking ./exec.js.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { run, which } from "./exec.js";
import { cronSync } from "./cron.js";
import { ENV_SCHEMA, generateSecret, isMissing, parseEnv, writeEnvFile, type EnvKey } from "./env.js";
import { CONSOLE_UNIT_TEMPLATE, UNIT_NAMES, buildPath, renderUnit, unitTemplate, type UnitVars } from "./units.js";
import { boxFactsOf, cliSteps, formatChecks, formatSteps, runChecks } from "./doctor.js";
import { firstDeviceLines } from "./pair.js";
import { checkoutInWorkspace, defaultWorkspaceDir } from "./layout.js";
import { CLI_NAME, DISPLAY_NAME } from "../../server/brand.js";
import { NO_CHECK_SWITCH } from "../../server/buildcheck.mjs";
import { cli, stepOf, type Probes } from "../../server/setup/steps.js";
import { installKind, versionInfo } from "../../server/release.js";
import { settingsFile } from "../../server/layout.js";

// ---------------------------------------------------------------- pure helpers

// Tool → apt package. `make`/`g++` both come from build-essential, hence the
// dedupe in aptPlan (which preserves first-seen order for a stable command).
const APT_PACKAGES: Record<string, string> = {
  dtach: "dtach",
  make: "build-essential",
  "g++": "build-essential",
  python3: "python3",
};

export function aptPlan(
  missing: string[],
  haveAptGet: boolean,
  haveSudoN: boolean,
): { auto: string[] | null; manual: string } {
  const pkgs: string[] = [];
  for (const tool of missing) {
    const pkg = APT_PACKAGES[tool] ?? tool;
    if (!pkgs.includes(pkg)) pkgs.push(pkg);
  }
  // Auto-install only when apt-get exists AND sudo needs no password: anything
  // else would hang on a hidden password prompt mid-setup.
  return { auto: haveAptGet && haveSudoN ? pkgs : null, manual: `sudo apt-get install -y ${pkgs.join(" ")}` };
}

// true = the port is free. Binds 127.0.0.1 only, which is exactly where the
// console listens.
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// -------------------------------------------------------------------- prompts

// Thrown when a prompt cannot be answered (no TTY, or stdin hit EOF). runSetup
// catches it and reports it through the normal step-failure contract.
export class PromptError extends Error {}

// `setup` is an interactive installer: it asks for a bot token, an owner id and
// "press enter when installed". Without a TTY there is nobody to answer, and
// readline's question() NEVER settles on EOF — piping /dev/null in would drain
// the event loop and exit 0 having installed nothing (a false success). So we
// refuse up front rather than hang or lie.
function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new PromptError(`needs an interactive terminal — stdin is not a TTY, so this prompt cannot be answered; run \`pnpm ${CLI_NAME} setup\` from a real terminal`);
  }
}

// Belt and braces for a TTY that goes away mid-prompt (Ctrl-D, closed SSH
// session): readline resolves nothing on EOF, it only emits "close".
function questionOrEof(rl: { question: (q: string) => Promise<string>; once: (ev: string, fn: () => void) => unknown }, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = <T>(fn: (v: T) => void) => (v: T) => { if (!settled) { settled = true; fn(v); } };
    rl.once("close", () => done(reject)(new PromptError("stdin closed before the prompt was answered")));
    rl.question(prompt).then(done(resolve), done(reject));
  });
}

// readline echoes input itself, so a hidden prompt cannot rely on setRawMode:
// the question is printed separately and the interface writes to a sink that
// swallows every write. Each prompt closes its interface — a live interface
// keeps stdin resumed and later prompts would compete for keystrokes.
export async function ask(question: string, def?: string): Promise<string> {
  requireTty();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await questionOrEof(rl, def ? `${question} (${def}): ` : `${question}: `)).trim();
    return answer || def || "";
  } finally {
    rl.close();
  }
}

export async function askHidden(question: string): Promise<string> {
  // No non-TTY fallback: the "input will be visible" path could only ever serve
  // piped input, which readline cannot terminate cleanly anyway (see requireTty).
  requireTty();
  process.stdout.write(`${question}: `);
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return (await questionOrEof(rl, "")).trim();
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

async function askYesNo(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N]`));
}

async function pause(message: string): Promise<void> {
  await ask(message);
}

// Re-prompt until the answer validates, bounded so a fat-fingering user is not
// looped forever. Empty return = gave up (the caller fails the step).
async function askUntil(prompt: () => Promise<string>, valid: (v: string) => boolean, complaint: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const answer = await prompt();
    if (valid(answer)) return answer;
    console.log(`  ${complaint}`);
  }
  return "";
}

// ------------------------------------------------------------------- plumbing

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function step(name: string, detail: string): void {
  console.log(`→ ${name}: ${detail}`);
}

function fail(name: string, fix: string): number {
  console.error(`\n✖ ${name} failed: ${fix}`);
  console.error(`re-run \`pnpm ${CLI_NAME} setup\` — completed steps are skipped`);
  return 1;
}

// The env of the `pnpm build` of an install (setup, update): Next's own type check and lint are
// off (server/buildcheck.mjs: they do not fit in the memory of a 2 GB server). Only the build's
// child gets the switch: no other step sees it.
function installBuildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [NO_CHECK_SWITCH]: "1" };
}

async function missingTools(tools: string[]): Promise<string[]> {
  const found = await Promise.all(tools.map((t) => which(t)));
  return tools.filter((_, i) => !found[i]);
}

// ------------------------------------------------------------- unit rendering

function unitDirPath(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitVars(repoDir: string, pnpmBin: string): UnitVars {
  return {
    REPO_DIR: repoDir,
    SETTINGS_FILE: settingsFile(repoDir),
    PNPM_BIN: pnpmBin,
    // ~/.local/bin matters: gh, claude and dtach live there on typical hosts.
    PATH: buildPath([dirname(process.execPath), dirname(pnpmBin), join(homedir(), ".local", "bin")]),
  };
}

// Render the console unit (its template in deploy/) into unitDir, writing ONLY the files whose content
// actually changed, and return the names written. The caller needs that list:
// systemd keeps running the old unit until something restarts it, so "changed"
// is the signal for a daemon-reload + try-restart. Throws on a missing template
// or a leftover placeholder (renderUnit).
function writeUnits(repoDir: string, unitDir: string, vars: UnitVars, names: readonly string[] = UNIT_NAMES): string[] {
  const changed: string[] = [];
  for (const name of names) {
    const rendered = renderUnit(unitTemplate(repoDir, CONSOLE_UNIT_TEMPLATE), vars);
    const dest = join(unitDir, name);
    if (existsSync(dest) && readFileSync(dest, "utf8") === rendered) continue;
    writeFileSync(dest, rendered);
    changed.push(name);
  }
  return changed;
}

async function pollHttp(url: string, budgetMs: number, accept: (status: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (accept(res.status)) return true;
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) return false;
    await sleep(2_000);
  }
}

// ---------------------------------------------------------------------- setup

// Fatal in step 1 only; every other doctor check is informational here because
// step 3 is what actually resolves the missing tools. Exported so a test can pin
// these names against the checks runChecks() actually produces — a renamed check
// would otherwise turn its gate into a silent no-op.
export const FATAL_CHECKS = ["platform", "systemd (user)", "node", "git repo"];

const DEFAULTS: Record<string, string> = {
  PORT: "3100",
  HOST: "127.0.0.1",
  CODE_SERVER_BIND: "127.0.0.1:8081",
};

async function choosePort(key: string, def: string): Promise<string> {
  if (await probePort(Number(def))) return def;
  let port = Number(def);
  for (;;) {
    console.log(`  port ${port} is already in use`);
    const answer = await ask(`another port for ${key}`, String(port + 1));
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      console.log("  not a valid port number");
      continue;
    }
    if (await probePort(n)) return String(n);
    port = n;
  }
}

// `setup --auto`: the set-up that asks nothing and needs no terminal. It picks every value
// itself; these three are the only ones a caller can give (each one has a default).
//   port       where the search for a free port starts (default 3100)
//   workspace  the folder the agents work in (default: outside the console's folder)
//   url        the address the console is opened at (default: this box, on its port)
// brief: no title, no step list and no pairing code at the end. The install script (install.sh)
// calls it so: it prints its own start and its own end.
export type AutoOpts = { port?: string; workspace?: string; url?: string; brief?: boolean };

// A free port at `start` or above. Null when the next 100 are all in use.
export async function freePort(start: number, isFree: (port: number) => Promise<boolean> = probePort): Promise<number | null> {
  for (let port = start; port < start + 100 && port <= 65535; port++) if (await isFree(port)) return port;
  return null;
}

// What `--auto` got for its three values, or the plain reason one is not valid.
export function checkAutoOpts(o: AutoOpts): string | null {
  if (o.port !== undefined && !(/^\d{1,5}$/.test(o.port) && Number(o.port) >= 1024 && Number(o.port) <= 65535)) {
    return "The port must be a number from 1024 to 65535.";
  }
  if (o.workspace !== undefined && !isAbsolute(o.workspace)) return "The workspace must be a full path of a folder.";
  if (o.url !== undefined && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o.url)) {
    return "The address must look like https://name.example, with no path.";
  }
  return null;
}

// The failure line of `--auto`: plain words, the fix, and how to go on.
function failAuto(text: string): number {
  console.error(`\n✖ ${text}`);
  console.error(`Then run this again: ${cli("setup --auto")}. It goes on where it stopped.`);
  return 1;
}

const tail = (text: string, lines = 30): string => text.trimEnd().split("\n").slice(-lines).join("\n");

export async function runSetup(opts: { repoDir: string; auto?: AutoOpts }): Promise<number> {
  // `at` names the step a prompt failure belongs to, so an unanswerable prompt
  // still reports through the normal step-failure contract instead of a stack.
  const at = { step: "environment" };
  try {
    return await setupSteps(opts, at);
  } catch (e) {
    if (e instanceof PromptError) return fail(at.step, e.message);
    throw e;
  }
}

async function setupSteps({ repoDir, auto }: { repoDir: string; auto?: AutoOpts }, at: { step: string }): Promise<number> {
  // Two voices. The interactive set-up speaks to the person who installs by hand: technical
  // lines (`tech`), as before. `--auto` speaks plain words (`say`): no settings key, no path.
  const tech = (name: string, detail: string): void => { if (!auto) step(name, detail); };
  // `brief`: the lines sit under a title of the install script, so they are indented like its own.
  const pad = auto?.brief ? "  " : "";
  const say = (text: string): void => { if (auto) console.log(`${pad}✔ ${text}`); };
  const note = (text: string): void => { if (auto) console.log(`${pad}○ ${text}`); };
  const stop = (name: string, fix: string, plainFix: string): number => (auto ? failAuto(plainFix) : fail(name, fix));

  if (auto) {
    const bad = checkAutoOpts(auto);
    if (bad) return failAuto(bad);
    if (!auto.brief) console.log(`Set-up of ${DISPLAY_NAME} on this server\n`);
  } else {
    console.log(`${CLI_NAME} setup — installing ${DISPLAY_NAME} on this host\n`);
  }

  // 1. environment gate ------------------------------------------------------
  const results = await runChecks(repoDir);
  if (!auto) {
    console.log(formatChecks(results));
    console.log("");
  }
  const fatal = results.filter((r) => FATAL_CHECKS.includes(r.name) && !r.ok);
  if (fatal.length > 0) {
    if (auto) {
      // The plain sentence of the step list for the same failure (the install step's check).
      const facts = boxFactsOf(fatal, { service: "running", answers: true });
      const why = await stepOf("install").check({ box: async () => facts } as Probes);
      return failAuto(why.done === true ? "This server cannot run the console." : why.reason);
    }
    return fail(
      "environment",
      fatal.map((r) => `${r.name} (${r.detail})${r.hint ? ` → ${r.hint}` : ""}`).join("; "),
    );
  }
  tech("environment", "linux, systemd user bus, node ≥ 22, git repo — the rest is resolved below");
  say(`This server can run ${DISPLAY_NAME}`);

  // 2. .env ------------------------------------------------------------------
  at.step = ".env";
  const envPath = settingsFile(repoDir);
  // An empty file holds no setting: it is a new one. The release layout's install makes its
  // settings file empty before the set-up (install.sh release_layout), so that this set-up writes
  // there; it must get the settings of a new install (the Queue on), not those of an old one.
  const existed = existsSync(envPath) && statSync(envPath).size > 0;
  const values = existed ? parseEnv(readFileSync(envPath, "utf8")) : new Map<string, string>();
  const schema = new Map(ENV_SCHEMA.map((k) => [k.key, k]));
  const needs = (key: string): boolean => {
    const k = schema.get(key);
    return k ? isMissing(k, values) : !values.get(key);
  };
  const added: string[] = [];
  const set = (key: string, value: string): void => {
    values.set(key, value);
    added.push(key);
  };

  if (needs("CONSOLE_COOKIE_SECRET")) set("CONSOLE_COOKIE_SECRET", generateSecret());
  // A new install: agents get only what they need to run (bin/lib/agent-env.mjs).
  // A .env from before keeps its mode: setup never adds this key to it.
  if (!existed) set("AGENT_ENV_PASS", "");

  if (needs("WORKSPACE_DIR")) {
    // Default out of the checkout's way, so agents do not work next to its .env.
    const def = defaultWorkspaceDir(homedir(), repoDir);
    const dir = auto ? auto.workspace ?? def : await ask("workspace directory (where agents and the editor operate)", def);
    mkdirSync(dir, { recursive: true });
    if (!auto && checkoutInWorkspace(repoDir, dir)) {
      console.log(`  note: the console checkout is inside ${dir}, so agents work next to its .env and data (fine if they work on the console itself)`);
    }
    set("WORKSPACE_DIR", dir);
  }

  // A written-but-busy port would crash-loop the unit with EADDRINUSE, so probe
  // before writing the default.
  if (needs("PORT")) {
    if (auto) {
      // Code picks the port: no question, and no service that cannot start on a taken one.
      const first = Number(auto.port ?? DEFAULTS.PORT);
      const port = await freePort(first);
      if (port === null) return failAuto(`No port from ${first} to ${first + 99} is free on this server. Give another one: ${cli("setup --auto --port 4100")}`);
      if (port !== first) say(`Port ${first} is in use by another program. ${DISPLAY_NAME} uses ${port}.`);
      set("PORT", String(port));
    } else {
      set("PORT", await choosePort("PORT", DEFAULTS.PORT));
    }
  }
  for (const key of ["HOST", "CODE_SERVER_BIND"]) if (needs(key)) set(key, DEFAULTS[key]);

  // A new install made by `--auto`: the Queue and the leads are on, and devices pair from the
  // box (no Telegram needed). A settings file from before keeps what it has: these keys are
  // never added to it.
  if (auto && !existed) {
    set("CHIEF_ENABLED", "1");
    set("CHIEF_USER_AUTH", "log");
    set("CHIEF_CONSOLE_URL", auto.url ?? `http://127.0.0.1:${values.get("PORT")}`);
  }

  // Telegram is a later step of the list (the Settings form), never a question of `--auto`.
  if (!auto) await optionalGroup(
    "telegram",
    "Telegram notifications when an agent finishes?",
    "  Message @BotFather in Telegram → /newbot → copy the token it gives you.",
    needs,
    set,
    [
      ["TELEGRAM_BOT_TOKEN", "notification bot token", undefined, true],
      ["TELEGRAM_CHAT_ID", "chat id", undefined],
    ],
  );

  // Only rewrite when something actually changed: serializeEnv drops comments
  // and re-orders keys, so a no-op write would quietly mangle a hand-edited
  // .env while claiming it was kept as is. Step 3 appends the resolved binary
  // paths under the same rule, so a complete .env survives a re-run byte-identical.
  const addedInEnvStep = added.length;
  if (added.length > 0) {
    writeEnvFile(envPath, values);
    tech(".env", `${existed ? "updated" : "created"} ${envPath} (0600): ${added.join(", ")}`);
  } else {
    tech(".env", `${envPath} already complete — kept as is`);
  }

  // 3. prereqs ---------------------------------------------------------------
  at.step = "prereqs";
  const TOOLS = ["dtach", "make", "g++", "python3"];
  let missing = await missingTools(TOOLS);
  if (missing.length === 0) {
    tech("prereqs", `dtach and build tools present (${TOOLS.join(", ")})`);
  } else {
    const plan = aptPlan(missing, !!(await which("apt-get")), (await run("sudo", ["-n", "true"])).code === 0);
    const stillMissing = (): string => `The tools ${missing.join(", ")} are not on the server. Install them with: ${plan.manual}`;
    if (plan.auto) {
      console.log(`  installing with apt-get: ${plan.auto.join(" ")}`);
      await run("sudo", ["apt-get", "install", "-y", ...plan.auto], { stdio: "inherit" });
    } else if (auto) {
      // Nobody is there to type a sudo password: say the one command, then stop.
      return failAuto(stillMissing());
    } else {
      console.log(`  missing: ${missing.join(", ")} — install them with:\n    ${plan.manual}`);
      await pause("  press enter when installed");
    }
    missing = await missingTools(TOOLS);
    if (missing.length > 0 && !auto) {
      console.log(`  still missing: ${missing.join(", ")} — install them with:\n    ${plan.manual}`);
      await pause("  press enter when installed");
      missing = await missingTools(TOOLS);
    }
    if (missing.length > 0) return stop("prereqs", `${missing.join(", ")} still missing — run: ${plan.manual}`, stillMissing());
    tech("prereqs", `resolved ${TOOLS.join(", ")}`);
  }
  say("The tools are on the server");

  // Claude and GitHub are later steps of the list: `--auto` goes on without them, and the
  // list at the end says what is open.
  let claudeBin = await which("claude");
  if (!claudeBin && !auto) {
    console.log("  claude CLI not found — install Claude Code: https://claude.com/claude-code");
    await pause("  press enter when installed");
    claudeBin = await which("claude");
    if (!claudeBin) return fail("prereqs", "the claude CLI is still not on PATH — install Claude Code: https://claude.com/claude-code");
  }
  if (claudeBin) tech("prereqs", `claude at ${claudeBin}`);
  else note("The Claude program is not on the server yet. Agents cannot start without it.");

  let gh = await which("gh");
  if (!gh && !auto) {
    console.log("  gh not found — the GitHub tab needs it: https://cli.github.com then `gh auth login`");
    await pause("  press enter when installed (or to skip — gh is optional)");
    gh = await which("gh");
  }
  tech("prereqs", gh ? `gh at ${gh} (run \`gh auth login\` if the GitHub tab is empty)` : "gh missing — continuing; the GitHub tab stays degraded");

  // The code's built-in fallbacks point at another user's home, so pin the
  // resolved paths now that the tools exist — but only where the key is still
  // missing/placeholder. Overwriting a value the user chose (a wrapper script, a
  // pinned build) would both undo their edit and force a rewrite of the file.
  const dtachBin = await which("dtach");
  if (dtachBin && needs("AGENT_DTACH_BIN")) set("AGENT_DTACH_BIN", dtachBin);
  if (claudeBin && needs("CLAUDE_CODE_EXECUTABLE")) set("CLAUDE_CODE_EXECUTABLE", claudeBin);
  // Codex is optional: resolve it when present, and leave the key unset
  // otherwise so a Claude-only box gets no misleading path.
  if (needs("CODEX_EXECUTABLE")) {
    const codexBin = await which("codex");
    if (codexBin) set("CODEX_EXECUTABLE", codexBin);
  }
  const resolved = added.slice(addedInEnvStep);
  if (resolved.length > 0) {
    writeEnvFile(envPath, values);
    tech(".env", `resolved binaries written: ${resolved.map((k) => `${k}=${values.get(k)}`).join(", ")}`);
  } else {
    tech(".env", `resolved binary paths already set — ${envPath} left untouched`);
  }
  // One plain line for both writes of the settings (the values, then the paths of the tools).
  if (!existed) say("Settings written");
  else if (added.length > 0) say("Settings completed. No value that was there is changed.");
  else say("Settings are complete. Nothing is changed.");

  // 4. build -----------------------------------------------------------------
  at.step = "build";
  // `--auto` on a console that runs and is built: no new build under it (a build under a
  // running console breaks it; `update` is the command for new code).
  const consoleRuns = auto !== undefined && existsSync(join(repoDir, ".next", "BUILD_ID"))
    && (await run("systemctl", ["--user", "is-active", "--quiet", UNIT_NAMES[0]])).code === 0;
  // A release (install.sh CHOIBOT_RELEASE) holds its packages and its build: never a new one
  // (that would need the network and the build tools that a release server does not have).
  const own = versionInfo(repoDir);
  const releaseBuilt = own.kind === "release" && own.version !== null && own.problem === undefined;
  if (consoleRuns) {
    say(`${DISPLAY_NAME} is built and runs. No new build.`);
  } else if (releaseBuilt) {
    say(`${DISPLAY_NAME} ${own.version} is a release: it is built. No build.`);
  } else if (auto) {
    // The build output is long and technical: shown only when the build fails.
    console.log(`${pad}  Building. This takes a few minutes.`);
    for (const args of [["install"], ["build"]]) {
      const r = await run("pnpm", args, args[0] === "build" ? { env: installBuildEnv() } : {});
      if (r.code !== 0) {
        console.error(tail(`${r.stdout}\n${r.stderr}`));
        return failAuto(r.code === -1 ? "The tool pnpm is not on the server. Install it with: corepack enable" : "The build failed. The lines above say why.");
      }
    }
    say(`${DISPLAY_NAME} is built`);
  } else {
    console.log("→ build: pnpm install");
    const install = await run("pnpm", ["install"], { stdio: "inherit" });
    if (install.code !== 0) return fail("build", "`pnpm install` failed — see the output above (build tools missing usually breaks node-pty)");
    console.log("→ build: pnpm build");
    const build = await run("pnpm", ["build"], { stdio: "inherit", env: installBuildEnv() });
    if (build.code !== 0) return fail("build", "`pnpm build` failed — see the output above");
    step("build", "dependencies installed and Next.js build produced");
  }

  // 5. services --------------------------------------------------------------
  at.step = "services";
  const unitDir = unitDirPath();
  mkdirSync(unitDir, { recursive: true });
  const pnpmBin = await which("pnpm");
  if (!pnpmBin) return stop("services", "pnpm is not on PATH — `corepack enable`, then re-run", "The tool pnpm is not on the server. Install it with: corepack enable");
  const vars = unitVars(repoDir, pnpmBin);
  // Which units are already up decides what has to be RESTARTED below: an
  // already-running unit keeps its old unit file and its old .env until then.
  const wasActive: string[] = [];
  for (const name of UNIT_NAMES) {
    if ((await run("systemctl", ["--user", "is-active", "--quiet", name])).code === 0) wasActive.push(name);
  }
  let changedUnits: string[];
  try {
    changedUnits = writeUnits(repoDir, unitDir, vars);
  } catch (e) {
    return stop("services", `rendering unit files failed: ${(e as Error).message}`, `The service file could not be written: ${(e as Error).message}`);
  }
  tech(
    "services",
    changedUnits.length > 0
      ? `wrote ${changedUnits.join(", ")} → ${unitDir}`
      : `${UNIT_NAMES.join(", ")} already current in ${unitDir}`,
  );

  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  const systemdSaid = (r: { code: number; stderr: string }): string => r.stderr.trim() || `exit ${r.code}`;
  if (reload.code !== 0) {
    return stop("services", `\`systemctl --user daemon-reload\` failed: ${systemdSaid(reload)}`, `The service manager of this user did not take the service. It said: ${systemdSaid(reload)}`);
  }

  const linger = await run("sh", ["-c", "loginctl enable-linger $USER"]);
  let staysOn = linger.code === 0;
  if (staysOn) {
    tech("services", "linger enabled — services survive logout and reboot");
  } else if (auto) {
    // No question: the service still starts, and the list at the end keeps the step open.
    staysOn = (await run("sh", ["-c", "loginctl show-user $USER --property=Linger"])).stdout.includes("Linger=yes");
  } else {
    console.log("  could not enable linger (polkit refused). In another shell run:\n    sudo loginctl enable-linger $USER");
    await pause("  press enter when done (or to skip)");
    const show = await run("sh", ["-c", "loginctl show-user $USER --property=Linger"]);
    if (show.stdout.includes("Linger=yes")) step("services", "linger enabled");
    else console.log("  warning: linger is still disabled — the services stop when you log out and do not come back after a reboot");
  }

  for (const name of UNIT_NAMES) {
    const r = await run("systemctl", ["--user", "enable", "--now", name]);
    if (r.code !== 0) {
      return stop("services", `\`systemctl --user enable --now ${name}\` failed: ${systemdSaid(r)}`, `The service did not start. The service manager said: ${systemdSaid(r)}`);
    }
  }
  tech("services", `enabled and started ${UNIT_NAMES.join(", ")}`);
  const started = wasActive.length === UNIT_NAMES.length ? "The service runs." : "Service started.";
  if (staysOn) say(`${started} It stays on after you log out.`);
  else note(`${started} It stops when you log out. To keep it on, run: sudo loginctl enable-linger $USER`);

  // `enable --now` is a no-op START on a unit that is already active: on a
  // re-run the corrected .env and the re-rendered units would silently not take
  // effect. Restart exactly the already-running units the change touches — the
  // unit reads the settings file (SETTINGS_FILE), so an edit of it counts too.
  const reasons: string[] = [];
  if (changedUnits.length > 0) reasons.push(`unit file changed (${changedUnits.join(", ")})`);
  if (added.length > 0) reasons.push(`.env updated (${added.join(", ")})`);
  const toRestart = reasons.length === 0
    ? []
    : wasActive.filter((n) => added.length > 0 || changedUnits.includes(n));
  for (const name of toRestart) {
    // try-restart, not restart: it touches running units only, so a unit that
    // died between the check above and here is left for `enable --now` to own.
    const r = await run("systemctl", ["--user", "try-restart", name]);
    if (r.code !== 0) {
      return stop("services", `\`systemctl --user try-restart ${name}\` failed: ${systemdSaid(r)}`, `The service did not restart. The service manager said: ${systemdSaid(r)}`);
    }
  }
  if (toRestart.length > 0) {
    tech("services", `restarted already-running ${toRestart.join(", ")} — ${reasons.join("; ")}`);
    say("Service restarted with the new settings");
  }

  // 6. verify ----------------------------------------------------------------
  at.step = "verify";
  const port = values.get("PORT") ?? DEFAULTS.PORT;
  if (!auto) console.log("→ verify: waiting for the console…");
  // Loopback is auto-trusted by the console, so 200 is the healthy answer here.
  if (!(await pollHttp(`http://127.0.0.1:${port}/`, 60_000, (s) => s === 200))) {
    return stop("verify", `the console never answered 200 on 127.0.0.1:${port} — check \`pnpm ${CLI_NAME} logs console\``,
      `${DISPLAY_NAME} did not answer on this server after 60 seconds. For its log: ${cli("logs")}`);
  }
  tech("verify", `console answers on 127.0.0.1:${port}`);
  say(`${DISPLAY_NAME} answers on this server`);

  // `--auto` ends with the step list and its state: the same list `doctor` prints. How the
  // console is opened from other devices is a step of that list, not a job of the installer.
  if (auto) {
    if (auto.brief) return 0;
    console.log(`\n${formatSteps(await cliSteps(repoDir, await runChecks(repoDir)))}`);
    // A new install has no paired device: the code for the first one (bin/lib/pair.ts).
    const pair = await firstDeviceLines({ repoDir });
    if (pair) console.log(`\n${pair}`);
    return 0;
  }

  // Remote access runs over the tailnet; setup cannot configure it itself
  // (`tailscale serve` needs operator privileges granted via sudo once), so
  // report the state and print the commands instead of failing.
  const serve = await run("tailscale", ["serve", "status"]);
  if (serve.code === 0 && serve.stdout.includes(`127.0.0.1:${port}`)) {
    const url = serve.stdout.trim().split("\n")[0] ?? "";
    step("verify", `tailscale serve proxies ${url.trim()} → 127.0.0.1:${port}`);
    console.log(`\n✔ setup complete — ${url.replace(/\(.*\)/, "").trim()}`);
  } else {
    console.log("  remote access is not configured yet. On this host run once:");
    console.log("    sudo tailscale set --operator=$USER");
    console.log(`    tailscale serve --bg --https=443 ${port}`);
    console.log(`\n✔ setup complete — console on http://127.0.0.1:${port} (loopback only until tailscale serve is set up)`);
  }
  return 0;
}

// Optional key groups are y/N and skipped by default; a group whose keys are
// already filled in never prompts again (idempotent re-runs).
async function optionalGroup(
  group: EnvKey["group"],
  question: string,
  note: string,
  needs: (key: string) => boolean,
  set: (key: string, value: string) => void,
  // `hidden` = a secret: prompt with no echo (askHidden takes no default, so a
  // hidden key must not carry one either).
  prompts: [key: string, label: string, def: string | undefined, hidden?: boolean][],
): Promise<void> {
  // "Already configured" is judged on the keys this group actually PROMPTS for —
  // schema-only tuning flags (e.g. TELEGRAM_NOTIFY_AGENTS) must not make setup
  // re-interrogate an install that already answered the group.
  if (prompts.every(([k]) => !needs(k))) return; // already configured
  console.log("");
  if (!(await askYesNo(question))) return;
  console.log(note);
  for (const [key, label, def, hidden] of prompts) {
    if (!needs(key)) continue;
    const answer = hidden
      ? await askHidden(`  ${key} — ${label} (input hidden)`)
      : await ask(`  ${key} — ${label}`, def);
    if (answer) set(key, answer);
  }
}

// ----------------------------------------------------------------------- port

// `port <n>`: another port for a console whose port is taken by another program. `setup` never
// changes a value that is in the settings, so this is the one command that does (the install
// agent uses it). The address of the server itself that a set-up with no question wrote follows
// the port; an address that a person set is kept. The console reads the port at its next start.
export async function runPort(repoDir: string, value: string | undefined, isFree: (port: number) => Promise<boolean> = probePort): Promise<number> {
  const envPath = settingsFile(repoDir);
  const n = Number(value);
  if (!/^\d{4,5}$/.test(value ?? "") || n < 1024 || n > 65535) { console.error("✖ Give a port from 1024 to 65535."); return 1; }
  if (!existsSync(envPath)) { console.error(`✖ ${DISPLAY_NAME} has no settings yet. First: ${cli("setup --auto")}`); return 1; }
  const values = parseEnv(readFileSync(envPath, "utf8"));
  const old = values.get("PORT") ?? DEFAULTS.PORT;
  if (old === String(n)) { console.log(`✔ The port of ${DISPLAY_NAME} is ${n}. Nothing is changed.`); return 0; }
  if (!(await isFree(n))) { console.error(`✖ Port ${n} is in use by another program. Give another one.`); return 1; }
  values.set("PORT", String(n));
  if (values.get("CHIEF_CONSOLE_URL") === `http://127.0.0.1:${old}`) values.set("CHIEF_CONSOLE_URL", `http://127.0.0.1:${n}`);
  writeEnvFile(envPath, values);
  console.log(`✔ The port of ${DISPLAY_NAME} is ${n} now (it was ${old}). It is used at the next start: ${cli("restart")}`);
  return 0;
}

// ------------------------------------------------------------------------ ops

export type OpsCommand = "status" | "logs" | "restart" | "stop";

// "console" → the console unit ("choibot", or "choibot" on an install with the old
// names). systemctl/journalctl accept the suffix-less name; derived from UNIT_NAMES so a
// renamed unit cannot drift out of sync here.
const OPS_UNITS = UNIT_NAMES.map((n) => n.replace(/\.service$/, ""));
const TARGETS = ["console"];

function unitFor(target: string): string {
  if (!TARGETS.includes(target)) throw new Error(`unknown target: ${target} (expected ${TARGETS.join(", ")})`);
  return OPS_UNITS[0];
}

// The argv list a command expands into, run in order. Pure: it validates the
// target and throws BEFORE anything is executed, so a typo never half-applies.
export function opsArgv(cmd: OpsCommand, target?: string): string[][] {
  switch (cmd) {
    case "status":
      if (target !== undefined) throw new Error(`unknown target: ${target} (\`${CLI_NAME} status\` covers the console service)`);
      return [["systemctl", "--user", "status", "--no-pager", "-n", "0", ...OPS_UNITS]];
    case "stop":
      if (target !== undefined) throw new Error(`unknown target: ${target} (\`${CLI_NAME} stop\` stops the console service)`);
      return [["systemctl", "--user", "stop", ...OPS_UNITS]];
    case "logs":
      return [["journalctl", "--user", "-u", unitFor(target ?? "console"), "-f", "-n", "100"]];
    case "restart":
      return [["systemctl", "--user", "restart", ...(target === undefined ? OPS_UNITS : [unitFor(target)])]];
  }
}

// stdio is inherited throughout: these commands are the user watching systemd
// (and `logs` blocks until Ctrl-C). Stops at the first failure and returns its
// code; run() resolves -1 for a spawn error, which is normalised to 1 so the
// exit status stays a sane small number.
async function runArgvs(argvs: string[][], env?: NodeJS.ProcessEnv): Promise<number> {
  for (const [cmd, ...args] of argvs) {
    const r = await run(cmd, args, { stdio: "inherit", ...(env ? { env } : {}) });
    if (r.code !== 0) {
      if (r.stderr.trim()) console.error(r.stderr.trim()); // only ever set when spawn itself failed
      return r.code < 0 ? 1 : r.code;
    }
  }
  return 0;
}

export async function runOps(cmd: OpsCommand, target?: string): Promise<number> {
  return runArgvs(opsArgv(cmd, target));
}

// A pull can change deploy/*.service, but systemd keeps running the copy in
// ~/.config/systemd/user — so re-render it here. Refresh-only: a host that was
// never `setup` (no installed units) or whose vars cannot be resolved is left
// alone rather than half-installed.
async function refreshUnits(repoDir: string): Promise<void> {
  const unitDir = unitDirPath();
  // Only ever refresh units this host already has: `update` must never turn a
  // clone that was never `setup` into a half-installed one.
  const installed = UNIT_NAMES.filter((n) => existsSync(join(unitDir, n)));
  if (installed.length === 0) return;
  const pnpmBin = await which("pnpm");
  if (!pnpmBin) return; // cannot resolve the unit vars — leave them be
  let changed: string[];
  try {
    changed = writeUnits(repoDir, unitDir, unitVars(repoDir, pnpmBin), installed);
  } catch {
    return; // missing template or bad placeholder — the installed units still work
  }
  if (changed.length === 0) return;
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    console.log(`  warning: unit files refreshed but \`systemctl --user daemon-reload\` failed (${reload.stderr.trim() || `exit ${reload.code}`})`);
    return;
  }
  console.log(`→ update: refreshed unit files (${changed.join(", ")}) and reloaded systemd`);
}

// git pull → install → build → refresh units → restart the console.
export async function runUpdate(repoDir: string): Promise<number> {
  // A release gets new code as a release (the Update ticket of a hosted console), never by git.
  if (installKind(repoDir) === "release") {
    console.error(`✖ This ${DISPLAY_NAME} runs a release. \`update\` gets new code from git only; a new release comes from its release file.`);
    return 1;
  }
  // An install from an archive file (install.sh) has no git history: there is nothing to pull.
  if (!existsSync(join(repoDir, ".git"))) {
    console.error(`✖ This install of ${DISPLAY_NAME} came from an archive file, not from git. \`update\` cannot get new code for it.`);
    return 1;
  }
  // No cwd option on run(): `pnpm choibot` is launched from the repo root, so the
  // git and pnpm calls below already act on the repo.
  const build: string[][] = [["git", "pull", "--ff-only"], ["pnpm", "install"], ["pnpm", "build"]];
  const runStep = async (argv: string[]): Promise<number> => {
    console.log(`→ update: ${argv.join(" ")}`);
    const code = await runArgvs([argv], argv[0] === "pnpm" && argv[1] === "build" ? installBuildEnv() : undefined);
    if (code !== 0) console.error(`\n✖ update aborted: \`${argv.join(" ")}\` exited ${code} — fix the failure above and re-run \`pnpm ${CLI_NAME} update\``);
    return code;
  };
  for (const argv of build) {
    const code = await runStep(argv);
    if (code !== 0) return code;
  }
  // After the build, before the restart: a re-rendered unit only takes effect on
  // the restart that follows it.
  await refreshUnits(repoDir);
  // Cron job units render from deploy/cron-job.* too; a cron failure must not
  // abort the update itself.
  try { await cronSync(repoDir); } catch (e) { console.log(`  warning: cron sync failed: ${e instanceof Error ? e.message : e}`); }
  for (const argv of opsArgv("restart")) {
    const code = await runStep(argv);
    if (code !== 0) return code;
  }
  console.log("\n✔ update complete — console restarted");
  return 0;
}
