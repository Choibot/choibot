// src/components/ThreadTicket.tsx — a queue ticket inside its agent's thread (direction A, 3b).
// Open: a card with the Queue view's own actions (looks good, one button per option, a reply, the
// master's suggestion; a pr ticket has no approve: it shows "Not merged yet" and the link to where
// the user merges, overview decision 60). Closed: a small card with the answer; a click shows the
// question again. Colour only at dot size. Every item string is a React text node.
"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { isUndelivered } from "../../server/chief/queue/sections";
import { linkParts } from "../lib/linkify";
import { openLink, previewSrc } from "../lib/queue";
import { undeliveredText } from "../lib/queueActions";
import { measureCard, type CardPlace } from "../lib/queueGuard";
import { detailActions, localPrHref, openLinkAttrs, PR_CHECK_TEXT, PR_CHECK_TITLE, PR_CHECKING_TEXT, PR_WAIT_TEXT, prFacts, prWait, recommendLine } from "../lib/queueDetail";
import { prAutoCheck } from "../lib/prAutoCheck";
import { useOnScreen, usePrCi } from "../lib/prCi";
import { usePrChecking } from "../lib/useQueueRun";
import { fmtClock, fmtDay } from "../lib/thread";
import { canUndo, closedAt, closedMark, closedText, kindWord, type TicketRow } from "../lib/threadTickets";
import type { ThreadTickets } from "../lib/useThreadTickets";
import type { QueueAction } from "../lib/useQueueKeys";
import { Md, Zoom } from "./QueueView";
import { DeployPanel } from "./DeployPanel";
import { ChecksFact, ChecksList, PreviewLinks } from "./PrCi";
import { shiftGuardBlocks } from "../lib/queueGuard";
import { getChiefState } from "../lib/chief";
import { mergeableWord } from "../lib/queueInbox";
import { ArrowUpIcon, DiamondIcon, ExternalIcon } from "./SideIcons";
import s from "./ThreadTicket.module.css";
import { AuthedImg } from "./AuthedImg";
import { AnswerThumbs, AttachedRow, AttachImages } from "./AnswerImages";
import { answerImages, filesOf, useAnswerImages } from "../lib/answerImages";

// The merge state in words ("Mergeable", "Conflicts"), as the Queue shows it.
const mergeText = (v?: string) => { const t = mergeableWord(v).text; return t.charAt(0).toUpperCase() + t.slice(1); };

const REPLY_MAX = 1500; // the server's answer text limit
const NOTE_MS = 2500;
const LONG_BODY_CHARS = 420;
const LONG_BODY_LINES = 6;
type PickKey = "A" | "B" | "C" | "D" | "E" | "F";

// "17:38" today, "9 Nov 17:38" on another day.
function when(ts: number, now: number): string {
  if (!ts) return "";
  const a = new Date(ts), b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? fmtClock(ts) : `${fmtDay(ts)} ${fmtClock(ts)}`;
}

// Ticket text stays plain text; only its http(s) URLs become links that open in a new tab
// (the Queue view's rule, lib/linkify).
function Linked({ text }: { text: string }) {
  return <>{linkParts(text).map((p, n) => ("url" in p
    ? <a key={n} className={s.link} href={p.url} target="_blank" rel="noopener noreferrer">{p.text}</a>
    : <span key={n}>{p.text}</span>))}</>;
}

// The body: markdown, as in the Queue (QueueView's Md), at the card's size. A long body folds
// to about five lines until "Show all".
function Body({ text, onToggle }: { text: string; onToggle: () => void }) {
  const long = text.length > LONG_BODY_CHARS || text.split("\n").length > LONG_BODY_LINES;
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className={`${s.body} ${long && !open ? s.clamped : ""}`}><Md text={text} /></div>
      {long && (
        <button type="button" className={s.more} onClick={() => { onToggle(); setOpen((v) => !v); }}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function Thumbs({ item: i, onZoom }: { item: QueueItem; onZoom: (item: QueueItem, name: string, n: number) => void }) {
  if (!i.preview || i.preview.images.length === 0) return null;
  return (
    <div className={s.thumbs} role="group" aria-label="Preview images">
      {i.preview.images.map((name, n) => (
        <button key={name} type="button" className={s.thumb} aria-label={`Zoom image ${n + 1}`} onClick={() => onZoom(i, name, n + 1)}>
          <AuthedImg src={previewSrc(i, name)} alt={`${i.title} — image ${n + 1}`} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

type CardProps = {
  row: TicketRow; nowTs: number; readOnly: boolean; draft: string; error: string | null;
  act: ThreadTickets["act"]; setDraft: ThreadTickets["setDraft"]; dismissError: () => void;
  // When this card last moved on the screen by itself (the shift guard's input).
  movedAt: (id: string) => number | undefined;
  onZoom: (item: QueueItem, name: string, n: number) => void;
  // The user opens something in the card: the thread must not jump away from it.
  onToggle: () => void;
};

export const TicketCard = memo(function TicketCard({ row, nowTs, readOnly, draft, error, act, setDraft, dismissError, movedAt, onZoom, onToggle }: CardProps) {
  const i = row.item;
  const [replyOpen, setReplyOpen] = useState(false);
  const [note, setNote] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const wantFocus = useRef(false);

  const bar = detailActions(i, readOnly).filter((a) => a.id !== "snooze" && a.id !== "withdraw"); // those two stay in the Queue view
  const canReply = bar.some((a) => a.id === "changes" || a.id === "reply");
  // A question has no other answer than its reply, so its box is always there.
  // The reply's images (lib/answerImages; the Queue view shows the same list): with them the reply
  // is ready to send without text too.
  const imgs = useAnswerImages(i.id);
  const takesImages = canReply && !readOnly;
  const addImages = (files: File[]) => { if (files.length > 0) { answerImages.add(i.id, files); setReplyOpen(true); } };
  const showReply = canReply && (replyOpen || i.kind === "question" || draft !== "" || imgs.length > 0);
  const ready = (draft.trim() !== "" || imgs.length > 0) && !imgs.some((a) => a.state !== "ok");
  const facts = prFacts(i);
  // The PR's CI (the checks list, the preview links): one read while the card is on screen.
  const cardRef = useRef<HTMLElement>(null);
  const pr = facts && "url" in facts ? facts : null;
  const ci = usePrCi(pr?.slug, pr?.number, pr?.checks, useOnScreen(cardRef));
  const rec = recommendLine(i);
  const local = localPrHref(i);
  const wait = prWait(i);
  const openAttrs = openLinkAttrs(wait); // "Open PR #n": the PR on GitHub, in a new tab
  // A press of that link counts as "the user went to merge": the ticket is checked when the
  // user is back in this tab (lib/prAutoCheck).
  const wentToPr = openAttrs?.target ? () => prAutoCheck.opened(i.id) : undefined;
  const checking = usePrChecking(i.id);
  const previewUrl = i.preview?.url;

  useLayoutEffect(() => {
    if (!wantFocus.current || !replyRef.current) return;
    wantFocus.current = false;
    replyRef.current.focus();
  });
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(false), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  // A key press on a focused control goes where the focus is: the thread cannot move it to
  // another button. Only a pointer press needs the shift guard (a click by key has detail 0).
  const go = (a: QueueAction, byPointer: boolean): void => {
    const r = act(i, a, byPointer ? movedAt(i.id) : undefined);
    if (r === "blocked") setNote(true);
    else if (r === "focusReply") { onToggle(); wantFocus.current = true; setReplyOpen(true); replyRef.current?.focus(); }
    else if (r === "done") setNote(false);
  };
  const click = (a: QueueAction) => (e: MouseEvent) => go(a, e.detail !== 0);
  const closeReply = (): void => { setDraft(i.id, ""); answerImages.clear(i.id); setReplyOpen(false); replyRef.current?.blur(); };
  const onReplyKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go({ t: "send" }, false); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeReply(); }
  };

  return (
    <section
      ref={cardRef} className={s.card} data-ticket-card={i.id} data-ticket-moved={row.moved ? "" : undefined} aria-label={`${kindWord(i)} ticket: ${i.title}`}
      // An image dropped on this card goes with its reply: the pane's drop cover reads this mark
      // (AgentPane, lib/answerImages ticketAt), and the reply shows with the image.
      data-answer-images={takesImages ? "" : undefined}
    >
      <div className={s.kd}>
        <i className={s.dot} data-tone={wait ? "warn" : i.blocking || i.kind === "deploy" ? "turn" : "idle"} aria-hidden />
        <span>{kindWord(i)} · {i.kind === "deploy" ? "in your queue · from the console" : `in your queue · ${i.blocking ? "the agent waits" : "not blocking"}`}</span>
        <time dateTime={new Date(i.createdAt).toISOString()} title={new Date(i.createdAt).toLocaleString()}>
          {row.moved ? `asked ${when(i.createdAt, nowTs)} · earlier in the thread` : when(i.createdAt, nowTs)}
        </time>
      </div>
      <h3 className={s.title}><Linked text={i.title} /></h3>
      {i.body && <Body text={i.body} onToggle={onToggle} />}
      <Thumbs item={i} onZoom={onZoom} />
      {i.html && <div className={s.ro}>This ticket has a page: see it in the Queue.</div>}
      {pr && (
        <div className={s.facts}>
          <span>Checks: <ChecksFact view={ci} pr={pr} onToggle={onToggle}>{pr.checks ?? "unknown"}</ChecksFact></span>
          <span>{mergeText(pr.mergeable)}</span>
          <PreviewLinks view={ci} />
        </div>
      )}
      {pr && <ChecksList view={ci} />}
      {facts && "branch" in facts && <div className={s.facts}><span>Branch: {facts.branch}</span></div>}
      {i.kind === "choice" && i.choice && (
        <div className={s.options} role="group" aria-label="Options">
          {i.choice.options.map((o) => (
            <button key={o.key} type="button" className={s.option} disabled={readOnly} onClick={click({ t: "pick", key: o.key as PickKey })}>
              <span className={s.optKey}>{o.key}</span>
              <span className={s.optText}>{o.label}{o.detail ? <span className={s.optDetail}> — {o.detail}</span> : null}</span>
              {rec && i.recommend?.value === o.key && <span className={s.star} title="suggested" role="img" aria-label="suggested"><DiamondIcon size={10} /></span>}
            </button>
          ))}
        </div>
      )}
      {rec && <div className={s.rec}><DiamondIcon size={12} />{rec}{i.recommend?.why ? <span className={s.why}> <Linked text={i.recommend.why} /></span> : null}</div>}
      {wait && <div className={s.wait} role="status"><b>{PR_WAIT_TEXT}</b><span>{wait.hint.replace("This item", "This ticket")}</span></div>}
      {i.kind === "deploy" && (
        <DeployPanel
          item={i} readOnly={readOnly} userAuth={getChiefState().userAuth}
          blocked={(byPointer) => byPointer && shiftGuardBlocks(movedAt(i.id), Date.now())}
        />
      )}
      <div className={s.acts}>
        {wait && openAttrs && !local && <a className={`${s.b} ${s.pri}`} {...openAttrs} onClick={wentToPr} onAuxClick={wentToPr}>{wait.open}{openAttrs.target && <ExternalIcon size={10} />}</a>}
        {/* "I merged it" (decision 64): no approve. The server reads the PR's state now and closes
            the ticket when the PR is merged; else the card shows the reason. */}
        {wait && !readOnly && (
          <button type="button" className={s.b} title={PR_CHECK_TITLE} disabled={checking} onClick={click({ t: "approve" })}>
            {checking ? PR_CHECKING_TEXT : PR_CHECK_TEXT}
          </button>
        )}
        {bar.map((a) => {
          if (a.id === "approve" || a.id === "accept") {
            return <button key={a.id} type="button" className={`${s.b} ${s.pri}`} onClick={click({ t: a.id })}>{a.label}</button>;
          }
          if (i.kind === "question") return null; // its reply box is open
          return <button key={a.id} type="button" className={s.b} aria-expanded={showReply} onClick={click({ t: a.id } as QueueAction)}>{a.label}</button>;
        })}
        {/* A pr ticket has its PR link above ("Open PR #n"); this one is for another kind that names a PR. */}
        {facts && "url" in facts && i.kind !== "pr" && <button type="button" className={s.b} onClick={() => openLink(facts.url)}>PR #{facts.number} <ExternalIcon size={10} /></button>}
        {local && <a className={s.b} href={local}>Reconcile</a>}
        {previewUrl && <button type="button" className={s.b} onClick={() => openLink(previewUrl)}>Open preview <ExternalIcon size={10} /></button>}
        {readOnly && i.kind !== "deploy" && <span className={s.ro}>Read-only. Pair this device to answer (see the Queue).</span>}
      </div>
      {showReply && (
        <div className={s.replyRow}>
          <AttachedRow itemId={i.id} />
          <div className={s.replyField}>
            {!readOnly && <AttachImages itemId={i.id} onAdd={onToggle} />}
            <textarea
              ref={replyRef} className={s.reply} rows={2} value={draft} maxLength={REPLY_MAX} aria-label="Reply"
              placeholder={i.kind === "pr" || i.kind === "preview" ? "What should change?" : "Your answer"}
              onChange={(e) => setDraft(i.id, e.target.value)} onKeyDown={onReplyKey}
              // A pasted image (a screenshot, a copied picture) goes with the reply; text stays a normal paste.
              onPaste={(e) => { const files = filesOf(e.clipboardData); if (files.length > 0 && !readOnly) { e.preventDefault(); addImages(files); } }}
            />
          </div>
          <div className={s.replyActs}>
            {/* No shift guard: Send takes this card's own draft, and on a phone the keyboard that
                closes at the press moves the thread. */}
            <button type="button" className={`${s.b} ${s.pri}`} disabled={!ready} onClick={() => go({ t: "send" }, false)}>Send</button>
            {i.kind !== "question" && <button type="button" className={s.b} onClick={closeReply}>Cancel</button>}
            <span className={s.hint}>Enter sends · Shift+Enter adds a line</span>
          </div>
        </div>
      )}
      {note && <div className={s.note} role="status">The thread moved. Press again.</div>}
      {error && (
        <div className={s.error} role="alert">
          <span>{error}</span>
          <button type="button" className={s.b} onClick={dismissError}>Dismiss</button>
        </div>
      )}
    </section>
  );
});

type LineProps = {
  row: TicketRow; nowTs: number; readOnly: boolean; undoMs: number;
  undo: ThreadTickets["undo"]; onToggle: () => void;
  onZoom: (item: QueueItem, name: string, n: number) => void;
};

// The word after the kind ("Choice · answered") and the tone of the dot.
function phaseOf(i: QueueItem, phase: TicketRow["phase"]): { word: string; tone: string } {
  if (phase === "snoozed") return { word: "snoozed", tone: "idle" };
  if (phase === "answered") return { word: "answered", tone: "done" };
  return closedMark(i) === "✓" ? { word: "closed", tone: "done" } : { word: "closed", tone: "idle" };
}

// A closed (or snoozed) ticket: one line. A click shows the question again.
export const TicketLine = memo(function TicketLine({ row, nowTs, readOnly, undoMs, undo, onToggle, onZoom }: LineProps) {
  const i = row.item;
  const [open, setOpen] = useState(false);
  const snoozed = row.phase === "snoozed";
  const text = snoozed ? `Snoozed until ${when(i.snoozedUntil ?? 0, nowTs)}` : closedText(i);
  const at = snoozed ? 0 : closedAt(i);
  const stuck = isUndelivered(i);
  const ph = phaseOf(i, row.phase);
  return (
    <div className={s.lineWrap} data-phase={row.phase} data-open={open ? "" : undefined} data-ticket-line={i.id} data-ticket-moved={row.moved ? "" : undefined}>
      <div className={s.lineTop}>
        <i className={s.dot} data-tone={ph.tone} aria-hidden />
        <span className={s.lkind}>{kindWord(i)} · {ph.word}</span>
        {at > 0 && <time className={s.ltime} dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{when(at, nowTs)}</time>}
        {canUndo(i, nowTs, undoMs, readOnly) && <button type="button" className={s.undo} onClick={() => undo(i)}>Undo</button>}
      </div>
      <button type="button" className={s.lineMain} aria-expanded={open} onClick={() => { onToggle(); setOpen((v) => !v); }}>
        <span className={s.ltitle}>{i.title}</span>
        <span className={s.lans}>{text}</span>
      </button>
      {stuck && <div className={s.stuck}>{undeliveredText(i)} · see the Queue</div>}
      {open && (i.body || (i.preview?.images.length ?? 0) > 0 || (i.answer?.images?.length ?? 0) > 0) && (
        <div className={s.lineBody}>
          {i.body && <div className={s.body}><Md text={i.body} /></div>}
          <Thumbs item={i} onZoom={onZoom} />
          <AnswerThumbs item={i} onZoom={(name, n) => onZoom(i, name, n)} />
        </div>
      )}
    </div>
  );
});

// ---- the thread view's side: where the cards are, the pill, the image overlay ----

// A ticket card with less than this many px on screen counts as above it; a
// jump to it leaves this gap over the card.
const ABOVE_PX = 24;
const ABOVE_GAP_PX = 14;

export type TicketCards = {
  // Measure every card now. `byUser`: after a scroll event (lib/queueGuard, measureCard).
  measure: (byUser: boolean) => void;
  movedAt: (id: string) => number | undefined;
  above: number; // open cards above the visible part of the thread
  toAbove: () => void;
  zoom: { item: QueueItem; name: string; n: number } | null;
  onZoom: (item: QueueItem, name: string, n: number) => void;
  closeZoom: () => void;
};

// `stick`: the thread view's "follow the bottom" flag; a jump to a card ends it.
export function useTicketCards(
  scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, stick: { current: boolean }, tickets: QueueItem[],
): TicketCards {
  const places = useRef(new Map<string, CardPlace>());
  const [above, setAbove] = useState(0);
  const [zoom, setZoom] = useState<TicketCards["zoom"]>(null);
  const any = tickets.length > 0;
  const anyRef = useRef(any);
  anyRef.current = any;

  const measure = useCallback((byUser: boolean) => {
    const inner = content.current;
    if (!inner || (!anyRef.current && places.current.size === 0)) return; // no ticket: a scroll costs nothing
    const at = Date.now();
    const edge = scroller.current?.getBoundingClientRect().top ?? 0;
    const seen = new Set<string>();
    let hidden = 0;
    inner.querySelectorAll<HTMLElement>("[data-ticket-card]").forEach((el) => {
      const id = el.dataset.ticketCard ?? "";
      const box = el.getBoundingClientRect();
      seen.add(id);
      places.current.set(id, measureCard(places.current.get(id), box, at, byUser));
      if (box.bottom <= edge + ABOVE_PX) hidden++;
    });
    for (const id of [...places.current.keys()]) if (!seen.has(id)) places.current.delete(id);
    setAbove(hidden);
  }, [scroller, content]);
  const movedAt = useCallback((id: string) => places.current.get(id)?.movedAt, []);

  // To the nearest open ticket above: the next one up comes with the next press.
  const toAbove = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const edge = el.getBoundingClientRect().top;
    const all = Array.from(content.current?.querySelectorAll<HTMLElement>("[data-ticket-card]") ?? []);
    const target = all.reverse().find((c) => c.getBoundingClientRect().bottom <= edge + ABOVE_PX);
    if (!target) return;
    stick.current = false;
    el.scrollTop += target.getBoundingClientRect().top - edge - ABOVE_GAP_PX;
  }, [scroller, content, stick]);

  // The overlay's ticket left the thread (a refetch): close it.
  useEffect(() => { if (zoom && !tickets.some((t) => t.id === zoom.item.id)) setZoom(null); }, [zoom, tickets]);
  const onZoom = useCallback((item: QueueItem, name: string, n: number) => setZoom({ item, name, n }), []);
  const closeZoom = useCallback(() => setZoom(null), []);

  return { measure, movedAt, above, toAbove, zoom, onZoom, closeZoom };
}

// Open tickets above the visible part: one pill names them, so a ticket the
// agent wrote past is never out of sight.
export function TicketsAbove({ count, onJump }: { count: number; onJump: () => void }) {
  if (count <= 0) return null;
  return (
    <button type="button" className={s.above} onClick={onJump}>
      <span className={s.aboveDot} aria-hidden />
      {count === 1 ? "1 open ticket" : `${count} open tickets`}<ArrowUpIcon />
    </button>
  );
}

// A preview image, opened from a thumbnail: the Queue view's own overlay.
export function TicketZoom({ cards }: { cards: TicketCards }) {
  const z = cards.zoom;
  return z ? <Zoom item={z.item} name={z.name} n={z.n} onClose={cards.closeZoom} /> : null;
}
