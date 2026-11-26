// server/agents/runtimes/claude.ts — the Claude Code runtime. This is the
// console's original behaviour, moved behind the adapter interface unchanged.
import { mkdir, writeFile, readdir, readFile, copyFile, link, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { isPersistentKind, type AgentRecord } from "../store.js";
import type { AgentTask } from "../tasks.js";
import { parseTaskFile, sortTasks } from "../tasks.js";
import { buildHookSettings, hookToStatus } from "../hooks.js";
import type { AgentRuntime, ArgOpts, PrepareCtx, PrepareResult, Preset } from "./types.js";
import { accountDir, accountPaths, claudeAccountEnv, claudeJsonPath, isDefaultAccount, syncAccountDir, type AccountPaths } from "../accounts.js";
import { CONSOLE_HOME_KINDS, trustClaudeDir } from "./claude-trust.js";
import { writeFileNoFollow } from "../nofollow.js";
import { runsAsChief } from "../../chief/chiefaccount.js";
import { hardenedDeployment, helperSpawn } from "../../chief/hardened.js";
import { resolveClaudeBin } from "../../defaults.js";
import { names } from "../../names.mjs";
import { CLONE_NO_HELPER, cloneFolders, isClone, ownFolderProblem } from "../agentclone.js";
import { ensureSessionAsAgent } from "../sessionread.js";
import { readPlanAsAgent } from "../tasksread.js";

// Build the argv for an interactive `claude` PTY session from a preset.
// Interactive mode (no -p) starts the TUI; a trailing positional prompt is
// submitted as the first user turn. (If a future CLI version stops
// auto-submitting the positional in interactive mode, the fallback is to spawn
// without it and write `prompt + "\r"` to the PTY once ready — see terminal.ts.)
export function buildClaudeArgs(preset: Preset, opts: ArgOpts = {}): string[] {
  const args: string[] = [];
  if (preset.model) args.push("--model", preset.model);
  if (preset.effort) args.push("--effort", preset.effort);
  if (preset.systemPrompt) args.push("--append-system-prompt", preset.systemPrompt);
  args.push("--dangerously-skip-permissions");
  if (opts.promptSnapshotOff) args.push("--system-prompt-snapshot", "off");
  if (opts.settingsPath) args.push("--settings", opts.settingsPath);
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.prompt && opts.prompt.trim()) args.push(opts.prompt);
  return args;
}

// Worktree agents keep their settings inside the worktree (cleaned up with it);
// workspace agents share one cwd, so each gets a private per-id file to avoid
// clobbering each other's hook token. The masters have their own private cwd.
export function claudeHooksPath(rec: AgentRecord, workspaceDir: string): string {
  const n = names();
  if (isPersistentKind(rec.kind)) return join(rec.worktree, n.hooksFile);
  // Strong protection (design B): never in the agent's own clone; a console folder that the
  // agents may read (agentclone.ts), checked in prepare() before the write.
  if (isClone(rec)) {
    const f = cloneFolders();
    if (!f) throw new Error(CLONE_NO_HELPER);
    return join(f.settings, `${rec.id}.json`);
  }
  if (!rec.repo) return join(workspaceDir, n.agentsFolder, rec.id, n.hooksFile);
  return join(rec.worktree, n.hooksFile);
}

// Transcripts live under the DEFAULT config dir whatever account an agent runs
// under: a named account's dir shadows `projects/` with a symlink back here
// (accounts.ts), which is what keeps `--resume` working across a switch.
function claudeProjectsRoot(): string {
  return join(accountPaths().defaultDir, "projects");
}

// Claude Code stores each session transcript under
// ~/.claude/projects/<cwd with every '/' and '.' flattened to '-'>/<sessionId>.jsonl
export function claudeTranscriptPath(cwd: string, sessionId: string, root = claudeProjectsRoot()): string {
  const project = cwd.replace(/[/.]/g, "-");
  return join(root, project, `${sessionId}.jsonl`);
}

// Hardened (ruling F1): the Claude config dir an agent runs with, an agent-side
// dir (the agents' account's own), never the console's own CLAUDE_CONFIG_DIR or a
// named account. A persistent agent of the second account (chief/chiefaccount.ts)
// has that account's own: its own sign-in, never a copy of the workers'. Throws a
// [chief] error when it is unset or relative.
export function agentClaudeConfigDir(id: string, env: Record<string, string | undefined> = process.env): string {
  const key = runsAsChief(id, env) ? "AGENT_CHIEF_CLAUDE_CONFIG_DIR" : "AGENT_CLAUDE_CONFIG_DIR";
  const dir = env[key]?.trim() ?? "";
  if (dir === "" || !isAbsolute(dir)) {
    throw new Error(`[chief] ${id}: ${key} is not set to an absolute path; claude agents need it in a hardened deployment`);
  }
  return dir;
}

// The Claude env of an agent launch. Hardened: CLAUDE_CONFIG_DIR is always
// AGENT_CLAUDE_CONFIG_DIR (a named account is not used: one log line).
// Otherwise the account's env, as before (empty for the default account).
export function claudeAgentEnv(rec: AgentRecord, paths?: AccountPaths): Record<string, string> {
  if (!helperSpawn()) return claudeAccountEnv(rec.account, paths);
  const dir = agentClaudeConfigDir(rec.id);
  if (!isDefaultAccount(rec.account)) {
    console.warn(`[chief] ${rec.id}: account ${rec.account} is not used in a hardened deployment; the agent runs with AGENT_CLAUDE_CONFIG_DIR`);
  }
  return { CLAUDE_CONFIG_DIR: dir };
}

// Make the session's transcript reachable from `cwd` so `claude --resume`
// launched there can find it. A session that used EnterWorktree (or otherwise
// moved cwd) gets its transcript filed under the NEW cwd's project dir — so a
// resume from the agent's own worktree would cold-start despite the full
// conversation sitting on disk. Search every project dir for the session and
// hard-link it into place (same inode, so the resumed session's appends stay
// visible at both paths); the sidecar dir (subagent transcripts) rides along
// as a symlink. Returns whether the transcript is reachable from `cwd`.
// Hardened (ruling F1): the projects root is an agent's Claude dir, where a
// planted symlink would make the console's link or copy write an
// attacker-chosen file; only the existence check runs (one log line).
export async function ensureTranscriptAt(
  cwd: string, sessionId: string, root = claudeProjectsRoot(),
): Promise<boolean> {
  const want = claudeTranscriptPath(cwd, sessionId, root);
  if (existsSync(want)) return true;
  // With strong protection the console never looks or links in an agent's Claude folder: the
  // helper does it as the agent (canResumeAsAgent).
  if (helperSpawn()) return false;
  let projects: string[];
  try { projects = await readdir(root); } catch { return false; }
  for (const project of projects) {
    const src = join(root, project, `${sessionId}.jsonl`);
    if (!existsSync(src)) continue;
    try {
      await mkdir(dirname(want), { recursive: true });
      try { await link(src, want); }
      catch { await copyFile(src, want); } // cross-device or exotic fs: copy
    } catch { return false; }
    const sideSrc = join(root, project, sessionId);
    const sideDst = join(dirname(want), sessionId);
    if (existsSync(sideSrc) && !existsSync(sideDst)) {
      try { await symlink(sideSrc, sideDst); } catch { /* optional extra */ }
    }
    return true;
  }
  return false;
}

// With strong protection: "present" or "linked" resumes, "absent" starts a new session quietly
// (as today). A failure of the helper is not "absent": one more try, then a new session with a
// log line that names the helper's own line (the conversation is not lost on disk: a later
// relaunch can still resume it).
export async function canResumeAsAgent(rec: AgentRecord, cwd: string, o: { tries?: number; log?: (s: string) => void } = {}): Promise<boolean> {
  if (!rec.sessionId) return false;
  let root: string;
  try { root = join(agentClaudeConfigDir(rec.id), "projects"); } catch { return false; }
  const want = claudeTranscriptPath(cwd, rec.sessionId, root);
  let why = "";
  for (let i = 0; i < (o.tries ?? 2); i++) {
    try { return shouldResume(rec, (await ensureSessionAsAgent(want)) !== "absent"); }
    catch (e) { why = (e as Error).message; }
  }
  (o.log ?? ((s: string) => console.warn(s)))(`[chief] ${rec.id}: the session ${rec.sessionId} could not be checked through the helper (${why}); it starts a new session`);
  return false;
}

// Resume with the full conversation only when we have a captured session id AND
// its transcript file is still on disk — `claude --resume <id>` exits nonzero if
// the transcript is missing, so we cold-start (worktree diffs preserved) instead.
export function shouldResume(rec: AgentRecord, transcriptExists: boolean): boolean {
  return Boolean(rec.sessionId) && transcriptExists;
}

export const claudeRuntime: AgentRuntime = {
  id: "claude",

  bin: () => resolveClaudeBin(),

  async prepare(rec, ctx: PrepareCtx): Promise<PrepareResult> {
    // Hardened (ruling F1): AGENT_CLAUDE_CONFIG_DIR or a refusal, before any write.
    if (helperSpawn()) agentClaudeConfigDir(rec.id);
    // An agent with its own clone starts only through the helper, as the agent: never as the
    // console's user in a folder that the agent writes (a failed probe keeps direct dtach).
    if (isClone(rec) && !helperSpawn()) throw new Error(`[chief] ${rec.id}: ${CLONE_NO_HELPER}`);
    const settingsPath = claudeHooksPath(rec, ctx.workspaceDir);
    if (isClone(rec)) {
      const why = await ownFolderProblem(dirname(settingsPath));
      if (why) throw new Error(`[chief] ${rec.id}: the hook settings folder is refused: ${why}`);
    } else await mkdir(dirname(settingsPath), { recursive: true });
    const settings = JSON.stringify(buildHookSettings({ agentId: rec.id, token: rec.hookToken, port: ctx.port }));
    // Hardened (ruling 2c-7-a): the worktree or home is agent-writable, so a
    // planted symlink or hard link there is refused, never written through.
    // A persistent agent of the second account: mode 0640, so only the console and
    // that account's group read its token (the workers are not in that group).
    if (hardenedDeployment()) await writeFileNoFollow(settingsPath, settings, runsAsChief(rec.id) ? 0o640 : undefined);
    else await writeFile(settingsPath, settings);
    // Helper spawn: never a named account's shadow dir (ruling F1). A hardened
    // deployment with a failed probe keeps today's account env below.
    if (helperSpawn()) return { settingsPath, env: claudeAgentEnv(rec, ctx.accounts) };
    // A named account runs under its own CLAUDE_CONFIG_DIR. Refresh its shadow
    // dir first so it sees every shared entry (settings, plugins, transcripts);
    // the default account needs neither, and keeps env unset as before.
    const paths = ctx.accounts ?? accountPaths();
    if (!isDefaultAccount(rec.account)) await syncAccountDir(rec.account!, paths);
    // A lead's home is outside the trusted workspace dir: mark its cwd trusted
    // in the .claude.json of the config dir its env gives, or the TUI stops at
    // the folder-trust dialog. Never blocks the spawn (claude-trust.ts).
    // The same for the other homes that the console itself makes: the Coordinator's (it has no
    // tab where somebody would see the dialog) and the fleet master's (a new install).
    // A worker's folder is the user's: there the user answers the dialog in the agent's pane.
    // Hardened (ruling 2c-7-a): no write; the console never writes into agent-owned dirs.
    // Never for an agent's own clone (strong protection): the console writes no trust there.
    if (CONSOLE_HOME_KINDS.has(rec.kind ?? "") && !hardenedDeployment() && !isClone(rec)) {
      trustClaudeDir(claudeJsonPath(rec.account, paths), rec.cwd ?? (rec.repo ? rec.worktree : ctx.workspaceDir));
    }
    if (isDefaultAccount(rec.account)) return { settingsPath };
    return { settingsPath, env: claudeAccountEnv(rec.account, paths) };
  },

  buildArgs: buildClaudeArgs,

  hookToStatus,

  async canResume(rec, cwd) {
    // Helper spawn: the agent's transcripts are in its account's Claude folder (ruling F1), which
    // the console cannot look into; the helper checks the session file as that account, and links
    // it from another project folder of its own when the cwd changed (sessionread.ts).
    if (helperSpawn()) return canResumeAsAgent(rec, cwd);
    return shouldResume(
      rec,
      Boolean(rec.sessionId) && (await ensureTranscriptAt(cwd, rec.sessionId!)),
    );
  },

  // The agent's live harness task list (TaskCreate/TaskUpdate tools persist
  // one JSON per task under <its Claude folder>/tasks/<sessionId>/). Missing
  // session/dir/file is a normal state, never an error. The root arrives as a
  // dependency (see PlanCtx) rather than from the environment: nothing but a
  // caller should be able to repoint the Plan rail, and terminal.ts spreads
  // process.env into every agent child, so an ambient var would leak into them.
  // Strong protection: the folder is in the agent's own home (the Claude folder of its account:
  // agentClaudeConfigDir), which the console cannot read; the helper reads it as that account
  // (tasksread.ts). Otherwise the folder of the agent's own login (accounts.ts): Claude keeps
  // its tasks in the config folder that it runs with, and a login's `tasks` is a link to the
  // default login's folder only when that folder was there at the sync.
  async readPlan(rec, ctx): Promise<AgentTask[]> {
    if (!rec.sessionId) return [];
    if (!ctx?.tasksRoot && helperSpawn()) {
      let dir: string;
      try { dir = agentClaudeConfigDir(rec.id); } catch { return []; }
      return readPlanAsAgent(rec, dir);
    }
    const root = ctx?.tasksRoot ?? join(accountDir(rec.account), "tasks");
    const dir = join(root, rec.sessionId);
    let names: string[];
    try { names = (await readdir(dir)).filter((n) => !n.startsWith(".")); }
    catch { return []; }
    const tasks: AgentTask[] = [];
    for (const name of names) {
      let raw: string;
      try { raw = await readFile(join(dir, name), "utf8"); } catch { continue; }
      const t = parseTaskFile(raw);
      if (t) tasks.push(t);
    }
    return sortTasks(tasks);
  },
};
