// bin/lib/queue.ts — `pnpm choibot queue <sub>`: the decision queue over the console API.
// JSON on stdout; errors on stderr with exit 1.
import { createConsoleClient, msg, CliError, defaultIo, readStdinJson, type CliEnv } from "./client.js";
import type { Cli } from "./cli.js";
import { CLI_NAME } from "../../server/brand.js";
import { envKey, envRead } from "../../server/names.mjs";

const HELP = `${CLI_NAME} queue — the decision queue

  add               add an item; JSON on stdin; prints {id}
  show <id>         show one item
  list [--open] [--area a] [--mine]   list items (--open: open only; --mine: your own)
  withdraw <id>     withdraw one of your items
  recommend <id>    set your recommendation; JSON on stdin
  answer <id>       master: answer an item by rule; JSON on stdin (a downgrade reason goes to stderr)
  undo <id>         master: undo your own auto answer`;

// Same rule as the store: q + 8 base36. Keeps dot segments out of the URL path.
const ITEM_ID_RE = /^q[0-9a-z]{8}$/;

export type QueueDeps = {
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

function defaultDeps(): QueueDeps {
  return defaultIo();
}

export async function runQueue(sub: string | undefined, rest: string[], overrides?: Partial<QueueDeps>): Promise<number> {
  const d: QueueDeps = { ...defaultDeps(), ...overrides };
  const print = (v: unknown) => d.out(JSON.stringify(v, null, 2));
  const needId = () => {
    if (!rest[0]) throw new CliError(`usage: ${CLI_NAME} queue ${sub} <id>`);
    if (!ITEM_ID_RE.test(rest[0])) throw new CliError(`invalid item id: ${rest[0]}`);
    return rest[0];
  };
  const stdinJson = () => readStdinJson(d, sub);
  const flagValue = (name: string): string | undefined => {
    const v = d.flags[name];
    if (v === true || v === "") throw new CliError(`--${name} needs a value`);
    return v;
  };

  try {
    switch (sub) {
      case "add": {
        const body = await stdinJson();
        const r = await createConsoleClient(d).call("POST", "/api/queue", body);
        print({ id: r.id });
        return 0;
      }
      case "show": {
        const id = needId();
        const item = await createConsoleClient(d).call("GET", `/api/queue/${id}`);
        print(item);
        // A page (rich part) is not in the JSON: say that the item has one and where the copy is.
        if (item?.html) d.err(`This item has a page (${item.html.bytes} bytes): the user sees it in the Queue. The body is the text of the ticket. The copy of the page: ${item.html.copy ?? "in the queue's store"}`);
        return 0;
      }
      case "list": {
        const area = flagValue("area");
        const mine = d.flags.mine === true;
        const me = mine ? (flagValue("agent") || envRead(d.env, "AGENT_ID")) : undefined;
        if (mine && !me) throw new CliError(`--mine needs ${envKey("AGENT_ID")} or --agent <id>`);
        const q = `status=${d.flags.open === true ? "open" : "all"}${area ? `&area=${encodeURIComponent(area)}` : ""}`;
        const r = await createConsoleClient(d).call("GET", `/api/queue?${q}`);
        const items: any[] = Array.isArray(r?.items) ? r.items : [];
        print(mine ? items.filter((i) => i?.agentId === me) : items);
        return 0;
      }
      case "withdraw": {
        const id = needId();
        print(await createConsoleClient(d).call("POST", `/api/queue/${id}/withdraw`));
        return 0;
      }
      case "recommend": {
        const id = needId();
        const body = await stdinJson();
        print(await createConsoleClient(d).call("POST", `/api/queue/${id}/recommend`, body));
        return 0;
      }
      case "answer": {
        const id = needId();
        const body = await stdinJson();
        const { downgraded, ...item } = await createConsoleClient(d).call("POST", `/api/queue/${id}/answer`, body);
        print(item);
        if (downgraded !== undefined) d.err(`downgraded: ${downgraded}`);
        return 0;
      }
      case "undo": {
        const id = needId();
        print(await createConsoleClient(d).call("POST", `/api/queue/${id}/undo`));
        return 0;
      }
      default:
        d.out(HELP);
        return 2;
    }
  } catch (e) {
    d.err(msg(e));
    return 1;
  }
}
