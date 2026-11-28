// server/agents/recovery.ts
// Self-healing agent recovery: resume/reconcile dead agents (restoring their
// full conversation via the runtime's resume path when the transcript survives).
import { startModel } from "./model.js";
import { isPersistentKind, type AgentRecord, type SessionStore } from "./store.js";
import type { TerminalManager } from "./terminal.js";
import { pick } from "./runtimes/index.js";
import { claudeAgentEnv, claudeRuntime } from "./runtimes/claude.js";
import type { Preset } from "./runtimes/types.js";
import { agentPrompt, type ChiefPromptOpts } from "./argv.js";
import { resolveWidgetsDataDir } from "../widgets/paths.js";
import { ensureChoiBotExcluded } from "./upload.js";
import { fleetMasterSystemPrompt } from "../master/prompt.js";
import { resolveMasterDataDir } from "../master/paths.js";
import { coordinatorSystemPrompt } from "../coordinator/prompt.js";
import { COORDINATOR_MODEL, resolveCoordinatorDataDir } from "../coordinator/paths.js";
import { resolveCronDataDir } from "../../bin/lib/cronspec.js";
import { loginInPlaceOf, type AccountPaths } from "./accounts.js";
import { chiefPromptFor } from "../chief/brain/prompt.js";
import { chiefActive, chiefPaths, resolveChiefDataDir, CHIEF_PROMPT_REV, agentIdentityEnv } from "../chief/paths.js";
import { AREA_RE, AreaStore } from "../chief/leads/areas.js";
import { leadSystemPrompt } from "../chief/leads/prompt.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isClone } from "./agentclone.js";
import type { ChiefWait } from "../chief/chiefwait.js";
import type { LoginHold } from "./loginhold.js";
import { hostOf } from "./host.js";
import { headless } from "./headless/wiring.js";

// The Claude transcript helpers moved into the Claude runtime adapter;
// re-exported here so existing imports keep working.
export { claudeTranscriptPath, ensureTranscriptAt, shouldResume } from "./runtimes/claude.js";

// Everything resumeAgent/reconcileAgents need, decoupled from the HTTP layer so
// both the boot reconciler and the resume endpoint can share one path (DRY).
export interface RecoveryCtx {
  terminals: TerminalManager;
  store: SessionStore;
  port: number;
  workspaceDir: string;
  // Where the Claude login dirs live (accounts.ts). Production omits it and the
  // runtime resolves it from the environment; tests aim it at a fixture.
  accounts?: AccountPaths;
  // CLAUDE-ONLY test seam, and named so. When both are provided they replace
  // the runtime's prepare() for writing per-agent hook settings — which is a
  // Claude-shaped job: a settings-file path plus a writer. Codex configures
  // itself through a whole generated CODEX_HOME (hook plugin, skills, trust
  // entries, an auth symlink) that has no path-plus-writer form, so a Codex
  // record must never come down here: it would launch against the user's real
  // ~/.codex with no hooks and no status reporting. resumeAgent enforces that
  // by ignoring these for any non-Claude runtime.
  //
  // Production leaves them unset (makeRecoveryCtx omits both, so the runtime
  // adapter handles it); fakes in tests stub them to keep resume logic
  // exercisable without touching the real filesystem.
  claudeHooksPathFor?: (rec: AgentRecord) => string;
  writeClaudeHookSettings?: (rec: AgentRecord, settingsPath: string) => Promise<void>;
  // The second account's sign-in (chief/chiefwait.ts): a persistent agent waits for it.
  chiefWait?: Pick<ChiefWait, "mayStart">;
  // The persistent agents that a "Sign out" stopped (agents/loginhold.ts): one waits until its
  // login is signed in again.
  loginHold?: Pick<LoginHold, "mayStart">;
}

// A master's identity lives in its system prompt, not its transcript, so it is
// re-applied on every relaunch (resume included). null = not a master.
async function masterPreset(rec: AgentRecord, chief?: ChiefPromptOpts): Promise<Preset | null> {
  const kind = rec.kind;
  if (kind === "fleet-master") {
    return { systemPrompt: fleetMasterSystemPrompt({
      repoDir: process.cwd(), masterDataDir: resolveMasterDataDir(), claudeBin: claudeRuntime.bin(),
      cronDataDir: resolveCronDataDir(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(chief ? { chief } : {}),
    }) };
  }
  // The Coordinator (server/coordinator): its narrow prompt and its own, cheaper model. It runs
  // only with the chief active (reconcile skips it otherwise).
  if (kind === "coordinator" && chief) {
    return {
      systemPrompt: coordinatorSystemPrompt({ dataDir: resolveCoordinatorDataDir(), claudeBin: claudeRuntime.bin(), chief }),
      ...(COORDINATOR_MODEL ? { model: COORDINATOR_MODEL } : {}),
    };
  }
  if (kind === "lead" && chief && rec.area !== undefined && !AREA_RE.test(rec.area)) {
    console.warn(`[chief] lead ${rec.id} has a bad area ${JSON.stringify(rec.area)}; using the worker prompt`);
    return null;
  }
  if (kind === "lead" && chief && rec.area) {
    // Reached only with the chief active (reconcile skips leads otherwise).
    const chiefDir = resolveChiefDataDir();
    const repos = (await new AreaStore(chiefPaths(chiefDir).areas, { exists: async () => true }).read())[rec.area]?.repos;
    const charter = await readFile(join(chiefPaths(chiefDir).leadsDir, rec.area, "charter.md"), "utf8").catch(() => "");
    return { systemPrompt: leadSystemPrompt({
      area: rec.area, charter, repos: Array.isArray(repos) ? repos : [], cli: chief.cli, brain: chief.brain, chiefDir,
    }) };
  }
  return null;
}

// Bring one agent back if it isn't already live. "alive" = the session survived
// (already tracked here, or a live dtach socket we reattached). Otherwise spawn
// a fresh runtime CLI, resuming its conversation when the transcript is intact
// ("resumed") or cold-starting in the worktree when it isn't ("cold").
// `prompt` is submitted as the first turn of the relaunched session (a new
// prompt sent to a stopped closed agent). It is not used when the session is
// still alive. With no `prompt`, a start with no session to resume sends the
// agent's kept first message (firstPrompt, store.ts): Claude never took it in.
export async function resumeAgent(
  rec: AgentRecord,
  ctx: RecoveryCtx,
  opts: { prompt?: string } = {},
): Promise<"resumed" | "cold" | "alive" | "waits"> {
  const t = hostOf(rec.id) ?? ctx.terminals;
  if (t.has(rec.id)) return "alive";
  if (await t.reattach(rec.id)) return "alive";
  // A headless worker (headless/wiring.ts) with the flag off: nothing is prepared or started.
  const hw = rec.host === "headless" ? headless() : null;
  if (rec.host === "headless" && !hw) throw new Error(`${rec.id} is a headless worker, and headless workers are off (AGENT_HEADLESS)`);
  // A persistent agent of the second account waits for that account's sign-in (chief/
  // chiefwait.ts): no session starts, and its record keeps its status.
  if (ctx.chiefWait && !(await ctx.chiefWait.mayStart(rec.id))) return "waits";
  // The same for a persistent agent that a sign-out stopped, until its login is signed in again.
  if (ctx.loginHold && !(await ctx.loginHold.mayStart(rec))) return "waits";

  // A console-made agent (the Coordinator, a lead, the fleet master) whose Claude login is
  // signed out starts on a login that works: nobody would see why it does nothing. A worker
  // keeps its login: its pane says that the login is signed out, and the user moves it.
  if (isPersistentKind(rec.kind)) {
    const next = await loginInPlaceOf(rec.account, ctx.accounts).catch(() => null);
    if (next) {
      console.warn(`[accounts] ${rec.id}: its Claude login ${rec.account ?? "default"} is signed out; it starts on ${next.account ?? "default"}`);
      await ctx.store.patch(rec.id, { account: next.account });
      rec = { ...rec, account: next.account };
    }
  }

  // Records carry their spawn dir; older ones don't, so infer it as before —
  // workspace agents run at the workspace root, repo agents in their worktree.
  const cwd = rec.cwd ?? (rec.repo ? rec.worktree : ctx.workspaceDir);
  const runtime = pick(rec);
  // Chief of staff (spec §5.2): read once, so the env and the status patch agree.
  const chief = chiefActive();
  const chiefPrompt: ChiefPromptOpts | undefined = await chiefPromptFor(rec.kind, { repoDir: process.cwd() });
  // A master's identity lives in its system prompt, not its transcript, so it
  // is re-applied on every relaunch (resume included). Computed BEFORE
  // prepare() so both it and buildArgs carry the same prompt — Claude delivers
  // it via --append-system-prompt, Codex via the generated AGENTS.md.
  // The master check stays first: a master never gets the widgets text.
  const preset: Preset = (await masterPreset(rec, chiefPrompt))
    ?? { systemPrompt: agentPrompt(rec, resolveWidgetsDataDir(), chiefPrompt) };
  let env: Record<string, string> | undefined;
  let settingsPath: string | undefined;
  // The seam is Claude-shaped (see RecoveryCtx) — every other runtime keeps its
  // own prepare(), whatever a caller passes.
  if (runtime.id === "claude" && ctx.claudeHooksPathFor && ctx.writeClaudeHookSettings) {
    settingsPath = ctx.claudeHooksPathFor(rec);
    await ctx.writeClaudeHookSettings(rec, settingsPath);
    // The seam skips the adapter's shadow-dir sync, but the account still has
    // to reach the child: an agent pinned to a login must not silently run
    // under the default one. Hardened: AGENT_CLAUDE_CONFIG_DIR (ruling F1).
    const accountEnv = claudeAgentEnv(rec, ctx.accounts);
    if (Object.keys(accountEnv).length) env = accountEnv;
  } else {
    ({ env, settingsPath } = await runtime.prepare(rec, {
      port: ctx.port, workspaceDir: ctx.workspaceDir, systemPrompt: preset.systemPrompt,
      accounts: ctx.accounts,
    }));
  }
  // Both branches above: the identity is merged into their env, never replacing it.
  if (chief) env = { ...(env ?? {}), ...agentIdentityEnv(rec) };

  // Worktrees created before the exclusion moved to creation time only get
  // .choibot/ excluded on their first screenshot upload — ensure it here too so
  // pre-existing agents that share docs never dirty their Changes rail.
  // Strong protection: an agent's own clone got its excludes when it was made (no git there).
  if (rec.repo && !isClone(rec)) {
    try {
      await ensureChoiBotExcluded(rec.worktree, rec.repo);
    } catch {
      /* cosmetic — never blocks a resume */
    }
  }

  const canResume = await runtime.canResume(rec, cwd);
  // A cold start of a Claude agent before its first turn: the task goes in again (a resume has
  // it in its session). Never for Codex or a headless worker (store.ts firstPrompt).
  const resend = opts.prompt === undefined && !canResume && runtime.id === "claude" && !hw && rec.firstPrompt !== undefined;
  const prompt = opts.prompt ?? (resend ? rec.firstPrompt : undefined);
  // The model (model.ts startModel), also on a resume: a resumed session keeps the model it was
  // saved on unless --model says another (code.claude.com/docs/en/model-config).
  const model = runtime.id === "claude" && !preset.model ? startModel(rec, { fresh: !canResume }) : undefined;
  // runModel: the model of this start (the --model passed). None passed (a resumed lead or master
  // session): the field stays, as the session goes on on the model it was saved on.
  const runModel = preset.model ?? model;
  // A headless worker (headless/wiring.ts) starts again headless; the prompt is its first message.
  if (hw) {
    const args = runtime.buildArgs(
      model ? { ...preset, model } : preset,
      { settingsPath, resume: canResume ? rec.sessionId! : undefined, cwd, promptSnapshotOff: chief },
    );
    await hw.launch(rec.id, { cwd, args, command: runtime.bin(), env, settingsPath });
    await ctx.store.patch(rec.id, { status: "idle", chiefRev: chief ? CHIEF_PROMPT_REV : undefined, ...(runModel ? { runModel } : {}) });
    await hw.first(rec.id, opts.prompt);
    return canResume ? "resumed" : "cold";
  }
  const args = runtime.buildArgs(
    model ? { ...preset, model } : preset,
    { settingsPath, resume: canResume ? rec.sessionId! : undefined, cwd, prompt, promptSnapshotOff: chief },
  );
  const bin = runtime.bin();
  ctx.terminals.spawn({ id: rec.id, cwd, args, command: bin, env, persist: true, helperLaunch: runtime.helperLaunch?.(bin, args, rec) });
  // Comes up idle, waiting for input; UserPromptSubmit flips it to running.
  // chiefRev rides in the same write: set when launched with the identity env,
  // cleared (undefined is dropped by JSON) when launched without it.
  await ctx.store.patch(rec.id, {
    status: "idle", chiefRev: chief ? CHIEF_PROMPT_REV : undefined, ...(runModel ? { runModel } : {}), ...(resend ? { firstPromptAt: Date.now() } : {}),
  });
  return canResume ? "resumed" : "cold";
}

// Move an agent to another Claude login. CLAUDE_CONFIG_DIR is read once at
// process start, so a live agent has to be relaunched: end its PTY, then bring
// it back through the normal resume path, which restores the conversation via
// `--resume` (the transcript is shared between account dirs — see accounts.ts).
// A dead agent just takes the new account; its next Resume uses it. The record
// is patched BEFORE the kill so the exit handler's own status patch (load+save
// of the whole record) can never overwrite the account with the old one.
export async function switchAccount(
  rec: AgentRecord,
  account: string | undefined,
  ctx: RecoveryCtx,
): Promise<"resumed" | "cold" | "patched"> {
  await ctx.store.patch(rec.id, { account });
  const next: AgentRecord = { ...rec, account };
  const t = hostOf(rec.id) ?? ctx.terminals;
  const live = t.has(rec.id) || (await hasPersistedSession(t, rec.id));
  if (!live) return "patched";
  t.kill(rec.id);
  if (!(await waitUntilGone(t, rec.id))) {
    // The old session would not end. Resuming now would just reattach it, still
    // on the old login, while the record claims the new one — say so instead.
    throw new Error("the running session did not end; try again");
  }
  const outcome = await resumeAgent(next, ctx);
  // "waits": the record has its new login; the session starts after the second sign-in.
  return outcome === "alive" || outcome === "waits" ? "patched" : outcome;
}

async function hasPersistedSession(terminals: Pick<RecoveryCtx["terminals"], "hasSession">, id: string): Promise<boolean> {
  return typeof terminals.hasSession === "function" ? terminals.hasSession(id) : false;
}

// kill() is asynchronous on both ends: the local PTY exits a beat later, and
// the dtach master (pkill'd) removes its socket when it goes. Spawning before
// both are gone would either throw ("terminal already exists") or `-A`ttach to
// the dying master. Bounded: a wedged session falls through and the spawn's
// own error surfaces instead of hanging the request. Resolves false on timeout.
export async function waitUntilGone(terminals: Pick<RecoveryCtx["terminals"], "has" | "hasSession">, id: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!terminals.has(id) && !(await hasPersistedSession(terminals, id))) {
      // Let the exit handler's status patch land before resume writes its own.
      await new Promise((r) => setTimeout(r, 150));
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Boot reconciliation: resume every dead, non-done agent that is not closed. A
// closed agent stays stopped until an explicit Reopen/Resume or a new prompt
// (closed.ts); boot never brings it back. One agent's failure
// must never abort the loop or crash boot, so each is wrapped in try/catch.
export async function reconcileAgents(
  ctx: RecoveryCtx,
): Promise<{ resumed: string[]; cold: string[]; alive: string[]; waits: string[]; failed: string[] }> {
  const out = {
    resumed: [] as string[],
    cold: [] as string[],
    alive: [] as string[],
    // Persistent agents that wait for the second sign-in (chief/chiefwait.ts): not failed.
    waits: [] as string[],
    failed: [] as string[],
  };
  for (const rec of await ctx.store.list()) {
    if (rec.status === "done" || rec.closedAt !== undefined) continue;
    // Leads and the Coordinator are chief features: with the flag off (or
    // misconfigured) such a record is never resumed.
    if ((rec.kind === "lead" || rec.kind === "coordinator") && !chiefActive(process.env)) continue;
    try {
      const r = await resumeAgent(rec, ctx);
      out[r].push(rec.id);
    } catch (e) {
      out.failed.push(rec.id);
      console.error(`[reconcile] ${rec.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(
    `[reconcile] resumed=${out.resumed.length} cold=${out.cold.length} alive=${out.alive.length} failed=${out.failed.length}`,
  );
  return out;
}
