// src/components/setup/GuidePane.tsx — the guide on the Set-up page: its thread and the box
// "Ask the guide, or say what you want to do".
//
// The thread is data of the server (server/guide/types.ts). What the guide says is drawn as
// PLAIN TEXT: no HTML, no markdown, no link and no picture made from its words. The thread draws
// no step card: a step is only on the stage (Stage.tsx), and an address the user must open comes
// only from the part of the step there. The result of a check and the last error of a step are
// the server's words.
//
// The box stops a text that looks like a secret before it leaves the browser (lib/guide.ts
// sendToGuide). The box is emptied at the send, and no text of it is kept in a store.
"use client";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Fold } from "./Fold";
import { BUSY_LATE_TEXT, nextParts, OFF_HEAD, OFF_TAIL, offLine, sideOf, type GuideItem, type GuideOff } from "../../lib/guide";
import type { SetupRow } from "../../lib/setup";
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

// The items of the thread. A card item of the server (the step to do now) is not drawn: the step
// is on the stage.
export function GuideItems({ items: all, rows, busy = false, late = false }: {
  items: GuideItem[]; rows: SetupRow[]; busy?: boolean; late?: boolean;
}) {
  const items = all.filter((i) => i.kind !== "card");
  // The lines that were there when the thread opened. A line that comes later folds in.
  const firstIds = useRef<Set<string> | null>(null);
  if (firstIds.current === null) firstIds.current = new Set(items.map((i) => i.id));
  const known = firstIds.current;
  return (
    <>
      {items.map((i, n) => {
        const side = sideOf(i);
        const first = n === 0 || sideOf(items[n - 1]) !== side;
        const parts = (
          <>
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
            {i.kind === "stopped" && <div className={g.stop} role="note"><LockIcon /><span>{i.text}</span></div>}
            {i.kind === "note" && <p className={g.note}>{i.text}</p>}
          </>
        );
        return known.has(i.id)
          ? <Fragment key={i.id}>{parts}</Fragment>
          : <Fold key={i.id} open appear frame={g.foldLine} className={g.foldLineIn}>{parts}</Fold>;
      })}
      <Fold open={busy} frame={g.foldLine} className={g.foldLineIn}>
        <div className={t.live} role="status"><i className={t.liveDot} aria-hidden /><span className={t.liveWord}>The guide writes…</span></div>
      </Fold>
      <Fold open={late} frame={g.foldLine} className={g.foldLineIn}>
        <p className={g.note} role="status">{BUSY_LATE_TEXT}</p>
      </Fold>
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

export function GuidePane({ guide, rows, phone = false }: { guide: GuideHook; rows: SetupRow[]; phone?: boolean }) {
  const items = guide.view?.items ?? [];
  // The end of the thread stays on screen: when a line comes, when the guide starts to write,
  // and when a line folds in. A user who scrolled up to read is left there until the next line
  // of the thread.
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
            : <GuideItems items={items} rows={rows} busy={guide.busy} late={guide.late} />}
        </div>
      </div>
      <Box guide={guide} phone={phone} />
    </section>
  );
}
