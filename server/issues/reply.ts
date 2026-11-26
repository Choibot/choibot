// server/issues/reply.ts — a Telegram reply that quotes an issue message goes
// to that issue's agent as typed input.
import type { TerminalManager } from "../agents/terminal.js";
import type { SessionStore } from "../agents/store.js";
import type { CaptureLine } from "../chief/brain/capture.js";
import type { IssueActions } from "./actions.js";
import type { IssueIntake } from "./intake.js";
import { reopened, summaryOf, type Issue, type IssueStore } from "./store.js";
import type { TgMessage } from "./telegram.js";
import { largestPhoto } from "./updates.js";

export type ReplyTerminals = Pick<TerminalManager, "has" | "hasSession" | "write" | "inputReady"> & {
  reattach(id: string): Promise<unknown>;
  // TerminalManager.dialogOn; a terminal set with none has no dialog check.
  dialogOn?(id: string): Promise<boolean>;
};

export type SendResult = "sent" | "not-live" | "starting";
export type TypeResult = "sent" | "not-live" | "dialog";
// After a reattach the session's screen comes back with the replay: the dialog check waits this long for it.
export const REATTACH_SETTLE_MS = 400;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One typing lock per agent PTY. sendToAgent sleeps between the paste and its
// Enter, so two writers (the composer, the fleet-master inbox, Telegram
// replies, widget asks) must not interleave inside that gap. Not re-entrant:
// code inside the lock calls typeIntoAgent, never sendToAgent. The chain goes
// on after fn throws.
const typingChains = new Map<string, Promise<unknown>>();

export function withTypingLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = typingChains.get(agentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  typingChains.set(agentId, tail);
  void tail.then(() => { if (typingChains.get(agentId) === tail) typingChains.delete(agentId); });
  return run;
}

// Write `text` into the agent's PTY as one bracketed paste, then Enter as a
// separate write ~100 ms later, so Claude does not swallow the Enter while it
// collapses a large paste and a multi-line reply never submits early. C0
// controls (ESC and CR included), DEL and the 8-bit C1 CSI are stripped
// first: an embedded `\x1b[201~` would end the paste and turn the rest of the
// text into keystrokes, and the other controls act as keys in the TUI. Only
// \n and \t survive, so multi-line replies keep their shape.
// Call it only inside withTypingLock(agentId, …).
//
// The one way a console line reaches an agent (the inboxes of the fleet master, the leads and
// the Coordinator, the composer, Telegram replies, widget asks, the go-on line after a login
// move). So the rule is here: no line while Claude shows a dialog on the agent's screen. A line
// typed there answers the dialog by accident (Enter at the folder trust dialog is "No, exit":
// the incident of 2026-11-20). "dialog": nothing was written; the caller keeps the line.
export async function typeIntoAgentWhy(
  terminals: ReplyTerminals, agentId: string, text: string, sleep = defaultSleep,
): Promise<TypeResult> {
  if (!terminals.has(agentId) && (await terminals.hasSession(agentId))) {
    await terminals.reattach(agentId);
    if (terminals.dialogOn && terminals.has(agentId)) await sleep(REATTACH_SETTLE_MS);
  }
  if (!terminals.has(agentId)) return "not-live";
  if (terminals.dialogOn && (await terminals.dialogOn(agentId).catch(() => false))) return "dialog";
  terminals.write(agentId, pasteOf(text));
  await sleep(100);
  terminals.write(agentId, "\r");
  return "sent";
}

// True when the line was written.
export async function typeIntoAgent(
  terminals: ReplyTerminals, agentId: string, text: string, sleep = defaultSleep,
): Promise<boolean> {
  return (await typeIntoAgentWhy(terminals, agentId, text, sleep)) === "sent";
}

// The bytes typeIntoAgent writes before its Enter.
export function pasteOf(text: string): string {
  const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, "");
  return `\x1b[200~${clean}\x1b[201~`;
}

// With checkReady (index.ts sets it from chiefActive), a PTY tracked here
// whose TUI has not turned on bracketed paste yet (a relaunch that held the
// lock just respawned it) gets nothing: "starting". The check runs inside the
// lock, so a send queued behind the relaunch sees the new PTY. Without
// checkReady the result is never "starting".
export function sendToAgent(
  terminals: ReplyTerminals, agentId: string, text: string, sleep = defaultSleep,
  opts: { checkReady?: boolean } = {},
): Promise<SendResult> {
  return withTypingLock(agentId, async (): Promise<SendResult> => {
    if (opts.checkReady && terminals.has(agentId) && !terminals.inputReady(agentId)) return "starting";
    // A dialog on its screen: as a TUI that is not ready, the line can go later.
    const r = await typeIntoAgentWhy(terminals, agentId, text, sleep);
    return r === "dialog" ? "starting" : r;
  });
}

export const REPLY_TEXT = {
  closed: "Issue closed.",
  notLive: "Agent not live — resume it in the console.",
  startFailed: "Start failed — tap Fix to retry.",
  starting: "Agent is starting — send this again in a moment.",
} as const;

export type ReplyDeps = {
  store: IssueStore;
  actions: IssueActions;
  intake: IssueIntake;
  agents: Pick<SessionStore, "load">;
  terminals: ReplyTerminals;
  sleep?: (ms: number) => Promise<void>;
  // Resumes a closed agent whose session is stopped, with `text` as its first
  // turn. True when it did; false sends the text to the live terminal as usual.
  resumeClosed?: (agentId: string, text: string) => Promise<boolean>;
  // sendToAgent's readiness check (index.ts sets it from chiefActive).
  checkReady?: boolean;
  // The chief's capture of a reply typed into the agent (spec §6.2 source 2);
  // index.ts passes it only while the chief is active.
  capture?: (line: CaptureLine) => Promise<{ hint?: string }>;
};


export async function handleReply(d: ReplyDeps, issueId: string, msg: TgMessage): Promise<void> {
  const pre = await d.store.get(issueId);
  if (!pre || pre.chatMessageIds.includes(msg.message_id)) return; // re-delivered after a crash

  // Network work before taking the queue.
  const photo = largestPhoto(msg.photo);
  const { paths, notes } = photo
    ? await d.intake.downloadPhotos(issueId, [photo], `reply-${msg.message_id}`)
    : { paths: [] as string[], notes: [] as string[] };
  const said = (msg.text ?? msg.caption ?? "").trim();
  const text = [
    said,
    paths.length ? `Screenshot (read it with the Read tool): ${paths[0]}` : "",
    ...notes,
  ].filter(Boolean).join("\n\n");
  if (!text) return; // sticker, location, …: nothing to relay

  await d.store.queue(issueId, async () => {
    const cur = await d.store.get(issueId);
    if (!cur || cur.chatMessageIds.includes(msg.message_id)) return;
    // The reply's message id is recorded in the same queued step that acts on it.
    const record = (change: (i: Issue) => Issue = (i) => i) =>
      d.store.mutate(issueId, (i) => change({ ...i, chatMessageIds: [...i.chatMessageIds, msg.message_id] }));
    const say = (t: string) => d.actions.postInQueue(issueId, t);
    const send = async (): Promise<SendResult> =>
      (await d.resumeClosed?.(cur.agentId!, text))
        ? "sent"
        : sendToAgent(d.terminals, cur.agentId!, text, d.sleep, { checkReady: d.checkReady });
    // After a "sent" reply is recorded: the user's own words (no screenshot
    // note) go to the brain. Not awaited and best effort, so the reply path
    // never waits on it; a duplicate `rule:` hint is posted after this step.
    const captured = () => {
      const c = d.capture;
      if (!c || !said) return;
      const line: CaptureLine = { text: said, via: "issue-telegram", agentId: cur.agentId!,
        ...(cur.prUrl ? { prUrl: cur.prUrl } : {}) };
      void Promise.resolve().then(() => c(line))
        .then((r) => (r.hint ? d.actions.post(issueId, r.hint) : undefined))
        .catch((e: unknown) => console.warn(`[issues] capture ${issueId}:`, e instanceof Error ? e.message : e));
    };
    // Nothing was typed: keep the status, tell the user why.
    const refused = async (r: Exclude<SendResult, "sent">) => {
      await record();
      await say(r === "starting" ? REPLY_TEXT.starting : REPLY_TEXT.notLive);
    };

    switch (cur.status) {
      case "starting":
        // fix() already dispatched the agent with a snapshot of the issue, so
        // text merged now would never reach it.
        await record();
        await say(REPLY_TEXT.starting);
        return;
      case "pending": {
        const next = await record((i) => {
          const merged = [i.text, text].filter(Boolean).join("\n\n");
          return { ...i, text: merged, summary: summaryOf(merged), photos: [...i.photos, ...paths] };
        });
        if (next) await d.actions.refreshCard(next);
        return;
      }
      case "dropped":
        await record();
        await say(REPLY_TEXT.closed);
        return;
      case "done":
      case "error": {
        if (!cur.agentId) {
          await record();
          await say(cur.status === "error" ? REPLY_TEXT.startFailed : REPLY_TEXT.closed);
          return;
        }
        if (!(await d.agents.load(cur.agentId))) { await record(); await say(REPLY_TEXT.closed); return; }
        const sent = await send();
        if (sent !== "sent") { await refused(sent); return; }
        await record(reopened);
        captured();
        return;
      }
      case "running":
      case "needs-input":
      case "pr-open": {
        if (!cur.agentId || !(await d.agents.load(cur.agentId))) {
          await record((i) => ({ ...i, status: "done" })); // agent deleted from the Agents view
          await say(REPLY_TEXT.closed);
          return;
        }
        const sent = await send();
        if (sent !== "sent") { await refused(sent); return; }
        await record((i) => ({ ...i, status: i.status === "needs-input" ? "running" : i.status }));
        captured();
        return;
      }
    }
  });
}
