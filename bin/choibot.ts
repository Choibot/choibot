// bin/choibot.ts — the CLI: `pnpm choibot <command>` and `pnpm choi`.
import { parseCli, type Cli } from "./lib/cli.js";
import { runCron } from "./lib/cron.js";
import { runAgents } from "./lib/agents.js";
import { runBrain } from "./lib/brain.js";
import { runLeads } from "./lib/leads.js";
import { runCoordinator, runFleet } from "./lib/fleet.js";
import { runQueue } from "./lib/queue.js";
import { runRemind } from "./lib/remind.js";
import { runDoctor } from "./lib/doctor.js";
import { runPair } from "./lib/pair.js";
import { runLogin } from "./lib/login.js";
import { runAccess } from "./lib/access.js";
import { runStrongSetup } from "./lib/strong.js";
import { runFirstStart } from "./lib/firststart.js";
import { runRepair } from "./lib/repair.js";
import { runOps, runPort, runSetup, runUpdate } from "./lib/steps.js";
import { exitAfterFlush, ignoreEpipe } from "./lib/exit.js";
import { CLI_NAME, CLI_SHORT_NAME, DISPLAY_NAME } from "../server/brand.js";
import { namesDecision } from "../server/names.mjs";

const HELP = `${CLI_NAME} — install & operate ${DISPLAY_NAME}, your console

Usage: pnpm ${CLI_NAME} <command>     (short: pnpm ${CLI_SHORT_NAME})

  repair            the install agent: Claude Code with fixed rules explains a failed step of the
                    install and repairs it (it asks before each command that needs root)
  port <n>          give the console another port (when another program took its port); then restart
  setup             one-command install: doctor, .env, prereqs, build, services, verify
                    --auto: no question, no terminal needed; ends with the set-up steps
                    (optional with --auto: --port <n>, --workspace <dir>, --url <address>)
  doctor            the set-up steps and their state (--details: the technical checks too)
  pair              a code that pairs your first device with a new install (one use, 10 minutes)
  login             log in to Claude on this server (your Claude plan), then check that it works
  access            how to open the console from your devices: the SSH tunnel line, and the
                    private address with Tailscale (it turns the address on when Tailscale is ready)
  status            systemd status for the console
  logs [unit]       follow logs (default console)
  restart [unit]    restart the console
  stop              stop the console
  update            git pull, install, build, refresh unit files, restart the console
  cron <sub>        scheduled claude runs (\`pnpm ${CLI_NAME} cron\` for help)
  agents <sub>      console agents: list, spawn, stop, resume, close, merge-pr, delete, pr, fetch-base (\`pnpm ${CLI_NAME} agents\` for help)
  brain <sub>       brain devices, rules and decisions: claim, pair, devices, revoke, decision, add, list, show, confirm, retire, distill, apply, rollback, import-memory, triage
  queue <sub>       decision queue: add, show, list, withdraw, recommend
  remind <sub>      reminders an agent sets for itself: add, list, cancel
  leads <sub>       area leads: start, report, show, list
  fleet [part]      the state of the fleet in short lines (read-only): queue, agents, leads, cron
  coordinator       the Coordinator's state; \`coordinator tell\` gives it a task (the fleet master or the user)
  names             the technical names of this install (unit, data dir, env prefix, folders) and why
  strong-setup      (root, a new server) strong protection: agents under their own account
                    --user <the console's user>; --dry-run prints the plan and changes nothing
                    --accept-used-server: on a server where agents already ran as the console's
                    user, you accept that root runs code and changes folders those agents could change
  first-start <f>   (the first boot of a server made from an image) its own secret, address and claim link
`;

// The three values `setup --auto` takes. A flag with no value counts as not given.
function autoOpts(flags: Cli["flags"]): { port?: string; workspace?: string; url?: string; brief?: boolean } {
  const text = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
  const o = { port: text(flags.port), workspace: text(flags.workspace), url: text(flags.url) };
  return { ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)), ...(flags.brief === true ? { brief: true } : {}) };
}

type Handler = (target: string | undefined, rest: string[], flags: Cli["flags"]) => Promise<number>;
// `pnpm choibot` is always launched from the repo root, so cwd IS the repo dir.
const commands: Record<string, Handler> = {
  setup: (_target, _rest, flags) => runSetup({ repoDir: process.cwd(), ...(flags.auto === true ? { auto: autoOpts(flags) } : {}) }),
  doctor: (_target, _rest, flags) => runDoctor(process.cwd(), { details: flags.details === true }),
  pair: () => runPair({ repoDir: process.cwd() }),
  login: () => runLogin({ repoDir: process.cwd() }),
  access: () => runAccess({ repoDir: process.cwd() }),
  repair: () => runRepair({ repoDir: process.cwd() }),
  port: (target) => runPort(process.cwd(), target),
  "strong-setup": (_target, _rest, flags) => runStrongSetup({
    repoDir: process.cwd(), dryRun: flags["dry-run"] === true, printFacts: flags["print-facts"] === true,
    ...(typeof flags.user === "string" ? { user: flags.user } : {}), ...(typeof flags.facts === "string" ? { factsFile: flags.facts } : {}),
    acceptUsed: flags["accept-used-server"] === true,
  }),
  "first-start": async (target) => {
    if (!target?.startsWith("/")) { console.error(`Give the full path of the first-start file: ${CLI_NAME} first-start /path/to/file`); return 2; }
    return runFirstStart({ repoDir: process.cwd(), file: target });
  },
  status: (target) => runOps("status", target),
  logs: (target) => runOps("logs", target),
  restart: (target) => runOps("restart", target),
  stop: (target) => runOps("stop", target),
  update: () => runUpdate(process.cwd()),
  cron: (target, rest, flags) => runCron(target, rest, undefined, flags),
  agents: (target, rest, flags) => runAgents(target, rest, { flags }),
  brain: (target, rest, flags) => runBrain(target, rest, { flags }),
  queue: (target, rest, flags) => runQueue(target, rest, { flags }),
  remind: (target, rest, flags) => runRemind(target, rest, { flags }),
  leads: (target, rest, flags) => runLeads(target, rest, { flags }),
  fleet: (target, rest, flags) => runFleet(target, rest, { flags }),
  coordinator: (target, rest, flags) => runCoordinator(target, rest, { flags }),
  // An install made before the rename keeps its old names (server/names.mjs).
  names: async () => {
    const { names: n, markers } = namesDecision();
    console.log(JSON.stringify({ install: n.legacy ? "old names" : "new names", markers, names: n }, null, 2));
    return 0;
  },
};

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help || !Object.hasOwn(commands, cli.command)) { console.log(HELP); return cli.help ? 0 : 2; }
  return commands[cli.command](cli.target, cli.rest, cli.flags);
}
// Handlers signal normal user errors by throwing (e.g. "unknown target: …");
// print the message, not a stack trace.
ignoreEpipe();
main().catch((e: Error) => { console.error(String(e.message)); return 2; }).then(exitAfterFlush);
