// server/agents/spawn.ts
// The one launch path for a new agent. POST /api/agents and the issue
// dispatcher (server/issues/dispatch.ts) both call spawnAgent, so the
// worktree, record, hook settings and argv are built the same way for both.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionStore, AgentRecord, AgentRuntimeId } from "./store.js";
import type { TerminalManager } from "./terminal.js";
import type { EventHub } from "../events.js";
import { createWorktree, hardenedRefRefusal, startCommit, validBranchName } from "./worktree.js";
import { CLONE_CLAUDE_ONLY, agentClones, cloneFolders, cloneForAgent } from "./agentclone.js";
import { agentPrompt } from "./argv.js";
import { resolveWidgetsDataDir } from "../widgets/paths.js";
import { pick, isRuntimeId } from "./runtimes/index.js";
import type { Preset } from "./runtimes/types.js";
import { isAgentModel, MODEL_REFUSAL, startModel, type AgentModel } from "./model.js";
import { agentClaudeConfigDir, claudeHooksPath } from "./runtimes/claude.js";
import { discard } from "./reconcile.js";
import { listRepos, ensureBaseBranch, defaultBranch } from "./repos.js";
import { accountExists, isAccountId, listAccounts, preferredAccount, DEFAULT_ACCOUNT, type AccountPaths } from "./accounts.js";
import { loginUse, pickLogin } from "./loginuse.js";
import type { UsageResult } from "../usage.js";
import { chiefPromptFor } from "../chief/brain/prompt.js";
import { chiefActive, CHIEF_PROMPT_REV, agentIdentityEnv } from "../chief/paths.js";
import { resolveWorkspaceDir } from "../defaults.js";
import { headless } from "./headless/wiring.js";

// Sentinel the launcher sends for a "no repo" agent that runs at the workspace
// root. A blank/absent repo means the same thing.
export const WORKSPACE_REPO = "__workspace__";

export type SpawnDeps = {
  terminals: TerminalManager;
  store: SessionStore;
  hub: EventHub;
  workspaceDir: string;
  worktreeRoot: string;
  port: number;
  accounts?: AccountPaths;
  // The usage of each login (usage.ts usageWithin), for the pick of a login with room. Absent
  // (tests, a caller with no meter): the usual login, as before.
  usage?: () => UsageResult | null | Promise<UsageResult | null>;
};

// Env defaults in one place, so the agents API and server/index.ts (issue
// dispatcher) launch with identical settings.
export function makeSpawnDeps(d: {
  terminals: TerminalManager; store: SessionStore; hub: EventHub;
  workspaceDir?: string; worktreeRoot?: string; accounts?: AccountPaths; usage?: () => UsageResult | null | Promise<UsageResult | null>;
}): SpawnDeps {
  return {
    terminals: d.terminals, store: d.store, hub: d.hub, accounts: d.accounts, usage: d.usage,
    workspaceDir: d.workspaceDir ?? resolveWorkspaceDir(),
    worktreeRoot: d.worktreeRoot ?? process.env.AGENT_WORKTREE_ROOT ?? ".agent-worktrees",
    port: Number(process.env.PORT ?? 3000),
  };
}

export type SpawnRequest = {
  prompt?: string; repo?: string; baseBranch?: string; createFrom?: string; branch?: string;
  // `unknown`: these arrive from JSON on the wire and must be checked before use.
  runtime?: unknown; account?: unknown; model?: unknown;
  // Server-side only — the HTTP route never copies these from the request body.
  kind?: "issue"; issueId?: string; label?: string; spawnedBy?: string;
};

export type SpawnResult =
  // waitsLogin: no Claude login has room, so the agent has no session yet. It starts when a
  // login comes back (`until`, if known) or when the user moves it.
  | { ok: true; id: string; status: "running" | "idle"; waitsLogin?: { until: number | null }; startedOn?: { from: string; until: number | null } }
  | { ok: false; code: 400 | 500; error: string };

// Resolve the `account` a request names into a record value: undefined for
// the default (so default records stay byte-identical to pre-account ones),
// the id for a known named account, or an error string. Accounts are a Claude
// login; a Codex agent naming one is a mistake worth a 400, not a silent drop.
// `startedOn`: the default login had no room, so `account` is another login. `waits`: no login
// has room now: the agent must not start a session (it would stop at once).
export type ResolvedAccount = { account?: string; startedOn?: { from: string; until: number | null }; waits?: { until: number | null } };

export async function resolveAccount(
  want: unknown, runtimeId: AgentRuntimeId, accounts?: AccountPaths, usage?: () => UsageResult | null | Promise<UsageResult | null>,
): Promise<ResolvedAccount | { error: string }> {
  const wanted = typeof want === "string" ? want.trim() : want;
  if (wanted == null || wanted === "") {
    if (runtimeId !== "claude") return {};
    // No account named: the default login (the pick of the page, or the setting) when it exists.
    const pref = preferredAccount();
    const first = pref && await accountExists(pref, accounts) ? pref : DEFAULT_ACCOUNT;
    // When that login has no room (its plan or one model of it is at its limit) and another
    // one has room, the new agent starts there: it can work now. The default login stays the
    // default. No login has room: the agent waits (loginuse.ts pickLogin). Nothing known
    // about the usage: the default login, as before.
    const known = (await usage?.()) ?? null;
    const acct = (id: string): { account?: string } => (id === DEFAULT_ACCOUNT ? {} : { account: id });
    if (!known) return acct(first);
    const list = await listAccounts(accounts);
    const now = Date.now();
    const pick = pickLogin(first, list.filter((a) => a.loggedIn && a.id !== first).map((a) => a.id), (id) => loginUse(known, id, list.length, now));
    const nameOf = (id: string): string => { const a = list.find((x) => x.id === id); return a?.email ?? (id === DEFAULT_ACCOUNT ? "the main login" : id); };
    return {
      ...acct(pick.id),
      ...(pick.from ? { startedOn: { from: nameOf(pick.from.id), until: pick.from.until } } : {}),
      ...(pick.waits ? { waits: pick.waits } : {}),
    };
  }
  if (wanted === DEFAULT_ACCOUNT) return {};
  if (!isAccountId(wanted)) return { error: `invalid account: ${String(wanted).slice(0, 100)}` };
  if (runtimeId !== "claude") return { error: "accounts apply to Claude agents only" };
  if (!(await accountExists(wanted, accounts))) {
    // The caller (a lead with `agents spawn`) gets the ids it can name.
    const ids = (await listAccounts(accounts)).map((a) => a.id);
    return { error: `unknown account: ${wanted}. The logins are: ${ids.join(", ")}` };
  }
  return { account: wanted };
}

export async function spawnAgent(deps: SpawnDeps, req: SpawnRequest): Promise<SpawnResult> {
  const { terminals, store, hub, workspaceDir, worktreeRoot, port, accounts } = deps;
  const { prompt, repo, baseBranch, createFrom, branch: wantBranch } = req;

  // Resolve the runtime BEFORE any side effect: everything below this point
  // creates a worktree or a record, and a rejected request must leave neither.
  // Absent, null or blank means claude; anything else has to be a known id.
  const wantedRuntime = typeof req.runtime === "string" ? req.runtime.trim() : req.runtime;
  let runtimeId: AgentRuntimeId = "claude";
  if (wantedRuntime != null && wantedRuntime !== "") {
    if (!isRuntimeId(wantedRuntime)) {
      return { ok: false, code: 400, error: `unknown runtime: ${String(wantedRuntime).slice(0, 300)}` };
    }
    runtimeId = wantedRuntime;
  }
  // The model (model.ts): absent, null or blank means none; else one alias, for a Claude agent.
  const wantedModel = typeof req.model === "string" ? req.model.trim() : req.model;
  let model: AgentModel | undefined;
  if (wantedModel != null && wantedModel !== "") {
    if (!isAgentModel(wantedModel)) return { ok: false, code: 400, error: MODEL_REFUSAL };
    if (runtimeId !== "claude") return { ok: false, code: 400, error: "model is for a Claude agent only" };
    model = wantedModel;
  }
  // Hardened (final review C1): the caller's branch, base and start names are
  // plain ref text, checked before any git call. Not hardened: null.
  const refRefused = hardenedRefRefusal({
    branch: typeof wantBranch === "string" ? wantBranch.trim() : wantBranch, baseBranch, createFrom,
  });
  if (refRefused) return { ok: false, code: 400, error: refRefused };
  // Same rule for the account: settled before any side effect.
  const resolved = await resolveAccount(req.account, runtimeId, accounts, deps.usage);
  if ("error" in resolved) return { ok: false, code: 400, error: resolved.error };
  const account = resolved.account;
  // No login has room: the record is made, but no session starts now (it would stop at its
  // first answer). The agent starts when a login comes back, or when the user moves it.
  const waits = resolved.waits;

  const id = randomUUID();
  // Running only if we hand the CLI an initial prompt to work on; otherwise the
  // session launches idle, waiting for the first message.
  const initialStatus = (prompt ?? "").trim() && !waits ? "running" : "idle";
  // Chief of staff (spec §5.2): read once, so the record and the env agree.
  // Off, the record and the env are exactly as before.
  const chief = chiefActive();
  // The --model of the first start (model.ts startModel): the agent's own model, else the setting.
  const runModel = runtimeId === "claude" ? startModel({ kind: req.kind, model }, { fresh: true }) : undefined;
  const extra: Partial<AgentRecord> = {
    ...(req.kind ? { kind: req.kind } : {}),
    ...(req.issueId ? { issueId: req.issueId } : {}),
    ...(chief ? { chiefRev: CHIEF_PROMPT_REV } : {}),
    ...(req.spawnedBy ? { spawnedBy: req.spawnedBy } : {}),
    ...(resolved.startedOn && !waits ? { startedOn: resolved.startedOn } : {}),
    ...(waits ? { waitsLogin: { until: waits.until, prompt: prompt ?? "" } } : {}),
    // Kept until Claude takes it in (store.ts): a start before that sends it again.
    ...((prompt ?? "").trim() && !waits && runtimeId === "claude" ? { firstPrompt: prompt, firstPromptAt: Date.now() } : {}),
    // The model of this start (an agent that waits starts later: its start writes it).
    ...(runModel && !waits ? { runModel } : {}),
  };
  const wantedLabel = (req.label ?? "").trim();

  // A workspace agent (no repo, or the explicit sentinel) runs at the
  // workspace ROOT with no worktree, branch, or fork point.
  let record: AgentRecord;
  let cwd: string;
  if (!repo || repo === WORKSPACE_REPO) {
    const label = wantedLabel || (prompt ?? "").trim().slice(0, 50) || "workspace";
    cwd = workspaceDir;
    record = {
      id, label, repo: "", worktree: workspaceDir, branch: "", baseBranch: "",
      sessionId: null, hookToken: randomUUID(), status: initialStatus, createdAt: Date.now(),
      cwd, runtime: runtimeId, ...(account ? { account } : {}), ...(model ? { model } : {}), ...extra,
    };
  } else {
    const match = (await listRepos(workspaceDir)).find((r) => r.path === repo);
    if (!match) return { ok: false, code: 400, error: "unknown repo" };
    // Working branch: the name the user typed, or a generated `agent/<id8>`.
    // A named branch gets the id appended to its dir so two agents never collide.
    let branch = `agent/${id.slice(0, 8)}`;
    let dirName: string | undefined;
    const wanted = (wantBranch ?? "").trim();
    if (wanted) {
      const valid = validBranchName(wanted);
      if (!valid) return { ok: false, code: 400, error: "invalid branch name" };
      branch = valid;
      dirName = `${valid}-${id.slice(0, 8)}`;
    }
    let base: string;
    try {
      // No explicit base → the repo's default branch (main/master). Current HEAD
      // is the last resort.
      const wantedBase = baseBranch ?? (await defaultBranch(match.path)) ?? match.branch;
      // Hardened: a default base comes from refs an agent can write (origin/HEAD).
      const baseRefused = hardenedRefRefusal({ baseBranch: wantedBase });
      if (baseRefused) throw new Error(baseRefused);
      base = await ensureBaseBranch(match.path, wantedBase, createFrom);
    } catch (e) {
      return { ok: false, code: 400, error: e instanceof Error ? e.message : "base branch error" };
    }
    const repoName = match.path.split("/").filter(Boolean).pop() ?? match.path;
    const label = wantedLabel || (prompt ?? "").trim().slice(0, 50) || repoName;
    let wt: { path: string; branch: string };
    // Strong protection (design B, agentclone.ts): the agent's own clone, made as the agent.
    const x = agentClones();
    const folders = cloneFolders();
    if (x && folders && runtimeId !== "claude") return { ok: false, code: 400, error: CLONE_CLAUDE_ONLY };
    try {
      if (x && folders) {
        // The helper's repo-clone needs the agent's CLAUDE_CONFIG_DIR: the same value as its spawn.
        const claudeDir = agentClaudeConfigDir(id);
        const sha = await startCommit(match.path, base, branch);
        wt = { path: await cloneForAgent(x, folders, match.path, id, branch, sha, claudeDir), branch };
      } else wt = await createWorktree({ repo: match.path, baseBranch: base, branch, root: worktreeRoot, dirName });
    } catch (e) {
      // Most likely: the chosen branch is already checked out in another worktree.
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, code: 400, error: msg.slice(0, 300) };
    }
    cwd = wt.path;
    record = {
      id, label, repo: match.path,
      worktree: wt.path, branch: wt.branch, baseBranch: base,
      sessionId: null, hookToken: randomUUID(), status: initialStatus, createdAt: Date.now(),
      cwd, runtime: runtimeId, ...(account ? { account } : {}), ...(model ? { model } : {}), ...extra,
      ...(x && folders ? { clone: true as const } : {}),
    };
  }
  // AGENT_HEADLESS=1 (headless/wiring.ts): a worker runs as `claude -p` with a message stream.
  const hw = headless();
  // A headless worker keeps no first message (store.ts firstPrompt): undefined is not saved.
  if (hw?.eligible(record)) record = { ...record, host: "headless", firstPrompt: undefined, firstPromptAt: undefined };
  try {
    await store.save(record);
    if (waits) {
      hub.emitEvent({ type: "agent-status", agentId: id, status: initialStatus });
      return { ok: true, id, status: initialStatus, waitsLogin: { until: waits.until } };
    }
    const runtime = pick(record);
    // Every agent gets the widgets instruction; worktree agents also get the
    // shared-docs one (plus the issue prompt for kind "issue"). Computed once
    // so prepare() and buildArgs() carry the SAME prompt.
    const preset: Preset = { ...(runModel ? { model: runModel } : {}), systemPrompt: agentPrompt(record, resolveWidgetsDataDir(), await chiefPromptFor(record.kind, { repoDir: process.cwd() })) };
    const prepared = await runtime.prepare(record, {
      port, workspaceDir, systemPrompt: preset.systemPrompt, accounts,
    });
    const { settingsPath } = prepared;
    // The identity is merged into the runtime's env, never replacing it.
    const env = chief ? { ...(prepared.env ?? {}), ...agentIdentityEnv(record) } : prepared.env;
    if (record.host === "headless" && hw) {
      // The prompt is the first message of the stream, not an arg.
      const args = runtime.buildArgs(preset, { prompt: "", settingsPath, cwd, promptSnapshotOff: chief });
      await hw.launch(id, { cwd, args, command: runtime.bin(), env, settingsPath });
      await hw.first(id, prompt);
    } else {
      const args = runtime.buildArgs(preset, { prompt: prompt ?? "", settingsPath, cwd, promptSnapshotOff: chief });
      // persist: host the CLI in a detached dtach session so it survives a restart.
      const bin = runtime.bin();
      terminals.spawn({ id, cwd, args, command: bin, env, persist: true, helperLaunch: runtime.helperLaunch?.(bin, args, record) });
    }
  } catch (e) {
    // A failed prepare or spawn must not become a record that boot recovery
    // retries forever. Remove every side effect created for this launch.
    if (record.host === "headless" && hw) await hw.remove(id);
    else terminals.kill(id);
    if (record.repo) {
      try { await discard(record); } catch { /* best-effort cleanup */ }
    } else {
      await rm(dirname(claudeHooksPath(record, workspaceDir)), { recursive: true, force: true })
        .catch(() => { /* already gone */ });
    }
    await store.delete(id);
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 500, error: `agent launch failed: ${message.slice(0, 300)}` };
  }
  hub.emitEvent({ type: "agent-status", agentId: id, status: initialStatus });
  return { ok: true, id, status: initialStatus, ...(record.startedOn ? { startedOn: record.startedOn } : {}) };
}
