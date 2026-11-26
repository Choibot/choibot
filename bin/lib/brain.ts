// bin/lib/brain.ts — `pnpm choibot brain <sub>`: device pairing and brain decisions
// over the console API. JSON on stdout; errors on stderr with exit 1.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { foldRules, type RuleEvent } from "../../server/chief/brain/store.js";
import { parseJsonl } from "../../server/chief/files.js";
import { createConsoleClient, CliError, defaultIo, humanShell, readStdinJson, writeUserToken, type CliEnv } from "./client.js";
import type { Cli } from "./cli.js";
import { jevJudge, TRIAGE_WHY, triagePlan, type Judge, type TriageRule } from "./triage.js";
import { CLI_NAME } from "../../server/brand.js";
import { names } from "../../server/names.mjs";

const HELP = `${CLI_NAME} brain — brain devices and decisions

  claim <url>       claim a pairing URL (human shell only); stores the user token
  pair <label>      start pairing for a device (human shell only); prints {url, expiresAt}
  devices           list paired devices
  revoke <label>    revoke a device
  decision          record a decision; JSON on stdin
  add               add a rule; JSON {text, scope, kind, agent?, pr?} on stdin
  list [--state s]  list rules (active, candidate, all)
  show              the brain text, its age, and whether a proposal waits
  confirm <id> [--confidence n]   confirm a rule (user token)
  retire <id>       retire a rule; JSON {why} on stdin (user token)
  distill [--dry-run]   run the distiller now (user token; up to 10 min)
  apply             apply the proposal (user token); prints {version}: the saved
                    previous brain (for rollback), or null when none was saved
  rollback [--version v]   restore a brain version (user token)
  import-memory [dir]   add each memory file description as a candidate (user token)
  triage [--apply] [--file rules.jsonl --brain BRAIN.md] [--no-jev]
                    one-time cleanup of the old candidates: a one-time answer is
                    retired (why "triage"), a standing rule is kept and later asked
                    as "Make this a rule?" (a jev score from 0.2 to 0.8 is "not sure"
                    and is kept too); active rules get the BRAIN.md wording.
                    Dry run by default; --apply writes (user token). --file reads a
                    copy of the rules file (dry run only). jev judges when on PATH.`;

export type BrainDeps = {
  fetch: typeof fetch;
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  env: CliEnv;
  flags: Cli["flags"];
  readFile: (p: string) => string | null;
  writeToken: typeof writeUserToken;
  longFetch?: typeof fetch;
  // triage: the yes/no judge of the texts the plain test does not settle (default: jev).
  judge?: Judge;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function defaultDeps(): BrainDeps {
  return { ...defaultIo(), writeToken: writeUserToken };
}

const RULE_MAX = 200;

// At most RULE_MAX UTF-16 units, never half of a surrogate pair at the cut.
function cutRule(v: string): string {
  if (v.length <= RULE_MAX) return v;
  const c = v.charCodeAt(RULE_MAX - 1);
  return v.slice(0, c >= 0xd800 && c <= 0xdbff ? RULE_MAX - 1 : RULE_MAX);
}

// The `description:` lines inside the leading front matter of a memory file.
function descriptions(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const m = /^description:\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (v) out.push(cutRule(v));
  }
  return out;
}

function pairCode(url: string): string {
  let hash: string;
  try { hash = new URL(url).hash; } catch { throw new CliError("claim: not a valid URL"); }
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("pair");
  if (!code) throw new CliError("claim: the URL has no #pair=<code>");
  return code;
}

export async function runBrain(sub: string | undefined, rest: string[], overrides?: Partial<BrainDeps>): Promise<number> {
  const d: BrainDeps = { ...defaultDeps(), ...overrides };
  const print = (v: unknown) => d.out(JSON.stringify(v, null, 2));
  const needHuman = (what: string) => {
    if (!humanShell(d.env, d.stderrIsTTY)) throw new CliError(`${what} runs in a human shell only`);
  };
  const needArg = (name: string, v: string | undefined) => {
    if (!v) throw new CliError(`usage: ${CLI_NAME} brain ${sub} <${name}>`);
    return v;
  };

  const stdinJson = () => readStdinJson(d, sub);

  try {
    switch (sub) {
      case "claim": {
        const url = needArg("url", rest[0]);
        needHuman("claim");
        // Check before the request: a missing HOME must not spend the single-use code.
        if (!d.env.HOME) throw new CliError("HOME is not set: refusing to claim (the token cannot be written)");
        const code = pairCode(url);
        const client = createConsoleClient(d);
        const r = (await client.callBare("POST", "/api/chief/pair/claim", { code })) as { token: string; label: string };
        await d.writeToken(d.env, r.token);
        print({ label: r.label });
        return 0;
      }
      case "pair": {
        const label = needArg("label", rest[0]);
        needHuman("pair");
        const client = createConsoleClient(d);
        const r = (await client.callBare("POST", "/api/chief/pair/start", { label })) as { url: string; expiresAt: unknown };
        print({ url: r.url, expiresAt: r.expiresAt });
        return 0;
      }
      case "devices": {
        print(await createConsoleClient(d).callAsUser("GET", "/api/brain/devices"));
        return 0;
      }
      case "revoke": {
        const label = needArg("label", rest[0]);
        print(await createConsoleClient(d).callAsUser("POST", `/api/brain/devices/${encodeURIComponent(label)}/revoke`));
        return 0;
      }
      case "decision": {
        const body = await stdinJson();
        print(await createConsoleClient(d).call("POST", "/api/brain/decisions", body));
        return 0;
      }
      case "add": {
        const client = createConsoleClient(d);
        const body = await stdinJson();
        const withVia = (await client.identity()) === "user" && body && typeof body === "object" ? { ...(body as object), via: "cli" } : body;
        print(await client.call("POST", "/api/brain/rules", withVia));
        return 0;
      }
      case "list": {
        const state = d.flags.state ?? "all";
        if (state === true) throw new CliError("--state needs a value: active, candidate or all");
        print(await createConsoleClient(d).call("GET", `/api/brain/rules?state=${encodeURIComponent(state)}`));
        return 0;
      }
      case "show": {
        const r = await createConsoleClient(d).call("GET", "/api/brain");
        print({ text: r.text, updatedAt: r.updatedAt, proposed: Boolean(r.proposed) });
        return 0;
      }
      case "confirm": {
        const id = needArg("id", rest[0]);
        const c = d.flags.confidence;
        let confidence: number | undefined;
        if (c !== undefined) {
          confidence = c === true || !c.trim() ? NaN : Number(c);
          if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new CliError("--confidence needs a number from 0 to 1");
        }
        print(await createConsoleClient(d).callAsUser("POST", `/api/brain/rules/${encodeURIComponent(id)}`,
          { confirm: true, via: "cli", ...(confidence !== undefined && { confidence }) }));
        return 0;
      }
      case "retire": {
        const id = needArg("id", rest[0]);
        const b = (await stdinJson()) as { why?: unknown } | null;
        print(await createConsoleClient(d).callAsUser("POST", `/api/brain/rules/${encodeURIComponent(id)}`,
          { retire: { why: b?.why }, via: "cli" }));
        return 0;
      }
      case "distill": {
        print(await createConsoleClient(d).callAsUserLong("POST", "/api/brain/distill", { dryRun: d.flags["dry-run"] === true }));
        return 0;
      }
      case "apply": {
        print(await createConsoleClient(d).callAsUser("POST", "/api/brain/apply"));
        return 0;
      }
      case "rollback": {
        const v = d.flags.version;
        if (v === true) throw new CliError("--version needs a value");
        print(await createConsoleClient(d).callAsUser("POST", "/api/brain/rollback", v === undefined ? {} : { version: v }));
        return 0;
      }
      case "import-memory": {
        const dir = rest[0] ?? join(d.env.HOME ?? homedir(), ".local", "share", names().dataDir, "master", "memory");
        const client = createConsoleClient(d);
        let files: string[];
        try { files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort(); }
        catch (e) { throw new CliError(`cannot read ${dir}: ${msg(e)}`); }
        let candidates = 0, skipped = 0;
        for (const f of files) {
          const text = d.readFile(join(dir, f));
          if (text === null) { d.err(`warning: skipped unreadable file ${f}`); continue; }
          for (const description of descriptions(text)) {
            try {
              await client.callAsUser("POST", "/api/brain/rules", { text: description, state: "candidate",
                source: { memoryFile: basename(f) }, scope: { area: "*", audience: "all" }, kind: "preference" });
              candidates++;
            } catch (e) {
              if (e instanceof CliError && e.status === 409) skipped++;
              else throw e;
            }
          }
        }
        print({ candidates, skipped });
        return 0;
      }
      case "triage": {
        const { file, brain: brainFile } = d.flags;
        const apply = d.flags.apply === true;
        if (file === true || brainFile === true) throw new CliError("--file and --brain need a path");
        if (d.flags.apply !== undefined && !apply) throw new CliError("--apply takes no value");
        let rules: TriageRule[];
        let brain: string;
        if (file !== undefined) {
          if (apply) throw new CliError("--apply works on the console only (no --file): the console is the one writer of the rules");
          const text = d.readFile(file);
          if (text === null) throw new CliError(`cannot read ${file}`);
          rules = [...foldRules(parseJsonl<RuleEvent>(text)).values()].map(({ id, text: t, state }) => ({ id, text: t, state }));
          brain = brainFile === undefined ? "" : d.readFile(brainFile) ?? "";
        } else {
          const client = createConsoleClient(d);
          rules = (await client.call("GET", "/api/brain/rules?state=all")) as TriageRule[];
          brain = String(((await client.call("GET", "/api/brain")) as { text?: unknown }).text ?? "");
        }
        const plan = await triagePlan(rules, brain, d.flags["no-jev"] === true ? null : d.judge ?? jevJudge);
        if (apply) {
          const client = createConsoleClient(d);
          const at = (id: string) => `/api/brain/rules/${encodeURIComponent(id)}`;
          for (const r of plan.drop) await client.callAsUser("POST", at(r.id), { retire: { why: TRIAGE_WHY }, via: "cli" });
          for (const r of [...plan.keep, ...plan.notSure]) await client.callAsUser("POST", at(r.id), { text: r.text, via: "cli" });
          for (const r of plan.reword) await client.callAsUser("POST", at(r.id), { text: r.to, via: "cli" });
        }
        print({ ...plan, applied: apply });
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
