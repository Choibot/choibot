// server/guide/model.ts — one answer of the guide's model: a `claude -p` child on the Claude
// login of the server (no API key, no other provider), made the same way as the child of the
// brain distiller (chief/brain/distill.ts), which this file reuses:
//   - no tool at all: `--tools ""` takes away every built-in tool, `--restricted` ignores the
//     user's, the project's and the local settings (hooks, plugins), `--strict-mcp-config` with
//     no config gives no MCP server. A CLI that does not know one of these flags stops with an
//     error, and then the guide is "not available": it never starts with tools.
//   - `--system-prompt` puts the guide's own prompt in the place of the agent prompt.
//   - nothing kept: `--no-session-persistence`, and an empty folder made new for each call.
//   - an env allowlist: no setting and no secret of the console reaches the child.
// The child never throws to its caller: an answer is the text, or why there is none.
import { lstat, mkdir, rm } from "node:fs/promises";
import { distillConfigProblem, distillEnv, type ClaudeRun } from "../chief/brain/distill.js";
import type { Env } from "../defaults.js";

export const GUIDE_MODEL = "sonnet";
export const GUIDE_TIMEOUT_MS = 90_000;

// The argv of every call, before the system prompt. A test holds this list.
export const GUIDE_ARGV: readonly string[] = [
  "-p", "--model", GUIDE_MODEL, "--output-format", "json", "--tools", "", "--restricted",
  "--strict-mcp-config", "--no-session-persistence",
];

// model: another model for a caller that is not the guide (the clean-up audit uses a cheap one).
export const guideArgs = (system: string, model: string = GUIDE_MODEL): string[] =>
  [...GUIDE_ARGV.map((a, i) => (GUIDE_ARGV[i - 1] === "--model" ? model : a)), "--system-prompt", system];

// login: Claude is not logged in. limit: the plan is at its limit (`until`: when it comes back,
// if the answer says). down: all else (no answer, a timeout, an error of the service).
export type ModelFailure = { why: "login" | "limit" | "down"; until?: number };
export type ModelAnswer = { ok: true; text: string } | ({ ok: false } & ModelFailure);

const LOGIN_RE = /\/login|not logged in|log in to|invalid api key|invalid (bearer|x-api-key)|authentication[_ ]error|oauth token|unauthori[sz]ed|\b401\b/i;
const LIMIT_RE = /usage limit|limit reached|hit your [a-z ]*limit|out of (extra )?usage|rate[_ -]?limit|\b429\b/i;

// What an error text of the Claude program means. Older versions give the time the plan
// comes back as "…limit reached|<epoch seconds>".
export function classifyFailure(text: string, nowMs: number): ModelFailure {
  if (LIMIT_RE.test(text)) {
    const at = Number(/limit reached\|(\d{10})\b/.exec(text)?.[1]) * 1000;
    return { why: "limit", ...(at > nowMs ? { until: at } : {}) };
  }
  if (LOGIN_RE.test(text)) return { why: "login" };
  return { why: "down" };
}

type Envelope = { type?: unknown; is_error?: unknown; result?: unknown };

// The JSON envelope of `claude -p --output-format json`, or null.
function envelope(stdout: string): Envelope | null {
  try {
    const e: unknown = JSON.parse(stdout);
    return typeof e === "object" && e !== null ? (e as Envelope) : null;
  } catch {
    return null;
  }
}

// What one run of the child gave. The error text of a failure is read only here, for its kind.
export function readAnswer(r: { code: number | null; stdout: string; stderr: string }, nowMs: number): ModelAnswer {
  const e = envelope(r.stdout);
  if (r.code === 0 && e && e.type === "result" && e.is_error !== true && typeof e.result === "string" && e.result.trim() !== "") {
    return { ok: true, text: e.result };
  }
  const said = e && typeof e.result === "string" ? e.result : "";
  return { ok: false, ...classifyFailure(`${said}\n${r.stderr}`.slice(0, 4000), nowMs) };
}

export type GuideModelDeps = {
  run: ClaudeRun;
  // The empty folder the child runs in. It is made new for each call.
  runDir: string;
  env: Env;
  timeoutMs?: number;
  // Not the guide's own model.
  model?: string;
  // The run goes through the helper on the agents' login (strong protection,
  // agents/agentlogin.ts agentClaudeRun): the console's own Claude folder is not loaded, so its
  // check does not apply.
  agentLogin?: boolean;
  now?: () => number;
  log?: (s: string) => void;
};

export type GuideModel = (o: { system: string; input: string }) => Promise<ModelAnswer>;

export function makeGuideModel(d: GuideModelDeps): GuideModel {
  const log = d.log ?? ((s: string) => console.warn(s));
  const now = d.now ?? Date.now;
  return async ({ system, input }) => {
    // Hardened: a Claude folder that an agent can write is not loaded by a child of the console.
    if (!d.agentLogin && distillConfigProblem(d.env) !== null) { log("[guide] the Claude folder of the console is not safe to load: the guide does not start"); return { ok: false, why: "down" }; }
    try {
      // Whatever is in the folder (a planted CLAUDE.md, a link) goes before the call.
      await rm(d.runDir, { recursive: true, force: true });
      await mkdir(d.runDir, { recursive: true, mode: 0o700 });
      if (!(await lstat(d.runDir)).isDirectory()) return { ok: false, why: "down" };
      const r = await d.run(guideArgs(system, d.model), { stdin: input, cwd: d.runDir, env: distillEnv(d.env), timeoutMs: d.timeoutMs ?? GUIDE_TIMEOUT_MS });
      const answer = readAnswer(r, now());
      if (!answer.ok) log(`[guide] the model gave no answer (${answer.why}, exit ${r.code ?? "signal"})`);
      return answer;
    } catch (e) {
      // A timeout, or the program is not there. Fixed words: the message of the error can hold a path.
      const code = (e as NodeJS.ErrnoException | null)?.code;
      log(`[guide] the model did not run (${code ?? (e instanceof Error && /timed out/.test(e.message) ? "timeout" : "error")})`);
      return { ok: false, why: "down" };
    }
  };
}

// When a plan at its limit comes back, from the usage the console reads for its meter: the
// soonest reset of a window that is full. Null: not known.
export function limitUntil(usage: { ok: boolean; windows?: { percent: number; resetsAt: string | null }[] }, nowMs: number): number | null {
  const times = (usage.ok ? usage.windows ?? [] : [])
    .filter((w) => w.percent >= 100 && w.resetsAt)
    .map((w) => Date.parse(w.resetsAt!))
    .filter((t) => t > nowMs);
  return times.length ? Math.min(...times) : null;
}
