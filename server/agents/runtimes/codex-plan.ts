// server/agents/runtimes/codex-plan.ts — pure parsing of a Codex rollout JSONL
// into the rail's task shape. Filesystem access stays in the adapter; this
// module is string → shape, matching server/agents/tasks.ts.
//
// Codex tracks progress with an `update_plan` tool call rather than one file per
// task. Each call REPLACES the whole plan, so the LAST one in the rollout is the
// current state — never merge them.
//
// Payload shape:
//
//   UpdatePlanArgs { explanation?: string, plan: [{ step: string, status }] }
//   status ∈ pending | in_progress | completed
//
// It reaches the rollout three ways and we accept all three.
//
// (a) THE ONE ACTUALLY OBSERVED, codex-cli 0.144.0 (captured 2026-08-14).
// Codex routes every tool through a single JavaScript sandbox tool, so there is
// no `update_plan` function call in the rollout at all. The record is named
// "exec" and the plan arrives as JS SOURCE in `input`:
//
//   {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec",
//    "input":"const r = await tools.update_plan({explanation:\"…\",plan:[\n
//      {step:\"Define the handler\",status:\"completed\"},\n …]});\ntext(r);\n"}}
//
// That argument is a JS object literal — bare keys, possibly single quotes or a
// trailing comma — so JSON.parse cannot read it directly. We extract the call's
// argument with a string-aware balanced scan and normalise it to JSON below.
// Deliberately NOT eval: a rollout is model-authored text running server-side.
//
// (b) and (c) the classic forms, kept because other versions and configurations
// still use plain function calling, and supporting them costs nothing:
//   {"type":"response_item","payload":{"type":"function_call",
//    "name":"update_plan","arguments":"<json string>"}}
//   {"type":"event_msg","payload":{"type":"plan_update","plan":[...]}}
// Nothing below asserts the envelope's `type` fields: a record is interesting
// if it names the plan tool and carries a step array, whatever wraps it.
import type { AgentTask } from "../tasks.js";

type Step = { step?: unknown; status?: unknown };

const TOOL = "update_plan";

// Index just past the string literal opening at `i`. Unterminated → end of src.
function endOfString(s: string, i: number): number {
  const quote = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === quote) return j + 1;
  }
  return s.length;
}

// Text between the brackets of the call whose opening `(` sits at `open`.
// String-aware, so a bracket inside a step's text cannot unbalance the scan.
function bracketed(s: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { i = endOfString(s, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return s.slice(open + 1, i);
    }
  }
  return null; // truncated source
}

// Re-quote a single- or backtick-quoted JS string as a JSON string literal.
// Other escapes (\n, \t, \\, \uXXXX) mean the same in both, so they pass
// through unchanged; only the quote characters need adjusting.
function requote(inner: string): string {
  let out = '"';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      const next = inner[i + 1] ?? "";
      out += next === "'" ? "'" : c + next; // \' is not a JSON escape
      i++;
      continue;
    }
    if (c === '"') { out += '\\"'; continue; }
    if (c === "\n") { out += "\\n"; continue; }
    out += c;
  }
  return out + '"';
}

// JS object literal → JSON text, in one string-aware pass. Quotes bare keys,
// re-quotes non-JSON string literals and drops trailing commas. Done by walking
// rather than by regex so that a `{` or a `key:` INSIDE a step's text is copied
// verbatim instead of being rewritten.
function jsonish(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') { const e = endOfString(src, i); out += src.slice(i, e); i = e; continue; }
    if (c === "'" || c === "`") {
      const e = endOfString(src, i);
      out += requote(src.slice(i + 1, Math.max(i + 1, e - 1)));
      i = e;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      // An identifier followed by `:` is a key; true/false/null are values and
      // must stay bare.
      out += src[k] === ":" ? JSON.stringify(src.slice(i, j)) : src.slice(i, j);
      i = j;
      continue;
    }
    if (c === ",") {
      let k = i + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === "}" || src[k] === "]") { i++; continue; } // trailing comma
    }
    out += c;
    i++;
  }
  return out;
}

// How many CALL sites (`update_plan` followed by `(`) planFromScript will
// actually parse. Each one costs two O(record length) scans — bracketed() plus
// jsonish() — so an unbounded count is quadratic in the record: a 1 MB `input`
// repeating `update_plan(` ~87k times is ~10^11 character operations on the
// event loop, and the Plan rail POLLS, so the console would freeze rather than
// degrade. The content is model-authored, not attacker-supplied, but this is
// the same unbounded-work class already fixed for FIFOs. A real script calls
// update_plan a handful of times, so 32 is generous.
const MAX_CALL_SITES = 32;

// Steps from the LAST readable `tools.update_plan({…})` in a sandbox script.
// A script may legitimately call it more than once; the last call is current,
// matching the whole-file rule. Walked BACKWARDS so "last readable wins" is the
// first answer found, which is what lets the budget above cut the work off
// without changing the result for any plausible script. A bare mention costs
// O(1) and never spends budget; only a real call site does.
function planFromScript(src: string): unknown {
  const sites: number[] = [];
  // Collect call names only from executable source. Model-authored scripts can
  // contain patches, examples, and logs with call-shaped text inside them.
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = endOfString(src, i); continue; }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith(TOOL, i)) { sites.push(i); i += TOOL.length; continue; }
    i++;
  }
  let budget = MAX_CALL_SITES;
  for (let n = sites.length - 1; n >= 0 && budget > 0; n--) {
    const at = sites[n];
    let k = at + TOOL.length;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== "(") continue; // a mention, not a call
    budget--;
    const arg = bracketed(src, k);
    if (arg === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonish(arg));
    } catch {
      continue; // not readable as a plan — keep looking further back
    }
    const steps = (parsed as { plan?: unknown; steps?: unknown } | null)?.plan
      ?? (parsed as { steps?: unknown } | null)?.steps;
    if (Array.isArray(steps)) return steps;
  }
  return null;
}

function toStatus(v: unknown): AgentTask["status"] {
  return v === "completed" || v === "in_progress" ? v : "pending";
}

// The plan lives either under a JSON-string `arguments` (the tool call) or
// directly on the record (the event). Returns null when this is not a plan.
function stepsOf(p: { arguments?: unknown; plan?: unknown; steps?: unknown }): unknown {
  let args: unknown = p.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null; // a half-written or malformed call is not a plan
    }
  }
  const a = (args && typeof args === "object" ? args : p) as { plan?: unknown; steps?: unknown };
  return a.plan ?? a.steps ?? null;
}

export function parseRolloutPlan(jsonl: string): AgentTask[] {
  let latest: Step[] | null = null;
  for (const line of jsonl.split("\n")) {
    // Cheap prefilter: a rollout is mostly reasoning and command output, and
    // JSON.parse on every line of a megabyte file is the expensive path.
    if (!line.trim() || !line.includes("plan")) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a truncated tail line or a stray non-JSON line is normal
    }
    const outer = rec as { payload?: unknown } | null;
    const p = (outer && typeof outer === "object" ? (outer.payload ?? outer) : null) as
      | { type?: unknown; name?: unknown; arguments?: unknown; input?: unknown; plan?: unknown; steps?: unknown }
      | null;
    if (!p || typeof p !== "object") continue;
    // Form (a): the sandbox script. Checked first because this is the only form
    // codex-cli 0.144.0 actually emits, and its record is named "exec", so the
    // name/type test below would reject it.
    if (typeof p.input === "string" && p.input.includes(TOOL)) {
      const fromScript = planFromScript(p.input);
      if (Array.isArray(fromScript)) latest = fromScript as Step[];
      continue;
    }
    if (p.name !== TOOL && p.type !== "plan_update") continue;
    const steps = stepsOf(p);
    if (Array.isArray(steps)) latest = steps as Step[];
  }
  if (!latest) return [];
  const out: AgentTask[] = [];
  for (const s of latest) {
    const subject = typeof s?.step === "string" ? s.step.trim() : "";
    if (!subject) continue;
    // Rollouts carry no per-step id; index them so the rail has stable React keys.
    out.push({ id: String(out.length + 1), subject, status: toStatus(s?.status) });
  }
  return out;
}
