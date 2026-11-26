// server/index.ts
import Fastify from "fastify";
import next from "next";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { parseMounts } from "./health/sys.js";
import websocket from "@fastify/websocket";
import { EventHub } from "./events.js";
import { registerAuth } from "./auth.js";
import { registerOriginGuard } from "./origin.js";
import { collectRoutes, readTestSeams, writeRouteDump } from "./testseams.js";
import { installProxyGate, listenProxy, localAddressIn, readProxySettings, registerDeviceGate, registerProxyHeaderStrip, devListenerRefusal, type ProxyListener } from "./frontproxy.js";
import { registerApi } from "./api.js";
import { registerFilesApi } from "./files/api.js";
import { editorOff, startCodeServer, registerEditorProxy } from "./codeserver.js";
import { SessionStore } from "./agents/store.js";
import {
  AGENT_DTACH_DIR_RESOLVED, agentSessionName, TerminalManager, helperAgentEnv, probedAgentExec, scrollbackDirFor, type AgentExec,
} from "./agents/terminal.js";
import { registerAgentApi, makeRecoveryCtx } from "./agents/api.js";
import { WidgetStore } from "./widgets/store.js";
import { AgentTyper } from "./widgets/agent.js";
import { registerWidgetsApi } from "./widgets/api.js";
import { resolveWidgetsDataDir } from "./widgets/paths.js";
import { reconcileAgents, resumeAgent } from "./agents/recovery.js";
import { startDeadAgentSweep } from "./agents/sweep.js";
import { agentExitHandler } from "./agents/exit.js";
import { reopenIfClosed, resumeClosedWithPrompt, startClosedPurge } from "./agents/closed.js";
import { getUsage, peekUsage, registerUsageApi, usageWithin } from "./usage.js";
import { fixedPlaces, makeHealth, registerHealthApi } from "./health/api.js";
import { registerBrowseApi } from "./files/browse.js";
import { auditGit, auditTmpDirs, liveUse, livePid, registerAuditApi, systemMarks, systemMeasure, systemMeasureChildren } from "./audit/api.js";
import { Audit } from "./audit/audit.js";
import { wideFor } from "./files/wide.js";
import { accessTokenFor, accountPaths, claudeJsonPath, loadDefaultLogin, loadSignedOut, loginInPlaceOf, markSignedOut } from "./agents/accounts.js";
import { LoginHold } from "./agents/loginhold.js";
import type { WaitedStarts } from "./chief/chiefwait.js";
import { trustClaudeDir } from "./agents/runtimes/claude-trust.js";
import { watchHomeDialogs } from "./chief/hometrust.js";
import { registerTerminalWs } from "./agents/ws.js";
import { Notifier, telegramSender } from "./agents/notifier.js";
import { ServiceStore } from "./services/store.js";
import { createServiceManager, svcTermId } from "./services/manager.js";
import { registerServiceApi } from "./services/api.js";
import { retirePriceServices } from "./services/retire.js";
import { registerPrApi } from "./pr/api.js";
import { registerGhPrApi } from "./gh/pr.js";
import { registerGhStatusApi } from "./gh/status.js";
import { registerGhCockpitApi } from "./gh/cockpit.js";
import { mergePullRequest, registerGhActionsApi } from "./gh/actions.js";
import { registerGhCiApi } from "./gh/ci.js";
import { registerCronApi } from "./cron/api.js";
import { DRAFT_MODEL } from "./cron/draft.js";
import { ensureSpoolDir, spoolRoutes } from "./cron/spool.js";
import { retireCronMaster } from "./cron/retire.js";
import { recurringRunsNow } from "./cron/running.js";
import { resolveCronDataDir } from "../bin/lib/cronspec.js";
import { makeSpawnDeps, spawnAgent } from "./agents/spawn.js";
import { listRepos } from "./agents/repos.js";
import { removeWorktree, worktreeHeadBranch } from "./agents/worktree.js";
import { agentOpenPr, fetchPrMergeFacts } from "./gh/status.js";
import { gh, ghJson } from "./gh/exec.js";
import { listRepos as listGhRepos } from "./gh/repos.js";
import { registerSettingsApi } from "./settings/api.js";
import { registerShareSettings, shareToolFromEnv } from "./settings/share.js";
import { registerVersionApi, registerVersionHeader, versionInfo } from "./release.js";
import { BotCheck, testTelegramApi } from "./settings/telegram.js";
import { consoleStepProbes, makesStale, registerSetupApi } from "./setup/api.js";
import { registerSetupActions, type SetupLogin } from "./setup/actions.js";
import { FirstAgent } from "./setup/firstagent.js";
import { GithubLogin } from "./setup/ghlogin.js";
import { githubAppConfig } from "./gh/appconfig.js";
import { GithubApp } from "./gh/applogin.js";
import { TokenFile } from "./gh/appstore.js";
import { appTokenView, registerGithubAppApi } from "./gh/appapi.js";
import { readRecurring, USED_DAYS, usedRepos } from "./gh/appused.js";
import { listAppRepos } from "./gh/apprepos.js";
import { setupGitForApp } from "./gh/appsetup.js";
import { setGithubTokenSource } from "./gh/handoff.js";
import { consoleAddress, pushRepos } from "./setup/probes.js";
import { RepoPick } from "./setup/repopick.js";
import { guideDir, guideOn, registerGuideApi } from "./guide/api.js";
import { Guide } from "./guide/guide.js";
import { limitUntil, makeGuideModel } from "./guide/model.js";
import { envFilePath, loadTestEnvFile } from "./settings/envfile.js";
import { systemdRestarter } from "./settings/setup.js";
import { deployUnit } from "./chief/deploy/config.js";
import { IssueStore } from "./issues/store.js";
import { resolveIssuesDataDir, parseIssuesUserId } from "./issues/paths.js";
import { createTelegramClient } from "./issues/telegram.js";
import { IssueActions } from "./issues/actions.js";
import { IssueIntake } from "./issues/intake.js";
import { IssueRelay } from "./issues/relay.js";
import { IssuePoller, linkOnlyPoller } from "./issues/poller.js";
import { Coalescer } from "./issues/coalesce.js";
import { handleReply, typeIntoAgent, withTypingLock } from "./issues/reply.js";
import { ComposerGate, registerComposerApi } from "./agents/composer.js";
import { PromptWatcher } from "./agents/prompt-watch.js";
import { registerPromptApi } from "./agents/prompt-api.js";
import { makeDispatcher } from "./issues/dispatch.js";
import { guessRepo } from "./issues/guess.js";
import { ActedLog } from "./master/acted.js";
import { EventQueue, requeueDigest } from "./master/events.js";
import { InputTracker, pressesEnter } from "./master/draft.js";
import { MasterInbox } from "./master/inbox.js";
import { UserPresence, masterQueueEcho, quietWindows } from "./master/quiet.js";
import { MasterBridge, QUEUED_TEXT, cardChatOf, makePhotoSaver, makeSetupLogger, parseMasterTgConfig, routeMasterUpdate } from "./master/telegram.js";
import { moveCards } from "./chief/queue/cardmove.js";
import { registerMasterApi } from "./master/api.js";
import { ensureFleetMaster, ensureFleetMasterAtBoot, FLEET_MASTER_ID } from "./master/master.js";
import { AgentLoginStatus, agentAuthOf, agentClaudeRun, agentGitIdentity, agentLoginStatus, chiefAuthOf, agentGitSafe } from "./agents/agentlogin.js";
import { shareCommitName } from "./setup/commitname.js";
import { isClone, setCloneExec } from "./agents/agentclone.js";
import { setTranscriptReaders } from "./agents/sessionread.js";
import { masterPaths, resolveMasterDataDir } from "./master/paths.js";
import { registerCoordinatorApi } from "./coordinator/api.js";
import { ensureCoordinator } from "./coordinator/coordinator.js";
import { catchUp, makeCoordinatorFeed, NO_EVENTS, type CoordinatorFeed } from "./coordinator/feed.js";
import { registerCoordinatorGate } from "./coordinator/gate.js";
import { registerStrongAccess } from "./chief/access.js";
import { COORDINATOR_ID, coordinatorPaths, resolveCoordinatorDataDir } from "./coordinator/paths.js";
import { chiefFlag } from "./chief/paths.js";
import {
  agentRoots, captureDeps, deleteExpiredPairMessage, loadCardIndex, makeAutoAnswer, makeChiefCore, makeDistillRunner, queueAddDeps,
  relayQueueAdd, runAgentBoot, runChiefBoot, runChiefPreReconcile, startCardPoster, weekCounts,
} from "./chief/boot.js";
import { AreaStore } from "./chief/leads/areas.js";
import { registerLeadsApi } from "./chief/leads/api.js";
import { openItemOf } from "./chief/leads/close.js";
import { bootLeads, ensureLead, ensureLeadRuntimes, holdOnRelaunch, LeadRuntimes, masterAccept, type LeadDeps } from "./chief/leads/lead.js";
import { registerChiefApi } from "./chief/api.js";
import { BoxCodes, firstRunOn, newInstall, registerFirstRun } from "./chief/firstrun.js";
import { ClaimLinks } from "./chief/claimlink.js";
import { addDeviceOn, registerAddDevice } from "./chief/adddevice.js";
import { registerDeployApi } from "./chief/deploy/api.js";
import { makeDeployService } from "./chief/deploy/boot.js";
import type { DeployService } from "./chief/deploy/service.js";
import { UpdateService } from "./update/service.js";
import { updatePaths } from "./update/status.js";
import { registerBrainApi } from "./chief/brain/api.js";
import { RuleSuggester } from "./chief/brain/suggest.js";
import { makeClaudeRun, type ClaudeRun } from "./chief/brain/distill.js";
import { startDailyCompaction } from "./chief/brain/store.js";
import { CardIndex } from "./chief/cards.js";
import { claudeRuntime } from "./agents/runtimes/claude.js";
import { bootRelaunch, busyNow, registerRelaunchRoute, relaunchForChief, restartSession, RelaunchRetry, type ChiefRelaunchCtx } from "./chief/relaunch.js";
import { ChiefTelegram } from "./chief/telegram.js";
import { HardenedMonitor, codeRouteGate, hardenedDeployment, parseAgentUid, setAgentHelper } from "./chief/hardened.js";
import { chiefAccount, chiefFacts, chiefMisconfigured, chiefWanted, chiefTestSwitch } from "./chief/chiefaccount.js";
import { ChiefWait, startWaited } from "./chief/chiefwait.js";
import { filesGuard, registerCodeRouteGate } from "./chief/coderoutes.js";
import { wsUserOk, armCodeRouteGate, echoFirstProtocol, terminalWsGate } from "./chief/wsgate.js";
import { agentHomeRoot, persistentHome, writeHomeFile, setChiefGitSafe } from "./chief/homes.js";
import { QueueActions } from "./chief/queue/actions.js";
import { AuditLog } from "./chief/queue/auto.js";
import { addItem } from "./chief/queue/add.js";
import { registerQueueApi } from "./chief/queue/api.js";
import { Deliverer } from "./chief/queue/deliver.js";
import { resumeClosedFor, resumeFor } from "./chief/remind/deliver.js";
import { setupReminders } from "./chief/remind/setup.js";
import type { CardPoster } from "./chief/queue/poster.js";
import { PrWatch } from "./chief/queue/prwatch.js";
import { QueueMerge } from "./chief/queue/merge.js";
import { QueueShare } from "./chief/queue/share.js";
import { prMergeState } from "./chief/queue/prgate.js";
import { DISPLAY_NAME } from "./brand.js";
import { namesDecision } from "./names.mjs";
import { resolveAppDataDir, resolveClaudeBin, resolveWorkspaceDir } from "./defaults.js";
import { agentDataDir, servicesDataDir, settingsFile } from "./layout.js";

const PORT = Number(process.env.PORT ?? 3000);
// The catch-all that hands every address with no route of its own to the page server.
const PAGE_ROUTE = "/*";
const dev = process.env.NODE_ENV !== "production";

async function main() {
  // The test settings of the route walk (server/testseams.ts): a loud stop without CHIEF_TEST=1.
  const seams = readTestSeams(process.env);
  // Which version runs and how this console was installed: read once (server/release.ts).
  const ownVersion = versionInfo(process.cwd());
  if ("refused" in seams) {
    console.error(`Refusing to start: ${seams.refused}.`);
    process.exit(1);
  }
  // A CHIEF_TEST instance reads its Telegram set-up file now, as systemd does for the live .env.
  await loadTestEnvFile(process.env);
  const SECRET = process.env.CONSOLE_COOKIE_SECRET ?? "";
  const WEAK = new Set(["", "change-me", "at-least-32-chars-of-random-secret-here", "dev-secret"]);
  if (WEAK.has(SECRET)) {
    console.error("Refusing to start: set CONSOLE_COOKIE_SECRET to a strong, non-default value.");
    process.exit(1);
  }

  const hub = new EventHub();
  const store = new SessionStore(agentDataDir(process.env, process.cwd()));
  // The default login that the user picked on the page (Settings, Claude accounts): read before
  // any agent starts. The agent routes write the same file.
  await loadDefaultLogin(join(resolveAppDataDir(), "default-login.json"));
  // The logins that Claude reported as signed out (accounts.ts): not picked for an agent.
  await loadSignedOut(join(resolveAppDataDir(), "logins-signed-out.json"));
  // Chief of staff (spec 2026-11-08-chief-of-staff): built only with
  // CHIEF_ENABLED=1. With the flag off `chief` is undefined and no chief line
  // below runs. The pairing TTL timer reads `issuesTg` (declared further down)
  // lazily; no code is minted before listen.
  const chief = chiefFlag(process.env)
    ? makeChiefCore(process.env, { agents: store, hub, onPairExpire: deleteExpiredPairMessage(() => issuesTg) })
    : undefined;
  // The chief's Telegram side, built once the Master topic config is known
  // (below). The composer route is registered before that, so every chief
  // consumer posts its cards through this variable, read at post time.
  let chiefTg: ChiefTelegram | undefined;
  // A candidate rule reaches the user as one "Make this a rule?" queue item
  // (brain/suggest.ts): one suggester on the core's stores, synced on each new
  // candidate and answer and every minute (started below, active core only).
  const ruleSuggester = chief ? new RuleSuggester({ rules: chief.rules, store: chief.queue, stateFile: chief.paths.suggest }) : undefined;
  const suggestNow = (): void => { void ruleSuggester?.sync(); };
  // Undefined unless the chief is active: a misconfigured console captures
  // no user line (spec §4.4 fail closed).
  const chiefCapture = chief ? captureDeps(chief, { agents: store, onCandidate: suggestNow }) : undefined;

  // Assigned right after `terminals` so the onExit closure below can delegate to
  // it. Exits never fire before this is set (no PTY is spawned until a route hits).
  let services: ReturnType<typeof createServiceManager>;

  // Ids a chief relaunch is killing on purpose (spec §5.2). The onExit handler
  // and the dead-agent sweep only read it; with it empty both behave as before.
  const relaunching = new Set<string>();

  // Hardened deployment (Phase 2c, spec Appendix B step 3): agent sessions run
  // as CHIEF_AGENT_UID through the choibot-agent-exec helper, once its probe
  // passed. A failed probe logs one line and keeps direct dtach (weak mode).
  // Not hardened: no probe, no await, direct dtach as before.
  const execUid = hardenedDeployment() ? parseAgentUid(process.env.CHIEF_AGENT_UID) : null;
  // Strong protection: what the console writes is never group- or other-writable by its mode (the
  // agents are in the group of the workspace). The checklist assumes the service's umask 022, and
  // the unit sets none: hold it here.
  if (execUid !== null) process.umask(process.umask() | 0o022);
  let agentExec: AgentExec | undefined;
  if (execUid !== null) {
    agentExec = await probedAgentExec({
      sudo: process.env.AGENT_SUDO_BIN ?? "/usr/bin/sudo",
      helper: process.env.AGENT_EXEC_HELPER ?? "/usr/local/bin/choibot-agent-exec",
      uid: execUid,
    });
    setAgentHelper(agentExec !== undefined);
  }
  // The second account of strong protection (chief/chiefaccount.ts): the persistent agents run
  // as their own uid, through the same helper, probed as that uid. Asked for but broken, or its
  // probe failed: no exec, and those agents are refused (never run as the workers' account).
  const persistentAccount = agentExec !== undefined ? chiefAccount() : null;
  let chiefExec: AgentExec | undefined;
  if (agentExec !== undefined && chiefWanted()) {
    const why = chiefMisconfigured();
    if (why !== null) console.warn(`[chief] the persistent agents' account is not used: ${why}`);
    else if (persistentAccount) {
      chiefExec = await probedAgentExec({ ...agentExec, uid: persistentAccount.uid }, {
        log: (s) => console.warn(s.replace("agent exec unavailable", "the persistent agents' exec unavailable")),
      });
    }
  }
  // Design B of strong protection (agents/agentclone.ts): with the helper, each new agent of a repo
  // works in its own clone, made as the agent.
  setCloneExec(agentExec ?? null);
  // The agents' session files (their threads, stop reasons, subagents): with strong protection the
  // console cannot open them; each account's helper reads them as that account (agents/sessionread.ts).
  setTranscriptReaders({ agent: agentExec ?? null, chief: chiefExec ?? null });
  // Each home of the second account named safe in that account's own git config (chief/homes.ts).
  setChiefGitSafe(chiefExec ? (dir) => agentGitSafe(chiefExec!, dir) : null);
  // Strong protection with its helper ready: the one Claude login is the agents' own, made and
  // read from the page through the helper (agents/agentlogin.ts). Otherwise null: as before.
  const agentAuth = agentExec !== undefined ? agentAuthOf(process.env, agentExec) : null;
  // Its status, read through the helper and kept for a short time: the list of logins and the
  // Set-up step share one reader.
  const agentStatus = agentAuth ? new AgentLoginStatus(() => agentLoginStatus(agentAuth)) : null;
  // The second sign-in (chief/chiefaccount.ts): the persistent agents' own Claude login, made and
  // read through their own helper. While it is not there they WAIT (chief/chiefwait.ts): no
  // session starts, nothing fails. Only when the second account is asked for.
  const chiefAuth = chiefAuthOf(process.env, chiefExec);
  const chiefStatus = chiefAuth ? new AgentLoginStatus(() => agentLoginStatus(chiefAuth)) : null;
  // Why the server cannot make the second sign-in (null: it can): its settings, or its helper.
  const chiefProblem = (): string | null => chiefMisconfigured() ?? (chiefAuth ? null : "the helper of the second account did not answer its probe");
  // The test switch of the real proof (chief/chiefaccount.ts chiefTestSwitch): only on a test
  // instance, and loud while it is on.
  const testSwitch = chiefTestSwitch();
  if (testSwitch === "ignored") console.warn("[chief] CHIEF_TEST_START_UNSIGNED is ignored: it works only on a test instance (CHIEF_TEST=1)");
  if (testSwitch === "on" && chiefWanted()) {
    console.warn("[chief] TEST SWITCH ON (CHIEF_TEST_START_UNSIGNED=1): the fleet master, the leads and the Coordinator start WITHOUT the second sign-in. Never on a real install.");
  }
  const chiefWait = chiefWanted() && hardenedDeployment()
    ? new ChiefWait({ signedIn: async () => testSwitch === "on" || (chiefStatus ? (await chiefStatus.read()).loggedIn : false), cause: chiefProblem })
    : undefined;
  // The persistent agents that a "Sign out" stopped wait for a login (agents/loginhold.ts): the
  // login is signed in again, or (basic protection) another login works that they move to.
  const loginHold = new LoginHold({
    file: join(resolveAppDataDir(), "logins-held.json"),
    canStart: async (login) => (agentStatus ? (await agentStatus.read()).loggedIn
      : (await accessTokenFor(login)) !== null || (await loginInPlaceOf(login)) !== null),
  });
  await loginHold.load();
  // A persistent agent waits for a login: the second sign-in (chiefWait) or a sign-out's hold.
  const waitsForLogin = (id: string): boolean => chiefWait?.waitsFor(id) === true || loginHold.waitsFor(id);
  // That wait is for a login that was signed out on the page (the page says so), not the second sign-in.
  const waitsLogin = (id: string): boolean => loginHold.waitsFor(id) && chiefWait?.waitsFor(id) !== true;
  // The agents that a sign-out ends in silence (agents/exit.ts `quiet`, agents/api.ts).
  const quietExits = new Set<string>();
  // The console's own model calls (the guide, Fill in, the clean-up words, the Brain review): with
  // no tool, on the one login. Strong protection: through the helper, on the agents' login.
  const modelRun = (): { run: ClaudeRun; agentLogin: boolean } =>
    agentAuth ? { run: agentClaudeRun(agentAuth), agentLogin: true } : { run: makeClaudeRun(resolveClaudeBin()), agentLogin: false };

  // The prompt card's screen reader (agents/prompt-watch.ts): one headless
  // terminal per live agent PTY, and an `agent-prompt` event when the dialog an
  // agent waits on changes. AGENT_PROMPT_WATCH=0 turns it off: no screen is
  // kept, the prompt routes then report no prompt.
  const promptWatcher = new PromptWatcher({ emit: (e) => hub.emitEvent(e) });
  const promptWatch = !["0", "false"].includes(process.env.AGENT_PROMPT_WATCH ?? "");

  // PTY exit → terminal forgotten by the manager; reflect it as status + persist.
  const terminals = new TerminalManager({
    onExit: agentExitHandler({
      services: () => services, store, hub, relaunching, quiet: quietExits,
    }),
    dropUserToken: chief?.active,
    agentExec,
    chiefExec,
    agentEnv: agentExec ? helperAgentEnv(agentHomeRoot(), resolveCronDataDir()) : undefined,
    // Hardened (ruling F2): every .scrollback in <chief data dir>/scrollback,
    // never in the group-writable dtach dir. Otherwise undefined (as before).
    scrollbackDir: scrollbackDirFor(),
    observer: promptWatch ? promptWatcher : undefined,
  });
  const serviceStore = new ServiceStore(servicesDataDir(process.env, process.cwd()));
  const telegram = (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    ? telegramSender(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID)
    : undefined;
  services = createServiceManager(terminals, serviceStore, hub, {
    notify: telegram ? (text) => { void telegram(text); } : undefined,
  });

  const nextApp = next({ dev });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();
  const upgrade = nextApp.getUpgradeHandler(); // must be after prepare()

  const app = Fastify();
  const routes = seams.routeDump !== null ? collectRoutes(app) : null;
  // The front proxy (a hosted console, server/frontproxy.ts): the gate runs on the HTTP server's
  // own events, before every listener, route and hook. With no proxy settings it only removes the
  // proxy's token header from every request.
  const proxy = readProxySettings(process.env);
  installProxyGate(app.server, proxy !== null && !("off" in proxy) ? proxy.tokenSha256 : null);
  registerProxyHeaderStrip(app);
  // The version for the door, on the private listener's answers only (server/release.ts).
  registerVersionHeader(app, ownVersion);
  // Echo the first offered subprotocol, in every mode (ruling P7): a browser
  // fails the handshake otherwise, and a paired browser offers its user token.
  // None offered → no Sec-WebSocket-Protocol header, as before.
  await app.register(websocket, { options: { handleProtocols: echoFirstProtocol } });
  // Before auth and every route: a cross-origin write or WebSocket upgrade is
  // refused even from loopback (see server/origin.ts).
  registerOriginGuard(app);
  // A new install with no paired device serves the pairing screen and nothing else
  // (chief/firstrun.ts). An install with the old names, or one that pairs through Telegram,
  // registers nothing here.
  if (chief && firstRunOn(chief)) {
    registerFirstRun(app, {
      devices: chief.devices, codes: new BoxCodes(chief.paths.pairCode),
      links: new ClaimLinks({ firstStart: chief.paths.firstStart, state: chief.paths.claimLink }),
      caller: (req) => chief.gate.caller(req), pageRoute: PAGE_ROUTE,
    });
  }
  // The front proxy's deny-by-default: a request over the private listener with no paired device
  // reaches only the app shell and the pairing APIs (server/frontproxy.ts).
  registerDeviceGate(app, {
    kinds: new Set(["proxy"]),
    pageRoute: PAGE_ROUTE,
    proof: chief ? {
      request: async (req) => (await chief.gate.caller(req)).level === "user",
      upgrade: (req) => wsUserOk(req, async (t) => (await chief.devices.verify(t)) !== null),
    } : null,
  });
  registerAuth(app);
  // The Coordinator's allow-list (coordinator/gate.ts), before every route: a request in its
  // name gets the read routes and its three writes only.
  if (chief) registerCoordinatorGate(app);
  // Strong protection: a loopback request proves nothing, so each caller gets the list of its
  // credential, and a caller with none gets only the app's shell and the pairing paths
  // (chief/access.ts). Basic mode registers nothing.
  if (chief) registerStrongAccess(app, { gate: chief.gate, agents: store, queue: chief.queue, pageRoute: PAGE_ROUTE });
  // The code-route gate (Phase 2c, spec §3), before every route: only in a
  // hardened deployment; otherwise nothing is registered.
  let codeRouteHook = false;
  if (chief && hardenedDeployment()) {
    registerCodeRouteGate(app, { gate: chief.gate, agents: store });
    codeRouteHook = true;
  }
  // Its socket half: the user token on the agent, shell and service terminal
  // WebSockets. Undefined unless hardened; then those routes run today's code.
  const termGate = chief ? terminalWsGate({ devices: chief.devices, agents: store }) : undefined;
  registerApi(app, { hub });
  // The files routes' second check (ruling 2c-3-b): filesGuard is undefined
  // unless hardened, and without a guard the routes run today's code.
  registerFilesApi(app, {
    workspaceDir: resolveWorkspaceDir(),
    guard: chief ? filesGuard({ gate: chief.gate }) : undefined,
  });
  // The fleet master's act log: its CLI's stop/resume/delete are not news to it.
  const acted = new ActedLog();
  // Agent widgets (spec 2026-10-22): one folder per agent and widget under
  // WIDGETS_DATA_DIR, made absolute once here. Deleting an agent removes its
  // widget folder. In a hardened deployment (agentExec set after its probe
  // passed) widget scripts run as the agent uid through the helper's `run`.
  const widgets = new WidgetStore(resolveWidgetsDataDir(), { agentExec });
  // Lead areas (spec §13): areas.json, on an active core only. Flag off and
  // misconfigured have none, so an item's area is its repo. Flag off: no lead
  // check runs at all (no chief deps: no area spawn limit, no merge gate).
  // Misconfigured: the chief gate still runs, so a lead spawns no worker
  // (POST /api/agents). `exists` is store.exists (decision 37): a half-written
  // lead record still counts as live.
  const areas = chief?.active
    ? new AreaStore(chief.paths.areas, { exists: (id) => store.exists(id) })
    : undefined;
  const agentApi = registerAgentApi(app, {
    terminals, store, hub, acted, widgets,
    workspaceDir: resolveWorkspaceDir(),
    chief: chief?.gate, areas,
    // A lead's close asks it (spec §13): an active core only.
    openQueueItem: chief?.active ? (id) => openItemOf(chief.queue, id) : undefined,
    // A Claude login from the page ended well: the step "Log in to Claude" is checked again.
    // (`setupSteps` is declared below: a login ends only after listen.)
    onClaudeLogin: () => setupSteps.forget(),
    ...(agentAuth && agentStatus ? { agentAuth, agentStatus } : {}),
    // The second sign-in: its own login flow; when it ends, what waits starts.
    ...(chiefAuth && chiefStatus ? { chiefAuth, chiefStatus } : {}),
    ...(chiefWait ? { chiefWait } : {}),
    loginHold,
    onChiefLogin: () => { setupSteps.forget(); void chiefWait?.signedInNow(); },
    usage: peekUsage,
    usageNow: () => usageWithin(4_000),
    checkReady: chief?.active,
    // An agent with an open ticket that blocks it waits for the user's answer: after a move
    // to another login the console does not tell it to go on.
    waitsForUser: async (agentId) => !!chief?.active
      && (await chief.queue.list()).some((i) => i.agentId === agentId && i.blocking === true && (i.status === "open" || i.status === "snoozed")),
    // A lead or the fleet master moves to another login through the relaunch of the chief of
    // staff, forced (a move is the user's order). Busy now: the retry moves it when it is quiet.
    relaunchPersistent: async (id) => {
      if (!chiefRelaunch) return "failed";
      const r = await relaunchForChief(id, chiefRelaunch.ctx, { force: true });
      if (r.outcome === "retry-on-idle") { chiefRelaunch.retry.arm(id, { force: true }); return "waits"; }
      if (r.outcome !== "relaunched" && r.outcome !== "gone") console.warn(`[accounts] relaunch of ${id} after a login move: ${r.outcome}${r.error ? ` (${r.error})` : ""}`);
      return r.outcome === "relaunched" ? "relaunched" : r.outcome === "gone" ? "gone" : "failed";
    },
    // "Sign out" of a login: a relaunch that waits (its agent still runs on the old login), the
    // busy check of the relaunch, and the Recurring runs in progress.
    relaunchWaits: () => chiefRelaunch?.retry.armed() ?? [],
    agentBusy: (rec) => busyNow(rec, chiefRelaunch?.ctx ?? { terminals, masterHasDraft: () => false }),
    recurringRuns: () => recurringRunsNow(),
    quietExits,
    // The starts of what waited (chief/chiefwait.ts), the same as after the second sign-in.
    startPersistent: (ids) => startWaited(ids, waitedStarts()),
  });
  registerWidgetsApi(app, {
    agents: store, widgets, typer: new AgentTyper({ terminals, checkReady: chief?.active }),
    workspaceDir: resolveWorkspaceDir(),
  });
  // Assigned in the master block below; web input before that is ignored.
  let masterInbox: MasterInbox | undefined;
  // The leads' inboxes (spec §13): an active core only, assigned below.
  let leadRuntimes: LeadRuntimes | undefined;
  // The Coordinator's inbox and feed (server/coordinator): an active core only, assigned below.
  let coordinatorFeed: CoordinatorFeed | undefined;
  // The fleet master's quiet policy (master/quiet.ts): when the user last
  // typed to each agent. An active core only; otherwise nothing is recorded.
  const presence = chief?.active ? new UserPresence() : undefined;
  // USER_PRESENT_MS and BLOCKED_ALERT_MS; shorter only on an isolated test instance (CHIEF_TEST=1).
  const quietMs = quietWindows();
  // Keys the user sends from the browser: the terminal WebSocket, and the
  // prompt card's keys route.
  const onWebInput = (id: string, data: string): void => {
    presence?.mark(id, data);
    masterInbox?.onWebInput(id, data);
    leadRuntimes?.onWebInput(id, data);
    coordinatorFeed?.inbox.onWebInput(id, data);
    // Enter in a closed agent's tab uses it again (also covers a TUI dialog
    // answer, which fires no UserPromptSubmit hook). Only while its session
    // is up: a stopped closed agent has no terminal, and a keypress that
    // races its close must not reopen it. Restarting a stopped one takes
    // Reopen/Resume or a new prompt (see agents/closed.ts).
    if (pressesEnter(data) && terminals.has(id)) {
      void reopenIfClosed({ store, emit: (e) => hub.emitEvent(e) }, id, { liveOnly: true }).catch(() => {});
    }
  };
  registerTerminalWs(app, terminals, {
    gate: termGate, onInput: onWebInput,
    whyNone: async (id) => ((await store.load(id))?.waitsLogin ? "this agent has no session yet: it waits for a Claude login with room" : null),
  });
  // The prompt card (agents/prompt-api.ts): an agent's terminal dialog as
  // data, and the allow-listed keys that answer it.
  registerPromptApi(app, {
    terminals, prompts: promptWatcher, onTyped: onWebInput,
    agentExists: async (id) => (await store.load(id)) !== null,
  });
  // The composer under each agent terminal (spec 2026-11-05-agent-composer).
  // Its typed text counts as web input for the fleet master's inbox.
  const composerGate = new ComposerGate({
    terminals,
    agentExists: async (id) => (await store.load(id)) !== null,
    isBusy: async (id) => (await store.load(id))?.status === "running",
    // The user's own line only (never a queue answer or a reminder the console types).
    onUserLine: (id) => presence?.touch(id),
    onTyped: (id, data) => {
      masterInbox?.onWebInput(id, data);
      leadRuntimes?.onWebInput(id, data);
      coordinatorFeed?.inbox.onWebInput(id, data);
    },
    resumeClosed: (id, text) => resumeClosedWithPrompt({
      store, emit: (e) => hub.emitEvent(e),
      isLive: async (x) => terminals.has(x) || (await terminals.hasSession(x)),
      resume: (rec, o) => resumeAgent(rec, recoveryCtx, o),
    }, id, text),
  });
  registerComposerApi(app, composerGate, chiefCapture?.composer);
  // One recovery ctx, shared by the routes and the boot-time reconcile below.
  const recoveryCtx = makeRecoveryCtx({
    terminals, store,
    workspaceDir: resolveWorkspaceDir(),
    chiefWait, loginHold,
  });
  // The cron spool (Task 2c-8, rulings P4 and P11): hardened only. Agents
  // queue cron changes in <AGENT_HOME_ROOT>/cron-spool, made here at boot;
  // the user applies them in the Agents list's Cron pane. Otherwise no spool route exists.
  const cronSpool = spoolRoutes(chief?.gate);
  const spoolRoot = cronSpool ? agentHomeRoot() : null;
  if (spoolRoot !== null) {
    void ensureSpoolDir(spoolRoot).catch((e) => console.warn(`[cron] spool dir not ready: ${e instanceof Error ? e.message : e}`));
  }
  registerCronApi(app, {
    hub, spool: cronSpool, gate: chief?.gate,
    repos: () => listRepos(resolveWorkspaceDir()),
    // "Fill in" of the task form: the no-tool model of the console, a cheap one, in its own empty folder.
    draft: makeGuideModel({ ...modelRun(), runDir: join(resolveAppDataDir(), "recurring-draft-run"), env: process.env, model: DRAFT_MODEL }),
    // The link of a run to its ticket: only a ticket that this console's queue holds.
    ticket: chief ? async (id) => {
      const item = await chief.queue.get(id);
      return item ? { title: item.title, open: item.status === "open" || item.status === "snoozed" } : null;
    } : undefined,
  });
  registerUsageApi(app);
  // The Server page (health/api.ts): the state of the server, read only, for the paired user.
  registerHealthApi(app, {
    gate: chief?.gate,
    ...makeHealth({
      workDir: resolveWorkspaceDir(),
      agents: () => store.list(),
      sessionName: agentSessionName,
      worktreeDir: process.env.AGENT_WORKTREE_ROOT ?? ".agent-worktrees",
      fixed: fixedPlaces({ env: process.env, checkout: process.cwd(), dataDirs: [resolveAppDataDir(), AGENT_DTACH_DIR_RESOLVED] }),
    }),
  });
  registerServiceApi(app, { services, store: serviceStore, terminals, wsGate: termGate });
  // The Files tab of the Server page (files/browse.ts): every readable file of the server, read
  // only, less the secrets (files/wide.ts). For the paired user only: with no gate, 403.
  const filesWide = wideFor({ env: process.env, checkout: process.cwd(), dtachDir: AGENT_DTACH_DIR_RESOLVED });
  registerBrowseApi(app, {
    gate: chief?.gate, workDir: resolveWorkspaceDir(), envFile: envFilePath(process.env, process.cwd()), wide: filesWide,
  });
  // The clean-up audit of the Server page (audit/api.ts): what could be removed, found by code
  // under the refusal list of the Files tab; the words from a model with no tool. It starts
  // only on the paired user's press. A thing of its list is removed only on the user's press
  // and confirm (audit/remove.ts).
  registerAuditApi(app, {
    gate: chief?.gate,
    audit: new Audit({
      file: join(resolveAppDataDir(), "server-audit.json"),
      model: makeGuideModel({ ...modelRun(), runDir: join(resolveAppDataDir(), "audit-run"), env: process.env, model: "haiku" }),
      deps: async () => ({
        wide: filesWide, workDir: resolveWorkspaceDir(), checkout: process.cwd(),
        // An agent's own clone (strong protection) is not in a folder of copies: not resolved here.
        agents: (await store.list()).filter((a) => a.worktree && a.repo && !isClone(a)).map((a) => ({ id: a.id, title: a.label || "Agent", repo: a.repo, worktree: a.worktree, closed: a.closedAt !== undefined })),
        tmpDirs: auditTmpDirs(process.env, filesWide.home, tmpdir()), uid: process.getuid?.() ?? -1,
        measure: systemMeasure(), measureChildren: systemMeasureChildren(),
        git: auditGit,
        // Is a folder in use? Sockets, pipes, pid and lock files; what the running programs have open.
        marks: systemMarks(), inUse: () => liveUse(process.getuid?.() ?? -1), livePid: (file) => livePid(file),
        // "Remove" on the copy of a closed agent: the same as "Delete the agent".
        deleteAgent: (id) => agentApi.removeAgent(id),
        // "Remove" on a copy that no agent uses: the console's own way (git worktree remove).
        removeWorktree,
        // No answer is a doubt: the read throws, and nothing is removed.
        mounts: () => parseMounts(readFileSync("/proc/mounts", "utf8")).map((m) => m.path),
      }),
    }),
  });
  // Check (4) of chiefHardened: on once both halves of the code-route gate are
  // registered, the hook (above) and the socket checks on the two terminal
  // routes (agents above, services here), and only with the agent
  // exec helper (ruling F3). Never when not hardened.
  armCodeRouteGate({ hook: codeRouteHook, sockets: termGate, agentExec: agentExec !== undefined });
  registerPrApi(app, { workspaceDir: resolveWorkspaceDir(), store });
  // The PR route: the chief gate (the user, or the agent itself); gh of an agent with its own
  // clone runs in a folder of the console's app data dir (in its home, never in a repo).
  registerGhPrApi(app, { store, chief: chief?.gate, ghCwd: join(resolveAppDataDir(), "gh-work") });
  registerGhStatusApi(app, { store });
  registerGhCockpitApi(app, {});
  // The same gate as the agent merge route: both merge routes are gated together.
  // A merge or close made here closes its queue pr item at once (PrWatch, set
  // in the chief block below; overview decision 60).
  let onPrChange: (() => void) | undefined;
  registerGhActionsApi(app, { chief: chief?.gate, onPrChange: () => onPrChange?.() });
  registerGhCiApi(app, {});
  // Not registered in a hardened deployment (editorOff, overview decision 45).
  registerEditorProxy(app);

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const agentTelegram = !["0", "false"].includes(process.env.TELEGRAM_NOTIFY_AGENTS ?? "");
  // Cron results can go to their own forum topic (e.g. the "cron-job" topic).
  const cronChat = process.env.TELEGRAM_CRON_CHAT_ID?.trim();
  const cronThread = Number(process.env.TELEGRAM_CRON_THREAD_ID);
  // A CHIEF_TEST instance may point every Bot API client at a fake (scripts/chief-instance.sh):
  // a loopback origin only, since the token rides in the URL path.
  const tgApiBase = testTelegramApi(process.env);
  const cronTelegram = tgToken && cronChat && Number.isSafeInteger(cronThread) && cronThread > 0
    ? telegramSender(tgToken, cronChat, cronThread, tgApiBase) : undefined;
  const notifier = new Notifier(
    hub,
    tgToken && tgChat ? telegramSender(tgToken, tgChat, undefined, tgApiBase) : undefined,
    (id) => store.load(id),
    // The link of a run's message to its task page: the console's address, with the chief on.
    { agentTelegram, cronTelegram, ...(chief?.consoleUrl ? { consoleUrl: chief.consoleUrl } : {}) },
  );
  notifier.start();

  // Issues: a Telegram issue → one-tap agent → PR. The store and the relay
  // always run; the fleet master and the leads read the store. Telegram
  // intake (the poller) needs both TELEGRAM_BOT_TOKEN and TELEGRAM_ISSUES_USER_ID.
  const issuesWorkspace = resolveWorkspaceDir();
  // The ChoiBot GitHub app login: only with GITHUB_APP_LOGIN=1 and a client id (off by default).
  // Then the console's own gh and git calls use the app's token once it is connected, and the
  // Set-up step and its repo list are the app's; the agents' own gh login does not change.
  const githubAppOn = githubAppConfig(process.env);
  const githubApp = githubAppOn ? new GithubApp({
    clientId: githubAppOn.clientId,
    store: new TokenFile(join(resolveAppDataDir(), "github-app")),
    // git uses gh's helper (with the app's token), then the lists are read again.
    onDone: () => { void setupGitForApp().finally(() => { setupRepos.forget(); setupSteps.forget(); settings.forgetGithub(); }); },
  }) : null;
  if (githubApp && githubAppOn) {
    setGithubTokenSource(() => githubApp.token());
    registerGithubAppApi(app, {
      gate: chief?.gate, login: githubApp,
      onChange: () => { setupRepos.forget(); setupSteps.forget(); settings.forgetGithub(); },
      // Settings: the repos the app reaches, and the ones the agents used in the last 14 days.
      repos: {
        reach: () => listAppRepos({ token: () => githubApp.token() }), appUrl: githubAppOn.appUrl, days: USED_DAYS,
        used: async () => usedRepos({
          agents: await store.list(), recurring: await readRecurring(),
          tickets: chief ? await chief.queue.list() : [], workspace: await listGhRepos(issuesWorkspace), now: Date.now(),
        }),
      },
    });
    app.addHook("onClose", async () => githubApp.stop());
    console.warn("[github] GITHUB_APP_LOGIN=1: the console's own GitHub calls use the ChoiBot app's token once it is connected");
  }
  // The Settings page's add-on status (Telegram, GitHub) and its test message (USER only).
  // `setupSteps` is declared just below: a link action comes only after listen.
  const settings = registerSettingsApi(app, {
    linkStateFile: chief && join(chief.paths.root, "telegram-link.json"),
    onLinkChange: () => setupSteps.forget(),
    env: process.env,
    chief: chief && { gate: chief.gate, active: chief.active, devices: chief.devices },
    telegram: { apiBase: tgApiBase },
    gh: (args) => gh(args),
    ghRepos: () => listGhRepos(issuesWorkspace),
    ...(githubApp ? { githubApp: async () => appTokenView(await githubApp.tokenState(), Date.now()) } : {}),
    envFile: envFilePath(process.env, process.cwd()),
    restarter: systemdRestarter(deployUnit(process.env)),
    bootAt: Date.now() - Math.round(process.uptime() * 1000),
  });
  // "Share outside" (an add-on): the share tool the user sets in Settings, used by the queue's
  // share routes below. Off until set; a save applies at once.
  const shareTool = shareToolFromEnv(process.env);
  registerShareSettings(app, { setting: shareTool, envFile: envFilePath(process.env, process.cwd()), gate: chief?.gate });
  // Which version runs (Settings, "Version"; the updater's check after a start): read once, now.
  registerVersionApi(app, ownVersion);
  // The login of the Set-up step: the app's, or gh's own (below).
  const stepLogin = (): SetupLogin => (githubApp ? { state: () => githubApp.loginState(), start: (o) => githubApp.start(o) } : setupLogin);
  // The set-up steps and their state (setup/steps.ts): the list `doctor` prints, for the browser.
  const setupBot = new BotCheck({ apiBase: tgApiBase });
  const setupSteps = registerSetupApi(app, {
    newInstall: newInstall(),
    ...(githubAppOn ? { githubApp: true } : {}),
    strong: () => chief?.hardened() === true,
    probes: () => consoleStepProbes({
      env: process.env, repoDir: process.cwd(), agents: store, agentStatus: agentStatus ? () => agentStatus.read() : null,
      ...(githubApp ? { githubApp: () => githubApp.tokenState() } : {}),
      ...(chiefWait ? { persistent: { status: chiefStatus ? () => chiefStatus.read() : null, waits: () => chiefWait.waits(), problem: chiefProblem } } : {}),
      chief: chief && { problem: chief.misconfigured, devices: chief.devices, queue: chief.queue },
      areas, bot: (token) => setupBot.info(token),
      link: settings.link ? async () => (await settings.link!.view()).account : undefined,
    }),
  });
  // A pull request ticket changed: the next read of the list checks again (setup/api.ts makesStale).
  hub.subscribe((e) => { if (makesStale(e)) setupSteps.forget(); });
  const issuesDir = resolveIssuesDataDir();
  const issueStore = new IssueStore(issuesDir, (issue) => hub.emitEvent({ type: "issue", issue }));
  const issuesUserId = parseIssuesUserId(process.env.TELEGRAM_ISSUES_USER_ID);
  const issuesTg = tgToken && issuesUserId ? createTelegramClient({ token: tgToken, baseUrl: tgApiBase }) : undefined;
  const spawnDeps = makeSpawnDeps({ terminals, store, hub, workspaceDir: issuesWorkspace, usage: () => usageWithin(4_000) });
  // The actions of the Set-up page (USER only). Nothing of them runs until the user presses.
  const setupRepos = new RepoPick({
    workspaceDir: issuesWorkspace,
    ...(githubApp && githubAppOn ? { app: { repos: () => listAppRepos({ token: () => githubApp.token() }), appUrl: githubAppOn.appUrl } } : {}),
    // The first task uses the repo the user picked.
    onDone: (name) => { setupSteps.forget(); void setupFirst.picked(name).catch(() => {}); },
  });
  const setupLogin = new GithubLogin({ onDone: () => { setupRepos.forget(); setupSteps.forget(); settings.forgetGithub(); } });
  const setupFirst = new FirstAgent({
    file: join(resolveAppDataDir(), "setup", "first-agent.json"),
    agents: store,
    // The repos of the "Pick a repo" check: the ones GitHub lets the login push to.
    repos: async () => (await pushRepos(process.env)).names.map((name) => ({ name, path: join(issuesWorkspace, name) })),
    spawn: (req) => spawnAgent(spawnDeps, req),
    tickets: async () => (chief ? chief.queue.list() : []),
    changed: () => setupSteps.forget(),
  });
  // Strong protection: the agents commit under their own account, with the user's commit name.
  const agentIdentity = agentAuth ? (name: string, email: string) => agentGitIdentity(agentAuth, name, email) : undefined;
  registerSetupActions(app, {
    gate: chief?.gate, login: stepLogin(), repos: setupRepos, first: setupFirst, changed: () => setupSteps.forget(),
    ...(githubAppOn ? { githubApp: { appUrl: githubAppOn.appUrl } } : {}),
    ...(agentIdentity ? { agentIdentity } : {}),
  });
  // Once at start, for a name that the console had before (no log line when it has none yet).
  if (agentIdentity) void shareCommitName(agentIdentity).catch(() => false);
  app.addHook("onClose", async () => setupLogin.stop());
  // The guide of a new install (guide/guide.ts): a model with no tool that works on the list
  // with the paired user. An install with the old names has no guide: no route, no model.
  if (guideOn({ newInstall: newInstall(), gate: chief?.gate })) {
    const dir = guideDir(resolveAppDataDir());
    registerGuideApi(app, {
      gate: chief?.gate,
      guide: new Guide({
        dir,
        steps: async (o) => { if (o?.fresh) setupSteps.forget(); return (o?.fresh ? await setupSteps.read() : setupSteps.last() ?? await setupSteps.read()).steps; },
        facts: async () => ({ login: stepLogin().state(), clone: setupRepos.cloneState(), first: await setupFirst.view().catch(() => null) }),
        model: makeGuideModel({ ...modelRun(), runDir: join(dir, "run"), env: process.env }),
        limitUntil: async () => limitUntil(await getUsage(), Date.now()),
      }),
    });
  }
  const issueRepoNames = async () => (await listRepos(issuesWorkspace)).map((r) => r.name);
  const issueActions = new IssueActions({
    store: issueStore,
    dispatch: makeDispatcher({
      spawn: (req) => spawnAgent(spawnDeps, req),
      listRepos: () => listRepos(issuesWorkspace),
    }),
    ...(issuesTg && issuesUserId ? { tg: issuesTg, chatId: issuesUserId } : {}),
    listRepoNames: issueRepoNames,
  });
  const issueIntake = new IssueIntake({
    store: issueStore, actions: issueActions, tg: issuesTg,
    listRepoNames: issueRepoNames,
    guess: (text, repos) => guessRepo(text, repos),
  });
  // The chief queue's add deps (spec §5.1–§5.3), for the relay hook here and
  // for POST /api/queue and PrWatch in the chief block below. The agent roots
  // (where a preview's agent cwd may sit) are built once, here.
  const queueEnv = { agents: store, workspaceDir: issuesWorkspace, agentRoots: agentRoots(issuesWorkspace), areas };
  new IssueRelay({
    hub, store: issueStore, actions: issueActions, agents: store,
    findPr: (rec) => agentOpenPr(rec, ghJson),
    headBranch: worktreeHeadBranch,
    // A `pr` item per PR an issue agent opens: an active core only. Its digest
    // line goes to `fleetEvents` (declared below; used only once a hook fires).
    queueAdd: chief && relayQueueAdd(chief, queueAddDeps(chief, queueEnv), {
      addQueue: (...a) => fleetEvents.addQueue(...a),
      prWithoutItem: (...a) => fleetEvents.prWithoutItem(...a),
    }),
  }).start();

  // Fleet master (spec 2026-10-15): event digest + inbox + optional Telegram
  // topic. The master itself is created lazily by POST /api/master or by the
  // first Telegram message; boot only repairs an existing one (below).
  const masterDataDir = resolveMasterDataDir();
  // Its photo inbox: the legacy one, or in a hardened deployment the
  // agent-owned one in AGENT_HOME_ROOT (Task 2c-7), written with group modes.
  const fleetLegacy = masterPaths(masterDataDir);
  const fleetInbox = persistentHome("fleet-master", { legacy: fleetLegacy }).inboxDir ?? fleetLegacy.inboxDir;
  const fleetInboxWrite = agentHomeRoot() !== null ? writeHomeFile : undefined;
  // True once the fleet master exists (record at boot, or created by
  // ensureFleet). Until then the inbox's 1 s tick does nothing.
  let fleetKnown = false;
  // The Coordinator (server/coordinator, user pick A of 2026-11-20): with an active core it
  // reads the fleet digest in place of the master. Decided once, here, for the whole run of
  // this process: no event has two readers and none has no reader.
  const coordinatorOn = chief?.active === true;
  const coordinatorDataDir = resolveCoordinatorDataDir();
  // Single-flight (coordinator.ts). The feed is assigned below, before anything can call this.
  const ensureCoord = async (): Promise<void> => {
    const feed = coordinatorFeed;
    if (!feed) return;
    await ensureCoordinator({
      store, recoveryCtx, dataDir: coordinatorDataDir,
      markStarting: () => feed.starting(),
      isLive: async () => terminals.has(COORDINATOR_ID) || (await terminals.hasSession(COORDINATOR_ID)),
    });
    feed.markKnown();
  };
  // `inbox` is assigned just below; ensureFleet only runs after boot.
  const ensureFleet = async () => {
    // A cold spawn: Claude's TUI is not in raw/bracketed-paste mode until its
    // SessionStart hook, so hold the inbox busy until then (3 min bound).
    // A surviving dtach session is a reattach to a running TUI: no hold.
    if (!terminals.has(FLEET_MASTER_ID) && !(await terminals.hasSession(FLEET_MASTER_ID))) inbox.markStarting();
    const id = await ensureFleetMaster({ store, recoveryCtx, masterDataDir });
    fleetKnown = true;
    // The Coordinator starts with the Master (and by itself when an event waits, feed.ts).
    if (coordinatorFeed && !terminals.has(COORDINATOR_ID)) {
      void ensureCoord().catch((e) => console.warn("[coordinator] start failed:", e instanceof Error ? e.message : e));
    }
    return id;
  };
  const masterCfg = issuesTg ? parseMasterTgConfig(process.env, issuesUserId) : null;
  // One runtime (inbox + event queue) per lead, with `areas` only: the master
  // queue drops a live lead's workers' events, which that lead's queue takes,
  // and copies their queue items to it. Flag off and misconfigured: as before.
  if (areas) leadRuntimes = new LeadRuntimes({ hub, agents: store, issues: issueStore, acted, terminals, areas });
  const leads = leadRuntimes;
  const fleetEvents = new EventQueue({
    hub, agents: store, issues: issueStore, acted,
    // Every run of a recurring task is one digest line with its state (the reader: the master,
    // or the Coordinator with the chief of staff active).
    cron: true,
    ...(areas && leads ? { accept: masterAccept(areas), leads: { get: (id: string) => leads.get(id)?.events } } : {}),
    // The quiet policy (order of 2026-11-10): an active core only, and only
    // the master's queue; a lead's queue (LeadRuntimes) never gets it.
    ...(chief && presence ? {
      quiet: {
        blockedMs: quietMs.blockedMs,
        userPresent: (id: string) => presence.recent(id, quietMs.presentMs),
        queueEcho: masterQueueEcho({ queue: chief.queue, rules: chief.rules }),
      },
    } : {}),
  });
  // ensureLead's deps (spec §13): the boot repair below and the lead routes.
  const leadDeps: LeadDeps | undefined = chief && areas && leads ? {
    store, recoveryCtx, chiefDir: chief.paths.root, areas, terminals, markStarting: (id) => leads.markStarting(id),
  } : undefined;
  let masterBridge: MasterBridge | undefined;
  // Hub unsubscribers of the event queue and the bridge, called on shutdown.
  let stopFleetEvents: (() => void) | undefined;
  let stopMasterBridge: (() => void) | undefined;
  if (coordinatorOn) {
    coordinatorFeed = makeCoordinatorFeed({
      hub, events: fleetEvents, terminals, file: coordinatorPaths(coordinatorDataDir).feed, ensure: ensureCoord,
      dialog: () => terminals.dialogOn(COORDINATOR_ID),
    });
  }
  // Kept for the chief relaunch's draft guard (masterHasDraft below).
  const tracker = new InputTracker();
  const inbox: MasterInbox = new MasterInbox({
    // With the Coordinator the master's inbox carries the user's lines, the answers to its own
    // tickets and its reminders, and never a digest.
    hub, events: coordinatorFeed ? NO_EVENTS : fleetEvents, tracker,
    // Under the PTY's typing lock, with the block re-checked inside it: a
    // composer send that landed after tick()'s check wins (agents/composer.ts).
    send: (text): Promise<boolean> => withTypingLock(FLEET_MASTER_ID, async (): Promise<boolean> =>
      (inbox.blockedBy() ? false : typeIntoAgent(terminals, FLEET_MASTER_ID, text))),
    ready: () => fleetKnown || terminals.has(FLEET_MASTER_ID),
    // It waits for the second sign-in: nothing is sent, every message is kept (chief/chiefwait.ts).
    waits: () => waitsForLogin(FLEET_MASTER_ID),
    onQueued: (reason) => {
      void masterBridge?.post(QUEUED_TEXT[reason]).catch((e) => console.warn("[master] queued notice:", e));
    },
  });
  masterInbox = inbox;
  registerMasterApi(app, {
    ensure: ensureFleet,
    // While it waits for the second sign-in, the Master tab keeps a message for its start.
    waits: () => waitsForLogin(FLEET_MASTER_ID),
    waitsLogin: () => waitsLogin(FLEET_MASTER_ID),
    keep: (text) => { void inbox.pushConsole(text, "tab").catch((e) => console.warn("[master] kept message not delivered:", e)); },
    status: () => ({
      queuedEvents: coordinatorFeed ? 0 : fleetEvents.size(), queuedMessages: inbox.queuedMessages(),
      telegram: Boolean(masterCfg), surface: inbox.surface,
      // The Coordinator reads the events: the Master tab's status line shows no event count.
      ...(coordinatorFeed ? { coordinator: true } : {}),
      // The Master tab folds the master's `(quiet)` turns only with the policy on.
      ...(presence ? { quiet: true } : {}),
    }),
  });
  if (masterCfg && issuesTg) {
    masterBridge = new MasterBridge({
      tg: issuesTg, cfg: masterCfg, inbox, hub,
      isLive: async () => terminals.has(FLEET_MASTER_ID) || (await terminals.hasSession(FLEET_MASTER_ID)),
      revive: async () => { await ensureFleet(); },
      waits: () => waitsForLogin(FLEET_MASTER_ID),
      savePhoto: makePhotoSaver(issuesTg, fleetInbox, fleetInboxWrite),
    });
    stopMasterBridge = masterBridge.start();
    console.log("[master] Telegram topic bridge on");
  }

  // Chief routes and the relaunch context (spec §5.2): after the master block,
  // which gives `inbox` and the ensureFleet wrapper, and before the catch-all.
  // Registered with the flag on; in misconfigured mode they answer 503. The
  // same RelaunchRetry serves the route and the boot relaunch.
  let chiefRelaunch: { ctx: ChiefRelaunchCtx; retry: RelaunchRetry } | undefined;
  let queueDeliverer: Deliverer | undefined;
  let stopRelaunchRetry: (() => void) | undefined;
  let stopHardened: (() => void) | undefined;
  let stopDistill: (() => void) | undefined;
  let stopCompaction: (() => void) | undefined;
  let stopSuggester: (() => void) | undefined;
  let stopDeliverer: (() => void) | undefined;
  let stopPrWatch: (() => void) | undefined;
  let stopCardPoster: (() => void) | undefined;
  let stopReminders: (() => void) | undefined;
  // The console's own deploy ticket (spec §5.7): with the chief flag on only. A release or an
  // archive install gets the Update ticket of root's updater in its place (server/update).
  let deploy: DeployService | UpdateService | undefined;
  let stopDeployWatch: (() => void) | undefined;
  if (chief) {
    // The queue Deliverer (spec §5.4). runChiefBoot starts it, after its boot
    // scan; until then an answer's kick only marks the item.
    const deliverer = new Deliverer({
      store: chief.queue, agents: store, composer: composerGate, inbox, rules: chief.rules, hub, undoMs: chief.tunables.undoMs,
    });
    queueDeliverer = deliverer;
    // The one AuditLog on chief/audit/auto.jsonl (spec §5.6): the actions'
    // superseded and undone lines, the auto answers' lines and breaker.
    const audit = new AuditLog(chief.paths.auditAuto);
    // One isAncestor helper and one set of gh calls serve addItem, PrWatch
    // and the merge gate of a pr item (queueAddDeps; overview decision 60).
    const addDeps = queueAddDeps(chief, queueEnv);
    // One QueueActions for the queue routes and the Telegram item taps.
    const queueActions = new QueueActions({
      store: chief.queue, rules: chief.rules, decisions: chief.decisions, agents: store,
      deliverer, inbox, audit, undoMs: chief.tunables.undoMs,
      mergeState: (item) => prMergeState(addDeps, item),
      onRuleAnswered: suggestNow,
    });
    // The chief's Telegram routes (spec §8): the brain routes below take its
    // card posters, and the issue poller gets this same instance. The card
    // index loads here, before listen: cards.json plus every queue item's
    // message ids (spec §8 (b)), before the card poster starts, before the
    // poller takes a tap and before any route can record a card. A failed
    // load is only logged. The poster runs on an active core only.
    // The deploy ticket and its one user-only route (spec §5.7). Built before the Telegram
    // routes, which give the card its Deploy button. It acts only when this process is the
    // console's own unit and a production build; else it does nothing and the route says why.
    // A release or an archive install (every hosted console): the Update ticket, from root's
    // updater; its paths are constants there. A git checkout: Deploy, as before (a test instance
    // with CONSOLE_UPDATE_TEST_DIR: the Update ticket from its fake status files).
    const kind = ownVersion.kind;
    const updates = kind !== "checkout" || seams.updateDir !== null ? updatePaths(kind, seams.updateDir) : null;
    if (updates) console.warn(`[update] the Update ticket of root's updater (${kind}${updates.test ? ", a test folder" : ""}): it waits for root's status file; no Deploy here`);
    const deployService = updates
      ? new UpdateService({ store: chief.queue, paths: updates, running: ownVersion })
      : await makeDeployService(chief, { dev });
    deploy = deployService;
    registerDeployApi(app, { gate: chief.gate, deploy: deployService });
    let poster: CardPoster | undefined;
    // The chat of the ticket cards: the fleet master chat (as before). With a connected account
    // and no fleet master chat: the user's private chat with the bot, so tickets reach the phone
    // with "Connect your chat" alone.
    const cardChat = cardChatOf(masterCfg, issuesUserId);
    if (cardChat && issuesTg) {
      // The chat changed since the last start: the open items get their card again there. A
      // console with a fleet master chat that never had private cards is not touched.
      if (chief.active) await moveCards({ store: chief.queue, marker: join(chief.paths.root, "cards-chat.json"), chat: cardChat, tg: issuesTg });
      const cards = new CardIndex(chief.paths.cards);
      await loadCardIndex(chief, cards).catch((e) => console.warn("[chief] card index load failed:", e));
      const run = await startCardPoster(chief, { tg: issuesTg, cfg: cardChat, cards, hub });
      poster = run?.poster;
      stopCardPoster = run?.stop;
      chiefTg = new ChiefTelegram({
        tg: issuesTg, cfg: cardChat, consoleUrl: chief.consoleUrl, misconfigured: chief.misconfigured,
        userAuth: chief.userAuth, pairing: chief.pairing, devices: chief.devices,
        rules: chief.rules, decisions: chief.decisions, cards, paths: chief.paths, hub, capture: chiefCapture?.line,
        queue: chief.queue, actions: queueActions, queueStore: chief.queue, deploy: deployService, files: issuesTg,
      });
    }
    // The master's `answer --auto` (spec §5.6); its Telegram one-liner goes
    // through the poster (no poster: none).
    const autoAnswer = makeAutoAnswer(chief, { agents: store, audit, deliverer, onAuto: (i) => poster?.postAuto(i) });
    const ctx: ChiefRelaunchCtx = {
      ...recoveryCtx, terminals, hub, relaunching,
      onRelaunch: holdOnRelaunch({ fleet: inbox, leads: leadRuntimes, coordinator: coordinatorFeed && { markStarting: coordinatorFeed.starting } }),
      ensureFleet,
      masterHasDraft: () => tracker.hasDraft(),
      // Spec §5.2: the relaunched agent's `not-live` lines go out again.
      afterRelaunch: (id) => deliverer.retryAgent(id),
    };
    const retry = new RelaunchRetry({ hub, relaunch: (id, o) => relaunchForChief(id, ctx, o) });
    // A console-made agent whose session shows the trust dialog of its own home, or the login
    // picker: the console ends that dialog itself (chief/hometrust.ts).
    const stopHomeDialogs = watchHomeDialogs({
      hub, agents: store, hardened: hardenedDeployment(), workspaceDir: recoveryCtx.workspaceDir,
      prompt: (id) => promptWatcher.state(id),
      trust: (rec, home) => trustClaudeDir(claudeJsonPath(rec.account, accountPaths()), home),
      signedOut: (rec) => markSignedOut(rec.account, Date.now()),
      restart: async (rec) => {
        const r = await restartSession(rec.id, ctx);
        if (r.outcome !== "relaunched") console.warn(`[chief] ${rec.id} was not started again: ${r.outcome}${r.error ? ` (${r.error})` : ""}`);
      },
    });
    app.addHook("onClose", async () => stopHomeDialogs());
    chiefRelaunch = { ctx, retry };
    registerRelaunchRoute(app, { gate: chief.gate, ctx, retry });
    registerChiefApi(app, {
      gate: chief.gate, pairing: chief.pairing, devices: chief.devices, consoleUrl: chief.consoleUrl, tg: issuesTg,
    });
    // The Coordinator's row in Settings (503 while misconfigured, as the queue's routes).
    registerCoordinatorApi(app, {
      gate: chief.gate, agents: store,
      lastActivityAt: () => coordinatorFeed?.lastActivityAt() ?? null, queuedEvents: () => fleetEvents.size(),
      blocked: () => coordinatorFeed?.blocked() ?? null, live: () => terminals.has(COORDINATOR_ID),
      dialogOn: () => terminals.dialogOn(COORDINATOR_ID),
      // No timeout: the line waits for an idle Coordinator (it is started when a line waits).
      task: (line) => { void coordinatorFeed?.inbox.pushConsole(line, null).catch((e) => console.warn("[coordinator] task not delivered:", e)); },
      waitsSignIn: () => waitsForLogin(COORDINATOR_ID),
      waitsLogin: () => waitsLogin(COORDINATOR_ID),
      // Only the events dropped while it waited for the second sign-in, until its first digest
      // names them ("+N older"): then the count is 0 and the line goes.
      droppedEvents: () => {
        if (!chiefWait?.hasWaited(COORDINATOR_ID)) return 0;
        const n = fleetEvents.droppedCount();
        if (n === 0 && !chiefWait.waitsFor(COORDINATOR_ID)) chiefWait.forgetWaited(COORDINATOR_ID);
        return n;
      },
    });
    // "Add a device" (chief/adddevice.ts): a paired device makes the code for one more. Only
    // where devices pair from the box; a console that pairs through Telegram registers nothing.
    if (addDeviceOn(chief)) registerAddDevice(app, { gate: chief.gate, devices: chief.devices, file: chief.paths.addCode, changed: () => setupSteps.forget(), address: () => consoleAddress(process.env) });
    // The nightly distiller (spec §6.3). The child gets only distillEnv's
    // allowlist of process.env. Its notice is fire and forget, so a hung
    // Telegram call never holds a run: it goes to the Master topic (the log
    // without Telegram). The proposal of the whole brain text is still
    // written, but no card is posted: the prompt is the active rules, and a
    // candidate reaches the user only as a "Make this a rule?" queue item.
    const claudeBin = claudeRuntime.bin();
    const distill = makeDistillRunner(chief, {
      ...(agentAuth ? modelRun() : { run: makeClaudeRun(claudeBin) }), claudeBin, env: process.env, hub,
      notify: (text) => {
        const bridge = masterBridge;
        if (bridge) void bridge.post(text).catch((e) => console.warn("[chief] distill notice failed:", e));
        else console.warn(`[chief] ${text}`);
      },
      onProposal: async () => { suggestNow(); },
    });
    // The one registration of the brain routes (Fastify throws on a
    // duplicate route), with every Phase 1b dep. `surface` also gives a
    // master-chat correction its via.
    registerBrainApi(app, {
      gate: chief.gate, devices: chief.devices, decisions: chief.decisions, surface: () => inbox.surface,
      rules: chief.rules, classified: chief.classified, paths: chief.paths, hub, distill,
      hardened: () => chief.hardened(), editorOff: editorOff(), telegram: chiefTg, onCandidate: suggestNow,
    });
    // The queue routes (spec §7); 503 while misconfigured. A pr item closed
    // as merged owes its agent the merged line: the Deliverer sends it.
    const prWatch = new PrWatch({ ...addDeps, onMerged: (id) => deliverer.kick(id) });
    // The Merge button of a pr ticket (USER only): the GitHub tab's merge function, then the
    // close of "I merged it" (answerUser approve reads the PR's state and closes the ticket).
    const queueMerge = new QueueMerge({
      store: chief.queue, workspaceDir: addDeps.workspaceDir, listRepos: addDeps.listRepos,
      facts: (repoPath, pr) => fetchPrMergeFacts(repoPath, pr, ghJson),
      merge: (repoPath, pr, method, headSha) => mergePullRequest(gh, repoPath, pr, method, headSha),
      closeMerged: (id) => queueActions.answerUser(id, { value: "approve" }, "tab"),
      onPrChange: () => onPrChange?.(),
    });
    registerQueueApi(app, {
      gate: chief.gate, undoMs: chief.tunables.undoMs, store: chief.queue, actions: queueActions, autoAnswer, merge: queueMerge,
      share: new QueueShare({ store: chief.queue, tool: () => shareTool.path }),
      add: (agentId, input, createdBy) => addItem(addDeps, agentId, input, createdBy),
      events: fleetEvents, agents: store,
      weekMetrics: () => weekCounts(chief), hardened: () => chief.hardened(), prWatch,
      previewEnabled: true,
    });
    // The lead routes (spec §13), whenever chief is set (as the queue's): a
    // misconfigured core answers 503 before any dep below is touched, so
    // there the deps are throwing stubs.
    const unreachable = (): never => { throw new Error("lead routes: not active"); };
    registerLeadsApi(app, {
      gate: chief.gate, agents: store, leadsDir: chief.paths.leadsDir, events: fleetEvents,
      waits: (id) => waitsForLogin(id),
      waitsLogin: (id) => waitsLogin(id),
      areas: leadDeps?.areas ?? { read: unreachable, setRepos: unreachable, setAvatar: unreachable },
      runtimes: leads ?? { ensure: unreachable },
      ensureLead: (area) => (leadDeps ? ensureLead(leadDeps, area) : unreachable()),
    });
    if (chief.active) {
      // Before the boot relaunch below, which arms the ids that are busy at boot.
      stopRelaunchRetry = retry.start();
      // Spec §6.3: the timer runs only when active. Spec §6.2: the daily compaction.
      stopDistill = distill.start();
      stopSuggester = ruleSuggester?.start();
      stopCompaction = startDailyCompaction({
        decisions: chief.decisions, classified: chief.classified, at: chief.tunables.distillAt,
      });
      // Spec §5.1: the pr status refresh and the local merge check (60 s each).
      stopPrWatch = prWatch.start();
      onPrChange = () => prWatch.checkNow();
    }
  }
  // The reminders agents set for themselves: with a chief core the routes
  // (any session lists; agents, leads and the master set; 503 while
  // misconfigured, as the queue's) and the deliverer; flag off nothing. Due
  // reminders go out as queue answers do: a worker's through the composer
  // gate, the master's and a lead's through their inbox, a deleted agent's to
  // the master. A closed worker keeps its reminders: a due one reopens it and
  // resumes its session with the line as its first turn. The deliverer's boot
  // scan and 60 s tick start in the chief boot below, on an active core only.
  const isLiveAgent = async (id: string): Promise<boolean> => terminals.has(id) || (await terminals.hasSession(id));
  const remindDeliverer = setupReminders(app, chief, {
    agents: store,
    deliverer: {
      composer: composerGate,
      inboxFor: (id) => (id === FLEET_MASTER_ID ? inbox : id === COORDINATOR_ID ? coordinatorFeed?.inbox : leads?.get(id)?.inbox),
      isLive: isLiveAgent,
      // A deleted agent's reminder is an alert: with a Coordinator it is not a line of the Master's chat.
      ...(coordinatorFeed ? { orphansTo: COORDINATOR_ID } : {}),
      resume: resumeFor({
        agents: store, isLive: isLiveAgent, ensureFleet, ...(coordinatorFeed ? { ensureCoordinator: ensureCoord } : {}),
        ensureLead: (area) => (leadDeps ? ensureLead(leadDeps, area) : Promise.reject(new Error("no lead runtime"))),
        resumeAgent: (rec) => resumeAgent(rec, recoveryCtx),
      }),
      resumeClosed: resumeClosedFor({
        store, emit: (e) => hub.emitEvent(e), isLive: isLiveAgent,
        resume: (rec, o) => resumeAgent(rec, recoveryCtx, o),
      }),
      reopen: (id) => reopenIfClosed({ store, emit: (e) => hub.emitEvent(e) }, id),
      io: terminals, hub,
    },
  });
  let issuePoller: IssuePoller | undefined;
  let linkPoller: IssuePoller | undefined;
  let issueCoalescer: Coalescer | undefined;

  app.all(PAGE_ROUTE, async (req, reply) => {
    // A WebSocket upgrade that reaches the catch-all is one of our WS routes did
    // not claim (e.g. Next's HMR socket, routed through Fastify by
    // @fastify/websocket). It must NOT go to Next's HTTP handler — the socket is
    // already assigned (ERR_HTTP_SOCKET_ASSIGNED, which can crash the process).
    // Hand it to Next's own upgrade handler instead.
    if (req.raw.headers.upgrade?.toLowerCase() === "websocket") {
      reply.hijack();
      try { upgrade(req.raw, req.raw.socket, Buffer.alloc(0)); }
      catch { try { req.raw.socket?.destroy(); } catch { /* already gone */ } }
      return;
    }
    reply.hijack();
    await handle(req.raw, reply.raw);
  });

  // Reconcile persisted agents against surviving dtach sessions.
  // Agents whose session outlived the previous server stay running (and reattach lazily when
  // viewed); agents marked running but whose session is gone are demoted so the
  // list doesn't show a phantom-running agent. Best-effort — never blocks boot.
  try {
    for (const rec of await store.list()) {
      if (rec.status !== "running" && rec.status !== "idle") continue;
      const alive = await terminals.hasSession(rec.id);
      if (!alive && rec.status === "running") {
        await store.patch(rec.id, { status: "idle" });
        hub.emitEvent({ type: "agent-status", agentId: rec.id, status: "idle" });
      }
    }
    // The owner's price services left the repo: drop their records once their scripts are gone.
    await retirePriceServices({ store: serviceStore, alive: (id) => terminals.hasSession(svcTermId(id)) })
      .catch((e) => console.warn("[services] retire skipped:", e));
    await services.reconcile();
  } catch (e) {
    console.warn("[server] agent/session reconcile skipped:", e);
  }

  // The inbox takes the master's turn state from its record: by now a dead
  // `running` record has been demoted to idle above.
  // The event queue starts only now, after that demotion: the boot demotions'
  // agent-status events are intentionally not reported to the master as news.
  stopFleetEvents = await fleetEvents.start()
    .catch((e) => { console.warn("[master] event queue start failed:", e); return undefined; });
  const fleetRec = await store.load(FLEET_MASTER_ID);
  if (fleetRec) fleetKnown = true;
  // A record without a surviving session is cold-spawned by the boot repair
  // below: start busy (markStarting semantics) until its SessionStart.
  const fleetStarting = Boolean(fleetRec) && !(await terminals.hasSession(FLEET_MASTER_ID));
  inbox.start(fleetStarting || fleetRec?.status === "running" ? "busy" : "idle");
  // The Coordinator's inbox, by the same rule. Then the catch-up: a cron run or a lead report
  // that is newer than the feed's mark gets its digest line again (on the first start: the
  // last minutes before the hand-over from the fleet master).
  if (coordinatorFeed && chief) {
    const coordRec = await store.load(COORDINATOR_ID);
    if (coordRec) coordinatorFeed.markKnown();
    // A session id comes only from the session's own SessionStart hook: it started one time.
    if (coordRec?.sessionId) coordinatorFeed.markHello();
    const coordStarting = Boolean(coordRec) && !(await terminals.hasSession(COORDINATOR_ID));
    coordinatorFeed.inbox.start(coordStarting || coordRec?.status === "running" ? "busy" : "idle");
    await catchUp({
      file: coordinatorPaths(coordinatorDataDir).feed, cronDataDir: resolveCronDataDir(),
      leadsDir: chief.paths.leadsDir, events: fleetEvents,
      ...(coordRec && !coordRec.sessionId ? { neverStartedSince: coordRec.createdAt } : {}),
    }).catch((e) => console.warn("[coordinator] catch-up skipped:", e instanceof Error ? e.message : e));
    await coordinatorFeed.load();
    console.log("[coordinator] the Coordinator reads the event feed; the fleet master gets no digest");
  }
  // The leads' runtimes before listen, by the same rule: no event of a live
  // lead's worker can pass the master's filter before that lead's queue exists.
  if (leadDeps && leads) {
    await ensureLeadRuntimes({ ...leadDeps, runtimes: leads })
      .catch((e) => { console.warn("[chief] lead runtimes not started:", e); });
  }

  // Graceful shutdown: detach our PTY clients from their dtach masters so they
  // don't orphan onto init and pile up across restarts (stacked orphan clients
  // pin the dtach window size, leaving a reattached idle agent's terminal
  // blank). Agents keep running headless; next boot reattaches them.
  let closing = false;
  const shutdown = (sig: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.log(`[server] ${sig} — detaching terminal clients (agents stay alive)`);
    try { issuePoller?.stop(); } catch { /* best effort */ }
    try { linkPoller?.stop(); } catch { /* best effort */ }
    try { issueCoalescer?.stop(); } catch { /* best effort */ }
    try { masterInbox?.stop(); } catch { /* best effort */ }
    try { leadRuntimes?.stopAll(); } catch { /* best effort */ }
    try { coordinatorFeed?.stop(); } catch { /* best effort */ }
    try { stopFleetEvents?.(); } catch { /* best effort */ }
    try { stopMasterBridge?.(); } catch { /* best effort */ }
    try { stopRelaunchRetry?.(); } catch { /* best effort */ }
    try { stopHardened?.(); } catch { /* best effort */ }
    try { stopDistill?.(); } catch { /* best effort */ }
    try { stopCompaction?.(); } catch { /* best effort */ }
    try { stopSuggester?.(); } catch { /* best effort */ }
    try { stopDeliverer?.(); } catch { /* best effort */ }
    try { stopReminders?.(); } catch { /* best effort */ }
    try { stopPrWatch?.(); } catch { /* best effort */ }
    try { stopDeployWatch?.(); } catch { /* best effort */ }
    try { stopCardPoster?.(); } catch { /* best effort */ }
    try { terminals.shutdown(); } catch { /* best effort */ }
    try { promptWatcher.dispose(); } catch { /* best effort */ }
    // After close no request can bump a device's lastUsedAt: flush the rest.
    void app.close()
      .finally(() => chief?.devices.flush().catch((e) => console.warn("[chief] device flush on shutdown failed:", e)))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Not started in a hardened deployment (editorOff, overview decision 45).
  startCodeServer();
  const HOST = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port: PORT, host: HOST });
  console.log(`${DISPLAY_NAME} on http://${HOST}:${PORT}`);
  // The front proxy's private listener: only with its settings, only on this server's one address
  // in the proxy's network. Any problem: it stays off (the console is then reachable on loopback
  // only), with one line that names the problem.
  let proxyListener: ProxyListener | null = null;
  if (proxy !== null && "off" in proxy) console.warn(`[proxy] the private listener is off: ${proxy.off}`);
  else if (proxy !== null && devListenerRefusal(dev, seams.proxyTest !== null)) console.warn(`[proxy] the private listener is off: ${devListenerRefusal(dev, false)}`);
  else if (proxy !== null) {
    const address = seams.proxyTest?.address ?? localAddressIn(proxy.network);
    const from = seams.proxyTest?.from ?? proxy.from;
    if (!address) console.warn("[proxy] the private listener is off: this server has no one address in the proxy's network");
    else {
      try {
        proxyListener = await listenProxy({ http: app.server, address, from, port: proxy.port, tlsDir: proxy.tlsDir });
        console.log(`[proxy] private listener on ${address}:${proxyListener.port}, for ${from} only; certificate sha256 ${proxyListener.fingerprint256}`);
      } catch (e) {
        console.warn(`[proxy] the private listener is off: ${(e as Error).message}`);
      }
    }
  }
  process.once("exit", () => proxyListener?.server.close());
  if (routes !== null && seams.routeDump !== null) writeRouteDump(seams.routeDump, routes);
  // Which technical names this install uses, and the facts behind it (server/names.mjs).
  const nd = namesDecision();
  console.log(nd.names.legacy
    ? `names: old (${nd.names.unit}, data dir ${nd.names.dataDir}), because of: ${nd.markers.join(", ")}`
    : `names: new (${nd.names.unit}, data dir ${nd.names.dataDir})`);

  // Issues boot recovery needs only the on-disk agent records, so it runs here,
  // before the poller takes taps — not in the slow reconcile chain below.
  await issueActions.recoverStarting(store)
    .catch((e) => console.warn("[issues] boot recovery skipped:", e));
  if (issuesTg && issuesUserId) {
    const coalescer = new Coalescer({ onFlush: (m) => issueIntake.fromTelegram(m) });
    issueCoalescer = coalescer;
    // A reply to a closed agent whose session is stopped resumes that session
    // with the reply as its first turn (an explicit use, see agents/closed.ts).
    const resumeClosed = (agentId: string, text: string) => resumeClosedWithPrompt({
      store, emit: (e) => hub.emitEvent(e),
      isLive: async (x) => terminals.has(x) || (await terminals.hasSession(x)),
      resume: (rec, o) => resumeAgent(rec, recoveryCtx, o),
    }, agentId, text).catch((e) => {
      console.warn(`[issues] resume of closed agent ${agentId} failed:`, e instanceof Error ? e.message : e);
      return false;
    });
    const replyDeps = {
      store: issueStore, actions: issueActions, intake: issueIntake, agents: store, terminals, resumeClosed,
      checkReady: chief?.active, capture: chiefCapture?.line,
    };
    issuePoller = new IssuePoller({
      tg: issuesTg, userId: issuesUserId, offsetFile: join(issuesDir, "offset.json"),
      onCallback: (cq) => issueActions.handleCallback(cq),
      onReply: (id, msg) => handleReply(replyDeps, id, msg),
      onNew: (m) => coalescer.push(m),
      // TELEGRAM_ISSUE_INTAKE=0 deprecates private-chat issues: issues go to the
      // Master topic now. One hint per 10 minutes; card replies still work.
      intakeOff: ["0", "false"].includes(process.env.TELEGRAM_ISSUE_INTAKE ?? ""),
      onIntakeOff: (() => {
        let last = 0;
        return () => {
          if (Date.now() - last < 10 * 60_000) return;
          last = Date.now();
          void issuesTg.sendMessage(issuesUserId, "Issues moved: forward them to the Master topic in the console group.")
            .catch((e) => console.warn(`[issues] intake-off hint failed: ${e instanceof Error ? e.message : e}`));
        };
      })(),
      findIssueByMessageId: (mid) => issueStore.findByMessageId(mid),
      // The one-time codes of the Settings page: asked first, a pass while no code waits.
      link: settings.link ?? undefined,
      // The chief's Master-topic routes (spec §8), asked before the master
      // route. Misconfigured: only the /pair and /unpair reply.
      chief: chiefTg,
      master: masterCfg
        ? { route: (u) => routeMasterUpdate(u, masterCfg), onMessage: (m) => masterBridge!.onMessage(m) }
        : (() => {
            const setupLog = makeSetupLogger(issuesUserId);
            return { route: (u: Parameters<typeof routeMasterUpdate>[0]) => { setupLog(u); return "pass" as const; }, onMessage: async () => {} };
          })(),
    });
    issuePoller.start();
    console.log("[issues] Telegram issue intake on");
  } else if (tgToken && settings.link) {
    // A bot with no connected account: nothing polls it, as before. Only while a one-time code
    // of the Settings page waits (the user pressed "Connect your chat") does the console read
    // the bot's messages, with the same single poller and the same offset file.
    const link = settings.link;
    const linkTg = createTelegramClient({ token: tgToken, baseUrl: tgApiBase });
    link.onListen = (on) => {
      if (on && !linkPoller) {
        linkPoller = linkOnlyPoller({ tg: linkTg, offsetFile: join(issuesDir, "offset.json"), link });
        linkPoller.start();
      } else if (!on && linkPoller) {
        linkPoller.stop();
        linkPoller = undefined;
      }
    };
  }

  // Self-heal: first retire the old cron master (a record left from the Cron
  // tab: its session stopped and its record dropped, its memory kept), then
  // resume any dead, non-done agent (restoring its full Claude conversation via
  // `claude --resume` when the transcript survived). Live agents are skipped by
  // resumeAgent's has/reattach guards. Fire-and-forget so a slow or failing
  // reconcile never blocks listen; per-agent failures are isolated inside
  // reconcileAgents.
  // Then keep watching: reconcile only runs here, at boot, so an agent whose
  // session dies later (OOM kill, external pkill, crash) would keep its stale
  // "running"/"idle" record forever — a rail row promising a terminal that no
  // longer exists. The sweep marks those `error`, which the Notifier turns into
  // one Telegram ping and the rail into a red row with a Resume button. Started
  // only after reconcile settles, or its first pass could bury agents the
  // reconciler has not reached yet. AGENT_SWEEP_MS=0 disables it.
  const sweepMs = Number(process.env.AGENT_SWEEP_MS ?? 60_000);
  // The starts after a wait for a login (the second sign-in, or the hold of a sign-out): the fleet
  // master (when it has a record or waited), the Coordinator (with the master, or when it
  // waited), each lead that waited (chief/chiefwait.ts).
  function waitedStarts(): WaitedStarts {
    return {
      master: ensureFleet, masterKnown: async () => (await store.load(FLEET_MASTER_ID)) !== null,
      ...(coordinatorFeed ? { coordinator: ensureCoord } : {}), coordinatorKnown: async () => (await store.load(COORDINATOR_ID)) !== null,
      ...(leadDeps ? { lead: (area: string) => ensureLead(leadDeps, area) } : {}),
    };
  }
  // After the second sign-in, what waited starts, each by its own start: the fleet master (when
  // it has a record or waited), the Coordinator (with the master, or when it waited), each lead
  // that waited (chief/chiefwait.ts).
  chiefWait?.onSignedIn((ids) => startWaited(ids, waitedStarts()));
  void runAgentBoot({
    retireCronMaster: () => retireCronMaster({ store, kill: (id) => terminals.kill(id) }),
    // Then the Coordinator: repaired when its record exists, and made on a console that has a
    // fleet master (the first start after the update: the hand-over needs no user step). A new
    // install has neither: its Coordinator starts with the Master or with the first event.
    fleetMaster: async () => {
      const master = await ensureFleetMasterAtBoot({ store, recoveryCtx, masterDataDir });
      if (coordinatorFeed && (master !== null || (await store.load(COORDINATOR_ID)))) {
        await ensureCoord().catch((e) => console.warn("[coordinator] boot start skipped:", e instanceof Error ? e.message : e));
      }
      return master;
    },
    // Spec §13: each lead's runtime, then its boot repair whatever its status
    // (reconcile skips "done"), before reconcile. An active core only.
    preReconcile: () => runChiefPreReconcile(chief, {
      leadBoot: () => (leadDeps && leads ? bootLeads({ ...leadDeps, runtimes: leads }) : Promise.resolve([])),
    }),
    reconcile: () => reconcileAgents(recoveryCtx),
    // Chief (spec §5.2, §5.4 step 5, §3): the hardened monitor, the queue's
    // boot scan, the Deliverer, the digest re-add, then the boot relaunch of
    // the records reconcile found alive — before the sweep starts, which skips
    // the ids being relaunched. A misconfigured core runs only the monitor.
    chiefBoot: (r, leadIds) => {
      if (!chief || !chiefRelaunch || !queueDeliverer) return undefined;
      const { ctx, retry } = chiefRelaunch;
      const deliverer = queueDeliverer;
      return runChiefBoot(chief, {
        alive: r?.alive ?? [],
        resumed: r?.resumed ?? [],
        cold: r?.cold ?? [],
        // The leads the lead boot step spawned: their not-live items are retried too.
        leads: leadIds,
        bootScan: (ids) => deliverer.bootScan(ids),
        startDeliverer: () => { stopDeliverer = deliverer.start(); },
        // After reconcile: what a restart left `delivering` goes out again,
        // then the 60 s tick and the idle / SessionStart kicks.
        reminders: async () => {
          if (!remindDeliverer) return;
          await remindDeliverer.bootScan();
          stopReminders = remindDeliverer.start();
        },
        // Spec §5.6: open items without a recommendation go back in the digest.
        // A failed read is logged; the boot relaunch still runs.
        requeueDigest: async () => {
          try {
            requeueDigest(await chief.queue.list(), fleetEvents);
          } catch (e) {
            console.warn("[chief] queue digest re-add failed:", e);
          }
        },
        bootRelaunch: (ids) => bootRelaunch(ids, { store, relaunch: (id) => relaunchForChief(id, ctx), retry }),
        startMonitor: () => {
          const agentUid = parseAgentUid(process.env.CHIEF_AGENT_UID);
          const monitor = new HardenedMonitor({
            hub,
            facts: () => ({
              dataDir: chief.paths.root,
              // Check (1)'s other facts, as `choibot doctor` reads them (ruling F6).
              cronDir: resolveCronDataDir(),
              envFile: settingsFile(process.cwd()),
              homeRoot: agentHomeRoot(),
              // No getuid (not POSIX): -1 matches no owner, so the mode reads weak.
              selfUid: process.getuid?.() ?? -1,
              agentUid,
              // The dir the TerminalManager really uses, also when AGENT_DTACH_DIR is unset.
              dtachDir: AGENT_DTACH_DIR_RESOLVED,
              procRoot: "/proc",
              agentExec: agentExec !== undefined,
              // The second account, when it is asked for (chief/chiefaccount.ts).
              ...(chiefWanted() ? { chief: chiefFacts(chiefExec !== undefined) } : {}),
              codeRouteGate: codeRouteGate(),
            }),
          });
          chief.monitor = monitor;
          stopHardened = monitor.start();
        },
      // Spec §5.7, after reconcile and the chief steps: the result of a deploy that restarted
      // this console (the live commit, the agents alive), or the end of one that died; then
      // the first check and its timer. afterBoot never rejects.
      }).finally(async () => {
        await deploy?.afterBoot(r);
        stopDeployWatch = deploy?.startWatch();
      });
    },
  }).finally(() => {
    // Delete agents closed more than 7 days ago (see closed.ts). Flag on
    // (active or misconfigured: the reminders still go out once it is fixed),
    // an open reminder keeps a closed agent; flag off no reminder is read.
    startClosedPurge({
      store, remove: agentApi.removeAgent,
      reminderHolds: chief ? () => chief.reminders.purgeHolds() : undefined,
      onPurged: (rec) => console.log(`[closed] ${rec.id} (${rec.label}) closed 7+ days — deleted`),
    });
    if (!Number.isFinite(sweepMs) || sweepMs <= 0) return;
    startDeadAgentSweep({
      store, terminals, intervalMs: sweepMs,
      skip: (id) => relaunching.has(id),
      waits: (id) => chiefWait?.waitsFor(id) === true || loginHold.waitsFor(id),
      onDead: (rec) => {
        console.warn(`[sweep] ${rec.id} (${rec.label}) died — marking error`);
        hub.emitEvent({ type: "agent-status", agentId: rec.id, status: "error" });
      },
    });
  });
}

// Safety net: a stray socket error from an unmatched WebSocket upgrade must
// never take down the whole server. Ignore that specific case; fail fast on
// anything genuinely unexpected.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException).code === "ERR_HTTP_SOCKET_ASSIGNED") {
    console.warn("[server] ignored stray WS-upgrade socket error");
    return;
  }
  console.error("uncaughtException:", err);
  process.exit(1);
});

main().catch((e) => { console.error(e); process.exit(1); });
