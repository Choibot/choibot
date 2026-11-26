// src/lib/useThreadTickets.ts — the queue tickets of one agent, for its thread. It reads the page's
// one useQueue() state (no second fetch or stream) and answers through the Queue view's own path:
// planAction (read-only, Open and decision-39 guards) → runAnswer → useQueueRun (optimistic update,
// one POST, rollback). Reply drafts live here, so a refused answer keeps its text; the reply's
// images live in lib/answerImages (one list for the page, so the Queue view shows the same ones).
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { answerImages } from "./answerImages";
import { undo } from "./queue";
import { planAction, runAnswer } from "./queueActions";
import { shiftGuardBlocks } from "./queueGuard";
import type { TabState } from "./queueState";
import { agentTickets } from "./threadTickets";
import type { UseQueue } from "./useQueue";
import type { QueueAction } from "./useQueueKeys";
import { useQueueRun } from "./useQueueRun";

const CLOCK_TICK_MS = 30_000;
const DEFAULT_UNDO_MS = 10 * 60_000;
const NO_ITEMS: QueueItem[] = [];
const OFF_STATE: TabState = { items: NO_ITEMS, focusId: null, pending: {}, error: null, readOnly: true, arrived: {}, jumps: 0 };

// A pane with no queue (the chief queue is off): no tickets, and nothing to answer.
export const NO_QUEUE: UseQueue = {
  view: "off", state: OFF_STATE, dispatch: () => {}, now: () => Date.now(), refresh: () => {}, seenJumps: { current: 0 },
};

// "blocked": the card moved under the pointer a moment ago (shift guard); the press was ignored.
export type TicketActResult = "done" | "blocked" | "focusReply" | "none";

export type ThreadTickets = {
  tickets: QueueItem[]; // this agent's tickets, oldest first
  clock: number; // changes every 30 s while there are tickets (times, the undo window, a snooze that ends)
  now(): number;
  readOnly: boolean;
  undoMs: number;
  error: { id: string; text: string } | null;
  dismissError(): void;
  draft(id: string): string;
  setDraft(id: string, text: string): void;
  // `movedAt`: when the card last moved on the screen by itself (the thread view measures it).
  act(item: QueueItem, a: QueueAction, movedAt: number | undefined): TicketActResult;
  undo(item: QueueItem): void;
};

export function useThreadTickets(q: UseQueue, agentId: string | undefined): ThreadTickets {
  const live = useRef(q);
  live.current = q;
  const { run, respond, checkPr } = useQueueRun(q);
  const on = q.view === "on";
  const items = on ? q.state.items : NO_ITEMS;
  const tickets = useMemo(() => (agentId ? agentTickets(items, agentId) : NO_ITEMS), [items, agentId]);

  const [clock, setClock] = useState(0);
  const any = tickets.length > 0;
  useEffect(() => {
    if (!any) return;
    const id = setInterval(() => setClock((n) => n + 1), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [any]);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draft = useCallback((id: string) => drafts[id] ?? "", [drafts]);
  const setDraft = useCallback((id: string, text: string) => setDrafts((d) => ({ ...d, [id]: text })), []);
  // The reply of a ticket is its text and its images (lib/answerImages): both go together.
  const clearDraft = useCallback((id: string) => { setDrafts((d) => { const { [id]: _x, ...rest } = d; return rest; }); answerImages.clear(id); }, []);

  const act = useCallback((item: QueueItem, a: QueueAction, movedAt: number | undefined): TicketActResult => {
    const cur = live.current;
    // The newest copy of the item decides: the card may be one render behind the stream.
    const fresh = cur.state.items.find((i) => i.id === item.id) ?? item;
    const plan = planAction(a, {
      focused: fresh, readOnly: cur.state.readOnly, draft: draftsRef.current[item.id] ?? "", snoozeMin: 60, now: cur.now(),
      images: answerImages.names(item.id), imagesWait: answerImages.blocked(item.id),
    });
    if (!plan) return "none";
    switch (plan.t) {
      case "answer":
        if (shiftGuardBlocks(movedAt, Date.now())) return "blocked";
        void runAnswer(plan, { respond, clearDraft }); // the draft goes only once the answer landed
        return "done";
      // A pr item is never approved (decision 60): the server reads the PR's state, closes the
      // ticket when the PR is merged, and else gives the reason (the card's error line).
      case "checkPr":
        if (shiftGuardBlocks(movedAt, Date.now())) return "blocked";
        void checkPr(plan.item);
        return "done";
      case "focusReply": return "focusReply";
      default: return "none"; // a snooze is the Queue view's action; a card opens its links itself
    }
  }, [respond, checkPr, clearDraft]);

  const undoItem = useCallback((item: QueueItem) => {
    if (live.current.state.readOnly) return;
    void run(item, { ...item, status: "open" }, () => undo(item.id));
  }, [run]);

  const now = useCallback(() => live.current.now(), []);
  const dismissError = useCallback(() => live.current.dispatch({ t: "dismissError" }), []);
  const errId = q.state.errorId;
  const errText = q.state.error;
  const error = useMemo(
    () => (on && errText && errId && tickets.some((t) => t.id === errId) ? { id: errId, text: errText } : null),
    [on, errText, errId, tickets],
  );

  return {
    tickets, clock, now, readOnly: q.state.readOnly, undoMs: q.data?.undoMs ?? DEFAULT_UNDO_MS,
    error, dismissError, draft, setDraft, act, undo: undoItem,
  };
}
