// bin/lib/remind.ts — `pnpm choibot remind <sub>`: reminders an agent sets for
// itself over the console API. JSON on stdout; errors on stderr with exit 1.
// The caller's identity comes from CHOIBOT_AGENT_ID/CHOIBOT_AGENT_PASS (or the user
// token in a human shell), as for `choibot queue`. Here `--agent <id>` names the
// target agent; it is never the caller's identity.
import { createConsoleClient, msg, CliError, defaultIo, type CliEnv } from "./client.js";
import type { Cli } from "./cli.js";
import { CLI_NAME } from "../../server/brand.js";

const HELP = `${CLI_NAME} remind — reminders you set for yourself

  remind add --in <dur> | --at <ISO date-time> --text "<what to do then>" [--agent <id>]
                    set a reminder; prints {id, dueAt}. Durations: 30m, 6h, 3d, 1d12h
                    (5 min to 30 days). At the due time the console types
                    "[reminder <id>] (set by …) <text>" into the agent.
                    --agent: the fleet master for any agent, a lead for its workers
  remind list [--all] [--agent <id>]
                    the open reminders you may manage (--all: every state)
  remind cancel <id>
                    cancel an open reminder`;

const REMINDER_ID_RE = /^r_[0-9a-z]{8}$/;
const OFF = "reminders are off: this console runs without the chief of staff (CHIEF_ENABLED=1)";

export type RemindDeps = {
  fetch: typeof fetch;
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  env: CliEnv;
  flags: Cli["flags"];
  readFile: (p: string) => string | null;
};

type Stored = { id: string; agentId: string; setBy: string; state: string; dueAt: number; createdAt: number; text: string } & Record<string, unknown>;

const iso = (ms: unknown): unknown => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : ms);

// A reminder as the CLI prints it: dates as ISO strings.
function view(r: Stored): Record<string, unknown> {
  return { id: r.id, agentId: r.agentId, setBy: r.setBy, state: r.state, dueAt: iso(r.dueAt), createdAt: iso(r.createdAt), text: r.text };
}

export async function runRemind(sub: string | undefined, rest: string[], overrides?: Partial<RemindDeps>): Promise<number> {
  const d: RemindDeps = { ...defaultIo(), ...overrides };
  const print = (v: unknown) => d.out(JSON.stringify(v, null, 2));
  const value = (name: string): string | undefined => {
    const v = d.flags[name];
    if (v === true || v === "") throw new CliError(`--${name} needs a value`);
    return v;
  };
  // --agent is the target here, so the client never sees it (it would act as that agent).
  const { agent: _target, ...clientFlags } = d.flags;
  const client = () => createConsoleClient({ ...d, flags: clientFlags });

  try {
    switch (sub) {
      case "add": {
        const target = value("agent");
        const inV = value("in"), atV = value("at");
        if ((inV === undefined) === (atV === undefined)) throw new CliError("give exactly one of --in or --at (a duration like 3d, or an ISO date-time)");
        const text = value("text");
        if (text === undefined) throw new CliError('--text "<what to do then>" is required');
        const body = { ...(inV !== undefined ? { in: inV } : { at: atV }), text, ...(target !== undefined ? { agentId: target } : {}) };
        const r = await client().call("POST", "/api/reminders", body);
        print({ id: r.id, dueAt: iso(r.dueAt) });
        return 0;
      }
      case "list": {
        const target = value("agent");
        const r = await client().call("GET", `/api/reminders?status=${d.flags.all === true ? "all" : "open"}`);
        const list: Stored[] = Array.isArray(r?.reminders) ? r.reminders : [];
        print(list.filter((x) => target === undefined || x?.agentId === target).map(view));
        return 0;
      }
      case "cancel": {
        const id = rest[0];
        if (!id) throw new CliError(`usage: ${CLI_NAME} remind cancel <id>`);
        if (!REMINDER_ID_RE.test(id)) throw new CliError(`invalid reminder id: ${id}`);
        print(view(await client().call("POST", `/api/reminders/${id}/cancel`)));
        return 0;
      }
      default:
        d.out(HELP);
        return 2;
    }
  } catch (e) {
    // No route at all (Next's HTML 404, no JSON body): the feature is off.
    if (e instanceof CliError && e.status === 404 && (e.body === null || e.body === undefined)) d.err(OFF);
    else d.err(msg(e));
    return 1;
  }
}
