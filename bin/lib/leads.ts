// bin/lib/leads.ts — `pnpm choibot leads <sub>`: area leads over the console API.
// JSON on stdout; errors on stderr with exit 1.
import { createConsoleClient, msg, CliError, defaultIo, readStdinJson, type CliEnv } from "./client.js";
import type { Cli } from "./cli.js";
import { CLI_NAME } from "../../server/brand.js";

const HELP = `${CLI_NAME} leads — area leads

  start <area> --repos a,b   user: start the area's lead (needs a user token)
  report                     lead: write the area report; JSON {"text": "...", "needs": "none|decision|problem"} on stdin
                             (needs "none": a status report, the Coordinator gets no event)
  show <area>                show the area, its lead and its last report
  list                       list the areas with lead status, sessionId and cwd`;

export type LeadsDeps = {
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

export async function runLeads(sub: string | undefined, rest: string[], overrides?: Partial<LeadsDeps>): Promise<number> {
  const d: LeadsDeps = { ...defaultIo(), ...overrides };
  const print = (v: unknown) => d.out(JSON.stringify(v, null, 2));
  const needArea = (): string => {
    if (!rest[0]) throw new CliError(`usage: ${CLI_NAME} leads ${sub} <area>`);
    return rest[0];
  };
  try {
    switch (sub) {
      case "start": {
        const area = needArea();
        const r = d.flags.repos;
        if (typeof r !== "string" || !r.trim()) throw new CliError("--repos needs a comma list of repos");
        const repos = r.split(",").map((x) => x.trim()).filter(Boolean);
        print(await createConsoleClient(d).callAsUser("POST", "/api/leads", { area, repos }));
        return 0;
      }
      case "report": {
        const body = await readStdinJson(d, sub);
        print(await createConsoleClient(d).call("POST", "/api/leads/report", body));
        return 0;
      }
      case "show": {
        print(await createConsoleClient(d).call("GET", `/api/leads/${encodeURIComponent(needArea())}`));
        return 0;
      }
      case "list": {
        print(await createConsoleClient(d).call("GET", "/api/leads"));
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
