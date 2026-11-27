// server/agents/compact.ts — where a console-started Claude session compacts its context
// (owner's order of 2026-11-26, "cut the token use"). Each answer reads the session's whole
// context again; the sessions compacted only at 770–968 k. A cap of 200 k would have saved
// 57% of the tokens, 300 k 41%.
// Claude Code's own variable (https://code.claude.com/docs/en/env-vars):
// CLAUDE_CODE_AUTO_COMPACT_WINDOW "Set the auto-compact window, which is how full the context
// gets before compaction, to a token count of 100000 or more". It goes in the `env` of the
// settings file that the console passes with --settings: a hardened install passes only the
// sudoers env_keep keys to the agent's process.
import { isPersistentKind } from "./store.js";

// A worker's or an issue agent's window.
export const COMPACT_WINDOW_WORKER = 200_000;
// The long-lived kinds (a lead, the fleet master, the Coordinator): their facts live in more
// turns; their memory folder carries what a compaction drops.
export const COMPACT_WINDOW_LONG = 300_000;
// Claude Code's minimum.
export const COMPACT_WINDOW_MIN = 100_000;

// AGENT_COMPACT_WINDOW in the console's .env (bin/lib/env.ts): one token count for every kind,
// or "off" for Claude's own point. Not set (or not a number): the default of the kind.
export const COMPACT_WINDOW_KEY = "AGENT_COMPACT_WINDOW";

export function compactWindow(kind: string | undefined, env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[COMPACT_WINDOW_KEY]?.trim().toLowerCase();
  if (raw === "off") return null;
  const n = Number(raw?.replace(/k$/, "000"));
  if (raw && Number.isSafeInteger(n) && n > 0) return Math.max(COMPACT_WINDOW_MIN, n);
  return isPersistentKind(kind) ? COMPACT_WINDOW_LONG : COMPACT_WINDOW_WORKER;
}

// The `env` part of the session's settings file; empty when it is "off".
export function compactSettings(kind: string | undefined, env: Record<string, string | undefined> = process.env): { env?: Record<string, string> } {
  const w = compactWindow(kind, env);
  return w === null ? {} : { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(w) } };
}
