// server/master/events.ts — turns hub events about console agents into a short
// digest for the fleet master. In memory only; a restart loses it (spec non-goal).
// The digest never carries agent-written text: only agent-<id8>, the repo dir
// name, an event word and a validated GitHub PR URL.
import { basename } from "node:path";
import type { ConsoleEvent, EventHub } from "../events.js";
import { isPersistentKind, type AgentRecord, type SessionStore } from "../agents/store.js";
import type { Issue, IssueStore } from "../issues/store.js";
import type { QueueKind } from "../chief/kinds.js";
import { AREA_RE } from "../chief/leads/areas.js";
import { isAgentItem, type QueueItem } from "../chief/queue/types.js";
import { NAME_RE as CRON_NAME_RE } from "../../bin/lib/cronspec.js";
import { COORDINATOR_ID } from "../coordinator/paths.js";
import { FLEET_MASTER_ID } from "./paths.js";
import { BLOCKED_ALERT_MS, masterMayAnswer, type QuietPolicy } from "./quiet.js";

export type LeadEventKind = "lead-report" | "lead-errored";
// `service-crashed`: only with the quiet policy; agentId carries the service id.
// `cron-*`: the master's queue only (`cron` dep); agentId carries the name of the recurring task.
// The kind is the state of the run (cronEventKind): cron-all-clear, cron-needs-you, cron-failed
// (did not finish), and cron-ok for a run that finished with no result line (a task from before).
// at-limit, model-error: the last turn of the agent was cut by its Claude login (the plan or a
// model of it has no room; the model does not work). The agent did not end its work.
export type FleetEventKind = "waiting" | "errored" | "finished" | "pr-opened" | "at-limit" | "model-error" | "login-out" | "service-crashed" | "cron-all-clear" | "cron-needs-you" | "cron-ok" | "cron-failed" | LeadEventKind;
export type FleetEvent = { agentId: string; repo: string; kind: FleetEventKind; prUrl?: string };
export type QueueDigestEvent = { itemId: string; kind: QueueKind; repo: string };
export const EVENT_CAP = 50;
// Queue lines per digest; the rest wait for the next one (spec §5.6 "Digest").
export const QUEUE_DIGEST_CAP = 20;

export const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const REPO_RE = /^[\w.-]+$/;
const ITEM_ID_RE = /^q[0-9a-z]{8}$/;
// The kinds a digest line may carry. Never `deploy`: the console's own deploy ticket gives the
// master no event to act on (chief spec §5.7). Checked at run time too, not only by the types.
const DIGEST_KINDS: ReadonlySet<string> = new Set<QueueKind>(["pr", "choice", "preview", "question"]);

// The running leads' queues, by lead id (spec §13): the master queue's addQueue
// puts a copy of a lead's worker's item line in that lead's digest.
export type LeadDigests = {
  get(leadId: string): { addQueueLine(itemId: string, kind: QueueKind, repo: string): void } | undefined;
};

export type EventQueueDeps = {
  hub: Pick<EventHub, "subscribe">;
  agents: Pick<SessionStore, "load">;
  issues: Pick<IssueStore, "list">;
  acted: { recent(id: string): boolean };
  // Which agents' status and issue events this queue takes (spec §13): the
  // master's drops a live lead's workers, a lead's takes only its own. Absent
  // (flag off): all. Queue items do not use it.
  accept?: (rec: AgentRecord) => Promise<boolean>;
  // Absent (flag off, or a lead's own queue): no lead copies.
  leads?: LeadDigests;
  // The fleet master's quiet policy (master/quiet.ts): an active chief core
  // only. Absent (flag off, misconfigured, or a lead's own queue): every event
  // and every queue line as before.
  quiet?: QuietPolicy;
  // The fleet master's queue only (the reader of the runs: the Coordinator with the chief of
  // staff active): every run of a recurring task adds one `cron <name> <state>` line. The
  // reader reads the run (`choibot cron show`) when it needs the user; the line has no text of the task.
  cron?: boolean;
  cap?: number;
  log?: (s: string) => void;
};

export function repoNameOf(rec: Pick<AgentRecord, "repo">): string {
  if (!rec.repo) return "workspace";
  const name = basename(rec.repo);
  return REPO_RE.test(name) ? name : "?";
}

export function digestLine(e: FleetEvent): string {
  // A lead line is `lead-report <area>` or `lead-errored <area>`; repo carries the area.
  if (e.kind === "lead-report" || e.kind === "lead-errored") return `${e.kind} ${e.repo}`;
  if (e.kind === "service-crashed") return `service ${e.agentId} crashed`;
  if (e.kind === "cron-all-clear") return `cron ${e.agentId} all-clear`;
  if (e.kind === "cron-needs-you") return `cron ${e.agentId} needs-you`;
  if (e.kind === "cron-failed") return `cron ${e.agentId} did-not-finish`;
  // A run that finished with no result line (a task from before the result line): read as before.
  if (e.kind === "cron-ok") return `cron ${e.agentId} ok`;
  const pr = e.prUrl && PR_URL_RE.test(e.prUrl) ? ` ${e.prUrl}` : "";
  // The reason of a stop, in the line itself: no prompt of an agent names these two kinds.
  const why = e.kind === "at-limit" ? " (its Claude login has no room, so its turn was cut. It did not end its work. The user can move it to another login; a new worker can name a login with \"account\")"
    : e.kind === "model-error" ? " (the model of its session does not work for its Claude login, so its turn was cut. It did not end its work)"
    : e.kind === "login-out" ? " (its Claude login is signed out, so its turn was cut. It did not end its work. The user must sign in to that login again in Settings, or move the agent to another login)" : "";
  return `agent-${e.agentId.slice(0, 8)} ${e.repo} ${e.kind}${pr}${why}`;
}

// The digest kind of a run: a run that did not finish is never anything else; a run that
// finished has the state of its result line (a raw value: only the 2 fixed states count).
export function cronEventKind(ok: boolean, state: unknown): FleetEventKind {
  if (!ok || state === "did-not-finish") return "cron-failed";
  return state === "all-clear" ? "cron-all-clear" : state === "needs-you" ? "cron-needs-you" : "cron-ok";
}

// Ids only: null for an item id or repo that could carry other text.
export function queueDigestLine(e: QueueDigestEvent): string | null {
  if (!ITEM_ID_RE.test(e.itemId) || !REPO_RE.test(e.repo) || !DIGEST_KINDS.has(e.kind)) return null;
  return `queue ${e.itemId} ${e.kind} ${e.repo}`;
}

// Boot: the open or snoozed items the master has not yet recommended on (its own never).
export function requeueDigest(items: QueueItem[], events: Pick<EventQueue, "addQueue">,
  log: (s: string) => void = (s) => console.warn(s)): void {
  for (const i of items) {
    // Never the console's own deploy ticket: the master gets no event for it (spec §5.7).
    if (isAgentItem(i) && (i.status === "open" || i.status === "snoozed") && !i.recommend) {
      events.addQueue(i.id, i.kind, i.repo, i.agentId)
        .catch((e) => log(`[master] queue digest re-add of ${i.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

const STATUS_KIND: Partial<Record<string, FleetEventKind>> = { idle: "waiting", error: "errored", done: "finished" };

export class EventQueue {
  // Insertion-ordered: the first key is the oldest event.
  private items = new Map<string, FleetEvent>();
  // Queue lines (spec §5.6 "Digest"), validated at add: keyed `queue:<itemId>`,
  // not acted-filtered, never dropped: at most QUEUE_DIGEST_CAP per digest,
  // the rest in the next.
  private queueItems = new Map<string, string>();
  // The queue keys the last digest() rendered: clear() drops only these, so a
  // line added while that digest was sent goes in the next one.
  private queueRendered: string[] = [];
  private dropped = 0;
  // How many older events were dropped (EVENT_CAP) and not yet named in a digest: the next
  // digest names them ("+N older") and then this is 0 again.
  droppedCount(): number {
    return this.dropped;
  }
  private seenPr = new Map<string, string | undefined>();
  private seenIssueStatus = new Map<string, Issue["status"]>();
  // Notification hooks re-emit agent-status idle; only a change is news.
  private lastStatus = new Map<string, string>();
  // Quiet policy only: the waiting agents whose line is not an alert yet, by
  // agent id, with the time the wait began.
  // `checked`: the record read that a due waiting gets before it is released.
  private held = new Map<string, { ev: FleetEvent; since: number; checked?: "pending" | "ok" }>();
  // Quiet policy only: what the last digest() rendered. clear() then drops
  // only these, so an alert that arrives while that digest is sent stays.
  private rendered: Array<[string, FleetEvent]> = [];
  private renderedDropped = 0;

  constructor(private d: EventQueueDeps) {}

  private now(): number { return (this.d.quiet?.now ?? Date.now)(); }

  async start(): Promise<() => void> {
    for (const i of await this.d.issues.list()) {
      this.seenPr.set(i.id, i.prUrl);
      this.seenIssueStatus.set(i.id, i.status);
    }
    return this.d.hub.subscribe((e) => {
      void this.onEvent(e).catch((err) => console.warn("[master] event:", err instanceof Error ? err.message : err));
    });
  }

  async onEvent(e: ConsoleEvent): Promise<void> {
    if (e.type === "agent-status") {
      if (this.lastStatus.get(e.agentId) === e.status) return;
      this.lastStatus.set(e.agentId, e.status);
      // The agent runs again, ended or failed: its wait is over.
      if (e.status !== "idle") this.held.delete(e.agentId);
      // Ended on purpose by the console (a sign-out of its login): no "finished" line.
      if (e.quiet) return;
      const kind = STATUS_KIND[e.status];
      if (kind) await this.addFor(e.agentId, kind);
    } else if (e.type === "agent-stop") {
      // The hook route saw that a limit cut the agent: an alert, at once, with the reason.
      await this.addFor(e.agentId, e.why === "limit" ? "at-limit" : e.why === "login" ? "login-out" : "model-error", undefined, true);
    } else if (e.type === "issue") {
      await this.onIssue(e.issue);
    } else if (e.type === "service-status" && this.d.quiet && e.status === "crashed") {
      // `crashed` is a crash with no restart left (no auto-restart, or its
      // breaker tripped): a service problem the user must know about.
      if (REPO_RE.test(e.serviceId)) this.add({ agentId: e.serviceId, repo: "", kind: "service-crashed" });
    } else if (e.type === "cron-run" && this.d.cron) {
      // The name comes from the runner's notify POST: a job slug or no line.
      if (CRON_NAME_RE.test(e.name)) this.add({ agentId: e.name, repo: "", kind: cronEventKind(e.ok, e.said?.state) });
    }
  }

  private async onIssue(i: Issue): Promise<void> {
    const prev = this.seenPr.get(i.id);
    this.seenPr.set(i.id, i.prUrl);
    const prevStatus = this.seenIssueStatus.get(i.id);
    this.seenIssueStatus.set(i.id, i.status);
    if (!i.agentId) return;
    if (i.prUrl && i.prUrl !== prev) await this.addFor(i.agentId, "pr-opened", i.prUrl);
    if (i.status === "needs-input" && prevStatus !== "needs-input") await this.addFor(i.agentId, "waiting");
  }

  // Quiet policy: the `pr` queue item of this PR could not be made
  // (relayQueueAdd), so its pr-opened line is an alert after all. Routed as
  // every agent event (a lead's worker: not to the master).
  prWithoutItem(agentId: string, prUrl: string): Promise<void> {
    return this.addFor(agentId, "pr-opened", prUrl, true);
  }

  private async addFor(agentId: string, kind: FleetEventKind, prUrl?: string, alert = false): Promise<void> {
    if (this.d.acted.recent(agentId)) return;
    const rec = await this.d.agents.load(agentId);
    if (!rec) return;
    if (this.d.accept && !(await this.d.accept(rec))) return;
    if (rec.kind === "lead") {
      // Only a lead's error is news; its idle/done/other lines never enter the digest.
      if (kind === "errored" && rec.area) this.addLead("lead-errored", rec.area, agentId);
      return;
    }
    if (isPersistentKind(rec.kind)) return;
    // An agent that a limit cut gets its own line at once (at-limit): no second line "waiting".
    if (kind === "waiting" && rec.stop) return;
    const ev: FleetEvent = { agentId, repo: repoNameOf(rec), kind, ...(prUrl ? { prUrl } : {}) };
    // A failure alert always passes, at once. When in doubt, a kind passes.
    if (!this.d.quiet || alert || (kind !== "waiting" && kind !== "finished" && kind !== "pr-opened")) {
      this.add(ev);
      return;
    }
    // Quiet policy: `finished` is no alert, and a PR an issue agent opened has
    // its `pr` queue item (relayQueueAdd adds the line itself when that item
    // could not be made). `waiting` is held: digest() releases it once the
    // agent is blocked. A second waiting of a held agent keeps the first time.
    if (kind === "waiting" && !this.held.has(agentId)) this.held.set(agentId, { ev, since: this.now() });
  }

  // Quiet policy: what a held waiting is now. `over`: the agent's last status
  // is not idle (its running event overtook the record load of its idle
  // event). `due`: blocked for BLOCKED_ALERT_MS, and the user did not type to
  // the agent within the presence window — an alert.
  private heldState(agentId: string, since: number): "over" | "due" | "held" {
    const st = this.lastStatus.get(agentId);
    if (st !== undefined && st !== "idle") return "over";
    const blockedMs = this.d.quiet?.blockedMs ?? BLOCKED_ALERT_MS;
    return this.now() - since >= blockedMs && !this.d.quiet?.userPresent(agentId) ? "due" : "held";
  }

  // Moves the due waitings into the digest and forgets the ones that are over.
  // A due waiting first gets one record read: an agent deleted with no status
  // event (it had no live PTY) is not waiting. The line then goes in the next
  // digest() (the inbox asks every second). A read that fails passes the line.
  private releaseHeld(): void {
    for (const [agentId, h] of this.held) {
      const state = this.heldState(agentId, h.since);
      if (state === "held") continue;
      if (state === "over") {
        this.held.delete(agentId);
      } else if (h.checked === "ok") {
        this.held.delete(agentId);
        this.add(h.ev);
      } else if (h.checked === undefined) {
        h.checked = "pending";
        const settle = (exists: boolean): void => {
          if (this.held.get(agentId) !== h) return;
          if (exists) h.checked = "ok"; else this.held.delete(agentId);
        };
        void this.d.agents.load(agentId).then((rec) => settle(rec !== null), () => settle(true));
      }
    }
  }

  // The agents whose waiting is held (not yet an alert): for tests and the status line.
  heldCount(): number { return this.held.size; }

  add(ev: FleetEvent): void {
    const key = `${ev.agentId}:${ev.kind}`;
    this.items.delete(key); // re-adding moves it to the newest slot
    this.items.set(key, ev);
    const cap = this.d.cap ?? EVENT_CAP;
    while (this.items.size > cap) {
      const oldest = this.items.keys().next().value!;
      const gone = this.items.get(oldest);
      this.items.delete(oldest);
      // Quiet policy: an event the digest that is being sent carries is not "older" news.
      if (!this.rendered.some(([key, ev]) => key === oldest && ev === gone)) this.dropped++;
    }
  }

  // `lead-report <area>` or `lead-errored <area>`; an area that is not an area name adds nothing.
  addLead(kind: LeadEventKind, area: string, leadId: string): void {
    if (!AREA_RE.test(area)) return;
    this.add({ agentId: leadId, repo: area, kind });
  }

  // Every item of a non-master agent enters this digest, synchronously (before
  // any await). With `leads`, the item agent's record is loaded and an item of
  // a running lead's worker is copied into that lead's digest too (overview
  // decision 35). Rejects when the record load throws: callers .catch(log).
  // With the quiet policy the master's own line is filtered (a pr or preview
  // item: none; a choice or question: only when a brain rule can match it);
  // the lead's copy is not.
  async addQueue(itemId: string, kind: QueueKind, repo: string, agentId: string): Promise<void> {
    // Never the reader's own item: the fleet master's, or the Coordinator's (which reads this
    // digest when the chief is active, server/coordinator/feed.ts).
    if (agentId === FLEET_MASTER_ID || agentId === COORDINATOR_ID) return;
    const q = this.d.quiet;
    if (!q) {
      if (!this.addQueueLine(itemId, kind, repo)) return;
    } else {
      if (this.checkedQueueLine(itemId, kind, repo) === null) return;
      // queueEcho never rejects in production (masterQueueEcho); a rejection passes the line.
      if (masterMayAnswer(kind) && await q.queueEcho(itemId).catch(() => true)) this.addQueueLine(itemId, kind, repo);
    }
    if (!this.d.leads) return;
    const rec = await this.d.agents.load(agentId);
    if (!rec?.spawnedBy || isPersistentKind(rec.kind)) return;
    this.d.leads.get(rec.spawnedBy)?.addQueueLine(itemId, kind, repo);
  }

  // The item's digest line, or null (logged) for an id or repo that could carry other text.
  private checkedQueueLine(itemId: string, kind: QueueKind, repo: string): string | null {
    const line = queueDigestLine({ itemId, kind, repo });
    if (line === null) {
      const msg = `[master] queue digest: skipped item ${JSON.stringify(itemId)} (repo ${JSON.stringify(repo)}): not an item id and repo name`;
      if (this.d.log) this.d.log(msg); else console.warn(msg);
    }
    return line;
  }

  // The item's digest line only: no record load, no routing. False when skipped.
  addQueueLine(itemId: string, kind: QueueKind, repo: string): boolean {
    const line = this.checkedQueueLine(itemId, kind, repo);
    if (line === null) return false;
    this.queueItems.set(`queue:${itemId}`, line);
    return true;
  }

  // Held waitings count only once they are due: the inbox reads size() and
  // digest(), and a held line is not news yet.
  size(): number {
    let due = 0;
    for (const [agentId, h] of this.held) if (this.heldState(agentId, h.since) === "due") due++;
    return this.items.size + this.queueItems.size + due;
  }

  digest(): string | null {
    this.releaseHeld();
    if (!this.items.size && !this.queueItems.size) return null;
    if (this.d.quiet) {
      this.rendered = [...this.items];
      this.renderedDropped = this.dropped;
    }
    const parts = [...this.items.values()].map(digestLine);
    if (this.dropped) parts.push(`+${this.dropped} older`);
    this.queueRendered = [];
    for (const [key, line] of this.queueItems) {
      if (this.queueRendered.length === QUEUE_DIGEST_CAP) break;
      parts.push(line);
      this.queueRendered.push(key);
    }
    const more = this.queueItems.size - this.queueRendered.length;
    if (more > 0) parts.push(`+${more} more queue items — list them with \`queue list --open\``);
    return `[events] ${parts.join(" · ")}`;
  }

  clear(): void {
    if (this.d.quiet) {
      // Only what the last digest() carried: an alert added while that digest
      // was sent (or changed since) goes in the next one.
      for (const [key, ev] of this.rendered) if (this.items.get(key) === ev) this.items.delete(key);
      this.dropped = Math.max(0, this.dropped - this.renderedDropped);
    } else {
      this.items.clear();
      this.dropped = 0;
    }
    this.rendered = [];
    this.renderedDropped = 0;
    for (const key of this.queueRendered) this.queueItems.delete(key);
    this.queueRendered = [];
  }
}
