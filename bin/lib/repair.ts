// bin/lib/repair.ts — `repair`: the install agent. When a step of the install fails and Claude
// is logged in, a Claude Code session in the terminal reads the failed step and its output,
// explains it in plain words, repairs it, and runs the check again.
//
// Its rules are the ones of the design ("What the two agents may do"), and the SETTINGS of the
// session hold them, not only its prompt:
//   - a PreToolUse hook (bin/install-agent/hook.mjs → policy.mjs) decides for each tool call:
//     allow (no question), ask (the person sees the exact command), or deny (never);
//   - permission rules deny the same "never" things a second time, in case the hook cannot run:
//     then every command asks first, which is the default mode of Claude Code;
//   - `--restricted` loads no settings but these, keeps the file tools in the working folder and
//     refuses the mode that skips permissions; `--tools` leaves no web tool and no sub-agent.
// The session cannot mark a step done: it has no way to make a pairing code, to write the
// console's data or to change the code of a check. Only the check of a step says "done".
//
// With no login, a too old Claude Code or no terminal, there is no agent: the step has printed
// its own fix, and `setup --auto` goes on where it stopped.
//
// The formats are the ones of the Claude Code docs: settings and permission rules
// (https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/permissions),
// hooks (https://code.claude.com/docs/en/hooks), the flags (https://code.claude.com/docs/en/cli-reference).
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { CLI_NAME, CLI_SHORT_NAME, DISPLAY_NAME } from "../../server/brand.js";
import { resolveAppDataDir, resolveClaudeBin, type Env } from "../../server/defaults.js";
import { findSecret } from "../../server/guide/secret.js";
import { names } from "../../server/names.mjs";
import { boxProbes } from "../../server/setup/probes.js";
import { cli, stepOf, type Outcome, type Probes } from "../../server/setup/steps.js";
import { formatChecks, runChecks } from "./doctor.js";
import { run } from "./exec.js";
import { runLogin } from "./login.js";
import { installEnv } from "./pair.js";
import { PromptError, ask } from "./steps.js";

// The tools of the session. No web tool, no sub-agent, no tool of a plug-in.
export const AGENT_TOOLS = "Bash,Read,Edit,Write,Grep,Glob";
// The file the install script writes when a step fails: its title, then its output.
export const FAILED_STEP_FILE = "failed-step.log";
const OUTPUT_LINES = 80;

// What policy.mjs needs to know about this install (its Ctx).
export type AgentCtx = {
  base: string; app: string; home: string; user: string; unit: string; cronPrefix: string;
  dataDir: string; cli: string; cliNames: string[];
};

// The install that the install script made: the code is in <base>/app, next to its own Node and
// its command. Null: another kind of install (a clone by hand, the owner's console).
export function agentCtx(repoDir: string, env: Env = process.env): AgentCtx | null {
  const base = dirname(repoDir);
  if (!existsSync(join(base, `.installed-by-${CLI_NAME}`)) || !existsSync(join(base, "bin", CLI_NAME))) return null;
  const n = names();
  return {
    base, app: repoDir, home: env.HOME || homedir(), user: userInfo().username, unit: n.unit, cronPrefix: n.cronUnitPrefix,
    dataDir: resolveAppDataDir(env), cli: join(base, "bin", CLI_NAME), cliNames: [CLI_NAME, CLI_SHORT_NAME],
  };
}

const sh = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
// A rule path from the root of the file system (two slashes) or from the home.
const abs = (p: string): string => `/${p}`;

// The settings of the session. Deny wins over ask, and ask over allow. There is no allow rule:
// the hook is the only thing that lets a call run with no question.
export function agentSettings(c: AgentCtx, node: string = process.execPath): Record<string, unknown> {
  const secrets = [
    "~/.ssh/**", "~/.gnupg/**", "~/.aws/**", "~/.kube/**", "~/.config/gh/**", "~/.config/gcloud/**", "~/.docker/config.json",
    "~/.netrc", "~/.npmrc", "~/.git-credentials", "~/.claude/**", "~/.claude.json", "~/.claude-accounts/**", "~/.codex/**",
    "**/.env", "**/.env.*", "**/*.pem", "**/*.key", `${abs(c.dataDir)}/**`,
  ];
  const code = ["server", "bin", "src", "deploy", "scripts"].map((d) => `${abs(c.app)}/${d}/**`).concat(`${abs(c.app)}/package.json`);
  const hook = `${sh(node)} ${sh(join(c.app, "bin", "install-agent", "hook.mjs"))} ${Buffer.from(JSON.stringify(c)).toString("base64url")}`;
  return {
    permissions: {
      defaultMode: "default",
      disableBypassPermissionsMode: "disable",
      deny: [
        "WebFetch", "WebSearch", "Agent",
        ...secrets.map((p) => `Read(${p})`),
        ...code.map((p) => `Edit(${p})`),
        "Bash(tailscale funnel *)", "Bash(sudo tailscale funnel *)", "Bash(ufw allow *)", "Bash(sudo ufw allow *)",
        ...[c.cli, ...c.cliNames].map((n) => `Bash(${n} pair*)`),
      ],
      ask: ["Bash(sudo *)"],
    },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: 10 }] }] },
    autoMemoryEnabled: false,
  };
}

export function agentPrompt(c: AgentCtx): string {
  return [
    `You are the install agent of ${DISPLAY_NAME}, on the user's own server. One step of the install failed. Your job: explain in plain words what went wrong, repair it, and run the check again.`,
    "",
    "Your rules are held by the settings of this session, not by this text. A call that breaks a rule does not run.",
    `- With no question you can: read the state of the server (versions, ports, disk, the log of ${DISPLAY_NAME}), run a check or a step again, rebuild ${DISPLAY_NAME} (\`pnpm install\` and \`pnpm build\`, in ${c.app}), remove its build (${c.app}/.next, ${c.app}/node_modules), give it another port, and restart its own service.`,
    "- The person is asked first, and sees the exact command: each command with sudo, a system package, stopping a program that is not " + DISPLAY_NAME + ", swap, a firewall rule, a change of a file, and every command that is not on your list. Before such a command, say in one line what it does and why. Give one plain command at a time, with full paths, with no `&&`, no pipe, no `$( )` and no quote: only a plain command can run with no question.",
    `- Never: open a public port or address, delete a file that ${DISPLAY_NAME} did not make, read keys or secrets (also not the settings file of ${DISPLAY_NAME}), make a pairing code, change the code or the data of ${DISPLAY_NAME}. You cannot mark a step done: only its check does that. When a call is refused, do not try another way: say what you need, and stop.`,
    "",
    `The facts: ${DISPLAY_NAME}'s own folder is ${c.base} (the code in ${c.app}, its own Node in ${c.base}/node). Its service is ${c.unit}, a systemd service of the user ${c.user}. Its command is ${c.cli}.`,
    `The checks: \`${c.cli} doctor --details\` (each step, and the technical checks) and \`${c.cli} setup --auto --brief\` (the set-up; it goes on where it stopped).`,
    `Another port, when a program took the port of ${DISPLAY_NAME}: ${c.cli} port <number>   and then: systemctl --user restart ${c.unit}`,
    "",
    'Use plain words and short sentences. Say "your server". When the check passes, say so in one line and tell the person to type /exit: the installer then goes on by itself. When you cannot repair it, say what the person can do.',
  ].join("\n");
}

// The failed step for the model: no line that looks like a secret, and the last lines only.
export function forModel(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n").map((l) => (findSecret(l) ? "[a line that looks like a secret was removed]" : l));
  return lines.slice(-OUTPUT_LINES).join("\n").trim();
}

export function firstMessage(title: string, output: string): string {
  return `This step of the install failed: ${title}\n\nIts output (the last lines):\n\n${forModel(output)}\n\nExplain what went wrong, repair it, and run the check again.`;
}

export function agentArgs(c: AgentCtx, message: string, node?: string): string[] {
  return [
    "--restricted", "--tools", AGENT_TOOLS, "--permission-mode", "default", "--strict-mcp-config", "--disable-slash-commands",
    "--settings", JSON.stringify(agentSettings(c, node)), "--append-system-prompt", agentPrompt(c), message,
  ];
}

// The step that failed: the file of the install script, or (run by hand, later) what `doctor` finds now.
async function failedStep(c: AgentCtx): Promise<{ title: string; output: string }> {
  const file = join(c.base, FAILED_STEP_FILE);
  if (existsSync(file)) {
    const [first, ...rest] = readFileSync(file, "utf8").split("\n");
    return { title: first.replace(/^Step:\s*/, "") || "a step of the install", output: rest.join("\n") };
  }
  return { title: "the checks of the server", output: formatChecks(await runChecks(c.app)) };
}

type RepairDeps = {
  repoDir: string; env?: Env; isTTY?: boolean; out?: (s: string) => void; confirm?: () => Promise<void>; chdir?: (dir: string) => void;
  // The offer of the terminal login (true: the person said yes), and the login itself. Tests give both.
  offerLogin?: () => Promise<boolean>;
  login?: () => Promise<unknown>;
};

// 0: the session ran and ended. 1: no agent here (the reason is printed).
export async function runRepair(d: RepairDeps): Promise<number> {
  const out = d.out ?? ((s: string) => console.log(s));
  const shell = d.env ?? process.env;
  const env = installEnv(d.repoDir, shell);
  const fallback = `Each step prints its own fix, and the set-up goes on where it stopped: ${cli("setup --auto")}`;

  const c = agentCtx(d.repoDir, env);
  if (!c) { out(`The install agent works on an install that the install script of ${DISPLAY_NAME} made. This is not one.`); return 1; }
  const isTTY = d.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const check = (): Promise<Outcome> => stepOf("claude").check(boxProbes({ env, box: () => Promise.reject(new Error("not used")) }) as Probes);
  let claude = await check();
  if (claude.done !== true) {
    // The install does not make the person log in to Claude: the Set-up page does that. The one
    // place where the login is offered in the terminal is here, because the install agent is
    // Claude Code and cannot work with no login. "No" (or no terminal): the step's own fix, as before.
    const none = (): number => {
      out(`  ○ No install agent: ${claude.done === true ? "" : claude.reason} You can log in later on the page of ${DISPLAY_NAME}.`);
      out(`    ${fallback}`);
      return 1;
    };
    const installed = (await boxProbes({ env, box: () => Promise.reject(new Error("not used")) }).claude()).installed;
    if (!installed || !isTTY) return none();
    out("");
    out("  The install agent can look at this step with you. It is Claude Code, so it needs your Claude login.");
    let yes = false;
    try {
      yes = await (d.offerLogin ?? (() => ask("  Log in to Claude now, in this terminal? Type y for yes. Enter means no", "n").then((a) => /^y(es)?$/i.test(a.trim()))))();
    } catch (e) {
      if (!(e instanceof PromptError)) throw e;
    }
    if (!yes) return none();
    await (d.login ?? (() => runLogin({ repoDir: d.repoDir, env: shell, isTTY, out })))();
    claude = await check();
    if (claude.done !== true) return none();
  }
  const bin = resolveClaudeBin(env);
  if (!(await run(bin, ["--help"], { timeoutMs: 30_000 })).stdout.includes("--restricted")) {
    out("  ○ No install agent: the Claude Code on your server is too old for it. To update it: claude update");
    out(`    ${fallback}`);
    return 1;
  }
  if (!isTTY) {
    out(`  ○ The install agent needs a terminal with a person. To start it: ${cli("repair")}`);
    return 1;
  }

  const step = await failedStep(c);
  out("");
  out("  The install agent can repair this with you. It is Claude Code with fixed rules:");
  out(`    - It sends the output of the failed step ("${step.title}") to Claude, the model of Anthropic.`);
  out(`    - With no question: it reads the state of your server, runs a check again, rebuilds and restarts ${DISPLAY_NAME}.`);
  out("    - It asks you first, with the exact command: sudo, a system package, another program, a change of a file.");
  out("    - Never: a public door to your server, your own files deleted, a key or a secret read, a step marked done.");
  try {
    await (d.confirm ?? (() => ask("  Press Enter to start it (Ctrl-C stops here)").then(() => undefined)))();
  } catch (e) {
    if (!(e instanceof PromptError)) throw e;
    out(`  ○ Nobody answered, so the install agent did not start. To start it: ${cli("repair")}`);
    return 1;
  }

  (d.chdir ?? process.chdir)(c.base);
  // Its own Node first, as in the installed command.
  const path = [dirname(process.execPath), join(c.home, ".local", "bin"), shell.PATH ?? ""].filter(Boolean).join(":");
  const r = await run(bin, agentArgs(c, firstMessage(step.title, step.output)), { stdio: "inherit", env: { ...(shell as NodeJS.ProcessEnv), PATH: path } });
  out("");
  out(r.code === 0 ? "  The install agent ended." : `  The install agent stopped (code ${r.code}). ${fallback}`);
  return r.code === 0 ? 0 : 1;
}
