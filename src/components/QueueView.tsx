// src/components/QueueView.tsx — the Queue view (spec §8b), laid out as an inbox: a ticket list
// on the left (Blocks an agent, For review, Undelivered, Snoozed, Done today) and the selected
// ticket in full on the right. On a phone the list is the first screen and a tap opens the ticket
// on the full screen. Also here: the header, the `protection: basic` chip, the pairing card above a
// read-only list when unpaired, the misconfigured line, the empty state, the key model and undo.
// Item text is untrusted. A title, an option and a reason are plain text; a body is markdown
// through the thread view's safe renderer (no raw HTML, no remote image).
"use client";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import DOMPurify from "dompurify";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { isPersistentAgentId } from "../../server/chief/kinds";
import { isUndelivered } from "../../server/chief/queue/sections";
import {
  delivery, EMPTY_TEXT, latestUndoable, metricsLine, openLink, pairingText, previewSrc, sections,
  snooze, undo, withdraw,
} from "../lib/queue";
import { MISCONFIGURED_TEXT, getChiefState } from "../lib/chief";
import type { UseQueue } from "../lib/useQueue";
import { usePrChecking, useQueueRun } from "../lib/useQueueRun";
import { prAutoCheck } from "../lib/prAutoCheck";
import { isTypingTarget, useQueueKeys, type QueueAction } from "../lib/useQueueKeys";
import { detailActions, openLinkAttrs, PR_CHECK_TEXT, PR_CHECK_TITLE, PR_CHECKING_TEXT, PR_WAIT_TEXT, prFacts, prWait, recommendLine } from "../lib/queueDetail";
import { deliverySlot, optimisticDelivery, planAction, runAnswer, undeliveredText } from "../lib/queueActions";
import {
  HOLD_QUIET_MS, enterGuardBlocks, holdBlocks, holdOnKey, holdOnLeave, holdOnReturn, isHeld, mayTakeFocus, pageAway, replyBlurEnds,
  replyLost, startEnterGuard, startHold, type EnterGuard, type Hold,
} from "../lib/queueGuard";
import { useIsMobile } from "../lib/useIsMobile";
import { ensureLeadLooks, useLeadLooks } from "../lib/leads";
import { LeadAvatar } from "./LeadAvatar";
import { PhoneHeader } from "./PhoneHeader";
import { BackIcon, CheckIcon, ChevronIcon, DiamondIcon, ExternalIcon, Mark } from "./SideIcons";
import { PrDiffPanel } from "./PrDiffPanel";
import { DeployPanel } from "./DeployPanel";
import { LimitPanel } from "./LimitPanel";
import { askMerge, MergeButton, MergeHooksContext, MergeLine, MoreMenu, useMergeOff, type MoreItem } from "./QueueMerge";
import { recentDeployed } from "../lib/deploy";
import { appendTranscript, browserSpeech, pushToTalk, type PushToTalk, type VoiceView } from "../lib/voice";
import { linkParts } from "../lib/linkify";
import { MESSAGE_PURIFY, renderMessageMarkdown } from "../lib/markdown";
import { RichPart } from "./QueueRich";
import { ShareHead, SharePanel } from "./QueueShare";
import {
  ageText, agentWord, checksWord, clockText, countsLine, doneToday, inboxGroups, kindChip, mergeableWord, openOrder, rowMeta,
  snoozedRows, whereParts, type MetaPart,
} from "../lib/queueInbox";
import { canUndo as ticketCanUndo, closedAt, closedMark, closedText, kindWord } from "../lib/threadTickets";
import { usePrSize, type PrSizeFile } from "../lib/usePrSize";
import { pillFile, shownFile, toggleFile } from "../lib/prDiffNav";
import { usePrCi } from "../lib/prCi";
import { ChecksFact, ChecksList, PreviewLinks } from "./PrCi";
import s from "./QueueView.module.css";
import { AuthedImg } from "./AuthedImg";
import { AnswerThumbs, AttachedRow, AttachImages } from "./AnswerImages";
import { answerImages, filesOf, useAnswerImages } from "../lib/answerImages";
import { hasFiles } from "../lib/upload";

// Agent text stays plain text; only its http(s) URLs become links that open in a new tab.
function Linked({ text }: { text: string }) {
  return <>{linkParts(text).map((p, n) => ("url" in p
    ? <a key={n} className={s.link} href={p.url} target="_blank" rel="noopener noreferrer">{p.text}</a>
    : <span key={n}>{p.text}</span>))}</>;
}

// A ticket's body: markdown with links, each line of the text on its own line. The parser shows
// raw HTML as text and never makes an image; DOMPurify then drops what could load or submit.
// The thread's ticket card (ThreadTicket) renders its body with it too.
export function Md({ text }: { text: string }) {
  const html = useMemo(
    () => (typeof window === "undefined" ? "" : DOMPurify.sanitize(renderMessageMarkdown(text, { breaks: true }), MESSAGE_PURIFY)),
    [text],
  );
  return <div className={s.md} dangerouslySetInnerHTML={{ __html: html }} />;
}

// The reading pane's head in words: "PR · For review", with the kind word of the thread's ticket
// card (kindWord). The chip text stays the lib's (kindChip); only its first word is replaced.
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
// The console's own tickets (deploy, usage limit): no share, no reply box.
const isConsoleTicket = (i: QueueItem): boolean => i.kind === "deploy" || i.kind === "limit";
const headWords = (i: QueueItem, chipText: string) => [kindWord(i), ...chipText.split(" · ").slice(1).map(cap)];
// The dot of the head, as on the thread's ticket card: blue = the agent waits on you (and the
// deploy ticket), amber = waits on a PR, green = answered, hollow = the rest.
function headTone(i: QueueItem, now: number): Tone | "ok" | "idle" {
  const live = i.status === "open" || (i.status === "snoozed" && (i.snoozedUntil ?? 0) <= now);
  if (live) return prWait(i) ? "wait" : i.blocking || i.kind === "deploy" || i.kind === "limit" ? "turn" : "idle";
  if (i.status === "snoozed") return "idle";
  return i.status === "answered" || i.status === "auto" || closedMark(i) === "✓" ? "ok" : "idle";
}

// The dot of a list row (A · Inset: colour only at dot size). Blue: the ticket blocks its agent
// (your turn). Amber: it waits on a PR or a run. Red: an answer did not reach its agent. Grey: the rest.
type Tone = "turn" | "wait" | "err" | "run";
function rowTone(i: QueueItem, now: number, open?: boolean): Tone {
  if (open && i.blocking) return "turn";
  if (rowMeta(i, now).some((p) => p.warn)) return "wait";
  return open && i.kind === "deploy" ? "turn" : "run"; // the deploy ticket waits for your press
}

function Chevron() {
  return <svg className={s.chev} viewBox="0 0 16 16" aria-hidden><path d="m6 4 4 4-4 4" /></svg>;
}

const SNOOZE_MIN = 60;
const CLOCK_TICK_MS = 30_000;
const DEFAULT_UNDO_MS = 10 * 60_000;
const REPLY_MAX = 1500; // the server's answer text limit
const VOICE_STATUS_MS = 5_000; // how long a voice error status stays
const HOLD_TEXT = "Item changed — keys paused. Press Esc to continue.";
// Below this width of the view itself the two panes do not fit (a narrow window, a tablet):
// the view then shows one screen at a time, as on a phone.
const NARROW_PX = 640;

const SHORTCUTS: [string, string][] = [
  ["j / k, ↓ / ↑", "select a ticket"], ["a", "looks good (preview) / I merged it: check now (pr)"], ["c", "changes requested"],
  ["1–6", "pick option A–F"], ["r", "reply"], ["Enter", "accept the recommendation"], ["u", "undo the last answer"],
  ...(browserSpeech() ? [["v", "push to talk (fills the reply box)"] as [string, string]] : []),
  ["s", "snooze 1 h"], ["o", "open the PR / preview link"], ["m", "merge the PR (asks first)"], ["g then q", "jump to the Queue"], ["?", "this sheet"],
];

// `onOpenAgent` shows the thread of a ticket's agent (page.tsx). `onExit` (the phone shell): the
// back arrow of the list's header, to the home list.
export function QueueView({ q, onOpenAgent, onExit }: { q: UseQueue; onOpenAgent?: (agentId: string) => void; onExit?: () => void }) {
  const phone = useIsMobile(); // the page's phone layout: the list has the phone header, a ticket its back bar
  useEffect(ensureLeadLooks, []); // which areas have a lead: their avatar shows on a ticket
  const [narrow, setNarrow] = useState(false);
  const isMobile = phone || narrow; // one screen at a time: the list, or one ticket
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const wasNarrow = useRef(false);
  const [sheetId, setSheetId] = useState<string | null>(null); // mobile: the open ticket shown on the full screen
  // A ticket that is not open (snoozed, done, undelivered), shown read-only in the reading pane.
  // While it shows, the answer keys are off: they act on the selected open row, which is not on screen.
  const [peekId, setPeekId] = useState<string | null>(null);
  const peekRef = useRef(peekId);
  peekRef.current = peekId;
  const [doneOpen, setDoneOpen] = useState(false); // "Done today" is folded at first
  const inflight = useRef(new Set<string>()); // ids with a delivery POST in flight
  const [help, setHelp] = useState(false);
  const live = useRef(q);
  live.current = q;
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const replyEl = useRef<HTMLTextAreaElement | null>(null); // the reply box while it holds focus
  const hold = useRef<Hold>(null); // keys paused after the reply box vanished (lib/queueGuard)
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enterGuard = useRef<EnterGuard>(null); // a carry-over Enter after an answer from the detail pane (F3)
  const ptt = useRef<PushToTalk | null>(null);
  const [voiceView, setVoiceView] = useState<VoiceView>({ listening: false, error: null });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // The ticket whose diff is open, and the file it shows ("": the first changed file).
  const [diffFor, setDiffFor] = useState<{ id: string; path: string } | null>(null);
  const [zoom, setZoom] = useState<{ item: QueueItem; name: string; n: number } | null>(null); // preview image overlay
  const [, tick] = useState(0);

  // Ages re-render every 30 s inside this view only (not the whole page); a fresh list on every activation.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { live.current.refresh(); }, []);

  const on = q.view === "on" && !!q.data;
  const now = on ? q.now() : 0;
  const { undelivered } = sections(on ? q.state.items : [], now);
  const open = openOrder(on ? q.state.items : [], now); // the list order: blocking tickets first
  const undoMs = q.data?.undoMs ?? DEFAULT_UNDO_MS;
  const focused = open.find((i) => i.id === q.state.focusId);
  const readOnly = q.state.readOnly;
  // The peeked ticket, while it is not an Open row. A change in flight (an undo that the server
  // has not taken yet) does not count: if it fails, the ticket is closed again and the peek stays.
  const peekOpen = peekId !== null && !q.state.pending[peekId] && open.some((i) => i.id === peekId);
  const peekFrom = useRef<string | null>(null); // the selected open row when the peek began
  const peekItem = peekId !== null ? q.state.items.find((i) => i.id === peekId) : undefined;
  const peeked = on && !peekOpen ? peekItem : undefined;
  const shown = peeked ?? focused; // the ticket in the reading pane
  // One screen at a time (isMobile): the ticket screen shows the open ticket the user opened, or a peek.
  const sheetItem = isMobile ? peeked ?? (focused && focused.id === sheetId ? focused : null) : null;
  // The answer keys act on the selected open row. They are off while that row is not the ticket
  // on screen: a peek shows another ticket, or the one-screen layout shows the list.
  const keysOff = useRef(false);
  keysOff.current = peekId !== null || (isMobile && !sheetItem);

  // The view's own width decides between two panes and one screen (measured before the first paint).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    wasNarrow.current = el.getBoundingClientRect().width < NARROW_PX;
    setNarrow(wasNarrow.current);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (!w) return;
      const next = w < NARROW_PX;
      // The window got narrow: the ticket in the reading pane stays on screen (it is not replaced by the list).
      if (next && !wasNarrow.current && !phoneRef.current) setSheetId(live.current.state.focusId);
      wasNarrow.current = next;
      setNarrow(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);

  // Take keyboard focus off the tab button that opened the view: a focused button swallows Enter.
  // The Open listbox owns focus when it exists (aria-activedescendant), else the view root. Later
  // Open changes (empty <-> non-empty) take focus only from nowhere: never from a Brain panel input
  // or button, where the next keystrokes would turn into queue actions (I4).
  const hasOpen = open.length > 0;
  // The listbox while it is on screen (the mobile ticket screen hides the list), else the view root.
  const homeEl = () => { const l = listRef.current; return l && l.getClientRects().length > 0 ? l : rootRef.current; };
  const firstFocus = useRef(true);
  useEffect(() => {
    if (!on) return;
    const own = [rootRef.current, listRef.current];
    if (mayTakeFocus(document.activeElement, { body: document.body, own, firstRun: firstFocus.current })) {
      homeEl()?.focus({ preventScroll: true });
    }
    firstFocus.current = false;
  }, [on, hasOpen]);

  // Land focus on the first Open row when none is focused.
  const firstId = open[0]?.id ?? null;
  useEffect(() => {
    if (on && !focused && firstId) q.dispatch({ t: "focus", id: firstId });
  }, [on, focused, firstId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focused) return;
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [focused?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile: the ticket screen belongs to one item; once focus moves off it (j/k, an undo, an answer)
  // it closes, and the list shows again.
  const focusId = q.state.focusId;
  useEffect(() => { if (sheetId !== null && focusId !== sheetId) setSheetId(null); }, [focusId, sheetId]);

  // The peeked ticket left the queue: back to the selected row. It is open again (an undo, a snooze
  // that ended): it becomes the selected row, so the pane keeps the ticket and gets its actions.
  const peekLost = peekId !== null && on && !peekItem;
  useEffect(() => {
    if (peekId === null) return;
    if (peekLost) { closePeek(); return; }
    if (!peekOpen) return;
    setPeekId(null);
    live.current.dispatch({ t: "focus", id: peekId });
    if (isMobile) setSheetId(peekId);
  }, [peekId, peekOpen, peekLost, isMobile]);

  // I1: the reply box was removed while it held focus (its item left Open: answered on Telegram,
  // withdrawn, a refetch; or the focused item changed). Focus would drop to body and the next typed
  // letters would act on the newly focused item. Pause commit keys until Esc, a click or a quiet gap.
  // F1: the box still counts as focused while the user is in another window or browser tab (see
  // replyBlurEnds); a hold that starts or runs there waits, and its quiet gap starts on the return.
  const endHold = () => { hold.current = null; clearTimeout(holdTimer.current); setHeld(false); };
  const armHold = () => { clearTimeout(holdTimer.current); holdTimer.current = setTimeout(endHold, HOLD_QUIET_MS); };
  const beginHold = () => {
    const away = pageAway(document);
    hold.current = startHold(Date.now(), away);
    setHeld(true);
    if (away) clearTimeout(holdTimer.current); else armHold();
  };
  useLayoutEffect(() => {
    if (!replyLost(replyEl.current)) return;
    replyEl.current = null;
    beginHold();
    rootRef.current?.focus({ preventScroll: true });
  });
  // I1 (final wave): the focused row left Open by a server change the user did not make (answered
  // on another device, withdrawn by its agent, PrWatch merged/closed, agent gone, a refetch), and
  // the reducer moved focus to a row the user has not read (`jumps`). The same hold pauses commit
  // keys until Esc, a click or a quiet gap. Keyboard focus stays where it is. A jump while the
  // view was not shown (another tab) holds when the view comes back.
  const jumps = q.state.jumps;
  useLayoutEffect(() => {
    if (!on || q.seenJumps.current === jumps) return;
    q.seenJumps.current = jumps;
    beginHold();
  }, [on, jumps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!held) return;
    const leave = () => {
      clearTimeout(holdTimer.current);
      hold.current = holdOnLeave(hold.current, Date.now());
      if (!hold.current) endHold();
    };
    const back = () => {
      const h = hold.current;
      hold.current = holdOnReturn(h, Date.now());
      if (hold.current !== h) armHold();
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") leave();
      else if (!pageAway(document)) back();
    };
    document.addEventListener("pointerdown", endHold, true); // a click is deliberate: it ends the hold
    window.addEventListener("blur", leave);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("pointerdown", endHold, true);
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [held]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  // I6: a voice session never outlives the key release's chance to arrive: stop it on window blur,
  // a hidden page, the view turning off, the focused item changing, and unmount.
  const voiceCtl = () => (ptt.current ??= pushToTalk(browserSpeech(), setVoiceView));
  useEffect(() => {
    if (!voiceView.listening) return;
    const stop = () => ptt.current?.abort();
    const onVis = () => { if (document.visibilityState === "hidden") stop(); };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", onVis); };
  }, [voiceView.listening]);
  const focusedId = focused?.id ?? null;
  useEffect(() => () => ptt.current?.abort(), [on, focusedId]);
  // The zoom overlay removes the key listeners (keyup too): end any voice session when it opens.
  useEffect(() => { if (zoom) ptt.current?.abort(); }, [zoom]);
  // The zoomed item left the reading pane (answered, withdrawn, a refetch, another row): close the overlay.
  const shownId = shown?.id ?? null;
  useEffect(() => { if (zoom && shownId !== zoom.item.id) setZoom(null); }, [zoom, shownId]);
  useEffect(() => {
    if (!voiceView.error) return;
    const t = setTimeout(() => setVoiceView((v) => (v.listening ? v : { ...v, error: null })), VOICE_STATUS_MS);
    return () => clearTimeout(t);
  }, [voiceView.error]);

  // One POST for one item: optimistic update, then confirmed or failed (lib/useQueueRun; the
  // ticket cards in an agent's thread use the same path). The selected ticket, while it is a pr
  // ticket, is also checked when the user comes back to this tab (lib/prAutoCheck).
  const { run, respond, checkPr } = useQueueRun(q, () => live.current.state.focusId);

  // [Resend] / [Mark delivered]: the same optimistic -> POST -> settle path; one POST per item at a time.
  const deliver = (i: QueueItem, action: "resend" | "mark-delivered") => {
    if (inflight.current.has(i.id)) return;
    inflight.current.add(i.id);
    const slot = deliverySlot(i);
    void run(i, optimisticDelivery(i, action), () => delivery(i.id, action, slot)).finally(() => inflight.current.delete(i.id));
  };

  const undoItem = async (item: QueueItem) => {
    if (await run(item, { ...item, status: "open" }, () => undo(item.id))) live.current.dispatch({ t: "focus", id: item.id });
  };

  // The peek ends and the pane shows the selected open row again. If that row changed while the
  // peek covered it (answered on another device, withdrawn), the user has not read the new one:
  // the commit keys pause, as after any selection change the user did not make (I1).
  const closePeek = () => {
    if (peekRef.current === null) return;
    setPeekId(null);
    if (peekFrom.current !== live.current.state.focusId) beginHold();
  };
  // The reply of a ticket is its text and its images (lib/answerImages): both go together.
  const clearDraft = (id: string) => { setDrafts((d) => { const { [id]: _x, ...rest } = d; return rest; }); answerImages.clear(id); };
  // A deliberate exit from the reply box (Esc, send, Close): blur it while it is still in the document.
  const blurReply = () => { replyRef.current?.blur(); replyEl.current = null; };
  const toList = () => homeEl()?.focus({ preventScroll: true });
  const leaveReply = () => { blurReply(); toList(); };
  // F3: an answer, snooze or withdraw started in the detail pane (a click; a key on one of its
  // controls or in its reply box) removes that control. Focus goes to the list, never to body, and
  // an Enter on the list right after is a carry-over, not an accept of the next item (enter guard).
  const afterDetailCommit = () => { toList(); enterGuard.current = startEnterGuard(Date.now()); };
  // The Merge button (QueueMerge.tsx): its confirm press moves focus as an answer does (F3), and
  // the closed ticket comes back in the merge's answer (the stream may bring it first).
  const mergeHooks = { commit: afterDetailCommit, merged: (item: QueueItem) => live.current.dispatch({ t: "confirmed", item, now: live.current.now() }) };
  const focusInDetail = () => !!(document.activeElement as HTMLElement | null)?.closest?.("[data-queue-detail]");

  const onAction = (a: QueueAction, from: "keys" | "detail" = "keys") => {
    const cur = live.current;
    const t0 = Date.now();
    if (holdBlocks(hold.current, a, t0)) return;
    if (from === "keys" && enterGuardBlocks(enterGuard.current, a, t0)) return; // a click is deliberate
    if (a.t === "help") return setHelp((h) => !h);
    if (a.t === "cancel") {
      if (replyEl.current) { const id = cur.state.focusId; if (id) clearDraft(id); leaveReply(); return; }
      setHelp(false); setSheetId(null); closePeek(); cur.dispatch({ t: "dismissError" }); return;
    }
    if (a.t === "voice") {
      const p = voiceCtl();
      if (!a.down) { p.stop(); return; }
      const id = cur.state.focusId;
      if (!id || cur.state.readOnly || p.active() || !replyRef.current || keysOff.current) return;
      p.start({
        lang: navigator.language,
        onText: (t) => {
          if (live.current.state.focusId !== id) return; // the focused item changed: drop it, leave focus alone
          setDrafts((d) => ({ ...d, [id]: appendTranscript(d[id] ?? "", t).slice(0, REPLY_MAX) }));
          replyRef.current?.focus();
        },
      });
      return;
    }
    if (a.t === "move") { enterGuard.current = null; setPeekId(null); return cur.dispatch({ t: "move", by: a.by, now: cur.now() }); }
    if (a.t === "undo") {
      // While a peek shows, `u` is for the ticket on screen (when its answer can still be undone),
      // never for another ticket that the pane does not show.
      const pk = peekRef.current;
      const shownNow = pk !== null ? cur.state.items.find((i) => i.id === pk) : undefined;
      const u = pk !== null
        ? (shownNow && ticketCanUndo(shownNow, cur.now(), undoMs, cur.state.readOnly) ? shownNow : null)
        : latestUndoable(cur.state.items, cur.now(), undoMs);
      if (u && !cur.state.readOnly) void undoItem(u);
      return;
    }
    // Everything below acts on the focused Open row only (routing lives in lib/queueActions).
    // Never while that row is not the ticket on screen (keysOff): the user does not see it.
    if (keysOff.current) return;
    const f = sections(cur.state.items, cur.now()).open.find((i) => i.id === cur.state.focusId);
    const plan = planAction(a, {
      ...(f ? { focused: f, images: answerImages.names(f.id), imagesWait: answerImages.blocked(f.id) } : {}),
      readOnly: cur.state.readOnly, draft: f ? draftsRef.current[f.id] ?? "" : "", snoozeMin: SNOOZE_MIN, now: cur.now(),
    });
    if (!plan) return;
    const fromDetail = from === "detail" || focusInDetail();
    switch (plan.t) {
      case "answer":
        if (plan.sent) leaveReply(); // focus leaves the box before the item leaves Open (no hold)
        if (plan.sent || fromDetail) afterDetailCommit();
        void runAnswer(plan, { respond, clearDraft }); // the draft goes only once the answer landed (I2)
        return;
      // "I merged it" pressed in the pane: when the ticket closes, its button goes with it (F3).
      case "checkPr": if (fromDetail) afterDetailCommit(); void checkPr(plan.item); return;
      case "snooze": {
        if (fromDetail) afterDetailCommit();
        const t = cur.now();
        void run(plan.item, { ...plan.item, status: "snoozed", snoozedUntil: t + plan.minutes * 60_000 }, () => snooze(plan.item.id, plan.minutes));
        return;
      }
      // The merge is made on the page that opens: the ticket is checked when the user is back.
      case "open": if (f?.kind === "pr") prAutoCheck.opened(f.id); openLink(plan.url); return;
      case "focusReply": replyRef.current?.focus(); return;
      // `m`: the Merge button's confirm step opens (QueueMerge.tsx). It never merges by itself.
      case "mergeAsk": askMerge(plan.item.id); return;
    }
  };

  useQueueKeys({
    active: on && !zoom, // the zoom overlay owns the keyboard while it is open
    state: () => {
      const c = live.current;
      const f = keysOff.current ? undefined : sections(c.state.items, c.now()).open.find((i) => i.id === c.state.focusId);
      return {
        onQueueTab: true, gPending: false, inReplyBox: replyEl.current !== null,
        voiceEnabled: browserSpeech() !== null, voiceActive: ptt.current?.active() ?? false,
        ...(f ? { focused: f, focusedSection: "open" as const } : {}),
      };
    },
    onAction,
    // Every keydown while held: Esc or a quiet gap ends the hold, any other key restarts its window.
    onKeyDown: (e) => {
      // One screen at a time, the list on screen: Enter opens the selected ticket (it answers nothing there).
      const t = e.target;
      const onControl = isTypingTarget(t) || (t?.tagName ?? "").toUpperCase() === "BUTTON" || !!t?.closest?.("a[href], summary, [role=button]");
      if (e.key === "Enter" && isMobile && !sheetItem && focused && !hold.current && !help && !onControl
        && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.isComposing) setSheetId(focused.id);
      if (!hold.current) return;
      hold.current = holdOnKey(hold.current, e.key, Date.now());
      if (hold.current) armHold(); else endHold();
    },
  });


  if (q.view === "misconfigured") return <div className={s.root}><div className={s.quiet}>{MISCONFIGURED_TEXT}</div></div>;
  if (!on || !q.data) return <div className={s.root} />;
  const d = q.data;
  const userAuth = getChiefState().userAuth ?? d.userAuth;
  const undoable = latestUndoable(q.state.items, now, undoMs);
  const justAnswered = undoable && undoable.status === "answered" ? undoable : null;
  const canUndo = (i: QueueItem) => ticketCanUndo(i, now, undoMs, readOnly);
  const err = q.state.error;
  const groups = inboxGroups(open);
  const snoozed = snoozedRows(q.state.items, now);
  const done = doneToday(q.state.items, now, undoMs);
  const autoN = done.filter((i) => i.status === "auto").length; // answered by the master, still standing
  // The deploy ticket closes itself when the deploy is done: its result stays at the top for an hour.
  const deployed = recentDeployed(q.state.items, now);

  // Back to the list: the ticket opens on itself next time, not on its diff screen.
  const back = () => { blurReply(); setSheetId(null); setPeekId(null); setDiffFor(null); };
  // The reply box goes with the pane: blur it first, so that its removal starts no hold (I1).
  const peek = (id: string) => {
    enterGuard.current = null; blurReply();
    if (peekRef.current === null) peekFrom.current = q.state.focusId;
    setPeekId(id);
  };
  const stop = (fn: () => void) => (e: ReactMouseEvent) => { e.stopPropagation(); fn(); };
  // A row of a ticket that is not open: a press shows it in the reading pane. Enter or Space on
  // the row itself does the same; a key on a button inside the row is that button's.
  const peekRow = (i: QueueItem) => ({
    role: "button" as const, tabIndex: 0, "data-focused": peeked?.id === i.id, onClick: () => peek(i.id),
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); peek(i.id); }
    },
  });
  const pane = { now, ...(isMobile ? { onBack: back } : {}), ...(onOpenAgent ? { onOpenAgent } : {}) };
  // `u` and its hint are for the last answer; while a peek shows, `u` is for the ticket on screen.
  const lastIsU = !isMobile && (!peeked || peeked.id === justAnswered?.id);

  // The reading pane: the selected open ticket with its actions, a peeked ticket read-only, or
  // the empty state. Beside the list on desktop, the full screen on mobile (same state).
  const readEl = peeked ? (
    <Closed
      key={peeked.id} item={peeked} readOnly={readOnly} userAuth={userAuth} canUndo={canUndo(peeked)} {...pane} {...(isMobile ? {} : { onClose: closePeek })}
      onUndo={() => void undoItem(peeked)} onDeliver={(a) => deliver(peeked, a)}
      onZoom={(name, n) => setZoom({ item: peeked, name, n })}
    />
  ) : focused ? (
    <Detail
      key={focused.id} item={focused} readOnly={readOnly} userAuth={userAuth} draft={drafts[focused.id] ?? ""}
      onDraft={(v) => setDrafts((d) => ({ ...d, [focused.id]: v }))}
      replyRef={replyRef} onReplyFocus={(el) => { replyEl.current = el; }}
      onReplyBlur={(el) => { if (replyEl.current === el) replyEl.current = null; }}
      onZoom={(name, n) => setZoom({ item: focused, name, n })}
      diffPath={diffFor?.id === focused.id ? diffFor.path : null}
      onDiff={(path) => setDiffFor(path === null ? null : { id: focused.id, path })}
      onPick={(key) => onAction({ t: "pick", key }, "detail")}
      onAct={(id) => {
        if (id !== "withdraw") return onAction({ t: id } as QueueAction, "detail");
        if (isHeld(hold.current, Date.now()) || readOnly) return;
        afterDetailCommit();
        void run(focused, { ...focused, status: "withdrawn" }, () => withdraw(focused.id));
      }}
      onSend={() => onAction({ t: "send" }, "detail")} {...pane}
    />
  ) : (
    <section className={s.read} aria-label="Item detail">
      <div className={s.calm}>
        <b>{EMPTY_TEXT}</b>
        <span>{metricsLine(d)}</span>
      </div>
    </section>
  );

  const optionRow = (i: QueueItem) => (
    <li
      key={i.id} id={`queue-opt-${i.id}`} role="option" aria-selected={i.id === q.state.focusId} className={s.row}
      data-focused={!peeked && i.id === q.state.focusId}
      onClick={() => { enterGuard.current = null; setPeekId(null); q.dispatch({ t: "focus", id: i.id }); if (isMobile) setSheetId(i.id); }}
    >
      <Row item={i} now={now} open />
    </li>
  );

  // The week metrics: a quiet row under the panes (desktop), at the end of the list (mobile).
  // The rules are in Settings → Rules.
  const footEl = (
    <div className={s.viewFoot}>
      <div className={s.metrics}>{metricsLine(d)}</div>
    </div>
  );

  // The list's head: the title, the counts and the keys. On a phone: the screen's one header,
  // with the back arrow to the home list.
  const headEl = phone ? (onExit && <PhoneHeader onBack={onExit} title="Queue" sub={countsLine(open)} />) : (
    <div className={s.head}>
      <b className={s.headTitle}>Queue</b>
      <span className={s.headLine}>{countsLine(open)}</span>
      <span className={s.hint} title="j / k move · ? shows the keys"><kbd className={s.key}>j</kbd><kbd className={s.key}>k</kbd><kbd className={s.key}>?</kbd></span>
    </div>
  );
  // The pairing card and the last error: over the list beside the reading pane, or over the one
  // screen of the narrow layout (the ticket screen hides the list).
  const notices = (
    <>
      {readOnly && <div className={s.card} role="status">{pairingText(userAuth).split("`").map((t, n) => (n % 2 ? <code key={n} className={s.cardCode}>{t}</code> : t))}</div>}
      {err && (
        <div className={s.error} role="alert">
          <span>{err}</span>
          <button className={s.btn} onClick={() => q.dispatch({ t: "dismissError" })}>Dismiss</button>
        </div>
      )}
    </>
  );

  // The list stays mounted under the mobile ticket screen: its scroll place and the Brain panel's state survive.
  const listEl = (
    <div className={s.list} hidden={!!sheetItem}>
      {headEl}
      {!isMobile && notices}
      <div className={s.listScroll}>
        {!d.hardened && <div className={s.listChip}><span className={s.chip} title="Your agents and the console run under the same account on your server. Settings, Devices says what that means.">protection: basic</span></div>}
        {deployed && (
          <div className={s.section} role="group" aria-label={deployed.deploy?.release ? "Update" : "Deployed"}>
            <div className={s.grp}>{deployed.deploy?.release ? "Update" : "Deployed"}</div>
            <div className={s.row} data-done="" {...peekRow(deployed)}>
              <span className={s.mark}><span className={s.tick} aria-hidden><Mark kind={closedMark(deployed) === "✓" ? "ok" : "fail"} /></span></span>
              <div className={s.rowT}><b className={s.whole}>{closedText(deployed)}</b></div>
              <div className={s.rowB}><span className={s.rowM}>{clockText(closedAt(deployed), now)}{closedMark(deployed) === "✓" ? " · reload the page to get the new build" : ""}</span></div>
            </div>
          </div>
        )}
        {open.length === 0 ? (
          <div className={s.empty}>{isMobile ? EMPTY_TEXT : "No open ticket."}</div>
        ) : (
          <ul
            className={s.rows} role="listbox" aria-label="Open" ref={listRef} tabIndex={0}
            {...(focused ? { "aria-activedescendant": `queue-opt-${focused.id}` } : {})}
          >
            {groups.blocks.length > 0 && <li className={s.grp} role="presentation">Blocks an agent <span className={s.count}>{groups.blocks.length}</span></li>}
            {groups.blocks.map(optionRow)}
            {groups.review.length > 0 && <li className={s.grp} role="presentation">For review <span className={s.count}>{groups.review.length}</span></li>}
            {groups.review.map(optionRow)}
          </ul>
        )}
        {undelivered.length > 0 && (
          <div className={s.section} role="group" aria-label="Undelivered">
            <div className={s.grp}>Undelivered <span className={s.count}>{undelivered.length}</span></div>
            {undelivered.map((i) => (
              <div key={i.id} className={s.row} {...peekRow(i)}>
                <span className={s.mark}><span className={s.dot} data-tone="err" /></span>
                <div className={s.rowT}><b>{i.title}</b></div>
                <div className={s.rowM} title={undeliveredText(i)}>{undeliveredText(i)}</div>
                {!readOnly && (
                  <div className={s.rowActs}>
                    <button type="button" className={s.btn} onClick={stop(() => deliver(i, "resend"))}>Resend</button>
                    <button type="button" className={s.btn} onClick={stop(() => deliver(i, "mark-delivered"))}>Mark delivered</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {snoozed.length > 0 && (
          <div className={s.section} role="group" aria-label="Snoozed">
            <div className={s.grp}>Snoozed <span className={s.count}>{snoozed.length}</span></div>
            {snoozed.map((i) => <div key={i.id} className={s.row} {...peekRow(i)}><Row item={i} now={now} /></div>)}
          </div>
        )}
        <div className={s.section} role="group" aria-label="Done today">
          <button type="button" className={s.grpBtn} aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
            <Chevron />
            Done today <span className={s.count}>{done.length}</span>
            {autoN > 0 && <span className={s.grpNote}>· {autoN} by the master</span>}
          </button>
          {doneOpen && done.length === 0 && <div className={s.none}>No ticket was closed today.</div>}
          {doneOpen && done.map((i) => (
            <div key={i.id} className={s.row} data-done="" {...peekRow(i)}>
              <span className={s.mark}><span className={s.tick} aria-hidden><Mark kind={closedMark(i) === "✓" ? "ok" : "fail"} /></span></span>
              <div className={s.rowT}><b>{i.title}</b></div>
              <div className={s.rowB}>
                <span className={s.rowM} title={closedText(i)}>{clockText(closedAt(i), now)} · {closedText(i)}</span>
                {canUndo(i) && <button type="button" className={s.btn} onClick={stop(() => void undoItem(i))}>Undo</button>}
              </div>
            </div>
          ))}
        </div>
        {isMobile && footEl}
      </div>
      {justAnswered && (
        <div className={s.undoBar} role="status">
          <span className={s.undoText}><b><CheckIcon size={12} />{closedText(justAnswered)}</b> · {justAnswered.title}</span>
          {canUndo(justAnswered) && (
            <button type="button" className={s.btn} onClick={() => void undoItem(justAnswered)}>Undo{lastIsU && <kbd className={s.key}>u</kbd>}</button>
          )}
        </div>
      )}
      {!isMobile && footEl}
    </div>
  );

  const zoomEl = zoom && <Zoom item={zoom.item} name={zoom.name} n={zoom.n} onClose={() => setZoom(null)} />;

  return (
    <div className={s.root} role="region" aria-label="Queue" ref={rootRef} tabIndex={-1} data-mobile={isMobile ? "" : undefined} data-phone={phone ? "" : undefined}>
      {isMobile && notices}
      <div className={s.split}>
        {listEl}
        <MergeHooksContext.Provider value={mergeHooks}>{(!isMobile || sheetItem) && readEl}</MergeHooksContext.Provider>
      </div>
      {held && <div className={s.notice} role="status">{HOLD_TEXT}</div>}
      {voiceView.listening
        ? <div className={s.mic} role="status" aria-label="Listening"><span className={s.micDot} aria-hidden />Listening…</div>
        : voiceView.error && <div className={s.mic} role="status">{voiceView.error}</div>}
      {zoomEl}
      {help && (
        <div className={s.sheet} role="dialog" aria-label="Keyboard shortcuts">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className={s.sheetRow}><kbd className={s.kbd}>{k}</kbd><span>{v}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

// Meta words with a dot between them. A `lead` word (the area, or the lead as the ticket's agent)
// has the avatar of the area's lead before it.
function MetaParts({ parts, area }: { parts: MetaPart[]; area: string }) {
  return (
    <>
      {parts.map((p, n) => (
        <Fragment key={n}>
          {n > 0 && <span className={s.sep}> · </span>}
          <span className={p.warn ? s.amber : undefined}>{p.lead && <span className={s.leadAv}><LeadAvatar area={area} size={12} /></span>}{p.text}</span>
        </Fragment>
      ))}
    </>
  );
}

// A list row: the dot, the title, then kind · area · repo · facts · age (the area only when it has
// a lead: with the lead's avatar). The dot is blue on an Open row that blocks its agent (ruling
// 2a-26-a), amber when the row waits (rowTone).
function Row({ item: i, now, open }: { item: QueueItem; now: number; open?: boolean }) {
  const hasLead = useLeadLooks().has(i.area);
  const star = !!i.recommend && !isPersistentAgentId(i.agentId); // decision 39: no ★ on a master's or lead's own item
  return (
    <>
      <span className={s.mark}><span className={s.dot} data-tone={rowTone(i, now, open)} title={i.blocking ? "blocks its agent" : undefined} /></span>
      <div className={s.rowT}>
        <b title={i.title}>{i.title}</b>
        {star && <span className={s.star} title="recommended" role="img" aria-label="recommended"><DiamondIcon size={12} /></span>}
      </div>
      <div className={s.rowM}>
        <MetaParts parts={rowMeta(i, now, hasLead)} area={i.area} />
      </div>
    </>
  );
}

// The line of the reading pane's head: kind · state · area · repo · agent · age. The area shows
// when it has a lead, with the lead's avatar; on the lead's own ticket the avatar is before
// "lead <area>" and the area is not said twice.
function HeadInfo({ item: i, now }: { item: QueueItem; now: number }) {
  const hasLead = useLeadLooks().has(i.area);
  const own = hasLead && i.agentId === `lead-${i.area}`;
  const parts: MetaPart[] = [
    ...headWords(i, kindChip(i, now).text).map((text) => ({ text })),
    ...whereParts(i, hasLead && !own),
    own ? { text: agentWord(i.agentId), lead: true } : { text: agentWord(i.agentId) },
    { text: ageText(now - i.createdAt) },
  ];
  return (
    <div className={s.topInfo}>
      <span className={s.dot} data-tone={headTone(i, now)} aria-hidden />
      <span className={s.meta} title={parts.map((p) => p.text).join(" · ")}><MetaParts parts={parts} area={i.area} /></span>
    </div>
  );
}

type PaneProps = { item: QueueItem; now: number; onBack?: () => void; onOpenAgent?: (agentId: string) => void };

// The two parts of the reading pane's head. `info`: kind · state · repo · agent · age. `acts`:
// the quiet actions (Open agent, Snooze, Withdraw), at the right of the head on desktop and in
// the bar of the back control on a phone.
function paneBar({ item: i, now, onOpenAgent, children }: Omit<PaneProps, "onBack"> & { children?: ReactNode }) {
  const acts = (
    <div className={s.topActs}>
      {onOpenAgent && i.agentId !== "cron-master" && i.agentId !== "console" && (
        <button type="button" className={`${s.b} ${s.ghost}`} onClick={() => onOpenAgent(i.agentId)}>Open agent</button>
      )}
      {children}
    </div>
  );
  return { acts, info: <HeadInfo item={i} now={now} /> };
}

// Mobile: the control that goes back to the list, then the ticket's quiet actions.
function BackBar({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return (
    <div className={s.backBar}>
      <button type="button" className={s.backBtn} onClick={onBack} aria-label="Back to the Queue"><BackIcon /> Queue</button>
      {children}
    </div>
  );
}

// Large thumbnails; a press opens the zoom view.
function Thumbs({ item: i, onZoom }: { item: QueueItem; onZoom(name: string, n: number): void }) {
  if (!i.preview || i.preview.images.length === 0) return null;
  return (
    <div className={s.grid} role="group" aria-label="Preview images">
      {i.preview.images.map((name, n) => (
        <button key={name} type="button" className={s.thumb} aria-label={`Zoom image ${n + 1}`} onClick={() => onZoom(name, n + 1)}>
          <AuthedImg src={previewSrc(i, name)} alt={`${i.title} — image ${n + 1}`} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

type PickKey = "A" | "B" | "C" | "D" | "E" | "F";
type UserAuth = "telegram" | "log" | null;
type DetailProps = PaneProps & {
  readOnly: boolean; userAuth: UserAuth; draft: string; onDraft(v: string): void;
  replyRef: RefObject<HTMLTextAreaElement | null>; onReplyFocus(el: HTMLTextAreaElement): void; onReplyBlur(el: HTMLTextAreaElement): void;
  onZoom(name: string, n: number): void;
  // The file of the open diff ("": the first changed file), null while the diff is closed.
  diffPath: string | null; onDiff(path: string | null): void; onPick(key: PickKey): void; onAct(id: "accept" | "approve" | "changes" | "reply" | "snooze" | "withdraw"): void;
  onSend(): void;
};

// The reading pane of an open ticket (spec §8b). Its footer stays in place: the reply box and the
// main action. Every item string but the body renders as a React text node.
function Detail({ item: i, now, onBack, onOpenAgent, readOnly, userAuth, draft, onDraft, replyRef, onReplyFocus, onReplyBlur, diffPath, onDiff, onPick, onAct, onSend, onZoom }: DetailProps) {
  const facts = prFacts(i);
  const rec = recommendLine(i);
  const actions = detailActions(i, readOnly);
  const canSnooze = actions.some((a) => a.id === "snooze");
  const canWithdraw = actions.some((a) => a.id === "withdraw");
  const [confirmWithdraw, setConfirmWithdraw] = useState(false); // withdraw takes a second, deliberate click
  // F2: the pressed button is replaced by the confirm row (and back). Focus must never fall to body
  // there: Enter on body is "accept the suggestion". The confirm row takes focus on its "No"; No
  // or Esc gives it back to "Withdraw…". Enter on a focused button only clicks that button.
  const noRef = useRef<HTMLButtonElement>(null);
  const withdrawRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"no" | "withdraw" | null>(null);
  useLayoutEffect(() => {
    const r = refocus.current;
    refocus.current = null;
    if (r === "no") noRef.current?.focus();
    else if (r === "withdraw") withdrawRef.current?.focus();
  }, [confirmWithdraw]);
  const askWithdraw = () => { refocus.current = "no"; setConfirmWithdraw(true); };
  const backOut = () => { refocus.current = "withdraw"; setConfirmWithdraw(false); };
  const hasReply = actions.some((a) => a.id === "changes" || a.id === "reply");
  // An open pr item (decision 60): its state in place of Approve, and the one action that takes
  // the user to where the merge is made. Shown read-only too: it answers nothing.
  const wait = prWait(i);
  const size = usePrSize(facts && "url" in facts ? facts.slug : undefined, facts && "url" in facts ? facts.number : undefined);
  // The PR's CI (the checks list, the preview links): one read for the ticket in this pane.
  const pr = facts && "url" in facts ? facts : null;
  const ci = usePrCi(pr?.slug, pr?.number, pr?.checks, true);
  const previewUrl = i.preview?.url;
  // The diff: a press on a file row opens that file's change, a second press on it closes it.
  const diffOpen = diffPath !== null;
  const openFile = diffOpen ? shownFile(diffPath, size?.list.map((f) => f.path) ?? []) : null;
  const diffRef = useRef<HTMLDivElement>(null);
  // Desktop: the diff box comes into view under the file list (the list stays on screen).
  useEffect(() => {
    if (diffPath !== null && !onBack) diffRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [diffPath, onBack]);
  const review = i.kind === "pr" || i.kind === "preview";
  const typed = draft.trim() !== "";
  // The reply's images (lib/answerImages): with them the reply is ready to send without text too.
  const imgs = useAnswerImages(i.id);
  const addImages = (files: File[]) => { if (files.length > 0) answerImages.add(i.id, files); };
  const answering = typed || imgs.length > 0;
  const imagesWait = imgs.some((a) => a.state !== "ok");
  // The main action of the footer: looks good (preview), accept the suggestion. A pr ticket has
  // the link to its PR there (`wait`).
  const main = actions.find((a) => a.id === "approve" || a.id === "accept");
  // "Open PR #n": the PR on GitHub in a new tab (the `o` key opens the same url). "Open
  // Reconcile" of a local item stays in the console.
  const openAttrs = openLinkAttrs(wait);
  // A press of the link (also a middle click) counts as "the user went to merge": lib/prAutoCheck.
  const wentToPr = openAttrs?.target ? () => prAutoCheck.opened(i.id) : undefined;
  const waitLink = (cls: string) => (wait && openAttrs
    ? <a className={cls} {...openAttrs} onClick={wentToPr} onAuxClick={wentToPr}>{wait.open}{openAttrs.target && <ExternalIcon size={10} />}{openAttrs.target && !onBack && <kbd className={s.key}>o</kbd>}</a>
    : null);
  // "I merged it": the `a` key as a button (decision 64). The server reads the PR's state now.
  const checking = usePrChecking(i.id);
  // A pr ticket with a GitHub PR: the bar holds Request changes and Merge; Open PR and I merged it
  // go to the "more" menu (keys o and a). When Merge cannot run, Open PR is back in the bar.
  const mergeOff = useMergeOff(i, readOnly);
  const checkBtn = (withKey: boolean) => (wait && !readOnly ? (
    <button type="button" className={s.b} title={PR_CHECK_TITLE} disabled={checking} onClick={() => onAct("approve")}>
      {checking ? PR_CHECKING_TEXT : PR_CHECK_TEXT}{withKey && !checking && !onBack && <kbd className={s.key}>a</kbd>}
    </button>
  ) : null);
  const moreItems: MoreItem[] = pr ? [
    ...(wait && openAttrs && !mergeOff ? [{ id: "open", label: `${wait.open} on GitHub`, kbd: "o", link: openAttrs, onSelect: wentToPr }] : []),
    { id: "check", label: checking ? PR_CHECKING_TEXT : PR_CHECK_TEXT, kbd: "a", title: PR_CHECK_TITLE, disabled: checking, onSelect: () => onAct("approve") },
  ] : [];
  const mainLabel = main?.id === "accept" && i.kind === "choice" && i.recommend ? `Accept ${i.recommend.value}` : main?.label;
  // The reply box grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 150)}px`;
  }, [draft, replyRef]);
  const keyHint = (k: string) => (onBack ? "" : ` (${k})`); // no key hints on a phone
  const bar = paneBar({
    item: i, now, ...(onOpenAgent ? { onOpenAgent } : {}),
    children: (
      <>
        {!onBack && !isConsoleTicket(i) && <ShareHead item={i} readOnly={readOnly} />}
        {canSnooze && (
          <button type="button" className={`${s.b} ${s.ghost}`} onClick={() => onAct("snooze")}>Snooze 1 h{!onBack && <kbd className={s.key}>s</kbd>}</button>
        )}
        {canWithdraw && (
          <span
            className={s.withdraw}
            // Esc in the confirm row backs out (and stays here: it does not reach the view's Esc).
            onKeyDown={(e) => { if (confirmWithdraw && e.key === "Escape") { e.stopPropagation(); backOut(); } }}
          >
            {confirmWithdraw ? (
              <>
                <span className={s.why}>Withdraw this item?</span>
                {/* If the withdraw runs, the item leaves Open and this pane unmounts (focus: the list);
                    if it is refused (keys paused), focus goes back to "Withdraw…". */}
                <button className={s.b} onClick={() => { backOut(); onAct("withdraw"); }}>Yes, withdraw</button>
                <button ref={noRef} className={s.b} onClick={backOut}>No</button>
              </>
            ) : (
              <button ref={withdrawRef} className={`${s.b} ${s.ghost}`} onClick={askWithdraw}>Withdraw…</button>
            )}
          </span>
        )}
      </>
    ),
  });
  // A review ticket's c key is on its Request changes button: the box holds no key hint.
  const placeholder = review ? "What should change?" : i.kind === "choice" ? `Or reply with text…${keyHint("r")}` : `Your answer…${keyHint("r")}`;
  // One screen at a time (phone): the diff is its own screen; the back arrow goes to the ticket.
  if (onBack && diffOpen && pr) {
    return (
      <section className={s.read} aria-label="Changes" data-queue-detail="">
        <PhoneHeader
          onBack={() => onDiff(null)} backLabel="Back to the ticket" title="Changes"
          sub={size ? `#${pr.number} · ${size.plus} ${size.minus} in ${size.files}` : `#${pr.number}`}
        />
        <div className={s.diffScreen}><PrDiffPanel repo={pr.slug ?? i.repo} pr={pr.number} focus={diffPath} list={false} meta={false} /></div>
      </section>
    );
  }
  return (
    <section className={s.read} aria-label="Item detail" data-queue-detail="">
      {onBack ? <BackBar onBack={onBack}>{bar.acts}</BackBar> : <div className={s.rh}>{bar.info}{bar.acts}</div>}
      <div className={s.in}>
        {onBack && <div className={s.top}>{bar.info}{!isConsoleTicket(i) && <ShareHead item={i} readOnly={readOnly} phone />}</div>}
        {!isConsoleTicket(i) && <SharePanel item={i} readOnly={readOnly} />}
        <h2 className={s.title}><Linked text={i.title} /></h2>
        {i.body && <Md text={i.body} />}
        {i.html && <RichPart key={i.id} item={i} className={s.rich} />}
        {/* The console's own deploy ticket: its state and its one button. Shown read-only too
            (the button then says "Pair this device to deploy"). It has no reply and no answer. */}
        {i.kind === "deploy" && <DeployPanel item={i} readOnly={readOnly} userAuth={userAuth} />}
        {/* The usage-limit ticket: its rows and their buttons. It has no reply and no answer. */}
        {i.kind === "limit" && <LimitPanel item={i} readOnly={readOnly} userAuth={userAuth} />}
        <Thumbs item={i} onZoom={onZoom} />
        {/* The facts as one row of pills: merge state, checks, previews, then the size, which opens the diff. */}
        {(pr || previewUrl) && (
          <div className={s.facts}>
            {pr && <Fact word={mergeableWord(pr.mergeable)} />}
            {pr && <ChecksFact pill view={ci} pr={pr} tone={checksWord(pr.checks).tone}>{cap(checksWord(pr.checks).text)}</ChecksFact>}
            {pr && <PreviewLinks pill view={ci} />}
            {previewUrl && <button type="button" className={`${s.fact} ${s.factLink}`} onClick={() => openLink(previewUrl)}>Open the preview <ExternalIcon size={10} /></button>}
            {pr && (
              <button type="button" className={`${s.fact} ${s.factLink}`} aria-expanded={diffOpen} title={diffOpen ? "Hide the diff" : "Show the diff"} onClick={() => onDiff(pillFile(diffPath, size?.list ?? []))}>
                {size ? <><span className={s.num} data-tone="add">{size.plus}</span><span className={s.num} data-tone="del">{size.minus}</span>in {size.files}</> : "Diff"}
                <span className={s.factCaret} aria-hidden><ChevronIcon open={diffOpen} size={10} /></span>
              </button>
            )}
          </div>
        )}
        {pr && <ChecksList view={ci} />}
        {pr && size && size.list.length > 0 && <FileList files={size.list} open={openFile} onOpen={(path) => onDiff(toggleFile(openFile, path))} />}
        {facts && "branch" in facts && (
          <div className={s.facts}>
            <span className={s.fact}>Branch <code className={s.mono}>{facts.branch}</code></span>
          </div>
        )}
        {wait && (
          <div className={s.wait} role="status">
            <span className={s.dot} data-tone="wait" aria-hidden />
            <span className={s.waitText}>{PR_WAIT_TEXT}</span>
            <span className={s.why}>{hintParts(wait.hint, wait.what, openAttrs?.target ? <a className={s.link} {...openAttrs} onClick={wentToPr} onAuxClick={wentToPr}>{wait.what}</a> : null)}</span>
          </div>
        )}
        {diffOpen && pr && !onBack && (
          <div className={s.diff} ref={diffRef}>
            <PrDiffPanel repo={pr.slug ?? i.repo} pr={pr.number} focus={diffPath} list={false} onClose={() => onDiff(null)} />
          </div>
        )}
        {i.kind === "choice" && i.choice && (
          <div className={s.options} role="radiogroup" aria-label="Options">
            {/* Buttons, not native radios: arrow keys never select (and so never commit) an option.
                Only a click, or Space / Enter on the option itself, picks it (I3). */}
            {i.choice.options.map((o) => {
              const suggested = !!rec && i.recommend?.value === o.key;
              return (
                <button
                  key={o.key} type="button" role="radio" aria-checked={false} className={s.option} disabled={readOnly}
                  data-suggested={suggested ? "" : undefined} onClick={() => onPick(o.key as PickKey)}
                >
                  <kbd className={s.key}>{o.key}</kbd>
                  <span className={s.optText}>{o.label}{o.detail ? <span className={s.optDetail}> — {o.detail}</span> : null}</span>
                  {suggested && <em className={s.optMark}><DiamondIcon size={10} />{i.recommend?.by === "coordinator" ? "the Coordinator suggests" : "the master suggests"}</em>}
                </button>
              );
            })}
          </div>
        )}
        {rec && <div className={s.rec}><DiamondIcon size={12} />{rec}{i.recommend?.why ? <span className={s.why}> <Linked text={i.recommend.why} /></span> : null}</div>}
      </div>
      {isConsoleTicket(i) ? null : readOnly ? (
        <div className={s.foot} data-closed="">
          <span className={`${s.why} ${s.grow}`}>Read-only. Pair this device to answer.</span>
          {wait && <div className={s.footActs}>{waitLink(s.b)}{pr && <MergeButton item={i} readOnly userAuth={userAuth} phone={!!onBack} />}</div>}
        </div>
      ) : (
        <div
          className={s.foot}
          // A dropped image goes with the reply (a dropped file elsewhere is stopped: lib/upload guardFileDrops).
          onDragOver={hasReply ? (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } } : undefined}
          onDrop={hasReply ? (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); addImages(filesOf(e.dataTransfer)); } } : undefined}
        >
          {pr && !answering && <MergeLine item={i} />}
          {hasReply && (
            <div className={s.replyWrap}>
              <AttachedRow itemId={i.id} />
              <div className={s.replyRow}>
                <AttachImages itemId={i.id} />
                <textarea
                  ref={replyRef} data-queue-reply="" className={s.reply} rows={1} value={draft} maxLength={REPLY_MAX}
                  aria-label="Reply" placeholder={placeholder}
                  onChange={(e) => onDraft(e.target.value)} onFocus={(e) => onReplyFocus(e.currentTarget)}
                  // A pasted image (a screenshot, a copied picture) goes with the reply; text stays a normal paste.
                  onPaste={(e) => { const files = filesOf(e.clipboardData); if (files.length > 0) { e.preventDefault(); addImages(files); } }}
                  // Checked after the current task: a browser may fire blur while it removes the box, and a
                  // removal is the hold's case (I1). A window or browser-tab switch is not a real blur either:
                  // the box keeps document focus and must still count as focused while the user is away (F1).
                  onBlur={(e) => { const el = e.currentTarget; queueMicrotask(() => { if (replyBlurEnds(el, document)) onReplyBlur(el); }); }}
                />
              </div>
              {typed && !onBack && <span className={s.replyHint}>Enter sends · Shift+Enter adds a line · Esc cancels</span>}
            </div>
          )}
          <div className={s.footActs}>
            {main && answering && <button type="button" className={s.b} onClick={() => onAct(main.id)}>{mainLabel}</button>}
            {wait && answering && !pr && checkBtn(false)}
            {wait && answering && !pr && waitLink(s.b)}
            {pr && <MoreMenu phone={!!onBack} items={moreItems} />}
            {hasReply && review && !answering && (
              <button type="button" className={s.b} onClick={() => onAct("changes")}>Request changes{!onBack && <kbd className={s.key}>c</kbd>}</button>
            )}
            {hasReply && (answering || i.kind === "question") && (
              <button type="button" className={answering || !main ? `${s.b} ${s.pri}` : s.b} disabled={!answering || imagesWait} onClick={onSend}>
                {review ? "Send changes" : "Send"}{!onBack && <kbd className={s.key}>Enter</kbd>}
              </button>
            )}
            {main && !answering && (
              <button type="button" className={`${s.b} ${s.pri}`} onClick={() => onAct(main.id)}>
                {mainLabel}{main.key && !onBack ? <kbd className={s.key}>{main.key}</kbd> : null}
              </button>
            )}
            {wait && !answering && !pr && checkBtn(true)}
            {wait && !answering && (!pr || mergeOff) && waitLink(`${s.b} ${s.pri}`)}
            {pr && !answering && <MergeButton item={i} readOnly={false} userAuth={userAuth} phone={!!onBack} />}
          </div>
        </div>
      )}
    </section>
  );
}

// The PR's files under the facts: one 30 px row each (state, path, plus and minus). A press opens
// that file's change; the row of the open file is marked. A long list shows its first rows and a
// row that shows the rest.
const FILES_SHOWN = 8;
const FILE_MARK: Record<PrSizeFile["type"], string> = { add: "A", modify: "M", delete: "D", rename: "R" };
function FileList({ files, open, onOpen }: { files: PrSizeFile[]; open: string | null; onOpen(path: string): void }) {
  const [all, setAll] = useState(false);
  const shown = all || files.slice(FILES_SHOWN).some((f) => f.path === open) ? files : files.slice(0, FILES_SHOWN);
  const more = files.length - shown.length;
  return (
    <div className={s.files} role="group" aria-label="Files">
      {shown.map((f) => {
        const cut = f.path.lastIndexOf("/") + 1;
        return (
          <button
            key={f.path} type="button" className={s.file} title={f.path} onClick={() => onOpen(f.path)}
            aria-current={f.path === open ? "true" : undefined}
          >
            <span className={s.fileMark}>{FILE_MARK[f.type]}</span>
            <span className={s.filePath}><bdi>{f.path.slice(0, cut)}<b>{f.path.slice(cut)}</b></bdi></span>
            {f.additions > 0 && <span className={s.num} data-tone="add">+{f.additions}</span>}
            {f.deletions > 0 && <span className={s.num} data-tone="del">−{f.deletions}</span>}
          </button>
        );
      })}
      {more > 0 && <button type="button" className={s.file} onClick={() => setAll(true)}><span className={s.fileMark} /><span className={s.filePath}>{more} more {more === 1 ? "file" : "files"}</span></button>}
    </div>
  );
}

// The "This item closes when PR #470 is merged." line with "PR #470" as the link to GitHub.
function hintParts(hint: string, what: string, link: ReactNode): ReactNode {
  const at = link ? hint.indexOf(what) : -1;
  return at < 0 ? hint : <>{hint.slice(0, at)}{link}{hint.slice(at + what.length)}</>;
}

// "● Mergeable": the merge state as a pill; its dot has the colour.
const FACT_DOT: Record<string, Tone | "ok"> = { good: "ok", bad: "err", warn: "wait" };
function Fact({ word }: { word: { text: string; tone?: string } }) {
  const dot = word.tone ? FACT_DOT[word.tone] : undefined;
  return <span className={s.fact}><span className={s.dot} data-tone={dot ?? "idle"} aria-hidden />{cap(word.text)}</span>;
}

type ClosedProps = PaneProps & {
  readOnly: boolean; userAuth: UserAuth; canUndo: boolean; onUndo(): void; onDeliver(action: "resend" | "mark-delivered"): void;
  onClose?: () => void; // desktop: back to the selected open row (also Esc)
  onZoom(name: string, n: number): void;
};

// The reading pane of a ticket that is not open (snoozed, answered, withdrawn): the ticket and
// its answer, read-only. Its footer has Undo while the undo window is open, and the two delivery
// actions when the answer did not reach the agent.
function Closed({ item: i, now, onBack, onOpenAgent, readOnly, userAuth, canUndo, onUndo, onDeliver, onZoom, onClose }: ClosedProps) {
  const snoozed = i.status === "snoozed";
  const stuck = isUndelivered(i);
  const picked = i.status !== "withdrawn" ? i.answer?.value : undefined;
  const reopening = i.status === "open"; // an undo is in flight
  const bar = paneBar({
    item: i, now, ...(onOpenAgent ? { onOpenAgent } : {}),
    children: (
      <>
        {!onBack && !isConsoleTicket(i) && <ShareHead item={i} readOnly={readOnly} />}
        {onClose && <button type="button" className={`${s.b} ${s.ghost}`} onClick={onClose}>Close<kbd className={s.key}>Esc</kbd></button>}
      </>
    ),
  });
  return (
    <section className={s.read} aria-label="Item detail">
      {onBack ? <BackBar onBack={onBack}>{bar.acts}</BackBar> : <div className={s.rh}>{bar.info}{bar.acts}</div>}
      <div className={s.in}>
        {onBack && <div className={s.top}>{bar.info}{!isConsoleTicket(i) && <ShareHead item={i} readOnly={readOnly} phone />}</div>}
        {!isConsoleTicket(i) && <SharePanel item={i} readOnly={readOnly} />}
        <h2 className={s.title}><Linked text={i.title} /></h2>
        {i.body && <Md text={i.body} />}
        {i.html && <RichPart key={i.id} item={i} className={s.rich} />}
        {i.kind === "deploy" && <DeployPanel item={i} readOnly={readOnly} userAuth={userAuth} />}
        {i.kind === "limit" && <LimitPanel item={i} readOnly={readOnly} userAuth={userAuth} />}
        <Thumbs item={i} onZoom={onZoom} />
        {i.kind === "choice" && i.choice && (
          <div className={s.options} role="list" aria-label="Options">
            {i.choice.options.map((o) => (
              <div key={o.key} role="listitem" className={s.option} data-static="" data-picked={picked === o.key ? "" : undefined}>
                <kbd className={s.key}>{o.key}</kbd>
                <span className={s.optText}>{o.label}{o.detail ? <span className={s.optDetail}> — {o.detail}</span> : null}</span>
                {picked === o.key && <em className={s.optMark}><CheckIcon size={10} />the answer</em>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={s.foot} data-closed="">
        <div className={s.answer}>
          {reopening ? <b>Opening the ticket again…</b>
            : snoozed ? <><b>Snoozed until {clockText(i.snoozedUntil ?? 0, now)}</b><span>It comes back to the list then.</span></>
            : <><b><Mark kind={closedMark(i) === "✓" ? "ok" : "fail"} /> {closedText(i)}</b><span>{clockText(closedAt(i), now)}</span></>}
          {stuck && <span className={s.rose}>{undeliveredText(i)}</span>}
          {!reopening && !snoozed && <AnswerThumbs item={i} onZoom={onZoom} />}
        </div>
        <div className={s.footActs}>
          {stuck && !readOnly && <button type="button" className={s.b} onClick={() => onDeliver("resend")}>Resend</button>}
          {stuck && !readOnly && <button type="button" className={s.b} onClick={() => onDeliver("mark-delivered")}>Mark delivered</button>}
          {canUndo && <button type="button" className={s.b} onClick={onUndo}>Undo{!onBack && <kbd className={s.key}>u</kbd>}</button>}
        </div>
      </div>
    </section>
  );
}

// The zoom overlay: closes on Esc, on a click outside the image, and on the close button.
// Also the overlay of a preview ticket in an agent's thread (ThreadTicket).
export function Zoom({ item, name, n, onClose }: { item: QueueItem; name: string; n: number; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // Focus trap: the only focusable element is the Close button, so Tab stays on it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.({ preventScroll: true }); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={s.zoom} role="dialog" aria-modal="true" aria-label="Preview image" onClick={onClose}>
      <button ref={closeRef} type="button" className={s.btn} onClick={onClose}>Close</button>
      <AuthedImg src={previewSrc(item, name)} alt={`${item.title} — image ${n}`} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
