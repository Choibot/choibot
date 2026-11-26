// The contract every agent runtime satisfies. One implementation per CLI the
// console can host in a PTY. Everything here is called from api.ts or
// recovery.ts — no runtime detail leaks past this boundary.
import type { AgentRecord, AgentRuntimeId } from "../store.js";
import type { AgentTask } from "../tasks.js";
import type { AccountPaths } from "../accounts.js";

// Launch-time knobs that are not per-request. `model`/`effort` are unused by
// today's call sites but kept because buildClaudeArgs already accepts them.
export type Preset = { model?: string; effort?: string; systemPrompt?: string };

export type ArgOpts = { prompt?: string; settingsPath?: string; resume?: string; cwd?: string;
  // Claude only (Codex ignores it): launch with --system-prompt-snapshot off so a
  // relaunch picks up the new prompt. Set when chiefActive() (spec §6.4).
  promptSnapshotOff?: boolean };

// What prepare() is given: enough to place per-agent config and point hooks at us.
// `systemPrompt` is the same string the caller hands to buildArgs — Claude
// delivers it via --append-system-prompt and ignores it here; Codex has no such
// flag, so prepare() writes it into the generated AGENTS.md instead.
// `accounts` is where the Claude login dirs live (accounts.ts); production
// omits it and the adapter resolves it from the environment.
export type PrepareCtx = { port: number; workspaceDir: string; systemPrompt?: string; accounts?: AccountPaths };

// What prepare() hands back to the spawn call.
export type PrepareResult = {
  env?: Record<string, string>;
  // The path passed to buildArgs as `settingsPath`. Codex configures itself
  // through CODEX_HOME instead, so it returns none.
  settingsPath?: string;
};

export type HookPayload = {
  hook_event_name?: string;
  session_id?: string;
  source?: string;
  transcript_path?: string;
  // Claude's Stop payload: the final assistant text of the turn (see hooks.ts).
  last_assistant_message?: string;
};

export type HookStatus = {
  status?: "running" | "idle";
  sessionId?: string;
  transcriptPath?: string;
};

// What readPlan is allowed to be pointed at. `tasksRoot` is the Claude harness
// task directory (default ~/.claude/tasks); it is a dependency rather than an
// env var on purpose — CLAUDE_TASKS_ROOT is NOT a Claude Code variable, so a
// value picked up from the ambient environment could only ever aim the Plan rail
// at a directory Claude never writes. Codex takes its plan from the rollout path
// on the record and ignores this entirely.
export type PlanCtx = { tasksRoot?: string };

export interface AgentRuntime {
  id: AgentRuntimeId;
  /** Absolute path or bare name of the CLI to spawn. */
  bin(): string;
  /** Write per-agent config before spawn. Called on create AND on every resume. */
  prepare(rec: AgentRecord, ctx: PrepareCtx): Promise<PrepareResult>;
  buildArgs(preset: Preset, opts: ArgOpts): string[];
  hookToStatus(payload: HookPayload): HookStatus;
  /** Whether a full-conversation resume is possible for this record. */
  canResume(rec: AgentRecord, cwd: string): Promise<boolean>;
  /** The agent's live plan/task list for the rail. Empty is a normal state. */
  readPlan(rec: AgentRecord, ctx?: PlanCtx): Promise<AgentTask[]>;
}
