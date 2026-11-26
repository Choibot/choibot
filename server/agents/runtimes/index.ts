// Runtime registry. `pick` is the single dispatch point: every Claude-specific
// call site now goes through it. An unrecognized runtime falls back to Claude
// rather than throwing — a record hand-edited to a future runtime should degrade
// to a working agent, not crash the boot reconciler.
import type { AgentRecord, AgentRuntimeId } from "../store.js";
import { claudeRuntime } from "./claude.js";
import { codexRuntime } from "./codex.js";
import type { AgentRuntime } from "./types.js";

// Keyed by AgentRuntimeId (not plain string) so `isRuntimeId` narrows an
// untrusted body field straight to the record's own type — no cast at the
// call site, and adding a runtime id without a table entry is a type error.
const RUNTIMES: Record<AgentRuntimeId, AgentRuntime> = {
  claude: claudeRuntime,
  codex: codexRuntime,
};

// Routed through isRuntimeId rather than indexing directly, so the prototype
// chain cannot leak here either: a record hand-edited to `"runtime": "toString"`
// degrades to a working Claude agent instead of yielding Object.prototype's
// method, which would then blow up at .prepare() on every resume and hook call.
export function pick(rec: Pick<AgentRecord, "runtime">): AgentRuntime {
  const id = rec.runtime ?? "claude";
  return isRuntimeId(id) ? RUNTIMES[id] : claudeRuntime;
}

// `Object.hasOwn`, never `in`: `in` walks the prototype chain, so "toString",
// "constructor" and "__proto__" would all pass as runtime ids. That is reachable
// from the request body on POST /api/agents, and a value that passes here but
// has no table entry defeats pick()'s fallback too — pick would hand back
// Object.prototype.toString instead of claudeRuntime.
export function isRuntimeId(v: unknown): v is AgentRuntimeId {
  return typeof v === "string" && Object.hasOwn(RUNTIMES, v);
}

export * from "./types.js";
export { claudeRuntime } from "./claude.js";
export { codexRuntime } from "./codex.js";
