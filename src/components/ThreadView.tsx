// src/components/ThreadView.tsx — the agent's conversation, built from its
// Claude session file (not from the terminal screen): what the user sent, what
// the agent said (markdown), and the tool steps between, folded into one line.
// While the agent runs, one live line shows the current step and its time.
// The agent's queue tickets show in the conversation, at the place where it
// asked: an open one as a card with the Queue view's actions, a closed one as
// a small card with the answer. The speaker's name shows once per group of
// rows from the same speaker (lib/threadWho).
"use client";
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { viewMemory } from "../lib/viewCache";
import DOMPurify from "dompurify";
import { MESSAGE_PURIFY, renderMessageMarkdown } from "../lib/markdown";
import {
  fmtClock, fmtDay, fmtElapsed, fmtSpan, liveStep, newerSub, newerSubs, quietLabel, stepsSummary, subSteps, subView, subsLive, toBlocks,
  type Block, type Message, type Step, type SubagentState, type ThreadState,
} from "../lib/thread";
import { threadRows, type Row } from "../lib/threadTickets";
import { hideActivity as withoutActivity } from "../lib/quietChecks";
import { speakerHeads, speakerOf, type SpeakerHead } from "../lib/threadWho";
import { outLabel, type OutRow } from "../lib/outbox";
import type { Outbox } from "../lib/useOutbox";
import type { UseQueue } from "../lib/useQueue";
import { NO_QUEUE, useThreadTickets } from "../lib/useThreadTickets";
import { TicketCard, TicketLine, TicketsAbove, TicketZoom, useTicketCards } from "./ThreadTicket";
import { useSubThread } from "../lib/useSubThread";
import { ArrowDownIcon, ChevronIcon } from "./SideIcons";
import s from "./ThreadView.module.css";

// Within this many px of the bottom the view follows new output.
const STICK_PX = 48;
// A longer prompt (the launch brief of an agent is often a page) starts folded.
const LONG_PROMPT_CHARS = 900;
const LONG_PROMPT_LINES = 12;

// The sanitized HTML of each message text seen lately: a thread that opens again draws its rows
// without parsing every message once more (a long thread on a phone took a visible moment).
const mdHtml = viewMemory<string>(800);
function messageHtml(text: string): string {
  let html = mdHtml.get(text);
  if (html === undefined) {
    html = DOMPurify.sanitize(renderMessageMarkdown(text), MESSAGE_PURIFY);
    mdHtml.set(text, html);
  }
  return html;
}

const Md = memo(function Md({ text }: { text: string }) {
  const html = useMemo(() => (typeof window === "undefined" ? "" : messageHtml(text)), [text]);
  return <div className={s.md} dangerouslySetInnerHTML={{ __html: html }} />;
});

// The chevron of a fold: it points right, and down when the fold is open.
function Chev({ open }: { open?: boolean }) {
  return (
    <svg className={s.chev} data-open={open ? "" : undefined} viewBox="0 0 16 16" aria-hidden><path d="m6 4 4 4-4 4" /></svg>
  );
}

// A step's label in the normal font; the path or the pattern of a file tool in mono.
const CODE_TOOLS: Record<string, string> = {
  Read: "Read ", Edit: "Edit ", MultiEdit: "Edit ", Write: "Write ", NotebookEdit: "Edit ", Grep: "Search for ", Glob: "Find files ",
};
function StepText({ step }: { step: Step }) {
  const pre = CODE_TOOLS[step.tool];
  if (pre && step.label.startsWith(pre) && step.label.length > pre.length) {
    return <>{pre}<code className={s.code}>{step.label.slice(pre.length)}</code></>;
  }
  return <>{step.label}</>;
}

// The name of the speaker and the time, once at the start of a group.
function WhoLine({ head }: { head: SpeakerHead }) {
  return (
    <div className={s.who} data-mine={head.mine ? "" : undefined}>
      {head.agent && <span className={s.ag} aria-hidden>{head.name.charAt(0)}</span>}
      <span className={s.whoText} title={head.name}>
        {head.name}
        {head.ts > 0 && (
          <>{" · "}<time dateTime={new Date(head.ts).toISOString()} title={new Date(head.ts).toLocaleString()}>{fmtClock(head.ts)}</time></>
        )}
      </span>
    </div>
  );
}

const VIA_TAG: Record<string, string> = { queue: "queue answer", command: "command", shell: "shell" };

const UserText = memo(function UserText({ text, onToggle }: { text: string; onToggle: () => void }) {
  const long = text.length > LONG_PROMPT_CHARS || text.split("\n").length > LONG_PROMPT_LINES;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`${s.plain} ${long && !open ? s.clamped : ""}`}>{text}</div>
      {long && (
        <button type="button" className={s.more} onClick={() => { onToggle(); setOpen((v) => !v); }}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
});

// A message that left the agent's wait line unread (queueView in lib/thread.ts).
const UNREAD: Record<string, string> = {
  lost: "Not read. The session stopped first.",
  back: "Not read. It went back to the agent's input box.",
};

// A user turn is a grey bubble: on the right for what the user wrote, on the
// left for a console event line or a reminder. The agent's text has no box.
// `out`: the message is not an entry of the agent's yet (lib/outbox.ts). Its
// state is one line under the bubble. The line takes no room (it sits in the
// gap between two rows), so nothing moves when it goes away. Only a message
// that was not sent has a line with room: it has the Retry and Remove buttons.
const MessageRow = memo(function MessageRow({ m, onToggle, out, onRetry, onRemove }: {
  m: Message; onToggle: () => void; out?: OutRow; onRetry?: (id: string) => void; onRemove?: (id: string) => void;
}) {
  const mine = speakerOf(m).mine;
  const acts = out && out.localId && (out.state === "failed" || out.state === "retrying") ? out.localId : null;
  const label = out ? outLabel(out) : m.kind !== "assistant" && m.q ? UNREAD[m.q] : null;
  const off = out?.state === "failed" || out?.state === "stale" || (m.kind !== "assistant" && m.q !== undefined);
  const state = label && !acts
    // "Sending…" shows only when the send is slow: a normal send is over before the words can be read.
    ? <span className={`${s.outState} ${out?.state === "sending" ? s.outSlow : ""}`} role="status">{label}</span>
    : null;
  const line = acts && (
    <div className={s.outLine} data-mine={mine ? "" : undefined} data-failed={out?.state === "failed" ? "" : undefined} role={out?.state === "failed" ? "alert" : "status"}>
      <span className={s.outText}>{label}</span>
      <span className={s.outActs}>
        {out?.state === "failed" && <button type="button" className={s.outBtn} onClick={() => onRetry?.(acts)}>Retry</button>}
        <button type="button" className={s.outBtn} onClick={() => onRemove?.(acts)}>Remove</button>
      </span>
    </div>
  );
  if (m.kind === "user") {
    const tag = m.via ? VIA_TAG[m.via] : undefined;
    return (
      <>
        <div className={s.bubble} data-kind={m.kind} data-mine={mine ? "" : undefined} data-out={out?.state} data-off={off ? "" : undefined}>
          {tag && <span className={s.via}>{tag}{m.via === "queue" && m.ref ? ` · ${m.ref}` : ""}</span>}
          <UserText text={m.text} onToggle={onToggle} />
          {state}
        </div>
        {line}
      </>
    );
  }
  return (
    <div className={`${s.msg} ${m.kind === "peer" ? s.peer : ""}`} data-kind={m.kind} data-out={out?.state} data-off={off ? "" : undefined}>
      <Md text={m.text} />
      {state}
    </div>
  );
});

const StepsRow = memo(function StepsRow({ b, open, running, onToggle }: {
  b: Extract<Block, { type: "steps" }>; open: boolean; running: boolean; onToggle: (key: string) => void;
}) {
  const last = b.steps[b.steps.length - 1];
  return (
    <div className={s.steps}>
      <button type="button" className={s.fold} aria-expanded={open} onClick={() => onToggle(b.key)}>
        <Chev open={open} />
        <span className={s.count}>{stepsSummary(b)}</span>
        {!open && <span className={s.last}><StepText step={last} /></span>}
      </button>
      {open && (
        <ol className={s.stepList}>
          {b.steps.map((st) => (
            <li key={st.id} className={s.step} data-error={st.error ? "" : undefined}>
              <time className={s.stepTime}>{fmtClock(st.ts)}</time>
              <span className={s.stepLabel}><StepText step={st} /></span>
              <span className={s.stepMeta}>
                {st.error ? "failed · " : ""}{st.end !== undefined ? fmtSpan(st.end - st.ts) : running ? "running" : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

// `quiet`: ms with no session entry (the pane's quiet signal), else null. The
// line then turns amber and says so. The line reads like a steps line:
// "Working · 1 min 12 s  Run the test suite".
function LiveLine({ label, since, skew, quiet }: { label: string | null; since: number; skew: number; quiet: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = since ? fmtElapsed(now + skew - since) : "";
  return (
    <div className={s.live} role="status" aria-live="off" data-quiet={quiet !== null ? "" : undefined}>
      <span className={s.liveDot} aria-hidden />
      <span className={s.liveWord}>
        Working
        {elapsed && <>{" · "}<span className={s.liveTime}>{elapsed}</span></>}
        {quiet !== null && <>{" · "}<span className={s.liveQuiet}>{quietLabel(quiet)}</span></>}
      </span>
      {label && <span className={s.liveText}>{label}</span>}
    </div>
  );
}

// The time now, once a second while `active` (a running clock on the line).
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// An open subagent's own page tells its state too, at its own moments. Each
// line and the live line take the newer of the two states, so they never
// disagree between two polls.
const NO_FRESH: Record<string, SubagentState> = {};
const SubFresh = createContext<{ fresh: Record<string, SubagentState>; report: (s: SubagentState) => void }>({ fresh: NO_FRESH, report: () => {} });

// The state word of a subagent line. A running one has the live dot, a done one the check.
const SUB_STATE: Record<string, string> = { stopped: "stopped", failed: "failed", launched: "launched" };
// A subagent can start subagents. Their lines open in place, down to this depth.
const MAX_SUB_DEPTH = 4;

// One subagent: a line of its own (never inside "N steps"). It shows the
// description, a running or done mark, the time, and while it runs its current
// step. A click opens its own steps and its final message under the line.
const SubRow = memo(function SubRow({ agentId, blockKey, step, sub, status, skew, open, depth, onToggle, onRead }: {
  agentId: string; blockKey: string; step: Step; sub: SubagentState | undefined; status: string; skew: number;
  open: boolean; depth: number; onToggle: (key: string) => void; onRead: () => void;
}) {
  const { fresh } = useContext(SubFresh);
  const v = subView(step, newerSub(sub, step.agent ? fresh[step.agent] : undefined), status);
  const running = v.state === "running";
  const now = useNow(running);
  const time = v.until !== null ? fmtSpan(v.until - v.since) : running && v.since ? fmtElapsed(now + skew - v.since) : "";
  const count = subSteps(v);
  const canOpen = v.id !== null && agentId !== "" && depth <= MAX_SUB_DEPTH;
  return (
    <div className={s.sub} data-state={v.state} data-sub={v.id ?? undefined}>
      <button
        type="button" className={s.subHead} aria-expanded={canOpen ? open : undefined} disabled={!canOpen}
        title={v.agentType ? `${v.title} (${v.agentType})` : v.title}
        onClick={() => onToggle(blockKey)}
      >
        <span className={s.subIcon} aria-hidden>
          {running ? <i className={s.liveDot} /> : v.state === "done"
            ? <svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7" /></svg>
            : v.state === "failed" ? <svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg> : <Chev open={open} />}
        </span>
        <span className={s.subKind}>{v.agentType ? `${v.agentType} subagent` : "Subagent"}</span>
        <span className={s.subTitle}>{v.title}</span>
        <span className={s.subMeta}>
          {SUB_STATE[v.state] && <span className={s.subState}>{SUB_STATE[v.state]}</span>}
          {time && <span className={s.subTime}>{time}</span>}
          {count && <span>{count}</span>}
        </span>
        {running && v.step && <span className={s.subStep}>{v.step}</span>}
      </button>
      {open && canOpen && v.id && (
        <SubBody agentId={agentId} subId={v.id} running={running} skew={skew} depth={depth} onRead={onRead} />
      )}
    </div>
  );
});

// A message a subagent got: its brief (the first one), or a later message from
// the agent that started it. Folded to one line; a click opens the text.
function SubBrief({ m, first, onRead }: { m: Message; first: boolean; onRead: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.steps}>
      <button type="button" className={s.fold} aria-expanded={open} onClick={() => { onRead(); setOpen((x) => !x); }}>
        <Chev open={open} />
        <span className={s.count}>{first ? "Brief" : "Message to the subagent"}</span>
        {!open && <span className={s.last}>{m.text.slice(0, 200)}</span>}
      </button>
      {open && <div className={s.subBrief}><Md text={m.text} /></div>}
    </div>
  );
}

// The subagent's own thread: its steps, what it wrote between them, the
// subagents it started, and its final message. Read when the line opens.
function SubBody({ agentId, subId, running, skew, depth, onRead }: {
  agentId: string; subId: string; running: boolean; skew: number; depth: number; onRead: () => void;
}) {
  const t = useSubThread(agentId, subId, running);
  const items = t.state?.items;
  const subs = t.state?.subs;
  const { report } = useContext(SubFresh);
  const mine = subs?.[subId];
  useEffect(() => { if (mine) report(mine); }, [mine, report]);
  const blocks = useMemo(() => (items ? toBlocks(items) : []), [items]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    onRead();
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [onRead]);
  const firstId = t.state && t.state.start === null && items && items.length ? items[0].id : null;
  const last = blocks.length ? blocks[blocks.length - 1] : null;
  return (
    <div className={s.subBody} data-sub-body={subId}>
      {t.available === false && <div className={s.subEmpty}>The file of this subagent cannot be read.</div>}
      {t.available === null && <div className={s.subEmpty}>Loading…</div>}
      {t.state && t.state.start !== null && (
        <button type="button" className={s.subEarlier} onClick={() => { onRead(); t.loadOlder(); }} disabled={t.loadingOlder}>
          {t.loadingOlder ? "Loading…" : <><ChevronIcon dir="up" size={10} />Earlier steps</>}
        </button>
      )}
      {t.state && blocks.length === 0 && <div className={s.subEmpty}>No steps yet.</div>}
      {blocks.map((b) => {
        if (b.type === "msg") {
          if (b.item.kind !== "assistant") return <SubBrief key={b.key} m={b.item} first={b.item.id === firstId} onRead={onRead} />;
          return (
            <div key={b.key} className={s.subMsg} data-kind="subagent">
              <div className={s.subWho}>Subagent<time>{fmtClock(b.item.ts)}</time>{b.item.final && <span>final message</span>}</div>
              <Md text={b.item.text} />
            </div>
          );
        }
        if (b.type === "note") return <div key={b.key} className={s.note}>{b.item.text}<i>{fmtClock(b.item.ts)}</i></div>;
        if (b.type === "day") return <div key={b.key} className={s.day}>{fmtDay(b.ts)}</div>;
        if (b.type === "sub") {
          return (
            <SubRow
              key={b.key} agentId={agentId} blockKey={b.key} step={b.item} sub={b.item.agent ? subs?.[b.item.agent] : undefined}
              status={running ? "running" : ""} skew={skew} open={open.has(b.key)} depth={depth + 1} onToggle={toggle} onRead={onRead}
            />
          );
        }
        return <StepsRow key={b.key} b={b} open={open.has(b.key)} running={running && b === last} onToggle={toggle} />;
      })}
    </div>
  );
}

// The live line while the agent itself does not run and its subagents do.
function SubsLine({ text, since, skew }: { text: string; since: number; skew: number }) {
  const now = useNow(true);
  return (
    <div className={s.live} role="status" aria-live="off" data-subs="">
      <span className={s.liveDot} aria-hidden />
      <span className={s.liveWord}>
        {text}
        {since > 0 && <>{" · "}<span className={s.liveTime}>{fmtElapsed(now + skew - since)}</span></>}
      </span>
    </div>
  );
}

// `queue` is the page's one useQueue(); `agentId` picks this agent's tickets.
// With no queue (the chief queue is off) the thread has no tickets.
// `hideActivity`: the fleet master's chat with "Show activity" off (MasterView): the event
// digests and its "(quiet)" replies are not shown (lib/quietChecks.ts).
// `outbox`: what was sent and is not an entry of the agent's yet (lib/useOutbox):
// its rows come after the last row of the thread, before the live line.
const NO_OUT: OutRow[] = [];
export function ThreadView({ state, status, skew, loadingOlder, onLoadOlder, quiet = null, agentId, queue, hideActivity = false, outbox }: {
  state: ThreadState | null; status: string | null; skew: number; loadingOlder: boolean; onLoadOlder: () => void;
  quiet?: number | null; agentId?: string; queue?: UseQueue; hideActivity?: boolean; outbox?: Outbox;
}) {
  const items = state?.items;
  const [fresh, setFresh] = useState(NO_FRESH);
  const report = useCallback((st: SubagentState) => setFresh((p) => (p[st.id] === st ? p : { ...p, [st.id]: st })), []);
  const subFresh = useMemo(() => ({ fresh, report }), [fresh, report]);
  const subs = useMemo(() => newerSubs(state?.subs, fresh), [state?.subs, fresh]);
  const tix = useThreadTickets(queue ?? NO_QUEUE, agentId);
  const { tickets, clock, now: queueNow, undoMs } = tix;
  // `clock` moves every 30 s: times, the undo window, a snooze that ends.
  const { rows, nowTs } = useMemo(() => {
    const t = queueNow();
    const all = items ? threadRows(items, tickets, t, undoMs) : [];
    return { rows: hideActivity ? withoutActivity(all).rows : all, nowTs: t };
  }, [items, tickets, clock, queueNow, undoMs, hideActivity]); // eslint-disable-line react-hooks/exhaustive-deps
  // A digest of the console that waits is activity too.
  const outRows = useMemo(() => {
    const all = state && outbox ? outbox.rows : NO_OUT;
    return hideActivity ? all.filter((r) => !(r.item.kind === "user" && r.item.via === "events")) : all;
  }, [state, outbox, hideActivity]);
  const outByKey = useMemo(() => new Map(outRows.map((r) => [r.key, r])), [outRows]);
  const live = useMemo(() => (items ? liveStep(items, status ?? "") : null), [items, status]);
  // The agent is between turns (or waits) and subagents of it still work.
  const subsLine = useMemo(() => (items && !live ? subsLive(items, subs) : null), [items, subs, live]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [unseen, setUnseen] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  // Taken just before an older page goes in front: the first row on screen and
  // where it was (an open ticket can leave the bottom for its own place then,
  // so the height alone does not say how far the rows moved), and the scroll
  // height and position for a view with no such row.
  const anchor = useRef<{ height: number; top: number; node: HTMLElement | null; nodeTop: number } | null>(null);
  const lastId = useRef<string | null>(null);
  const sentSeen = useRef<Set<string>>(new Set());
  // Where the ticket cards are on the screen (the shift guard, the pill for
  // open tickets above the visible part) and the preview image overlay.
  const cards = useTicketCards(scroller, content, stick, tickets);
  const { measure } = cards;

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (stick.current) setUnseen(false);
    measure(true);
  }, [measure]);

  // New items: stay at the bottom when the user is there; when the user
  // scrolled up, do not move, and show the "new" button. An older page in
  // front keeps the line the user was reading where it was.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const newest = items && items.length ? items[items.length - 1].id : null;
    // The user sent a message from here: the thread goes to it.
    const sentNow = outbox?.lastLocal ?? null;
    if (sentNow !== null && !sentSeen.current.has(sentNow)) {
      sentSeen.current.add(sentNow);
      stick.current = true;
      setUnseen(false);
    }
    const a = anchor.current;
    if (a) {
      // Kept until the request ends (below): a live poll can land before the page does.
      if (a.node && a.node.isConnected) el.scrollTop += a.node.getBoundingClientRect().top - a.nodeTop;
      else el.scrollTop = a.top + (el.scrollHeight - a.height);
      a.height = el.scrollHeight;
      a.top = el.scrollTop;
    } else if (stick.current) {
      toBottom();
    } else if (newest !== lastId.current && lastId.current !== null) {
      // A new ticket needs no rule of its own: the step that made it is a new item.
      setUnseen(true);
    }
    lastId.current = newest;
    measure(false);
  }, [rows, outRows, toBottom, measure]); // eslint-disable-line react-hooks/exhaustive-deps

  // Anything else that changes the height (the live line, a wrapped table, the
  // composer growing, the phone keyboard) keeps the bottom in view too.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); measure(false); });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom, measure]);

  // Opening something is reading: the view must not jump away from it.
  const release = useCallback(() => { stick.current = false; }, []);
  const toggle = useCallback((key: string) => {
    release();
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [release]);

  const loadOlder = (): void => {
    const el = scroller.current;
    if (el) {
      const edge = el.getBoundingClientRect().top;
      const rowsOnScreen = Array.from(content.current?.children ?? []) as HTMLElement[];
      const node = rowsOnScreen.find((c) =>
        c.dataset.earlier === undefined && c.dataset.ticketMoved === undefined && c.getBoundingClientRect().bottom > edge) ?? null;
      anchor.current = { height: el.scrollHeight, top: el.scrollTop, node, nodeTop: node ? node.getBoundingClientRect().top : 0 };
    }
    onLoadOlder();
  };
  // The request ended with nothing in front (an error): drop the stale anchor.
  useEffect(() => { if (!loadingOlder) anchor.current = null; }, [loadingOlder]);

  let lastBlock: Block | null = null;
  for (const r of rows) {
    if (r.type !== "ticket") lastBlock = r;
  }
  const lastSteps = lastBlock;
  // The rows of the outbox are message rows after the last row: the speaker's
  // name shows above the first one when another speaker was before it.
  const tail = useMemo((): Row[] => outRows.map((r) => ({ type: "msg", key: r.key, item: r.item })), [outRows]);
  const heads = useMemo(() => speakerHeads(tail.length ? [...rows, ...tail] : rows), [rows, tail]);
  // A row with its speaker's name above it when it starts a group. The open
  // rows of a folded quiet turn are their own groups.
  const withWho = (b: Row, own: Map<string, SpeakerHead>): React.ReactNode => {
    const head = own.get(b.key);
    return head ? <Fragment key={b.key}><WhoLine head={head} />{renderRow(b)}</Fragment> : renderRow(b);
  };
  const renderRow = (b: Row): React.ReactNode => {
    if (b.type === "ticket") {
      return b.phase === "open" ? (
        <TicketCard
          key={b.key} row={b} nowTs={nowTs} readOnly={tix.readOnly} draft={tix.draft(b.item.id)}
          error={tix.error?.id === b.item.id ? tix.error.text : null}
          act={tix.act} setDraft={tix.setDraft} dismissError={tix.dismissError}
          movedAt={cards.movedAt} onZoom={cards.onZoom} onToggle={release}
        />
      ) : (
        <TicketLine key={b.key} row={b} nowTs={nowTs} readOnly={tix.readOnly} undoMs={tix.undoMs} undo={tix.undo} onToggle={release} onZoom={cards.onZoom} />
      );
    }
    if (b.type === "msg") {
      const out = outByKey.get(b.key);
      return out
        ? <MessageRow key={b.key} m={b.item} onToggle={release} out={out} onRetry={outbox?.retry} onRemove={outbox?.remove} />
        : <MessageRow key={b.key} m={b.item} onToggle={release} />;
    }
    if (b.type === "note") return <div key={b.key} className={s.note}>{b.item.text}<i>{fmtClock(b.item.ts)}</i></div>;
    if (b.type === "day") return <div key={b.key} className={s.day}>{fmtDay(b.ts)}</div>;
    if (b.type === "sub") {
      return (
        <SubRow
          key={b.key} agentId={agentId ?? ""} blockKey={b.key} step={b.item} sub={b.item.agent ? subs?.[b.item.agent] : undefined}
          status={status ?? ""} skew={skew} open={open.has(b.key)} depth={1} onToggle={toggle} onRead={release}
        />
      );
    }
    return <StepsRow key={b.key} b={b} open={open.has(b.key)} running={!!live && b === lastSteps} onToggle={toggle} />;
  };
  return (
    <div className={s.root}>
      <div className={s.scroller} ref={scroller} onScroll={onScroll}>
        <SubFresh.Provider value={subFresh}>
        <div className={s.content} ref={content}>
          {state && state.start !== null && (
            <button type="button" className={s.earlier} data-earlier="" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : <><ChevronIcon dir="up" size={10} />Earlier messages</>}
            </button>
          )}
          {state && state.start === null && rows.length > 0 && <div className={s.begin} data-earlier="">Start of the session</div>}
          {state && rows.length === 0 && tail.length === 0 && !live && !subsLine && <div className={s.empty}>No messages yet.</div>}
          {!state && <div className={`${s.empty} late`}>Loading the thread…</div>}
          {rows.map((b) => withWho(b, heads))}
          {tail.map((b) => withWho(b, heads))}
          {subsLine && <SubsLine text={subsLine.text} since={subsLine.since} skew={skew} />}
          {live && <LiveLine label={live.label} since={live.since} skew={skew} quiet={quiet} />}
        </div>
        </SubFresh.Provider>
      </div>
      {unseen && (
        <button type="button" className={s.unseen} onClick={() => { stick.current = true; setUnseen(false); toBottom(); }}>
          <ArrowDownIcon />New messages
        </button>
      )}
      <TicketsAbove count={cards.above} onJump={cards.toAbove} />
      <TicketZoom cards={cards} />
    </div>
  );
}
