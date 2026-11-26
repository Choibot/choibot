// src/components/setup/GuidePane.tsx — the guide on the Set-up page: its thread and the box
// "Ask the guide, or say what you want to do".
//
// The thread is data of the server (server/guide/types.ts). What the guide says is drawn as
// PLAIN TEXT: no HTML, no markdown, no link and no picture made from its words. An address the
// user must open comes only from a card, and a card is the same part as the row of that step in
// the list (StepAction): its form or its button calls the route of the row as the paired user.
// The result of a check and the last error of a step are the server's words.
//
// The box stops a text that looks like a secret before it leaves the browser (lib/guide.ts
// sendToGuide). The box is emptied at the send, and no text of it is kept in a store.
"use client";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BUSY_LATE_TEXT, cardModes, nextParts, OFF_HEAD, OFF_TAIL, offLine, sideOf, type CardMode, type GuideItem, type GuideOff } from "../../lib/guide";
import type { SetupRow } from "../../lib/setup";
import { stateWord } from "../../lib/setup";
import type { GuideHook } from "../../lib/useGuide";
import { STEPS, type StepId } from "../../../server/setup/steps";
import { CheckIcon } from "../SideIcons";
import f from "../Composer.module.css";
import t from "../ThreadView.module.css";
import c from "./Setup.module.css";
import g from "./Guide.module.css";

const titleOf = (id: StepId, rows: SetupRow[]): string => rows.find((r) => r.id === id)?.title ?? STEPS.find((s) => s.id === id)?.title ?? id;

const LockIcon = () => (
  <svg className={g.icon} viewBox="0 0 16 16" aria-hidden><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
);
const GuideIcon = () => (
  <svg className={g.icon} viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="5.8" /><path d="M10.4 5.6 9 9l-3.4 1.4L7 7z" /></svg>
);

// What the guide says: text nodes only. A line break of the text is a line break on screen.
function Said({ item }: { item: Extract<GuideItem, { kind: "guide" }> }) {
  const next = item.fixed ? nextParts(item.text) : null;
  return (
    <div className={t.msg} data-kind="guide">
      <p className={g.text}>{next ? <><b>{next.head}</b>{next.rest ? ` ${next.rest}` : ""}</> : item.text}</p>
    </div>
  );
}

const CARD_WORD: Record<CardMode, string> = { live: "", done: "Done", waits: "Waits", old: "", checking: "Checking…" };

// One card: the head with the title of the step, then the part of the step when the card is
// live. A card that is not live is one line: what the check says, or where the newer card is.
function Card({ step, mode, row, title, body, phone }: { step: StepId; mode: CardMode; row: SetupRow | undefined; title: string; body: ReactNode; phone: boolean }) {
  if (mode === "old") return <p className={g.stub} data-step={step}>{title}: a newer card is below.</p>;
  return (
    <section className={g.card} data-step={step} data-mode={mode} aria-label={title}>
      <header className={g.cardHead}>
        <span className={c.mark} data-state={mode === "done" ? "done" : row?.state ?? "checking"} aria-hidden>{mode === "done" && <CheckIcon size={12} />}</span>
        <b className={g.cardTitle}>{title}</b>
        <span className={g.cardWord}>{mode === "live" && row ? stateWord(row) : CARD_WORD[mode]}</span>
      </header>
      {/* The part of the step is the one of the list: it gets the list's own sizes (Setup.module.css .wrap). */}
      {mode === "live"
        ? <div className={`${c.wrap} ${g.cardBody}`} data-phone={phone ? "" : undefined}>{body}</div>
        : row && mode !== "checking" ? <p className={g.cardLine}>{row.text}</p> : null}
    </section>
  );
}

// The items of the thread. `card`: the live part of a step (the page gives StepAction).
export function GuideItems({ items, rows, busy = false, late = false, phone = false, card }: {
  items: GuideItem[]; rows: SetupRow[]; busy?: boolean; late?: boolean; phone?: boolean; card: (row: SetupRow) => ReactNode;
}) {
  const modes = cardModes(items, rows);
  return (
    <>
      {items.map((i, n) => {
        const side = sideOf(i);
        const first = n === 0 || sideOf(items[n - 1]) !== side;
        const row = "step" in i ? rows.find((r) => r.id === i.step) : undefined;
        return (
          <Fragment key={i.id}>
            {first && (
              <div className={t.who} data-mine={side === "you" ? "" : undefined}>
                {side === "guide" && <span className={t.ag}><GuideIcon /></span>}
                <span className={t.whoText}>{side === "you" ? "You" : "Guide"}</span>
              </div>
            )}
            {i.kind === "user" && <div className={t.bubble} data-mine=""><div className={t.plain}>{i.text}</div></div>}
            {i.kind === "guide" && <Said item={i} />}
            {i.kind === "check" && (
              <div className={g.chip} data-kind="check" data-state={i.state}>
                <span className={c.mark} data-state={i.state === "done" ? "done" : "turn"} aria-hidden>{i.state === "done" && <CheckIcon size={12} />}</span>
                <span className={g.chipHead}>Check: {titleOf(i.step, rows)}</span>
                <span className={g.chipText}>{i.text}</span>
              </div>
            )}
            {i.kind === "error" && (
              <div className={g.chip} data-kind="error">
                <span className={g.chipHead}>Last error of: {titleOf(i.step, rows)}</span>
                <span className={g.chipText}>{i.text}</span>
              </div>
            )}
            {i.kind === "card" && (
              <Card step={i.step} mode={modes.get(i.id) ?? "checking"} row={row} title={titleOf(i.step, rows)} body={row ? card(row) : null} phone={phone} />
            )}
            {i.kind === "stopped" && <div className={g.stop} role="note"><LockIcon /><span>{i.text}</span></div>}
            {i.kind === "note" && <p className={g.note}>{i.text}</p>}
          </Fragment>
        );
      })}
      {busy && <div className={t.live} role="status"><i className={t.liveDot} aria-hidden /><span className={t.liveWord}>The guide writes…</span></div>}
      {late && <p className={g.note} role="status">{BUSY_LATE_TEXT}</p>}
    </>
  );
}

// The one line for a guide that cannot answer: why, when it ends if the console knows, and
// that the list works without it.
export function GuideBanner({ off, now = Date.now() }: { off: GuideOff; now?: number }) {
  return (
    <p className={g.banner} role="status">
      <b>{OFF_HEAD}</b> {offLine(off, now)} {OFF_TAIL}
    </p>
  );
}

type Line = { tone: "stop" | "err"; text: string };

function Box({ guide, phone }: { guide: GuideHook; phone: boolean }) {
  // The text lives in this state only: no draft store, so nothing of it stays after the send.
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [line, setLine] = useState<Line | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = async () => {
    const value = text;
    if (!value.trim() || sending || guide.busy) return;
    // The box is emptied before the send: a text that the guard stops is on screen no longer.
    setText("");
    setLine(null);
    setSending(true);
    const r = await guide.send(value);
    setSending(false);
    if (r.ok) return;
    // Stopped by the guard: the thread says so (the server got the kind, never the text). With
    // no answer of the server, the line is shown here. Nothing of the text is kept.
    if ("stopped" in r) { if (!r.view) setLine({ tone: "stop", text: r.line }); return; }
    // Not a secret (the guide is busy, or there was no answer): the user gets the text back.
    setLine({ tone: "err", text: r.error });
    setText((now) => now || value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !phone) { e.preventDefault(); void submit(); }
  };
  const hint = phone ? "Ask the guide" : "Ask the guide, or say what you want to do";
  return (
    <div className={`${f.composer} ${g.box}`}>
      {line && (
        <div className={line.tone === "stop" ? g.stop : f.error} role="alert">
          {line.tone === "stop" && <LockIcon />}<span>{line.text}</span>
        </div>
      )}
      <div className={f.field}>
        <textarea
          ref={ref} className={f.input} rows={1} value={text} placeholder={hint} aria-label="Ask the guide"
          // A password manager and the browser keep no copy of this box.
          autoComplete="off" spellCheck
          onChange={(e) => { setText(e.target.value); if (line) setLine(null); }} onKeyDown={onKeyDown}
        />
        <button type="button" className={f.send} onClick={() => void submit()} onMouseDown={(e) => e.preventDefault()}
          disabled={!text.trim() || sending || guide.busy} aria-label="Send" title="Send (Enter)">
          <svg className={f.icon} viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M4 7l4-4 4 4" /></svg>
        </button>
      </div>
    </div>
  );
}

export function GuidePane({ guide, rows, phone = false, card }: {
  guide: GuideHook; rows: SetupRow[]; phone?: boolean; card: (row: SetupRow) => ReactNode;
}) {
  const items = guide.view?.items ?? [];
  // The end of the thread stays on screen: when a line comes, when the guide starts to write,
  // and when a card grows (its part loads after the card is there). A user who scrolled up to
  // read is left there until the next line of the thread.
  const scroller = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const toEnd = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
  const mark = `${items.length} ${guide.busy} ${guide.late}`;
  useEffect(() => { stick.current = true; toEnd(); }, [mark]);
  useEffect(() => {
    if (!col.current || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(() => { if (stick.current) toEnd(); });
    seen.observe(col.current);
    return () => seen.disconnect();
  }, []);
  const onScroll = () => { const el = scroller.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  return (
    <section className={g.pane} data-phone={phone ? "" : undefined} aria-label="Guide">
      <div className={g.scroll} ref={scroller} onScroll={onScroll}>
        <div className={g.col} ref={col}>
          {items.length === 0
            ? <p className={g.note}>The guide reads the list…</p>
            : <GuideItems items={items} rows={rows} busy={guide.busy} late={guide.late} phone={phone} card={card} />}
        </div>
      </div>
      <Box guide={guide} phone={phone} />
    </section>
  );
}
