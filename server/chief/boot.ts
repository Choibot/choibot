// server/chief/boot.ts — the chief of staff's core objects and its boot steps
// (spec §4.4, §5.2, §5.4, §3). server/index.ts builds the core only when
// chiefFlag; with the flag off it is undefined and nothing here runs.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ComposerCapture } from "../agents/composer.js";
import { runGit } from "../agents/git.js";
import type { SessionStore } from "../agents/store.js";
import type { EventHub } from "../events.js";
import { ghJson } from "../gh/exec.js";
import { listRepos as ghListRepos } from "../gh/repos.js";
import { fetchPrStatus } from "../gh/status.js";
import type { RelayDeps } from "../issues/relay.js";
import type { TelegramClient } from "../issues/telegram.js";
import type { EventQueue } from "../master/events.js";
import { masterPaths, resolveMasterDataDir } from "../master/paths.js";
import type { CardChat } from "../master/telegram.js";
import { DeviceStore, PairingCodes, type PendingPair } from "./auth.js";
import { makeConsoleToken } from "./consoletoken.js";
import { hardenedDeployment } from "./hardened.js";
import { captureUserLine, composerLineOf, type CaptureLine } from "./brain/capture.js";
import { DistillRunner } from "./brain/distill.js";
import { foldMetrics, type Counts } from "./brain/metrics.js";
import { ClassifiedLog, DecisionLog, RuleStore, type Rule } from "./brain/store.js";
import type { CardIndex } from "./cards.js";
import { deadline } from "./deadline.js";
import { makeGate, type ChiefGate } from "./gate.js";
import type { HardenedMonitor } from "./hardened.js";
import { agentHomeRoot } from "./homes.js";
import { areaOfOrRepo, type AreaStore } from "./leads/areas.js";
import {
  chiefActive, chiefMisconfigured, chiefPaths, chiefTunables, chiefUserAuth, resolveChiefDataDir,
  type ChiefPaths, type ChiefTunables, type Env,
} from "./paths.js";
import { addItem, type AddDeps } from "./queue/add.js";
import { AutoAnswer, type AuditLog } from "./queue/auto.js";
import { cardIdsOf } from "./queue/cards.js";
import type { Deliverer } from "./queue/deliver.js";
import { authMode, type AuthMode } from "./queue/eligibility.js";
import { MEDIA_NAME_RE } from "./queue/media.js";
import { CardPoster, type CardPosterDeps } from "./queue/poster.js";
import { parseAddInput } from "./queue/schema.js";
import { QueueStore } from "./queue/store.js";
import { isAgentItem, type QueueItem } from "./queue/types.js";
import { ReminderStore } from "./remind/store.js";

export type ChiefCore = {
  active: boolean; misconfigured: string | null; userAuth: "telegram" | "log"; consoleUrl: string;
  paths: ChiefPaths; devices: DeviceStore; pairing: PairingCodes; decisions: DecisionLog; gate: ChiefGate;
  rules: RuleStore; classified: ClassifiedLog; tunables: ChiefTunables;
  // The decision queue (spec §5.1); every write emits hub {type: "queue", item}.
  queue: QueueStore;
  // The reminders agents set for themselves; every write emits hub {type: "reminders"}.
  reminders: ReminderStore;
  // Set by index.ts when it creates the HardenedMonitor (runChiefBoot's startMonitor).
  monitor?: Pick<HardenedMonitor, "strong">;
  // False until the monitor exists, then monitor.strong().
  hardened(): boolean;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function makeChiefCore(env: Env, deps: {
  agents: Pick<SessionStore, "load">;
  // Takes the queue's hub events (spec §5.4 step 7, §7).
  hub?: Pick<EventHub, "emitEvent">;
  log?: (s: string) => void;
  onPairExpire?: (p: PendingPair) => void;
}): ChiefCore {
  const log = deps.log ?? ((s: string) => console.warn(s));
  const misconfigured = chiefMisconfigured(env);
  // The one boot line of spec §4.4; from here the console fails closed.
  if (misconfigured !== null) log(`[chief] misconfigured: ${misconfigured}`);
  const userAuth = chiefUserAuth(env);
  const paths = chiefPaths(resolveChiefDataDir(env));
  const devices = new DeviceStore(paths.devices);
  // Strong protection: a new token of the console's own account at each start (consoletoken.ts).
  const consoleToken = hardenedDeployment(env) ? makeConsoleToken(paths.consoleToken) : undefined;
  const core: ChiefCore = {
    active: chiefActive(env),
    misconfigured,
    userAuth,
    // An origin (spec §4.4): links are `${consoleUrl}/#pair=<code>`, so a
    // trailing slash would give `//#pair=`.
    consoleUrl: (env.CHIEF_CONSOLE_URL ?? "").replace(/\/+$/, ""),
    paths,
    devices,
    pairing: new PairingCodes({ onExpire: deps.onPairExpire }),
    decisions: new DecisionLog(paths.decisions),
    rules: new RuleStore(paths.rules),
    classified: new ClassifiedLog(paths.classified),
    tunables: chiefTunables(env),
    // Every store write (add, an action, a Deliverer state, a snooze wake, a
    // PrWatch close) is one hub event; the Queue tab upserts the item from it.
    queue: new QueueStore(paths.queueDir, { onChange: (item) => deps.hub?.emitEvent({ type: "queue", item }) }),
    // The Agents list re-fetches GET /api/reminders on it (no payload: the list is small).
    reminders: new ReminderStore(paths.reminders, { onChange: () => deps.hub?.emitEvent({ type: "reminders" }) }),
    gate: makeGate({ misconfigured, userAuth, strong: hardenedDeployment(env), deps: { devices, agents: deps.agents, ...(consoleToken ? { consoleToken } : {}) } }),
    hardened: () => core.monitor?.strong() === true,
  };
  return core;
}

// The capture of user lines (spec §6.2 sources 1–2) for index.ts: `composer`
// for registerComposerApi, `line` for handleReply and ChiefTelegram.
// Undefined unless the core is active, so a misconfigured console captures
// nothing (§4.4 fail closed). A composer line counts only for a real USER
// caller (the gate's caller check, never header presence). `onCandidate`
// is index.ts's lazy hook: the rule suggester is built after the composer route.
export type ChiefCapture = { composer: ComposerCapture; line: (l: CaptureLine) => Promise<{ hint?: string }> };

export function captureDeps(core: ChiefCore, d: {
  agents: Pick<SessionStore, "load">; onCandidate: (r: Rule) => void | Promise<void>;
}): ChiefCapture | undefined {
  if (!core.active) return undefined;
  const line = (l: CaptureLine) => captureUserLine({ decisions: core.decisions, rules: core.rules, onCandidate: d.onCandidate }, l);
  return {
    composer: {
      isUser: async (req) => (await core.gate.caller(req)).level === "user",
      lineFor: (id) => composerLineOf(d.agents, id),
      capture: line,
    },
    line,
  };
}

// The nightly distiller on the core's stores, at CHIEF_DISTILL_AT (spec §6.3).
export function makeDistillRunner(core: ChiefCore,
  d: Omit<ConstructorParameters<typeof DistillRunner>[0], "paths" | "rules" | "decisions" | "classified" | "at">): DistillRunner {
  return new DistillRunner({
    ...d, paths: core.paths, rules: core.rules, decisions: core.decisions, classified: core.classified, at: core.tunables.distillAt,
  });
}

// PairingCodes.onExpire for index.ts: at the TTL the private message that held
// the link is deleted (spec §3.1 step 1). `tg` is a getter because index.ts
// creates the Telegram client after the core. A failed delete (message gone,
// 48 h limit) is only logged.
export function deleteExpiredPairMessage(
  tg: () => Pick<TelegramClient, "deleteMessage"> | undefined,
  log: (s: string) => void = (s) => console.warn(s),
): (p: PendingPair) => void {
  return (p) => {
    const client = tg();
    if (!p.tg || !client) return;
    const { chatId, messageId } = p.tg;
    void client.deleteMessage(chatId, messageId)
      .catch((e: unknown) => { log(`[chief] pairing deleteMessage failed: ${errText(e)}`); });
  };
}

// The chief boot steps after reconcileAgents (spec §5.2, §5.4 step 5, §5.6,
// §3). The hardened monitor only reads, so it runs in every chief mode, and
// first, so it sees the SessionStart of each relaunched agent. The rest change
// agents or deliver lines, so a misconfigured core skips them (§4.4 fail
// closed). Each step starts once the previous one resolved: the Deliverer's
// boot scan (then retryAgent for each id reconcile resumed or cold-started),
// then its 5 s tick and agent-status subscription (none may run before the
// scan; until then a kick only marks the item), then the reminders' boot scan
// and timers, then the digest re-add of the open items, then the boot
// relaunch of the alive records.
export async function runChiefBoot(core: ChiefCore, d: {
  alive: string[];
  resumed: string[];
  cold: string[];
  // The leads runChiefPreReconcile resumed or cold-started (Task 3-7).
  leads?: string[];
  bootScan: (resumedIds: string[]) => Promise<void>;
  startDeliverer: () => void;
  // The reminders' boot scan, then their 60 s tick (index.ts). Never rejects.
  reminders?: () => Promise<void>;
  requeueDigest: () => Promise<void>;
  bootRelaunch: (ids: string[]) => Promise<unknown>;
  startMonitor: () => void;
}): Promise<{ relaunched: boolean }> {
  d.startMonitor();
  if (!core.active) return { relaunched: false };
  await d.bootScan([...new Set([...d.resumed, ...d.cold, ...(d.leads ?? [])])]);
  d.startDeliverer();
  await d.reminders?.();
  await d.requeueDigest();
  await d.bootRelaunch(d.alive);
  return { relaunched: true };
}

// The lead boot step (spec §13, Task 3-7), between the fleet master's boot
// repair and reconcileAgents: `leadBoot` makes each lead's runtime, then
// resumes the leads whatever their status, and returns the ids it spawned (for
// runChiefBoot's boot scan). Only an active core: no core or a misconfigured
// one does nothing.
export async function runChiefPreReconcile(core: ChiefCore | undefined, d: { leadBoot: () => Promise<string[]> }): Promise<string[]> {
  if (!core?.active) return [];
  return d.leadBoot();
}

export type Reconciled = { resumed: string[]; cold: string[]; alive: string[]; failed: string[] };

// index.ts's boot chain after listen, one step after the other: the retire
// step of the old cron master, the fleet master's boot repair, the lead boot step,
// reconcileAgents, then the chief steps (runChiefBoot) with reconcile's result
// (undefined when it failed) and the lead ids. A failed step is logged and the
// next one still runs.
export async function runAgentBoot(d: {
  retireCronMaster: () => Promise<unknown>;
  fleetMaster: () => Promise<unknown>;
  preReconcile: () => Promise<string[]>;
  reconcile: () => Promise<Reconciled>;
  chiefBoot: (r: Reconciled | undefined, leads: string[]) => Promise<unknown> | undefined;
}): Promise<void> {
  try { await d.retireCronMaster(); } catch (e) { console.warn("[cron] cron master retire step failed:", e); }
  try { await d.fleetMaster(); } catch (e) { console.warn("[master] fleet master boot-repair skipped:", e); }
  let leads: string[] = [];
  try { leads = await d.preReconcile(); } catch (e) { console.warn("[chief] lead boot failed:", e); }
  let r: Reconciled | undefined;
  try { r = await d.reconcile(); } catch (e) { console.error("[reconcile] boot error", e); }
  try { await d.chiefBoot(r, leads); } catch (e) { console.warn("[chief] boot steps failed:", e); }
}

// A hung git never holds a PrWatch run or a relay add for longer.
const GIT_TIMEOUT_MS = 20_000;

// The one `isAncestor` of addItem and PrWatch (spec §5.1): `git merge-base
// --is-ancestor <branch> <base>`, no shell, an env allowlist (plus the git
// overrides of a hardened deployment, server/agents/git.ts). Exit 0 → true,
// exit 1 → false; any other error (missing repo, bad ref, spawn failure,
// timeout) rejects, so a git error never reads as either answer. A ref that
// starts with "-" is refused (git would take it as an option).
export async function gitIsAncestor(repoPath: string, branch: string, base: string): Promise<boolean> {
  if (branch.startsWith("-") || base.startsWith("-")) throw new Error("isAncestor: a ref must not start with -");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  try {
    // Cast on purpose: next/types adds a required NODE_ENV to ProcessEnv; the
    // child env stays exactly the allowlist (hardened: plus GIT_CONFIG_*).
    await runGit(repoPath, ["-C", repoPath, "merge-base", "--is-ancestor", branch, base],
      { env: env as NodeJS.ProcessEnv, timeout: GIT_TIMEOUT_MS }, repoPath);
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === 1) return false;
    throw e;
  }
}

// The dirs an agent's cwd may sit in for preview media (acceptMedia, Ruling
// P3): the workspace, AGENT_WORKTREE_ROOT when absolute (the relative default
// sits inside each repo, so in the workspace), the fleet-master agent dir,
// with the chief active the leads dir of the chief
// data dir (a not-hardened lead's home, final review minor 1), and in a
// hardened deployment AGENT_HOME_ROOT (the persistent agents' homes, Task 2c-7).
export function agentRoots(workspaceDir: string, env: Record<string, string | undefined> = process.env): string[] {
  const wt = env.AGENT_WORKTREE_ROOT;
  const homes = agentHomeRoot(env);
  return [
    workspaceDir,
    ...(wt && isAbsolute(wt) ? [wt] : []),
    masterPaths(resolveMasterDataDir(env)).agentDir,
    ...(chiefActive(env) ? [chiefPaths(resolveChiefDataDir(env)).leadsDir] : []),
    ...(homes !== null ? [homes] : []),
  ];
}

// addItem's deps on the core's store (spec §5.1–§5.3): the workspace repos
// with a GitHub origin, `gh pr view` for checks, the git helper above. With
// `areas` (an active core, Task 3-7) an item's area comes from areas.json, its
// repo when the file cannot be read.
export function queueAddDeps(core: ChiefCore, d: {
  agents: Pick<SessionStore, "load">; workspaceDir: string; agentRoots: string[]; areas?: Pick<AreaStore, "areaOf">;
}): AddDeps {
  return {
    store: core.queue, agents: d.agents, workspaceDir: d.workspaceDir, agentRoots: d.agentRoots,
    listRepos: ghListRepos, prStatus: (repoPath, pr) => fetchPrStatus(repoPath, pr, ghJson), isAncestor: gitIsAncestor,
    ...(d.areas ? { areaOf: areaOfOrRepo(d.areas) } : {}),
  };
}

// The relay add runs inside the issue lock: its gh and git calls are cut here.
export const RELAY_ADD_TIMEOUT_MS = 20_000;

// The issue relay's queue hook (Task 2a-17, spec §5.3): a `pr` item for the PR
// an issue agent opened, created by the relay, then its digest line (a dedup
// adds none). Undefined unless the core is active, so a misconfigured console
// adds no item (§4.4). Only the record's id is used: the relay's copy was
// loaded before its PR patch, and addItem reloads it. A gh or git call past
// `timeoutMs` counts as failed, so the item is stored without checks.
// When the item cannot be made, the PR has no ticket: the master's digest gets
// its pr-opened line (`prWithoutItem`; the quiet policy drops that line
// otherwise) and the error goes on to the relay's log.
export function relayQueueAdd(core: ChiefCore, deps: AddDeps,
  events: Pick<EventQueue, "addQueue"> & Partial<Pick<EventQueue, "prWithoutItem">>,
  timeoutMs = RELAY_ADD_TIMEOUT_MS): RelayDeps["queueAdd"] {
  if (!core.active) return undefined;
  const bounded: AddDeps = {
    ...deps,
    listRepos: (ws) => deadline(deps.listRepos(ws), timeoutMs, "listRepos"),
    prStatus: (repoPath, pr) => deadline(deps.prStatus(repoPath, pr), timeoutMs, "gh pr view"),
    isAncestor: (repoPath, branch, base) => deadline(deps.isAncestor(repoPath, branch, base), timeoutMs, "git merge-base"),
  };
  return async (rec, pr) => {
    let added: { id: string; created: boolean };
    try {
      const v = parseAddInput({ kind: "pr", title: `PR #${pr.number}`, body: "", pr: { url: pr.url } }, { previewEnabled: false });
      if (!v.ok) throw new Error(`relay pr item refused: ${v.error}`);
      added = await addItem(bounded, rec.id, v.value, { agentId: rec.id, kind: "relay" });
    } catch (e) {
      events.prWithoutItem?.(rec.id, pr.url)
        .catch((err) => console.warn("[chief] relay pr-opened line failed:", err instanceof Error ? err.message : err));
      throw e;
    }
    const { id, created } = added;
    if (!created) return;
    const item = await deps.store.get(id);
    if (item && isAgentItem(item)) {
      events.addQueue(item.id, item.kind, item.repo, item.agentId)
        .catch((e) => console.warn("[chief] relay queue digest line failed:", e instanceof Error ? e.message : e));
    }
  };
}

// The Queue header's week line (spec §8b): the 1b metrics fold (§6.5) for the
// current ISO week.
export async function weekCounts(core: Pick<ChiefCore, "decisions" | "classified">, now: number = Date.now()): Promise<Counts> {
  const [lines, entries] = await Promise.all([core.decisions.read(), core.classified.read()]);
  const [week] = foldMetrics(lines, entries, { weeks: 1, now }).weeks;
  return { decisions: week?.decisions ?? 0, corrections: week?.corrections ?? 0 };
}

// The auto-answer mode (spec §3, §5.6 check 7), read per request: the
// hardened monitor's verdict can change while the console runs.
export function chiefAuthMode(core: Pick<ChiefCore, "userAuth" | "hardened">): AuthMode {
  return authMode({ userAuth: core.userAuth, hardened: core.hardened() });
}

// The master's `answer --auto` on the core's stores and tunables (spec §5.6).
// `audit` is the one AuditLog that QueueActions shares; `onAuto` posts the
// Telegram one-liner (no poster: nothing).
export function makeAutoAnswer(core: ChiefCore, d: {
  agents: Pick<SessionStore, "load">; audit: AuditLog; deliverer: Pick<Deliverer, "kick">;
  onAuto?: (item: QueueItem) => unknown; log?: (s: string) => void;
}): AutoAnswer {
  return new AutoAnswer({
    store: core.queue, rules: core.rules, agents: d.agents, audit: d.audit, deliverer: d.deliverer,
    mode: () => chiefAuthMode(core), threshold: core.tunables.autoThreshold, undoMs: core.tunables.undoMs,
    onAuto: d.onAuto, log: d.log,
  });
}

// The card index at boot (spec §8 (b)): cards.json, then every item's card,
// media and extra message ids (cardIdsOf), so a tap or a quoted reply on an
// item card posted before the restart finds its item. A failed queue read is
// logged; cards.json still loads.
export async function loadCardIndex(core: { queue: Pick<QueueStore, "list"> }, cards: Pick<CardIndex, "load">,
  log: (s: string) => void = (s) => console.warn(s)): Promise<void> {
  let items: QueueItem[] = [];
  try {
    items = await core.queue.list();
  } catch (e) {
    log(`[chief] card index: queue read failed, item cards not indexed: ${errText(e)}`);
  }
  await cards.load(items.flatMap((i) => cardIdsOf(i).map((messageId) => ({ messageId, itemId: i.id }))));
}

// `run` one at a time, with at most one rerun queued behind it: a call while
// a run is going gets the rerun, which starts once that run ends (so after the
// call), so what `run` reads only moves forward and a burst of calls runs it
// at most twice. A run that throws rejects its own callers only.
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const p: Promise<void> = run().finally(() => { if (current === p) current = null; });
    current = p;
    return p;
  };
  return () => {
    if (queued) return queued;
    if (!current) return start();
    queued = current.then(() => undefined, () => undefined).then(() => {
      queued = null;
      return start();
    });
    return queued;
  };
}

// The queue cards in the Master topic (spec §8 "Queue cards"): an active core
// only (misconfigured: no poster, no card). Hub `queue` events go to onItem;
// start() runs the boot tick (cards for open items posted while the poster
// was down) and the 30 s retry tick. The rule texts of the card's star line
// come from a cache, filled here and refreshed before each event of an item
// that cites rules (ruleText is sync); refreshes never overlap (coalesce), so
// an older fold never overwrites a newer map. `stop` ends the tick and the events.
export async function startCardPoster(core: ChiefCore, d: {
  tg: CardPosterDeps["tg"]; cfg: CardChat; cards: Pick<CardIndex, "addItem">;
  hub: Pick<EventHub, "subscribe">; log?: (s: string) => void;
}): Promise<{ poster: CardPoster; stop: () => void } | undefined> {
  if (!core.active) return undefined;
  const log = d.log ?? ((s: string) => console.warn(s));
  let texts = new Map<string, string>();
  const refresh = coalesce(async (): Promise<void> => {
    try {
      texts = new Map((await core.rules.all()).map((r) => [r.id, r.text]));
    } catch (e) {
      log(`[chief] card poster: rule texts not read: ${errText(e)}`);
    }
  });
  const poster = new CardPoster({
    tg: d.tg, cfg: d.cfg, consoleUrl: core.consoleUrl, store: core.queue, cards: d.cards,
    // A stored name is checked before it is joined into a path (a hand-edited item file).
    readMedia: (item, name) => (MEDIA_NAME_RE.test(name)
      ? readFile(join(core.queue.mediaDir, item.id, name))
      : Promise.reject(new Error(`media name ${JSON.stringify(name)} refused`))),
    ruleText: (id) => texts.get(id), telegramAuto: core.tunables.telegramAuto, log,
  });
  await refresh();
  let stopped = false;
  const unsubscribe = d.hub.subscribe((e) => {
    if (e.type !== "queue") return;
    const item = e.item;
    if (item.recommend?.ruleIds.length) {
      void refresh().then(() => { if (!stopped) poster.onItem(item); })
        .catch((err) => log(`[chief] card poster: event for ${item.id} failed: ${errText(err)}`));
    } else poster.onItem(item);
  });
  const stopTick = poster.start();
  return { poster, stop: () => { stopped = true; unsubscribe(); stopTick(); } };
}
