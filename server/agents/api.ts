// server/agents/api.ts
import { reopenIfClosed, closeAgent } from "./closed.js";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { runGit } from "./git.js";

// Validate a directory name: no traversal, no separators.
function safeRepoName(n: string): string | null {
  const t = (n ?? "").trim();
  if (!t || t === "." || t === ".." || /[\\/]/.test(t) || !/^[\w.-]+$/.test(t)) return null;
  return t;
}
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPersistentKind, type SessionStore, type AgentRecord } from "./store.js";
import type { ChiefWait } from "../chief/chiefwait.js";
import type { TerminalManager } from "./terminal.js";
import type { EventHub } from "../events.js";
import { baseCommit, worktreeChangedFiles, worktreeGitState, discardFileInWorktree, worktreeHeadBranch, worktreeHeadLabel } from "./worktree.js";
import { pick } from "./runtimes/index.js";
import type { HookPayload } from "./runtimes/types.js";
import { claudeHooksPath } from "./runtimes/claude.js";
import { diffPatch, merge, discard } from "./reconcile.js";
import { listRepos, listBranches, defaultBranch, normalizeCloneUrl, cloneArgv } from "./repos.js";
import { workspaceChangedFiles, workspaceDiff, workspaceDiscardFile } from "./workspace.js";
import { saveAgentUpload, uploadExt, uploadFolderMissing, ALLOWED_TEXT, EXT_BY_TYPE, MAX_UPLOAD_BYTES, NO_UPLOAD_FOLDER } from "./upload.js";
import { resumeAgent, switchAccount, waitUntilGone, type RecoveryCtx } from "./recovery.js";
import { accessTokenFor, accountPaths, clearSignedOut, createAccount, deleteAccount, isAccountId, isDefaultAccount, isSignedOut, listAccounts, accountExists, loginInPlaceOf, markSignedOut, preferredAccount, setDefaultLogin, DEFAULT_ACCOUNT, type AccountInfo, type AccountPaths } from "./accounts.js";
import { logoutCommand, runLogout, type LogoutWhy } from "./claudelogout.js";
import { busyNow } from "../chief/relaunch.js";
import type { RunNow } from "../cron/running.js";
import { loginUse, type LoginUse } from "./loginuse.js";
import type { UsageResult } from "../usage.js";
import { resolveAppDataDir } from "../defaults.js";
import { ClaudeLogin, type ClaudeLoginDeps, type ClaudeLoginReason, type ClaudeLoginState } from "./claudelogin.js";
import type { LoginHold } from "./loginhold.js";
import { AgentLoginStatus, agentAuthCommand, agentLoginStatus, type AgentAuth } from "./agentlogin.js";
import { CLONE_DIFF_TOO_LARGE, CLONE_NO_GIT, CLONE_NO_HELPER, agentClones, cloneChangedFiles, cloneDiff, cloneExecOrRefuse, cloneGitState, dropCloneReads, isClone } from "./agentclone.js";
import { ACTOR_HEADER, FLEET_ACTOR } from "../master/acted.js";
import { CHIEF_ERR, gateMerge, gateRoute, gateUser, type ChiefGate } from "../chief/gate.js";
import { closeRefusal, LEAD_DELETE_REFUSAL, LEAD_RENAME_RULE, ownerRefusal } from "../chief/leads/close.js";
import { checkTitle } from "./title.js";
import { isAgentId } from "../widgets/paths.js";
import { spawnAgent, makeSpawnDeps, resolveAccount, WORKSPACE_REPO } from "./spawn.js";
import type { AreaStore } from "../chief/leads/areas.js";
import { hardenedDeployment } from "../chief/hardened.js";
import { readThreadAfter, readThreadBefore, sessionFileFor } from "./threadfile.js";
import { continueText, goOnText, readStopFile, type StopRead, type StopWhy } from "./stopwhy.js";
import { sendToAgent, typeIntoAgentWhy, withTypingLock } from "../issues/reply.js";
import type { GoOnResult, LimitAgents, LimitLogin } from "../chief/limit/service.js";
import { isSubagentId } from "./thread.js";
import { MAX_SUBAGENTS, hasLaterSubagents, newestWrite, openSubagentDir, subagentIdsOf, subagentStates } from "./subagents.js";
import { resolveWorkspaceDir } from "../defaults.js";
import { hostOf } from "./host.js";
import { HEADLESS_HELD, headless, headlessRemover, removeHeadless, stopHeadlessOff } from "./headless/wiring.js";

// Build a RecoveryCtx from the same deps registerAgentApi uses, so the boot
// reconciler (server/index.ts) and the resume endpoint share one launch path —
// single source of truth for cwd/hook-settings/argv (DRY). Per-agent config
// writing itself lives in the runtime adapters (pick(rec).prepare).
// One login as the page gets it.
// persistent: the second sign-in (chief/chiefaccount.ts), the login of the fleet master, the
// leads and the Coordinator; `waits`: the persistent agents that wait for it (chief/chiefwait.ts).
// userLogin: basic protection's main login, the Claude login of the server's own user (also of
// a terminal there): "Sign out" says so.
export type LoginView = AccountInfo & { use: LoginUse | null; agents: number; persistent?: true; waits?: string[]; userLogin?: true };
// The id of the second sign-in in the login routes (an id that no login of the console has).
export const PERSISTENT_LOGIN = "persistent";

// The state of the Claude login for the page: the time that is left, not a clock value.
export type ClaudeLoginView =
  | { state: "idle" }
  | { state: "starting" | "checking"; account: string }
  | { state: "waiting"; account: string; url: string; leftMs: number }
  | { state: "done"; account: string; email: string | null; plan: string | null }
  | { state: "failed"; account: string; reason: ClaudeLoginReason };

export function makeRecoveryCtx(deps: {
  terminals: TerminalManager;
  store: SessionStore;
  workspaceDir?: string;
  accounts?: AccountPaths;
  chiefWait?: RecoveryCtx["chiefWait"];
  loginHold?: RecoveryCtx["loginHold"];
}): RecoveryCtx {
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const port = Number(process.env.PORT ?? 3000);
  return {
    terminals: deps.terminals, store: deps.store, port, workspaceDir, accounts: deps.accounts,
    ...(deps.chiefWait ? { chiefWait: deps.chiefWait } : {}), ...(deps.loginHold ? { loginHold: deps.loginHold } : {}),
  };
}

export function registerAgentApi(
  app: FastifyInstance,
  deps: {
    terminals: TerminalManager;
    store: SessionStore;
    hub: EventHub;
    workspaceDir?: string;
    worktreeRoot?: string;
    // Where the Claude harness writes its per-session task files. Injected so
    // tests can aim /tasks at a fixture dir without an ambient env var; see
    // PlanCtx in runtimes/types.ts for why it is not one.
    tasksRoot?: string;
    // Where the Claude login dirs live (accounts.ts); production omits it and
    // the module resolves it from the environment.
    accounts?: AccountPaths;
    // The Claude login that the page starts (claudelogin.ts): tests give a fake program here.
    claudeLogin?: Partial<Omit<ClaudeLoginDeps, "paths" | "onDone">>;
    // A Claude login ended well: what depends on it is read again (the step list, the usage).
    onClaudeLogin?: (account: string) => void;
    // Strong protection with its helper ready (agentlogin.ts): the one Claude login is the
    // agents' own. The page makes it and reads it through the helper. Absent: as before.
    agentAuth?: AgentAuth;
    // The read of that login, kept for a short time (agentlogin.ts AgentLoginStatus; the server
    // shares it with the Set-up step). Default: a new one on `claude auth status` through the helper.
    agentStatus?: Pick<AgentLoginStatus, "read" | "forget">;
    // The second sign-in (chief/chiefaccount.ts): the persistent agents' own login, through
    // their own helper, with its own flow (a start for one login never stops the other's), and
    // the agents that wait for it. Absent: one login, as before.
    chiefAuth?: AgentAuth;
    chiefStatus?: Pick<AgentLoginStatus, "read" | "forget">;
    // `mayStart`: the sign-out of the second sign-in puts the agents it ended in the wait.
    chiefWait?: Pick<ChiefWait, "waits"> & Partial<Pick<ChiefWait, "mayStart">>;
    chiefLogin?: Partial<Omit<ClaudeLoginDeps, "paths" | "onDone">>;
    // The second sign-in ended well: what waits starts (index.ts).
    onChiefLogin?: () => void;
    // The usage that the console has now (usage.ts peekUsage): the use of each login and the
    // pick of a login with room for a new agent. Absent (tests): nothing is known.
    usage?: () => UsageResult | null;
    // The same for the pick of a login for a new agent: it can wait a short time for a new read
    // (usage.ts usageWithin), so the pick is not made from old numbers. Absent: `usage`.
    usageNow?: () => Promise<UsageResult | null>;
    // Does the agent wait for the user now (an open ticket of it that blocks, a question)? Then
    // the console does not tell it to go on after a move. Absent: no Queue, so never.
    waitsForUser?: (agentId: string) => Promise<boolean>;
    // The readiness check of a typed line (index.ts sets it from chiefActive), and a faster
    // clock for tests.
    checkReady?: boolean;
    sleep?: (ms: number) => Promise<void>;
    // Where the default login that the user picks is kept. Default: the console's data dir.
    defaultLoginFile?: string;
    // The relaunch of a lead or of the fleet master by the chief of staff (chief/relaunch.ts:
    // its inbox is held, nobody types into it meanwhile). "waits": it is busy now and is
    // relaunched when it is quiet. Absent: no chief of staff, so no such agent.
    relaunchPersistent?: (id: string) => Promise<"relaunched" | "waits" | "gone" | "failed">;
    // The ids whose relaunch waits for a quiet moment (chief/relaunch.ts RelaunchRetry.armed):
    // a lead or the fleet master that a move gave a new login still runs on its old one.
    relaunchWaits?: () => string[];
    // Is the agent busy now (chief/relaunch.ts busyNow: a half-typed line, new output, a draft
    // of the Master tab)? Default: the same check with no draft.
    agentBusy?: (rec: AgentRecord) => boolean;
    // The Recurring runs in progress now and their logins (cron/running.ts). Absent: none.
    recurringRuns?: () => Promise<RunNow[]>;
    // The persistent agents that a sign-out stopped wait for a login (agents/loginhold.ts); the
    // starts of what waited (chief/chiefwait.ts startWaited), when a login is signed in again.
    loginHold?: Pick<LoginHold, "hold" | "release" | "mayStart" | "releaseAll" | "waitsFor">;
    startPersistent?: (ids: string[]) => Promise<void>;
    // The ids that a sign-out ends in silence (agents/exit.ts `quiet`), shared with the exit
    // handler. Absent (tests): a set of its own.
    quietExits?: Set<string>;
    // Where Claude files its session transcripts (<config dir>/projects), for
    // the thread reader. Injected for tests, like tasksRoot; production omits it.
    projectsRoot?: string;
    // The fleet master's act log (server/master/acted.ts). Production passes it;
    // tests may omit it.
    acted?: { mark(id: string): void };
    // Agent widgets (server/widgets/store.ts): delete removes the agent's
    // widget folder. Tests may omit it.
    widgets?: { removeAgent(id: string): Promise<void> };
    // Chief of staff gate. When set, hookToken is shown only to the paired user
    // and the local merge takes the merge gate (spec §7).
    chief?: ChiefGate;
    // Lead areas (spec §13), with an active chief only: a lead spawns only in
    // its area's repos. Without it a lead spawns nothing (fails closed).
    areas?: Pick<AreaStore, "read">;
    // The id of one queue item of the agent that still waits for the user, or
    // null (chief/leads/close.ts openItemOf), with an active chief only: a lead
    // does not close a worker that has one. Without it a lead closes nothing.
    openQueueItem?: (agentId: string) => Promise<string | null>;
  },
): { removeAgent: (id: string) => Promise<void>; checkWaiting: () => Promise<void>; limitOps: LimitAgents } {
  const { terminals, store, hub, accounts } = deps;
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const spawnDeps = makeSpawnDeps({ terminals, store, hub, workspaceDir, worktreeRoot: deps.worktreeRoot, accounts, usage: deps.usageNow ?? deps.usage });

  // A workspace agent runs at the workspace root with no repo/branch/worktree.
  const isWorkspace = (rec: { repo: string }): boolean => !rec.repo;

  // The masters (cron, fleet) are agent records, but not workers: each owns no
  // repo and no disposable worktree (its "worktree" is its own agent home dir).
  // Their empty `repo` would otherwise make them look like workspace agents, so
  // every repo-shaped route has to reject them explicitly.
  const isMaster = (rec: { kind?: string }): boolean => isPersistentKind(rec.kind);
  const MASTER_NA = { error: "not applicable to a master agent" };

  // Shared launch context (port + workspace dir, resume path) reused by the
  // resume endpoint and the boot reconciler. Hook-settings placement lives in
  // the runtime adapter (claudeHooksPath / pick(rec).prepare).
  // The waits for a login (the second sign-in, a sign-out's hold) also hold the starts of the
  // routes (resume, a move), not only those of the boot and of the ensures.
  const chiefMayStart = deps.chiefWait?.mayStart?.bind(deps.chiefWait);
  const recoveryCtx = makeRecoveryCtx({
    terminals, store, workspaceDir, accounts,
    ...(chiefMayStart ? { chiefWait: { mayStart: chiefMayStart } } : {}), ...(deps.loginHold ? { loginHold: deps.loginHold } : {}),
  });

  // A stop/resume/delete sent by the fleet master's CLI is marked BEFORE its
  // agent-status event, so the master's event queue can drop its own echo.
  const markActed = (req: FastifyRequest, id: string): void => {
    if (req.headers[ACTOR_HEADER] === FLEET_ACTOR) deps.acted?.mark(id);
  };

  // If the worktree sits on a real branch other than the one we recorded, adopt
  // it: the agent now tracks the branch actually checked out, so the git-state
  // bar stops warning and merge targets the right branch. No-op when detached or
  // already in sync, so it only writes on the (rare) transition.
  async function adoptLiveBranch(rec: AgentRecord): Promise<AgentRecord> {
    // Strong protection: no git and no read in an agent's own clone; the record's branch stays.
    if (isClone(rec)) return rec;
    const head = await worktreeHeadBranch(rec.worktree, rec.repo);
    if (head && head !== rec.branch) {
      await store.patch(rec.id, { branch: head });
      return { ...rec, branch: head };
    }
    return rec;
  }

  // Raw-buffer parser for uploads — one file per request. An image comes as
  // its own content-type, another file as application/octet-stream (the route
  // checks its ?ext= against a fixed list). parseAs:"buffer" hands the route a Buffer.
  app.addContentTypeParser(
    [...Object.keys(EXT_BY_TYPE), "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  // List agents, each enriched with the branch its worktree is actually on right
  // now (live HEAD) so the sidebar shows where HEAD is, not just the recorded
  // branch. `head` is null when the worktree is detached or missing.
  // The fleet master and the leads are filtered out: the sidebar shows them
  // in their own rows (fetched by id there).
  // Rail order: dragged agents by `order`, the rest after them by createdAt
  // (store.list() is already createdAt-sorted and the sort is stable).
  // With chief on, hookToken is hidden unless the caller is the paired user
  // (always hidden in misconfigured mode). Works on a copy.
  const stripToken = async (req: FastifyRequest): Promise<boolean> =>
    !!deps.chief && (deps.chief.misconfigured !== null || (await deps.chief.caller(req)).level !== "user");
  const withoutToken = <T extends { hookToken?: string }>(r: T): Omit<T, "hookToken"> => {
    const { hookToken: _t, ...rest } = r;
    return rest;
  };
  // A record as a page gets it: the first message of an agent that waits for a login stays on
  // the server (the page needs only "it waits" and the time); so does the kept first message.
  const forPage = <T extends { waitsLogin?: { until: number | null; prompt: string }; firstPrompt?: string; firstPromptAt?: number }>(r: T): T => {
    const { firstPrompt: _f, firstPromptAt: _fa, ...rest } = r;
    return (rest.waitsLogin ? { ...rest, waitsLogin: { until: rest.waitsLogin.until } } : rest) as unknown as T;
  };

  app.get("/api/agents", async (req: FastifyRequest) => {
    const strip = await stripToken(req);
    const recs = (await store.list()).filter((r) => !isMaster(r))
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    const sessions = await Promise.all(
      recs.map(async (r) => ({ ...forPage(strip ? withoutToken(r) : r), head: isClone(r) ? r.branch : await worktreeHeadLabel(r.worktree, r.repo) })),
    );
    return { sessions };
  });
  app.get("/api/repos", async () => ({ repos: await listRepos(workspaceDir) }));

  // Branches of a known workspace repo, for the launcher's branch picker.
  app.get("/api/repos/branches", async (req: FastifyRequest, reply: FastifyReply) => {
    const repo = (req.query as { repo?: string }).repo ?? "";
    const match = (await listRepos(workspaceDir)).find((r) => r.path === repo);
    if (!match) return reply.code(400).send({ error: "unknown repo" });
    const { local, remote } = await listBranches(match.path);
    // `defaultBranch`: the repo's default (origin/HEAD → main/master) — the
    // launcher preselects it so new agents fork from the mainline, not from
    // whatever happens to be checked out locally. `current` (the checkout) is
    // kept as the fallback when no default exists.
    return { local, remote, current: match.branch, defaultBranch: await defaultBranch(match.path) };
  });

  // The Settings actions (add a repo, add or delete a Claude login): with chief on, the paired
  // user only. gateUser refuses every agent header (a worker, a lead, the masters). Flag off: open
  // as before. Returns false once the reply is sent.
  const userOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> =>
    !deps.chief || (await gateUser(deps.chief, req, reply)) !== null;

  // Clone (if `url`) or init (if only `name`) a repo into the workspace, then
  // return the new repo entry so the launcher's picker can pick it up.
  app.post("/api/repos", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const { url, name } = (req.body as { url?: string; name?: string }) ?? {};
    // derive the target dir name: explicit name wins, else from the URL's last segment.
    let dir = name?.trim();
    if (!dir && url) dir = url.trim().replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
    const safe = safeRepoName(dir ?? "");
    if (!safe) return reply.code(400).send({ error: "invalid repo name" });
    const dest = join(workspaceDir, safe);
    if (existsSync(dest)) return reply.code(409).send({ error: "a folder with that name already exists" });
    try {
      // execFile via runGit (NO shell): `url` is an argv element, so no shell-injection risk.
      // Rewrite bare GitHub HTTPS URLs to SSH so private-repo clones use the SSH
      // key rather than failing on a missing username prompt.
      // A hardened deployment clones a network url only, after "--" (cloneArgv).
      if (url && url.trim()) {
        const argv = cloneArgv(normalizeCloneUrl(url), dest);
        if (!argv) return reply.code(400).send({ error: "clone url must be https://, ssh:// or user@host:path" });
        await runGit(dest, argv, { timeout: 180000 });
      } else await runGit(dest, ["init", dest], { timeout: 15000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: msg.slice(0, 400) });
    }
    const repo = (await listRepos(workspaceDir)).find((r) => r.path === dest);
    return reply.code(201).send({ ok: true, repo });
  });

  // The Claude logins on this box. Default first; `label` is the email once the
  // account has logged in, else its id. A brand-new account shows loggedIn:false
  // until the user logs in to it from the page (the login routes below).
  // `use`: how much of its plan the login has used, and if it is at its limit (null: not
  // known). `agents`: the agents on it that are not closed.
  const loginsView = async (): Promise<LoginView[]> => {
    // Strong protection: one login, the agents' own, as Claude Code says it through the helper.
    if (agentStatus) {
      const who = await agentStatus.read();
      const openRecs = (await store.list()).filter((r) => r.closedAt === undefined && (r.runtime ?? "claude") === "claude");
      // With the second sign-in, the persistent agents are on it, not on the first.
      const second = deps.chiefStatus;
      const rows: LoginView[] = [{ id: DEFAULT_ACCOUNT, label: who.email ?? DEFAULT_ACCOUNT, email: who.email, loggedIn: who.loggedIn, isDefault: true, use: null,
        agents: openRecs.filter((r) => !second || !isPersistentKind(r.kind)).length }];
      if (second) {
        const w = await second.read();
        rows.push({ id: PERSISTENT_LOGIN, label: w.email ?? PERSISTENT_LOGIN, email: w.email, loggedIn: w.loggedIn, isDefault: false, use: null,
          agents: openRecs.filter((r) => isPersistentKind(r.kind)).length, persistent: true, waits: deps.chiefWait?.waits() ?? [] });
      }
      return rows;
    }
    const list = await listAccounts(accounts);
    const usage = deps.usage?.() ?? null;
    const now = Date.now();
    const open = (await store.list()).filter((r) => r.closedAt === undefined && (r.runtime ?? "claude") === "claude");
    return list.map((a) => ({
      ...a,
      use: a.loggedIn ? loginUse(usage, a.id, list.length, now) : null,
      agents: open.filter((r) => (r.account ?? DEFAULT_ACCOUNT) === a.id).length,
      ...(a.isDefault ? { userLogin: true as const } : {}),
    }));
  };
  app.get("/api/accounts", async () => ({ accounts: await loginsView(), preferred: preferredAccount() ?? DEFAULT_ACCOUNT }));

  // "Make default": the login that new agents start on. Kept by the console, so no setting
  // of the server is edited by hand. Agents that run keep their login.
  const defaultLoginFile = deps.defaultLoginFile ?? join(resolveAppDataDir(), "default-login.json");
  app.post("/api/accounts/default", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const id = (req.body as { id?: unknown } | null)?.id;
    if (!isAccountId(id)) return reply.code(400).send({ error: "invalid account" });
    if (!isDefaultAccount(id) && !(await accountExists(id, accounts))) return reply.code(404).send({ error: "not found" });
    try {
      await setDefaultLogin(id, defaultLoginFile);
    } catch {
      return reply.code(500).send({ error: "Your server did not save the default login." });
    }
    return { preferred: preferredAccount() ?? DEFAULT_ACCOUNT };
  });

  app.post("/api/accounts", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    if (agentAuth) return reply.code(409).send({ error: "On this console the agents have one Claude login: the default one." });
    const want = (req.body as { id?: unknown } | null)?.id;
    const id = typeof want === "string" ? want.trim().toLowerCase() : want;
    if (!isAccountId(id)) {
      return reply.code(400).send({ error: "account id: lowercase letters, digits, - or _, max 32" });
    }
    if (isDefaultAccount(id)) return reply.code(400).send({ error: "that is the default account" });
    if (await accountExists(id, accounts)) return reply.code(409).send({ error: "account already exists" });
    try {
      return reply.code(201).send({ account: await createAccount(id, accounts) });
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : "create failed" });
    }
  });

  // Remove a login dir. Refused while any agent record still points at it —
  // resuming such an agent would otherwise recreate the dir logged out.
  app.post("/api/accounts/:id/delete", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const { id } = req.params as { id: string };
    if (!isAccountId(id)) return reply.code(400).send({ error: "invalid account" });
    if (isDefaultAccount(id)) return reply.code(400).send({ error: "cannot delete the default account" });
    if (!(await accountExists(id, accounts))) return reply.code(404).send({ error: "not found" });
    const users = (await store.list()).filter((r) => r.account === id);
    if (users.length) {
      return reply.code(409).send({ error: `in use by ${users.length} agent${users.length > 1 ? "s" : ""} — switch or delete them first` });
    }
    await deleteAccount(id, accounts);
    return reply.code(202).send({});
  });

  // ---- the Claude login of an account, from the page (claudelogin.ts) ----
  // The paired user only, as each action on a login. The answers never hold the code or a token.
  const agentAuth = deps.agentAuth;
  const agentStatus = deps.agentStatus ?? (agentAuth ? new AgentLoginStatus(() => agentLoginStatus(agentAuth)) : undefined);
  const claudeLogin = new ClaudeLogin({
    ...(agentAuth ? { command: (sub: "login" | "status") => agentAuthCommand(agentAuth, sub) } : {}),
    ...deps.claudeLogin, paths: accounts ?? accountPaths(),
    // A new login: the kept answer of the old state goes.
    onDone: (a) => { agentStatus?.forget(); deps.onClaudeLogin?.(a); void startHeld(); },
  });
  app.addHook("onClose", async () => claudeLogin.stop());
  // The second sign-in's own flow, through its own helper (never the first one's).
  const chiefAuth = deps.chiefAuth;
  const chiefLogin = chiefAuth ? new ClaudeLogin({
    command: (sub: "login" | "status") => agentAuthCommand(chiefAuth, sub),
    ...deps.chiefLogin, paths: accounts ?? accountPaths(),
    onDone: () => { deps.chiefStatus?.forget(); deps.onChiefLogin?.(); },
  }) : null;
  if (chiefLogin) app.addHook("onClose", async () => chiefLogin.stop());
  // The flow of a login: the second sign-in's for its id, else the first. The second sign-in
  // with no flow of its own (asked for, not ready): null, and the route refuses: a code or a
  // cancel for it never reaches the first login's flow.
  const NOT_READY = "The second sign-in is not ready on this console yet.";
  const flowOf = (account: unknown): ClaudeLogin | null => (account === PERSISTENT_LOGIN ? chiefLogin : claudeLogin);
  const accountOf = (req: FastifyRequest): unknown => (req.body as { account?: unknown } | null)?.account ?? (req.query as { account?: unknown } | null)?.account;
  const loginView = (st: ClaudeLoginState): ClaudeLoginView =>
    st.state === "waiting" ? { state: "waiting", account: st.account, url: st.url, leftMs: Math.max(0, st.expiresAt - Date.now()) } : st;

  app.get("/api/accounts/login", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const flow = flowOf(accountOf(req));
    if (!flow) return reply.code(409).send({ error: NOT_READY });
    return loginView(flow.state());
  });

  // Start the login of one account (or get the link of the one that waits). `fresh`: a new link.
  app.post("/api/accounts/:id/login", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const { id } = req.params as { id: string };
    if (!isAccountId(id)) return reply.code(400).send({ error: "invalid account" });
    // The second sign-in: its own flow, only where it is asked for and its helper is ready.
    if (id === PERSISTENT_LOGIN && hardenedDeployment()) {
      if (!chiefLogin) return reply.code(409).send({ error: NOT_READY });
      return loginView(await chiefLogin.start(id, { fresh: (req.body as { fresh?: unknown } | null)?.fresh === true }));
    }
    if (!isDefaultAccount(id) && !(await accountExists(id, accounts))) return reply.code(404).send({ error: "not found" });
    // There the agents run as their own user with their own login: a login of the console's user is
    // not theirs. With the helper ready, the page makes that one login (the default one).
    if (hardenedDeployment()) {
      if (!agentAuth) return reply.code(409).send({ error: "On this console the agents have their own Claude login. It is set up on the server, not from this page." });
      if (!isDefaultAccount(id)) return reply.code(409).send({ error: "On this console the agents have one Claude login: the default one." });
    }
    const fresh = (req.body as { fresh?: unknown } | null)?.fresh === true;
    return loginView(await claudeLogin.start(id, { fresh }));
  });

  app.post("/api/accounts/login/code", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const code = (req.body as { code?: unknown } | null)?.code;
    // The code goes to the flow of ITS login only (the body names it; none: the first login).
    const target = flowOf(accountOf(req));
    if (!target) return reply.code(409).send({ error: NOT_READY });
    const r = target.submit(typeof code === "string" ? code.trim() : "");
    if (r.state === "refused") {
      return r.why === "bad-code"
        ? reply.code(400).send({ error: "This does not look like the code of the Claude page. Copy the whole code and paste it again." })
        : reply.code(409).send({ error: "This sign-in link is not open any more. Press New link." });
    }
    return loginView(r);
  });

  // The user closed the form, or read the result.
  app.post("/api/accounts/login/cancel", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const flow = flowOf(accountOf(req));
    if (!flow) return reply.code(409).send({ error: NOT_READY });
    flow.stop();
    flow.clear();
    (flow === claudeLogin ? agentStatus : deps.chiefStatus)?.forget();
    return loginView(flow.state());
  });

  // Why a lead may not spawn in `repo`, or null (spec §13): only in a repo whose
  // basename its area's `repos` lists (the area is the lead record's own). No
  // repo is a workspace agent, never a lead's. spawnAgent then needs `repo` to
  // be exactly a workspace repo's path, so its basename is that repo's name.
  async function leadSpawnRefusal(leadId: string | undefined, repo: unknown): Promise<string | null> {
    if (!repo || repo === WORKSPACE_REPO) return "a lead spawns only in its area's repos";
    const area = leadId ? (await store.load(leadId))?.area : undefined;
    const repos = area && deps.areas ? (await deps.areas.read())[area]?.repos ?? [] : [];
    return typeof repo === "string" && repos.includes(basename(repo)) ? null : "repo outside the lead's area";
  }

  app.post("/api/agents", async (req: FastifyRequest, reply: FastifyReply) => {
    const { prompt, repo, baseBranch, createFrom, branch, runtime, account, model, title } =
      (req.body as {
        prompt?: string; repo?: string; baseBranch?: string;
        createFrom?: string; branch?: string; runtime?: unknown; account?: unknown; model?: unknown; title?: unknown;
      }) ?? {};
    // kind/issueId/spawnedBy are server-side only — never taken from the
    // body. With chief on, spawnedBy is the calling agent's own id (spec §13).
    // The label is the checked `title` (title.ts) of the caller that may spawn; none: the
    // fallback of spawn.ts.
    let label: string | undefined;
    if (title !== undefined) {
      const t = checkTitle(title);
      if ("error" in t) return reply.code(400).send({ error: t.error });
      label = t.title;
    }
    let spawnedBy: string | undefined;
    if (deps.chief) {
      const caller = await deps.chief.caller(req);
      if (caller.agentId && (caller.level === "master" || caller.level === "lead" || caller.level === "agent")) {
        spawnedBy = caller.agentId;
      }
      // Before spawnAgent: a refused lead spawn leaves no worktree and no record.
      if (caller.level === "lead") {
        const refused = await leadSpawnRefusal(caller.agentId, repo);
        if (refused) return reply.code(403).send({ error: refused });
      }
    }
    const r = await spawnAgent(spawnDeps, { prompt, repo, baseBranch, createFrom, branch, runtime, account, model, ...(label ? { label } : {}), ...(spawnedBy ? { spawnedBy } : {}) });
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    // waitsLogin: no Claude login has room, the agent starts later. startedOn: it started on
    // another login than the default one. The caller (a lead, the page) reads why.
    return reply.code(202).send({ id: r.id, ...(r.waitsLogin ? { waitsLogin: r.waitsLogin } : {}), ...(r.startedOn ? { startedOn: r.startedOn } : {}) });
  });

  app.post("/api/agents/:id/stop", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    // Stop acts on the id before (and without) a record: the kill builds the
    // dtach socket path and pkill pattern from it. Not an agent id -> 404.
    if (!isAgentId(id)) return reply.code(404).send({ error: "not found" });
    // The masters run the cron jobs and the fleet: never stopped from here.
    const target = await store.load(id);
    if (target && isMaster(target)) return reply.code(400).send({ error: "a master agent cannot be stopped" });
    markActed(req, id);
    // A headless worker with the flag off (a run with the flag on started it): its scope stops.
    if (target?.host === "headless" && !headless()) await stopHeadlessOff(id);
    else (hostOf(id) ?? terminals).kill(id);
    await store.patch(id, { status: "done" });
    hub.emitEvent({ type: "agent-status", agentId: id, status: "done" });
    return reply.code(202).send({});
  });

  // Delete/resume/reopen answer 404 for an id that is not an agent id, with
  // the flag off too (before any store or terminal access: delete kills by
  // id first). With chief on, a persistent agent (master, lead) needs the
  // paired user. Returns false once the reply is sent.
  async function gatePersistent(req: FastifyRequest, reply: FastifyReply, id: string): Promise<boolean> {
    if (!isAgentId(id)) { reply.code(404).send({ error: "not found" }); return false; }
    if (!deps.chief) return true;
    const rec = await store.load(id);
    if (!rec || !isPersistentKind(rec.kind)) return true;
    return (await gateUser(deps.chief, req, reply)) !== null;
  }

  // Reconnect to an agent. If its persisted session survived (e.g. across a
  // server restart) we reattach the SAME live `claude` — the running task
  // continues uninterrupted. Only when the session is truly gone do we relaunch:
  // resumeAgent restores the full conversation via `claude --resume` when the
  // transcript is intact, else cold-starts in the worktree (its code/diffs are
  // still on disk, so work is preserved). Hooks are re-registered so the new
  // session reports status.
  // Resuming is using the agent: a closed one goes back to the open list. This
  // and Reopen (same handler) are the explicit actions that restart a closed,
  // stopped agent; nothing else does (see closed.ts).
  async function resumeRoute(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    if (!(await gatePersistent(req, reply, id))) return reply;
    markActed(req, id);
    const rec = await store.load(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    const reopen = () => reopenIfClosed({ store, emit: (e) => hub.emitEvent(e) }, id);
    if ((hostOf(id) ?? terminals).has(id)) { await reopen(); return reply.code(202).send({ id }); } // already live
    const outcome = await resumeAgent(rec, recoveryCtx);
    await reopen();
    // A relaunched agent comes up idle; a reattached live one keeps its status
    // (resumeAgent left the store untouched), so don't clobber it with idle. One that waits for a
    // login (the second sign-in, a sign-out's hold) has no session: its status stays too.
    if (outcome !== "alive" && outcome !== "waits") hub.emitEvent({ type: "agent-status", agentId: id, status: "idle" });
    return reply.code(202).send({ id, outcome });
  }
  app.post("/api/agents/:id/resume", resumeRoute);

  // Move an agent to another Claude login. A live agent is relaunched on the
  // new login with its conversation restored (`--resume`); a dead one just
  // records it for its next Resume. The in-flight turn of a running agent is
  // lost — the UI only offers this while the agent is idle, but the server
  // does not refuse it: the user's explicit click wins.
  // Move one agent to another login. A worker: the switch of recovery.ts (end the session,
  // resume the conversation on the new login). A lead or the fleet master: the record gets the
  // new login, then the chief of staff relaunches it its own way (its inbox is held, nobody
  // types into it meanwhile). When it is busy now, it moves when it is quiet ("waits").
  type MoveOutcome = "resumed" | "cold" | "patched" | "waits";
  // ---- an agent that a limit stopped: the reason, and "go on" after a move ----

  // Why the last turn of the agent stopped, read from its session file now. stopRead tells a
  // file that could not be found or read (ok false) from a file with no stop mark.
  const stopRead = async (rec: AgentRecord): Promise<StopRead> => {
    const file = await sessionFileFor(rec, { workspaceDir, projectsRoot: deps.projectsRoot }).catch(() => null);
    return file && file.ok ? readStopFile(file.path) : { ok: false };
  };
  const stopOf = async (rec: AgentRecord): Promise<StopWhy | null> => {
    const r = await stopRead(rec);
    return r.ok ? r.stop : null;
  };

  // The login of `rec` is signed out (its session said so at `at`).
  async function onSignedOut(rec: AgentRecord, at: number): Promise<void> {
    if (!(await markSignedOut(rec.account, at, accounts))) return;
    console.warn(`[accounts] the Claude login ${rec.account ?? DEFAULT_ACCOUNT} is signed out (agent ${rec.id} said so): no agent starts on it until the user signs in again`);
    if (rec.kind !== "coordinator") return;
    const next = await loginInPlaceOf(rec.account, accounts);
    if (!next) { console.warn("[accounts] the Coordinator's login is signed out and no other login works"); return; }
    const outcome = await moveAgent(rec, next.account);
    console.warn(`[accounts] the Coordinator moved to the login ${next.account ?? DEFAULT_ACCOUNT} (${outcome})`);
  }

  // The line "go on", typed into the agent one time when its session is up after a move. The
  // session takes a paste only when its screen is ready: wait for that, then type. A session
  // that never gets ready gets nothing (the user sees the agent idle, as before this change).
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  async function tellToGoOn(id: string, to: string, signedOut = false): Promise<void> {
    for (let i = 0; i < 80; i++) {
      const t = hostOf(id) ?? terminals;
      if (t.has(id) && t.inputReady(id)) break;
      await sleep(250);
    }
    for (let i = 0; i < 5; i++) {
      const r = await sendToAgent(terminals, id, goOnText(to, signedOut), deps.sleep, { checkReady: deps.checkReady });
      if (r === "sent") { console.warn(`[accounts] ${id} was told to go on after its move to ${to}`); return; }
      if (r === "not-live") return;
      if (r === "too-large") { console.warn(`[accounts] ${id}: the go-on line is above the worker's limit: not sent`); return; }
      await sleep(1000);
    }
  }

  // The agent starts for the first time: it waited for a login with room (spawn.ts). On the
  // login given, with the first message that was kept for it.
  async function startWaiting(rec: AgentRecord, account: string | undefined, startedOn?: AgentRecord["startedOn"]): Promise<void> {
    const prompt = rec.waitsLogin?.prompt ?? "";
    // From now on the first message is kept as for any Claude agent (store.ts): a start before
    // Claude takes it in sends it again.
    const firstPrompt = prompt.trim() && (rec.runtime ?? "claude") === "claude" && rec.host !== "headless" ? prompt : undefined;
    const firstPromptAt = firstPrompt !== undefined ? Date.now() : undefined;
    await store.patch(rec.id, { account, waitsLogin: undefined, startedOn, firstPrompt, firstPromptAt });
    const { waitsLogin: _w, ...rest } = rec;
    await resumeAgent({ ...rest, account, firstPrompt, firstPromptAt, ...(startedOn ? { startedOn } : {}) }, recoveryCtx, prompt.trim() ? { prompt } : {});
    const status = prompt.trim() ? "running" : "idle";
    await store.patch(rec.id, { status });
    hub.emitEvent({ type: "agent-status", agentId: rec.id, status });
  }

  // Each minute: an agent that waits for a login starts when a login has room again.
  const checking = new Set<string>();
  async function checkWaiting(): Promise<void> {
    for (const rec of await store.list()) {
      if (!rec.waitsLogin || rec.closedAt !== undefined || checking.has(rec.id)) continue;
      checking.add(rec.id);
      try {
        const r = await resolveAccount(undefined, rec.runtime ?? "claude", accounts, deps.usageNow ?? deps.usage);
        if ("error" in r || r.waits) {
          const until = "error" in r ? rec.waitsLogin.until : r.waits!.until;
          if (until !== rec.waitsLogin.until) await store.patch(rec.id, { waitsLogin: { ...rec.waitsLogin, until } });
          continue;
        }
        await startWaiting(rec, r.account, r.startedOn);
        console.warn(`[accounts] ${rec.id} waited for a login and starts now on ${r.account ?? DEFAULT_ACCOUNT}`);
      } catch (e) {
        console.warn(`[accounts] ${rec.id} waits for a login; its start failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        checking.delete(rec.id);
      }
    }
  }
  const waiter = setInterval(() => { void checkWaiting().catch(() => {}); }, 60_000);
  waiter.unref?.();
  app.addHook("onClose", async () => clearInterval(waiter));

  // A lead or the fleet master that a move gave a new login and whose relaunch waits for a quiet
  // moment: its id and the login its Claude still runs on.
  const moveWaits = new Map<string, string>();
  // An id leaves when its relaunch is done: the relaunch's own list of waits (a relaunch that
  // is done, or that failed, is not on it) is the truth. A relaunch armed for another reason
  // (a new prompt), or of an agent that came from another login, does not count.
  const pruneMoveWaits = (): void => {
    const armed = new Set(deps.relaunchWaits?.() ?? []);
    for (const mid of [...moveWaits.keys()]) if (!armed.has(mid)) moveWaits.delete(mid);
  };
  // Who hears that an agent was deleted (the usage-limit ticket).
  const removedFns = new Set<(id: string) => void>();
  // A login was signed in from the page: what a sign-out held starts (agents/loginhold.ts).
  const startHeld = async (): Promise<void> => {
    const ids = (await deps.loginHold?.releaseAll().catch(() => [])) ?? [];
    if (ids.length) await deps.startPersistent?.(ids).catch((e: unknown) => console.warn(`[accounts] a start after a sign-in failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  async function moveAgent(rec: AgentRecord, account: string | undefined): Promise<MoveOutcome> {
    // An agent that waits for a login has no session yet: the move starts it there.
    if (rec.waitsLogin) {
      await startWaiting(rec, account);
      return "cold";
    }
    // A limit (or a model that does not work) cut the last turn of the agent: after the move the
    // console tells it to go on, one time, when its session is up (the hook route, SessionStart).
    // Not when the agent waits for the user: then the user's answer is what it needs.
    // The stop mark was of the old login: it goes with the move.
    const stop = (await stopOf(rec)) ?? null;
    const now = Date.now();
    if (stop && !(await deps.waitsForUser?.(rec.id).catch(() => false))) {
      const list = await listAccounts(accounts).catch(() => []);
      const id = account ?? DEFAULT_ACCOUNT;
      const email = list.find((a) => a.id === id)?.email;
      const to = email ? email.split("@")[0] : id === DEFAULT_ACCOUNT ? "the main login" : id;
      await store.patch(rec.id, { goOn: { to, at: now, ...(stop.why === "login" ? { signedOut: true as const } : {}) }, stop: undefined, movedAt: now });
    } else if (rec.goOn || rec.stop || stop) {
      await store.patch(rec.id, { goOn: undefined, stop: undefined, movedAt: now });
    }
    if (!isPersistentKind(rec.kind) || !deps.relaunchPersistent) {
      const outcome = await switchAccount(rec, account, recoveryCtx);
      if (outcome !== "patched") hub.emitEvent({ type: "agent-status", agentId: rec.id, status: "idle" });
      return outcome;
    }
    await store.patch(rec.id, { account });
    const r = await deps.relaunchPersistent(rec.id);
    if (r === "relaunched") { moveWaits.delete(rec.id); return "resumed"; }
    // Busy: its Claude runs on the old login until the relaunch (a sign-out of that login waits).
    if (r === "waits") { moveWaits.set(rec.id, rec.account ?? DEFAULT_ACCOUNT); return "waits"; }
    throw new Error(r === "gone" ? "the agent is gone" : "the relaunch did not work; try again");
  }

  // With chief on, the login of a lead or of the fleet master is the paired user's to change.
  app.post("/api/agents/:id/account", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(await gatePersistent(req, reply, id))) return reply;
    const rec = await store.load(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    const want = (req.body as { account?: unknown } | null)?.account;
    // An explicit login: "default" is the main login, never "the one with room".
    const resolved = await resolveAccount(want === undefined || want === null || want === "" ? DEFAULT_ACCOUNT : want, rec.runtime ?? "claude", accounts);
    if ("error" in resolved) return reply.code(400).send({ error: resolved.error });
    if ((resolved.account ?? undefined) === (rec.account ?? undefined)) {
      return reply.code(200).send({ id, outcome: "unchanged" });
    }
    // A login that Claude reported as signed out: an agent moved there would stop at once.
    const target = (await listAccounts(accounts)).find((x) => x.id === (resolved.account ?? DEFAULT_ACCOUNT));
    if (target?.signedOut) return reply.code(409).send({ error: "That login is signed out. Log in to it again first." });
    try {
      return reply.code(202).send({ id, outcome: await moveAgent(rec, resolved.account) });
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : "switch failed" });
    }
  });

  // "Move all agents": each agent of one login goes to another login, one after the other:
  // workers, leads, the fleet master and the Coordinator. The paired user only. A closed agent
  // only gets the new login for its next start.
  // A turn cannot go on on a login that is signed out, not logged in or at its limit: there each
  // agent moves at once, also one that works. On a login that works, an agent that works now
  // stays ("working"): a move would cut its turn. A lead or the fleet master with a half-typed
  // line or new output waits and moves when it is quiet (the relaunch of the chief of staff).
  // The move itself, for this route and for the sign-out of a login that has agents. The caller
  // checks both logins; `list` is its listAccounts.
  type MoveAll = { moved: number; waits: number; failed: number; working: number };
  async function moveAllOf(id: string, to: string, list: AccountInfo[]): Promise<MoveAll> {
    const source = list.find((a) => a.id === id);
    const stuck = !source?.loggedIn || (loginUse(deps.usage?.() ?? null, id, list.length, Date.now())?.atLimit ?? false);
    const account = isDefaultAccount(to) ? undefined : to;
    const mine = (await store.list()).filter((r) => (r.runtime ?? "claude") === "claude" && (r.account ?? DEFAULT_ACCOUNT) === id);
    const out = { moved: 0, waits: 0, failed: 0, working: 0 };
    for (const rec of mine) {
      try {
        if (rec.closedAt !== undefined) { await store.patch(rec.id, { account }); continue; }
        if (!stuck && rec.status === "running") { out.working++; continue; }
        if ((await moveAgent(rec, account)) === "waits") out.waits++; else out.moved++;
      } catch (e) {
        out.failed++;
        console.warn(`[accounts] ${rec.id} did not move to ${to}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  app.post("/api/accounts/:id/move", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await userOnly(req, reply))) return reply;
    const { id } = req.params as { id: string };
    const to = (req.body as { to?: unknown } | null)?.to;
    if (!isAccountId(id) || !isAccountId(to)) return reply.code(400).send({ error: "invalid account" });
    if (id === to) return reply.code(400).send({ error: "Pick another login." });
    const list = await listAccounts(accounts);
    const source = list.find((a) => a.id === id);
    const target = list.find((a) => a.id === to);
    if (!source || !target) return reply.code(404).send({ error: "not found" });
    if (!target.loggedIn) return reply.code(409).send({ error: "That login is not logged in. Log in to it first." });
    return moveAllOf(id, to, list);
  });

  // ---- "Sign out" of a Claude login (claudelogout.ts) ----
  // Every sign-out is a press of the paired owner: gateUser refuses an agent header (a worker, a
  // lead, the fleet master, the Coordinator), a device that is not paired and a local call with
  // no pairing (403 pair-required). With chief off nothing is paired, so nothing signs out.
  // A Claude that runs on the login keeps its token in memory and can write the login back when
  // it renews it. So the console signs out only when no Claude of its own will run on the login:
  //  - basic protection, another login works: the agents first move there (the move above, its
  //    rules: an agent that works now stays). One that did not move stops the sign-out;
  //  - no other login works (one login; strong protection's first login): the agents' Claude ends,
  //    the records stay open and keep their conversations; an agent that works or is busy now
  //    stops the sign-out (no force);
  //  - the second sign-in (strong protection): the fleet master, the leads and the Coordinator
  //    end the same way, then wait for the next second sign-in (chief/chiefwait.ts);
  //  - a Recurring run on the login stops the sign-out (cron/running.ts). In basic protection the
  //    login is marked as signed out first, so a run that starts meanwhile takes another login.
  // Then Claude signs out. If the login is there again (a Claude wrote it back meanwhile): one
  // more sign-out, and if it is still there, the answer says so and the mark goes.
  const SIGN_OUT_NO_PAIRING = "Pair a device first. Only a paired device can sign out a Claude login.";
  type SignOutWhy = "busy" | "moves" | "recurring" | "still-there" | LogoutWhy;
  // waiting: the persistent agents that it ended and that wait for a login now; restarted: those
  // that started again at once, because the login was still there.
  type SignOut = MoveAll & { signedOut: boolean; stopped: number; notEnded: number; waiting: string[]; restarted: string[]; recurring: string[]; why?: SignOutWhy };
  const signingOut = new Set<string>();
  const quietExits = deps.quietExits ?? new Set<string>();
  app.post("/api/accounts/:id/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.chief) return reply.code(403).send({ error: SIGN_OUT_NO_PAIRING });
    if (!(await gateUser(deps.chief, req, reply))) return reply;
    const { id } = req.params as { id: string };
    const to = (req.body as { to?: unknown } | null)?.to;
    if (!isAccountId(id) || (to !== undefined && to !== null && !isAccountId(to))) return reply.code(400).send({ error: "invalid account" });
    const strong = hardenedDeployment();
    const second = strong && id === PERSISTENT_LOGIN;
    let auth: AgentAuth | null = null;
    let status: Pick<AgentLoginStatus, "read" | "forget"> | undefined;
    if (second) {
      if (!chiefAuth) return reply.code(409).send({ error: NOT_READY });
      auth = chiefAuth; status = deps.chiefStatus;
    } else if (strong) {
      if (!agentAuth) return reply.code(409).send({ error: "On this console the agents have their own Claude login. It is set up on the server, not from this page." });
      if (!isDefaultAccount(id)) return reply.code(409).send({ error: "On this console the agents have one Claude login: the default one." });
      auth = agentAuth; status = agentStatus;
    } else if (!isDefaultAccount(id) && !(await accountExists(id, accounts))) return reply.code(404).send({ error: "not found" });
    const key = second ? PERSISTENT_LOGIN : id;
    if (signingOut.has(key)) return reply.code(409).send({ error: "This login signs out now." });
    if (flowOf(key)?.busyWith() === key) return reply.code(409).send({ error: "A sign-in of this login is open. Close it first." });
    signingOut.add(key);
    try {
      const paths = accounts ?? accountPaths();
      // Is the login on the server, as Claude Code says it (strong) or by its credentials file.
      const loggedIn = async (): Promise<boolean> => {
        if (auth) {
          if (status) { status.forget(); return (await status.read()).loggedIn; }
          return (await agentLoginStatus(auth)).loggedIn;
        }
        return (await accessTokenFor(id, paths)) !== null;
      };
      if (!(await loggedIn())) return reply.code(409).send({ error: "This login is not signed in on your server." });
      const out: SignOut = { signedOut: false, moved: 0, waits: 0, working: 0, failed: 0, stopped: 0, notEnded: 0, waiting: [], restarted: [], recurring: [] };
      const stop = (why: SignOutWhy, code = 409) => reply.code(code).send({ ...out, why });
      // The Recurring runs that can be on this login: its own, and a run that does not know its
      // login yet. The second sign-in runs no Recurring task.
      const runsOnIt = async (): Promise<string[]> => second ? []
        : (await (deps.recurringRuns?.() ?? Promise.resolve([]))).filter((r) => r.login === null || r.login === (strong ? DEFAULT_ACCOUNT : id)).map((r) => r.name);
      if ((out.recurring = await runsOnIt()).length) return stop("recurring");
      // A lead or the fleet master that a move took off this login and whose Claude still runs on
      // it: its relaunch waits for a quiet moment.
      pruneMoveWaits();
      if ((out.waits = [...moveWaits.values()].filter((from) => from === key).length)) return stop("busy");
      // The agents on the login (the rule of the list of logins above).
      const open = (await store.list()).filter((r) => r.closedAt === undefined && (r.runtime ?? "claude") === "claude");
      const onIt = second ? open.filter((r) => isPersistentKind(r.kind))
        : strong ? open.filter((r) => !deps.chiefStatus || !isPersistentKind(r.kind))
        : open.filter((r) => (r.account ?? DEFAULT_ACCOUNT) === id);
      const list = strong ? [] : await listAccounts(accounts);
      const others = list.filter((a) => a.id !== id && a.loggedIn);
      const busy = deps.agentBusy ?? ((r: AgentRecord) => busyNow(r, { terminals, masterHasDraft: () => false }));
      const works = (r: AgentRecord) => r.status === "running" || busy(r);
      const live: AgentRecord[] = [];
      if (onIt.length && others.length) {
        if (to === undefined || to === null) return reply.code(400).send({ error: "Pick the login that its agents move to." });
        if (!others.some((a) => a.id === to)) return reply.code(409).send({ error: "That login is not logged in. Log in to it first." });
        Object.assign(out, await moveAllOf(id, to as string, list));
        if (out.working || out.waits || out.failed) return stop("moves");
      } else {
        for (const rec of onIt) {
          const t = hostOf(rec.id) ?? terminals;
          if (t.has(rec.id) || (await t.hasSession(rec.id).catch(() => false))) live.push(rec);
        }
        if ((out.working = live.filter(works).length)) return stop("busy");
      }
      // Basic protection: the mark first (a Recurring run that starts now takes another login),
      // then the runs again.
      const hadMark = !strong && isSignedOut(id);
      const unmark = async () => { if (!strong && !hadMark) await clearSignedOut(id); };
      if (!strong) await markSignedOut(id, Date.now(), paths);
      if ((out.recurring = await runsOnIt()).length) { await unmark(); return stop("recurring"); }
      const cmd = logoutCommand({ account: id, paths, env: deps.claudeLogin?.env, bin: deps.claudeLogin?.bin, auth });
      const first = await runLogout(cmd);
      // 500, never 502: Cloudflare (the hosted console's edge) puts its own page in place of the body of an origin 502 or 504, and the page needs this
      // answer (what ended, what waits) for its words.
      if (!first.ok) { await unmark(); return stop(first.why, 500); }
      // No process ended before: a sign-out that failed stops no agent. The kept status is of
      // before the sign-out: a start of a persistent agent now reads it again (the second sign-in's
      // wait, chief/chiefwait.ts, then holds it). The other logins: the hold (agents/loginhold.ts)
      // comes BEFORE the end, so that no start (a message, a retry) runs a Claude on the login.
      status?.forget();
      const waitIds = live.filter((r) => isPersistentKind(r.kind)).map((r) => r.id);
      if (!second) await deps.loginHold?.hold(waitIds, key);
      const unwait = async (ids: string[]) => {
        if (!ids.length) return;
        if (!second) await deps.loginHold?.release(ids);
        await deps.startPersistent?.(ids).catch((e: unknown) => console.warn(`[accounts] a start after a sign-out that did not end failed: ${e instanceof Error ? e.message : String(e)}`));
      };
      const ended: string[] = [];
      for (const rec of live) {
        await withTypingLock(rec.id, async () => {
          // A turn can start while Claude signs out (up to 15 s): the agent is read again.
          const cur = await store.load(rec.id);
          if (!cur) return;
          if (works(cur)) { out.notEnded++; return; }
          // In silence: no "finished" message or digest line (agents/exit.ts); the record is "done".
          quietExits.add(rec.id);
          const t = hostOf(rec.id) ?? terminals;
          t.kill(rec.id);
          if (!(await waitUntilGone(t, rec.id))) { quietExits.delete(rec.id); out.notEnded++; return; }
          out.stopped++;
          ended.push(rec.id);
          // The second sign-in: it waits for the next one, which starts it (chief/chiefwait.ts).
          if (second && isPersistentKind(cur.kind)) await deps.chiefWait?.mayStart?.(rec.id);
          // No terminal of this process (a session that it had not attached): no exit handler ran.
          if (quietExits.delete(rec.id)) {
            await store.patch(rec.id, { status: "done" });
            hub.emitEvent({ type: "agent-status", agentId: rec.id, status: "done", quiet: true });
          }
        });
      }
      // A persistent agent that did not end runs on: it does not wait.
      const runsOn = waitIds.filter((x) => !ended.includes(x));
      if (runsOn.length && !second) await deps.loginHold?.release(runsOn);
      out.waiting = waitIds.filter((x) => ended.includes(x));
      if (await loggedIn()) {
        await runLogout(cmd);
        if (await loggedIn()) {
          // The login is there: what waited for it starts again now.
          await unwait(out.waiting);
          out.restarted = out.waiting;
          out.waiting = [];
          await unmark();
          return stop("still-there", 500);
        }
      }
      // The second sign-in: the last read says the login is gone, so each ended agent waits for
      // the next sign-in now. (The read inside the loop can be of a login that a Claude wrote back
      // a moment before the second sign-out: then that agent was not put in the wait.)
      if (second) for (const x of out.waiting) await deps.chiefWait?.mayStart?.(x);
      // A run that started on the login while it signed out (strong protection: no mark there).
      out.recurring = await runsOnIt();
      out.signedOut = true;
      console.warn(`[accounts] Claude login ${key} signed out from the page (${out.moved} moved, ${out.stopped} stopped)`);
      deps.onClaudeLogin?.(key);
      return out;
    } finally {
      signingOut.delete(key);
    }
  });

  app.get("/api/agents/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await store.load((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    return forPage((await stripToken(req)) ? withoutToken(rec) : rec);
  });

  app.get("/api/agents/:id/diff", async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await store.load((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (isMaster(rec)) return reply.code(400).send(MASTER_NA);
    if (isWorkspace(rec)) return { diff: await workspaceDiff(workspaceDir) };
    // An agent's own clone (strong protection): read as the agent, through the helper.
    if (isClone(rec)) {
      const x = agentClones();
      if (!x) return reply.code(409).send({ error: CLONE_NO_HELPER });
      try {
        return { diff: await cloneDiff(x, rec, await baseCommit(rec.repo, rec.baseBranch)) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "the diff could not be read";
        return reply.code(msg === CLONE_DIFF_TOO_LARGE ? 413 : 502).send({ error: msg });
      }
    }
    return { diff: await diffPatch(rec) };
  });

  // The agent's live plan/task list — the rail's Plan view renders it live.
  // Where it comes from is the runtime's business (Claude: harness task files
  // under <its Claude folder>/tasks/<sessionId>/). Missing session/dir/file is a normal
  // state, never an error. In a hardened deployment a persistent agent's list takes the user
  // token, as its thread does: the console reads it as the second account (tasksread.ts), and a
  // worker agent on the same server must not get it.
  app.get("/api/agents/:id/tasks", async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await store.load((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (deps.chief && hardenedDeployment() && isPersistentKind(rec.kind) && !(await gateUser(deps.chief, req, reply))) return reply;
    return { tasks: await pick(rec).readPlan(rec, { tasksRoot: deps.tasksRoot }) };
  });

  // The agent's conversation for the thread view, read from its Claude session
  // file (thread.ts, threadfile.ts): what the user sent, what the agent said and
  // the tool steps between. No cursor: the newest page. `before`: the page
  // before that byte offset ("earlier messages"). `after`: only what was
  // appended since (the live poll; a no-change poll is one stat).
  // `lastEntryAt` is the time of the file's last line (its mtime, from that
  // same stat): with `now` the client tells how long a running agent is quiet.
  // A session file holds everything the agent saw, so this route has no exempt
  // path: it sits behind the cookie preHandler like every /api/agents route
  // (auth.ts), and in a hardened deployment a persistent agent's thread takes
  // the user token, as its terminal socket does (chief/wsgate.ts).
  // No readable session (Codex, no session yet, no file) is a normal state:
  // 200 with ok:false, and the client shows the terminal.
  // Subagents (subagents.ts). A subagent is one Agent step here; its own
  // messages and steps are in a file of its own. `subs` in the answer gives the
  // state of each subagent that a step of the page launched, and of each id in
  // `?subs=` (the ones the client holds as running: the live poll). `?sub=<id>`
  // serves that subagent's own file in place of the session file, with the same
  // cursors, behind the same gate (it is the same route). `lastEntryAt` is the
  // newest write of the session file and of the running subagents among `subs`.
  app.get("/api/agents/:id/thread", async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await store.load((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (deps.chief && hardenedDeployment() && isPersistentKind(rec.kind) && !(await gateUser(deps.chief, req, reply))) return reply;
    const q = (req.query ?? {}) as { before?: unknown; after?: unknown; session?: unknown; sub?: unknown; subs?: unknown };
    // Both become file names: checked here, and again where the path is built.
    const sub = q.sub === undefined ? null : isSubagentId(q.sub) ? q.sub : undefined;
    const polled = q.subs === undefined ? [] : typeof q.subs === "string" && q.subs.length <= 65 * MAX_SUBAGENTS ? q.subs.split(",") : undefined;
    if (sub === undefined || polled === undefined || !polled.every(isSubagentId)) {
      return reply.code(400).send({ error: "sub is a subagent id; subs is a list of them" });
    }
    const cursor = (v: unknown): number | null | undefined =>
      v === undefined ? null : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : undefined;
    const before = cursor(q.before);
    const after = cursor(q.after);
    if (before === undefined || after === undefined || (before !== null && after !== null)) {
      return reply.code(400).send({ error: "before and after are byte offsets; send at most one" });
    }
    reply.header("cache-control", "no-store");
    const base = { status: rec.status, now: Date.now() };
    const file = await sessionFileFor(rec, { workspaceDir, projectsRoot: deps.projectsRoot });
    if (!file.ok) return { ok: false, reason: file.reason, ...base };
    const head = { ok: true, sessionId: file.sessionId, ...base };
    // A cursor belongs to one session file: after /clear or a relaunch the
    // client's offsets mean nothing here, so it gets the new session's tail.
    const sameSession = q.session === undefined || q.session === file.sessionId;
    const dir = sub ? await openSubagentDir(file.path) : null;
    if (sub && !dir) return { ok: false, reason: "no-file", ...base };
    const path = sub && dir ? dir.file(sub) : file.path;
    const opts = sub ? { sidechain: true } : undefined;
    try {
      let page = sameSession && after !== null ? await readThreadAfter(path, after, undefined, opts) : "reset";
      let reset = false;
      if (page === "reset") {
        page = await readThreadBefore(path, sameSession && after === null ? before : null, undefined, opts);
        reset = !sameSession || after !== null;
      }
      if (page === null) return { ok: false, reason: "no-file", ...base };
      const alive = rec.status === "running" || rec.status === "idle";
      const ids = [...(sub ? [sub] : []), ...subagentIdsOf(page.items), ...polled];
      // With strong protection a first answer may leave subagents for later (subagents.ts): the
      // next polls of this session look at them, also when the page names none.
      const subs = ids.length || hasLaterSubagents(file.path) ? await subagentStates(file.path, ids, { alive, now: base.now }) : {};
      const named = ids.length > 0 || Object.keys(subs).length > 0;
      // The session file is silent while only a subagent works: the quiet
      // signal takes the newest write of the running subagents too.
      const lastEntryAt = sub ? page.lastEntryAt : newestWrite(page.lastEntryAt, subs);
      return { ...head, ...page, lastEntryAt, ...(reset ? { reset: true } : {}), ...(named ? { subs } : {}) };
    } finally {
      await dir?.close();
    }
  });

  // Receive an image or a file of an allowed type, write it into the agent's
  // worktree (git-excluded), and return its worktree-relative path. The client
  // types that path into the terminal, or puts it in the composer, so the
  // agent can read the file. A persistent agent (a lead, a master) has its
  // home as worktree: the same route.
  app.post("/api/agents/:id/upload", { bodyLimit: MAX_UPLOAD_BYTES }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await store.load(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    const ext = uploadExt(req.headers["content-type"], (req.query as { ext?: unknown }).ext);
    if (!ext) return reply.code(415).send({ error: `file type not allowed (allowed: ${ALLOWED_TEXT})` });
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return reply.code(400).send({ error: "the file is empty" });
    if (uploadFolderMissing(rec)) return reply.code(409).send({ error: NO_UPLOAD_FOLDER });
    // Strong protection: a console folder that the agent reads, never its own clone.
    const path = await saveAgentUpload(rec, buf, ext);
    return reply.code(200).send({ path });
  });

  app.get("/api/agents/:id/changed", async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await store.load((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (isMaster(rec)) return reply.code(400).send(MASTER_NA);
    if (isWorkspace(rec)) return { files: await workspaceChangedFiles(workspaceDir) };
    if (isClone(rec)) {
      const x = agentClones();
      if (!x) return reply.code(409).send({ error: CLONE_NO_HELPER });
      const sha = await baseCommit(rec.repo, rec.baseBranch).catch(() => null);
      return { files: sha ? await cloneChangedFiles(x, rec, sha) : [] };
    }
    return { files: await worktreeChangedFiles(rec.worktree, rec.baseBranch, rec.repo) };
  });

  // Where the worktree's git actually is right now (live HEAD vs the agent's
  // tracked branch + base, plus dirty/stash state) — so a phantom or empty diff
  // is explained rather than mysterious.
  app.get("/api/agents/:id/git", async (req: FastifyRequest, reply: FastifyReply) => {
    const loaded = await store.load((req.params as { id: string }).id);
    if (!loaded) return reply.code(404).send({ error: "not found" });
    if (isMaster(loaded)) return reply.code(400).send(MASTER_NA);
    // A workspace agent spans many repos with no single HEAD/base — there's no
    // meaningful git-state bar, so report it as unavailable (the UI hides it).
    // An agent's own clone (strong protection): read as the agent, through the helper.
    const x = isClone(loaded) ? agentClones() : null;
    const sha = x ? await baseCommit(loaded.repo, loaded.baseBranch).catch(() => null) : null;
    if (x && sha) return { git: await cloneGitState(x, loaded, sha) };
    // With no helper, or no base commit: the same "unavailable" state.
    if (isWorkspace(loaded) || isClone(loaded)) {
      return { git: {
        head: "", detached: false, sha: "", trackedBranch: "", baseBranch: "",
        onTracked: false, ahead: 0, behind: 0, staged: 0, unstaged: 0,
        untracked: 0, stashes: [], error: true,
      } };
    }
    const rec = await adoptLiveBranch(loaded);
    return { git: await worktreeGitState(rec.worktree, rec.branch, rec.baseBranch, rec.repo) };
  });

  // Discard a single changed file — revert it to the fork-point state. Allowed
  // while the agent is live: it's a targeted revert, not a worktree teardown.
  app.post("/api/agents/:id/discard-file", async (req: FastifyRequest, reply: FastifyReply) => {
    const rec = await store.load((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (isMaster(rec)) return reply.code(400).send(MASTER_NA);
    const rel = (req.body as { rel?: string })?.rel ?? "";
    if (!rel) return reply.code(400).send({ error: "missing rel" });
    if (isClone(rec)) return reply.code(409).send({ error: CLONE_NO_GIT });
    try {
      if (isWorkspace(rec)) await workspaceDiscardFile(workspaceDir, rel);
      else await discardFileInWorktree(rec.worktree, rec.baseBranch, rel, rec.repo);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "discard failed" });
    }
    return reply.code(202).send({});
  });

  app.post("/api/agents/:id/merge", async (req: FastifyRequest, reply: FastifyReply) => {
    if (deps.chief && !(await gateMerge(deps.chief, req, reply))) return reply;
    const { id } = req.params as { id: string };
    if ((hostOf(id) ?? terminals).has(id)) return reply.code(409).send({ error: "agent still live — stop it first" });
    const loaded = await store.load(id);
    if (!loaded) return reply.code(404).send({ error: "not found" });
    if (isMaster(loaded)) return reply.code(400).send(MASTER_NA);
    // A workspace agent has no base branch to merge into — its edits already
    // live in the real repos. Nothing to reconcile.
    if (isWorkspace(loaded)) return reply.code(400).send({ error: "workspace agent — no branch to merge" });
    if (isClone(loaded)) return reply.code(409).send({ error: CLONE_NO_GIT });
    // Merge whatever branch the worktree is actually on, not a stale recorded name.
    const rec = await adoptLiveBranch(loaded);
    return merge(rec, rec.baseBranch);
  });

  app.post("/api/agents/:id/discard", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if ((hostOf(id) ?? terminals).has(id)) return reply.code(409).send({ error: "agent still live — stop it first" });
    const rec = await store.load(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (isMaster(rec)) return reply.code(400).send(MASTER_NA);
    await discard(rec);
    return reply.code(202).send({});
  });

  // Fully remove an agent: kill its PTY if live, remove the worktree + branch
  // (best-effort — it may already be merged/removed), and delete the record.
  // Shared by the delete route and the closed-agent purge (closed.ts).
  async function removeAgent(id: string): Promise<void> {
    // An agent with its own clone goes only through the helper (its clone is removed as the
    // agent): with no helper the record stays, so a later delete can remove the clone.
    const own = await store.load(id);
    if (own && isClone(own)) cloneExecOrRefuse();
    // A headless worker: its program and its folders go (headless/wiring.ts), also with the flag
    // off; held by another console: the record stays.
    const hw = own?.host === "headless" ? headlessRemover() : null;
    if (hw) await removeHeadless(hw, id);
    else (hostOf(id) ?? terminals).kill(id); // no-op if not live
    const rec = await store.load(id);
    // The master is deletable (kill + forget the record), but it owns no
    // disposable git state: its "worktree" is its own agent home dir, and
    // dirname(claudeHooksPath) IS that dir — tearing either down would delete it.
    if (rec && !isMaster(rec)) {
      try { await discard(rec); } catch { /* worktree gone/merged — ignore */ }
      // Workspace agents leave a private hook-settings dir behind; clean it up.
      if (isWorkspace(rec)) {
        await rm(dirname(claudeHooksPath(rec, workspaceDir)), { recursive: true, force: true }).catch(() => { /* already gone */ });
      }
    }
    await store.delete(id);
    moveWaits.delete(id);
    // The usage-limit ticket drops its row now, not at its next minute.
    for (const fn of [...removedFns]) { try { fn(id); } catch { /* a listener's fault */ } }
    // Best effort: a widget folder left behind is only disk space.
    await deps.widgets?.removeAgent(id).catch(() => { /* already gone */ });
  }
  app.post("/api/agents/:id/delete", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(await gatePersistent(req, reply, id))) return reply;
    // A lead never deletes an agent (spec §13): it closes its finished workers.
    if (deps.chief && (await deps.chief.caller(req)).level === "lead") {
      return reply.code(403).send({ error: LEAD_DELETE_REFUSAL });
    }
    markActed(req, id);
    try {
      await removeAgent(id);
    } catch (e) {
      if (e instanceof Error && e.message === CLONE_NO_HELPER) return reply.code(409).send({ error: CLONE_NO_HELPER });
      if (e instanceof Error && e.message === HEADLESS_HELD) return reply.code(409).send({ error: HEADLESS_HELD });
      throw e;
    }
    return reply.code(202).send({});
  });

  // Close = stop the session for real (claude, dtach and every process they
  // started) and move the agent to the rail's Closed section. The record,
  // worktree, branch, transcript and sessionId stay; the closed-agent purge
  // deletes it after 7 days. The masters are never closed. Reopen resumes the
  // same session and moves it back.
  // With chief on, an agent caller takes the close gate (chief/leads/close.ts):
  // a lead closes a worker it spawned (the record's spawnedBy), not while that
  // worker runs or has an open queue item; any other agent but a master is
  // refused. A request without agent headers (the user's ✕) is as before.
  app.post("/api/agents/:id/close", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (deps.chief) {
      const caller = await deps.chief.caller(req);
      const openItem = deps.openQueueItem;
      if (caller.level === "lead") {
        if (!gateRoute(deps.chief, reply)) return reply;
        if (!openItem) return reply.code(503).send({ error: CHIEF_ERR.misconfigured });
      }
      const refusal = await closeRefusal(caller, id, await store.load(id), openItem ?? (async () => null));
      if (refusal) return reply.code(refusal.code).send({ error: refusal.error });
    }
    markActed(req, id);
    // A headless worker: its program and its folders go first, also with the flag off (its
    // session file stays; a reopen starts it again). Held by another console: nothing changes.
    const hw = (await store.load(id))?.host === "headless" ? headlessRemover() : null;
    if (hw) {
      try { await removeHeadless(hw, id); } catch (e) {
        if (e instanceof Error && e.message === HEADLESS_HELD) return reply.code(409).send({ error: HEADLESS_HELD });
        throw e;
      }
    }
    const r = await closeAgent({ store, kill: (x) => (hostOf(x) ?? terminals).kill(x), emit: (e) => hub.emitEvent(e) }, id);
    if (r === "not-found") return reply.code(404).send({ error: "not found" });
    if (r === "master") return reply.code(400).send({ error: "a master agent cannot be closed" });
    // A close that did not come from this browser's ✕ (a lead's CLI, another
    // tab): the rail moves the row to Closed on this event. Chief on only.
    if (deps.chief) hub.emitEvent({ type: "agent-closed", agentId: id });
    return reply.code(202).send({});
  });
  app.post("/api/agents/:id/reopen", resumeRoute);

  // Rename = a new title (title.ts) for the agent's list row and header. With chief on, an agent
  // caller takes the owner rule of a close (chief/leads/close.ts ownerRefusal): a lead renames
  // only a worker it spawned; the user and the masters rename every agent.
  app.post("/api/agents/:id/rename", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!isAgentId(id)) return reply.code(404).send({ error: "not found" });
    const t = checkTitle((req.body as { title?: unknown } | undefined)?.title);
    if ("error" in t) return reply.code(400).send({ error: t.error });
    const target = await store.load(id);
    if (deps.chief) {
      const caller = await deps.chief.caller(req);
      if (caller.level === "lead" && !gateRoute(deps.chief, reply)) return reply;
      const refusal = ownerRefusal(caller, id, target, "renames", LEAD_RENAME_RULE);
      if (refusal) return reply.code(refusal.code).send({ error: refusal.error });
    }
    if (!target) return reply.code(404).send({ error: "not found" });
    await store.patch(id, { label: t.title });
    hub.emitEvent({ type: "agent-renamed", agentId: id, label: t.title });
    return reply.code(202).send({ id, label: t.title });
  });

  // Drag-to-reorder: the body is the full rail order; each id gets its index.
  app.post("/api/agents/order", async (req: FastifyRequest, reply: FastifyReply) => {
    const { ids } = (req.body as { ids?: unknown }) ?? {};
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "ids must be a string array" });
    }
    await Promise.all(ids.map((id, i) => store.patch(id, { order: i })));
    return reply.code(202).send({});
  });

  // Cookie-exempt (see auth.ts) but per-agent-token gated. The local `claude`
  // child POSTs its hook JSON here; we derive status + capture the session id.
  app.post("/api/agents/:id/hook", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const token = (req.query as { token?: string }).token ?? "";
    const rec = await store.load(id);
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (token !== rec.hookToken) return reply.code(401).send({ error: "bad token" });
    const body = (req.body as HookPayload) ?? {};
    const { status, sessionId, transcriptPath } = pick(rec).hookToStatus(body);
    const patch: Partial<AgentRecord> = {};
    // Track the LIVE session id, not just the first one: /clear (or any relaunch
    // inside the terminal) starts a new session, and resuming a stale id after a
    // server restart restores a days-old conversation.
    if (sessionId && sessionId !== rec.sessionId) {
      patch.sessionId = sessionId;
      // A new session means a new rollout, so the old path is stale the moment
      // the id changes. Drop it up front and let the line below reinstate it
      // from the same payload. Without this, a /clear whose payload carries no
      // usable path (absent, or rejected by the .jsonl guard) leaves the record
      // pointing at the PREVIOUS session's file: canResume then says yes against
      // it and the Plan rail keeps rendering the old plan.
      patch.transcriptPath = undefined;
    }
    // Codex hands us its rollout path in every payload; Claude's mapping never
    // returns one, so this stays a no-op there. Two clauses because this line
    // has two jobs: skip a redundant write when nothing moved, AND reinstate the
    // path the block above just cleared. A new id with the SAME rollout (Codex
    // appends to one file across a resume) satisfies only the second, and
    // without it the record keeps a session with no path — canResume says no and
    // the next restart cold-starts instead of resuming.
    if (transcriptPath && (transcriptPath !== rec.transcriptPath || patch.sessionId)) patch.transcriptPath = transcriptPath;
    if (status) patch.status = status;
    // The agent stopped: was its last turn cut by a limit or by a model that does not work?
    // The list and the thread then say so in plain words (not "waiting"), and the events of
    // its lead carry the reason. The agent works again: the reason is gone.
    let lineAtOfStop: number | undefined;
    if (status === "idle") {
      const found = await stopOf({ ...rec, ...patch });
      // A line from before the last move is of the old login.
      const stop = found && !(rec.movedAt && (found.lineAt ?? 0) <= rec.movedAt) ? found : null;
      lineAtOfStop = stop?.lineAt;
      if (stop && (rec.stop?.why !== stop.why || rec.stop.text !== stop.text)) patch.stop = { why: stop.why, text: stop.text, at: Date.now() };
      else if (!stop && rec.stop) patch.stop = undefined;
    } else if (status && rec.stop) {
      patch.stop = undefined;
    }
    // The session is up after a move of an agent that a limit had stopped: the console tells
    // it to go on. The mark goes in this same write, so it is used one time only.
    const goOn = body.hook_event_name === "SessionStart" && rec.goOn ? rec.goOn : null;
    if (goOn) patch.goOn = undefined;
    // A new prompt (typed, pasted from Telegram, sent by the master or another
    // session) means the agent is in use again: a closed one reopens. In the
    // same write as the status, so the two can't race.
    const reopen = status === "running" && rec.closedAt !== undefined;
    if (reopen) patch.closedAt = undefined;
    // Claude took a message in: the kept first message is in its session now (store.ts). Also on
    // Stop (it comes only after a turn): a SessionStart save at the same time as the
    // UserPromptSubmit one (load, change, save; no lock) can bring the message back.
    if ((status === "running" || body.hook_event_name === "Stop") && (rec.firstPrompt !== undefined || rec.firstPromptAt !== undefined)) {
      patch.firstPrompt = undefined;
      patch.firstPromptAt = undefined;
    }
    if (Object.keys(patch).length) await store.patch(id, patch);
    // The turn ended: the kept views of its own clone are old now (the page reads them again).
    if (body.hook_event_name === "Stop" && isClone(rec)) dropCloneReads(id);
    if (status) hub.emitEvent({ type: "agent-status", agentId: id, status });
    if (reopen) hub.emitEvent({ type: "agent-reopened", agentId: id });
    if (patch.stop) hub.emitEvent({ type: "agent-stop", agentId: id, why: patch.stop.why });
    // Claude said that the login of this agent is signed out: the login gets its mark (it is not
    // picked for an agent until the user signs in again). The Coordinator has no pane where the
    // user would move it: the console moves it to a login that works, and it goes on by itself.
    if (patch.stop?.why === "login") void onSignedOut({ ...rec, ...patch }, lineAtOfStop ?? Date.now()).catch((e) => console.warn(`[accounts] signed-out login of ${id}:`, e instanceof Error ? e.message : e));
    // Not waited for: the hook of the session must get its answer now. A mark older than 15
    // minutes is of a move whose session never came up: it is dropped with no line.
    if (goOn && Date.now() - goOn.at < 15 * 60_000) void tellToGoOn(id, goOn.to, goOn.signedOut === true).catch(() => {});
    if (body.hook_event_name === "Stop") {
      const lastMessage = typeof body.last_assistant_message === "string" ? body.last_assistant_message : "";
      hub.emitEvent({ type: "agent-turn-end", agentId: id, lastMessage });
    }
    if (typeof body.hook_event_name === "string" && body.hook_event_name) {
      hub.emitEvent({
        type: "agent-hook", agentId: id, event: body.hook_event_name,
        ...(typeof body.source === "string" ? { source: body.source } : {}),
      });
    }
    return reply.code(200).send({});
  });

  // ---- the usage-limit ticket (chief/limit/service.ts): what it reads and does ----

  // The logins with their use, as Settings shows them. Null with strong protection: the use of
  // its login is not known here, and the persistent agents' login is not the user's to pick.
  const limitLogins = async (): Promise<LimitLogin[] | null> => {
    if (agentStatus) return null;
    const list = await listAccounts(accounts);
    const usage = deps.usage?.() ?? null;
    const now = Date.now();
    return list.map((a) => ({
      // The name as the console shows it (src/lib/loginPick.ts loginShort): no e-mail address.
      id: a.id, name: a.email ? a.email.split("@")[0] : a.isDefault ? "Main login" : a.id, loggedIn: a.loggedIn, signedOut: a.signedOut === true,
      use: a.loggedIn ? loginUse(usage, a.id, list.length, now) : null,
    }));
  };

  // Continue: in the agent's typing lock, so no other line comes between the check and the line.
  // The stop mark is read again right before: an agent that works, or whose mark Claude cleared
  // (its own continue after the reset), gets nothing.
  const goOnAfterLimit = (id: string): Promise<GoOnResult> => withTypingLock(id, async (): Promise<GoOnResult> => {
    const rec = await store.load(id);
    if (!rec || rec.closedAt !== undefined) return "gone";
    if (rec.status === "running") return "running";
    if (rec.stop?.why !== "limit") return "no-mark";
    const now = await stopOf(rec).catch(() => null);
    if (now?.why !== "limit") return "no-mark";
    if (deps.checkReady && terminals.has(id) && !terminals.inputReady(id)) return "starting";
    // A headless worker has no own Continue: the console's go-on (the ticket's button or the
    // auto-continue, headless/wiring.ts) goes one time; a second press in the guard's window
    // reads as "it goes on already".
    const hw = rec.host === "headless" ? headless() : null;
    if (hw?.wentOnLately(id)) return "running";
    const r = await typeIntoAgentWhy(terminals, id, continueText(), deps.sleep);
    if (hw && r === "sent") hw.noteGoOn(id);
    return r;
  });

  const limitOps: LimitAgents = {
    list: () => store.list(),
    load: (id) => store.load(id),
    stopRead,
    logins: limitLogins,
    move: (rec, login) => moveAgent(rec, login === DEFAULT_ACCOUNT ? undefined : login),
    waitsToMove: (id) => { pruneMoveWaits(); return moveWaits.has(id); },
    goOn: goOnAfterLimit,
    onRemoved: (fn) => { removedFns.add(fn); return () => { removedFns.delete(fn); }; },
  };

  return { removeAgent, checkWaiting, limitOps };
}
