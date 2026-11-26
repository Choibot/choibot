// server/coordinator/feed.ts — what feeds the Coordinator. The fleet EventQueue (master/events.ts:
// queue lines, alerts, cron runs, lead reports, with the quiet policy of master/quiet.ts) is
// built once in index.ts. With the chief of staff active its digests go to the Coordinator's
// inbox, made here; the Master's inbox then gets NO_EVENTS. The pick is made once at boot, so
// each event has exactly one reader for the life of the process.
//
// The digest queue is in memory. The feed file (<coordinator data dir>/feed.json) holds the
// time up to which the Coordinator got every cron run and lead report. At boot `catchUp` adds
// one line for each job run and each lead report that is newer: a run that ended while the
// console was down, or in the last minute before a restart, is not lost. On the first start
// (no file: the hand-over from the fleet master) it looks back HANDOVER_MS.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalManager } from "../agents/terminal.js";
import type { EventHub } from "../events.js";
import { typeIntoAgent, withTypingLock, type ReplyTerminals } from "../issues/reply.js";
import { atomicWrite, onChain, readJson } from "../chief/files.js";
import { AREA_RE, leadId } from "../chief/leads/areas.js";
import { InputTracker } from "../master/draft.js";
import { cronEventKind, type EventQueue } from "../master/events.js";
import { resultState } from "../cron/result.js";
import { MasterInbox } from "../master/inbox.js";
import { NAME_RE as CRON_NAME_RE, cronPaths, readJsonSafe, type CronRunResult } from "../../bin/lib/cronspec.js";
import { COORDINATOR_ID } from "./paths.js";

// What the Master's inbox reads while the Coordinator has the feed: never an event.
export const NO_EVENTS = { size: (): number => 0, digest: (): null => null, clear: (): void => {} };

// The first start looks back this far. The code before the Coordinator kept no mark, so the
// hand-over cannot be exact: a run that the fleet master read in these last minutes is read a
// second time (the one-ticket rule keeps the Queue free of a second ticket), and a run that
// waited longer than this for a busy fleet master is not seen. Short on purpose.
export const HANDOVER_MS = 2 * 60_000;
// A run is written a moment before its event arrives: the mark stays this far behind a digest.
export const SEEN_MARGIN_MS = 2_000;
// Between two tries to start a Coordinator that is not live.
export const START_RETRY_MS = 60_000;
// A session that sent no hook yet gets no line before this time (see `mayType`).
export const HELLO_WAIT_MS = 3 * 60_000;

type FeedFile = { seenAt?: number; lastDigestAt?: number };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export async function readFeedFile(file: string): Promise<FeedFile> {
  const v = await readJson<FeedFile>(file).catch(() => null);
  return v && typeof v === "object" ? { ...(finite(v.seenAt) ? { seenAt: v.seenAt } : {}), ...(finite(v.lastDigestAt) ? { lastDigestAt: v.lastDigestAt } : {}) } : {};
}

const writeFeedFile = (file: string, v: FeedFile): Promise<void> => onChain(file, () => atomicWrite(file, JSON.stringify(v)));

// Boot: one digest line for each cron run and each lead report newer than the mark. Returns
// what it added. A dir that is not there adds nothing.
export async function catchUp(d: {
  file: string; cronDataDir: string; leadsDir: string;
  events: Pick<EventQueue, "add" | "addLead">;
  // When the Coordinator's record was made, for a Coordinator whose session never started
  // (no session id): the mark in the file is then not true (nothing was read), and the
  // catch-up looks back from the record.
  neverStartedSince?: number;
  now?: () => number; log?: (s: string) => void;
}): Promise<{ since: number; cron: string[]; reports: string[] }> {
  const now = (d.now ?? Date.now)();
  const state = await readFeedFile(d.file);
  const since = d.neverStartedSince !== undefined
    ? Math.min(state.seenAt ?? Infinity, d.neverStartedSince - HANDOVER_MS)
    : state.seenAt ?? now - HANDOVER_MS;
  const cron: string[] = [];
  const reports: string[] = [];
  const runsDir = cronPaths(d.cronDataDir).runsDir;
  for (const name of (await readdir(runsDir).catch(() => [] as string[])).sort()) {
    if (!CRON_NAME_RE.test(name)) continue;
    const last = await readJsonSafe<CronRunResult>(join(runsDir, name, "last.json"));
    if (!last || !finite(last.finishedAt) || last.finishedAt <= since) continue;
    d.events.add({ agentId: name, repo: "", kind: cronEventKind(last.ok, resultState(last)) });
    cron.push(name);
  }
  // A report file holds no `needs`: when the console cannot tell, the line passes (quiet.ts).
  for (const area of (await readdir(d.leadsDir).catch(() => [] as string[])).sort()) {
    if (!AREA_RE.test(area)) continue;
    const at = await stat(join(d.leadsDir, area, "report.md")).then((s) => s.mtimeMs, () => null);
    if (at === null || at <= since) continue;
    d.events.addLead("lead-report", area, leadId(area));
    reports.push(area);
  }
  // The mark is written now, so a second boot with no digest between does not look back again
  // from "now" and skip what this boot added: it keeps this boot's mark.
  if (state.seenAt !== since) await writeFeedFile(d.file, { ...state, seenAt: since }).catch(() => {});
  if (cron.length || reports.length) (d.log ?? console.log)(`[coordinator] catch-up: ${cron.length} cron run(s), ${reports.length} lead report(s) since ${new Date(since).toISOString()}`);
  return { since, cron, reports };
}

export type CoordinatorFeedDeps = {
  hub: Pick<EventHub, "subscribe">;
  events: Pick<EventQueue, "size" | "digest" | "clear">;
  terminals: ReplyTerminals & Pick<TerminalManager, "has">;
  file: string;
  // ensureCoordinator, bound (coordinator.ts). Called when the Coordinator is not live (its
  // record exists, or a digest or a line waits), at most once per START_RETRY_MS.
  ensure: () => Promise<unknown>;
  // True while Claude shows a dialog on the Coordinator's screen (the prompt watcher): a
  // line typed there answers the dialog (Enter at the folder trust dialog is "No, exit").
  dialog?: () => Promise<boolean>;
  now?: () => number;
  log?: (s: string) => void;
};

export type CoordinatorFeed = {
  inbox: MasterInbox;
  // The record exists (boot found it, or ensure made it).
  markKnown(): void;
  known(): boolean;
  // The session said hello: a hook came from it, or (boot) its record has a session id.
  markHello(): void;
  // A start or a relaunch begins: the new session must say hello before it gets a line.
  starting(): void;
  // Why no line is typed now, for the Settings row; null = nothing in the way.
  blocked(): "dialog" | "starting" | null;
  // When the Coordinator last got a digest or sent a hook (a turn began or ended); null = never.
  lastActivityAt(): number | null;
  // Reads the feed file's times (boot).
  load(): Promise<void>;
  stop(): void;
};

export function makeCoordinatorFeed(d: CoordinatorFeedDeps): CoordinatorFeed {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((s: string) => console.warn(s));
  let known = false;
  let lastTry = Number.NEGATIVE_INFINITY;
  let renderedAt = 0;
  let state: FeedFile = {};
  let lastHookAt: number | null = null;
  // The incident of 2026-11-20: the first session stopped at Claude's folder trust dialog and
  // sent no hook; after a console restart the digest was typed into the dialog, the session
  // ended, and the digest counted as delivered. So a line is typed only when the session said
  // hello and no dialog is on its screen.
  let hello = false;
  let waitingSince = now();
  let dialogSeen = false;

  // A session that never says hello and shows no dialog gets its lines after HELLO_WAIT_MS (a
  // hook lost in a console restart must not stop the feed for good).
  const mayType = async (): Promise<boolean> => {
    // Not attached in this process: no screen to check yet (`ready` starts or reattaches it).
    if (!d.terminals.has(COORDINATOR_ID)) return false;
    dialogSeen = d.dialog ? await d.dialog().catch(() => false) : false;
    if (dialogSeen) return false;
    return hello || now() - waitingSince >= HELLO_WAIT_MS;
  };

  const startIfDown = (): void => {
    if (now() - lastTry < START_RETRY_MS) return;
    lastTry = now();
    void d.ensure().then(() => { known = true; }, (e) => log(`[coordinator] start failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  const events = {
    size: () => d.events.size(),
    digest: () => {
      const text = d.events.digest();
      if (text !== null) renderedAt = now();
      return text;
    },
    clear: () => {
      d.events.clear();
      state = { seenAt: Math.max(state.seenAt ?? 0, renderedAt - SEEN_MARGIN_MS), lastDigestAt: now() };
      void writeFeedFile(d.file, state).catch((e) => log(`[coordinator] feed file not written: ${e instanceof Error ? e.message : String(e)}`));
    },
  };
  const inbox: MasterInbox = new MasterInbox({
    hub: d.hub, events, tracker: new InputTracker(now), agentId: COORDINATOR_ID, now,
    // Under the PTY's typing lock, the block re-checked inside it (as the master's and a lead's).
    send: (text): Promise<boolean> => withTypingLock(COORDINATOR_ID, async (): Promise<boolean> =>
      (inbox.blockedBy() || !(await mayType()) ? false : typeIntoAgent(d.terminals, COORDINATOR_ID, text))),
    // The tick asks every second. No session is attached here: start it (a dtach session that
    // outlived a restart is reattached, a dead one is resumed). A Coordinator that has a record
    // is started also with no work: a stopped one must not wait for the next event.
    ready: () => {
      if ((known || d.events.size() > 0 || inbox.queuedMessages() > 0) && !d.terminals.has(COORDINATOR_ID)) startIfDown();
      return known;
    },
  });
  const unsub = d.hub.subscribe((e) => {
    if (e.type !== "agent-hook" || e.agentId !== COORDINATOR_ID || e.event === "Notification") return;
    lastHookAt = now();
    hello = true;
  });
  return {
    inbox,
    markKnown: () => { known = true; },
    known: () => known,
    markHello: () => { hello = true; },
    starting: () => { hello = false; waitingSince = now(); dialogSeen = false; inbox.markStarting(); },
    blocked: () => (dialogSeen ? "dialog" : hello ? null : "starting"),
    lastActivityAt: () => {
      const t = Math.max(lastHookAt ?? 0, state.lastDigestAt ?? 0);
      return t > 0 ? t : null;
    },
    load: async () => { state = await readFeedFile(d.file); },
    stop: () => { inbox.stop(); unsub(); },
  };
}
