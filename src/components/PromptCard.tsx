// src/components/PromptCard.tsx — the terminal dialog an agent waits on, as a
// card above the composer. The thread is built from the session file, and that
// file holds no dialog: the server reads the agent's screen and gives the
// dialog as data (server/agents/prompt.ts).
//   - a known dialog (folder trust, login method, a numbered picker): its
//     question and one button for each option;
//   - any other dialog: the screen text and the keys Up, Down, Enter, Esc.
//     This is the only place where screen text shows.
// Each option of a known dialog shows its number as a key cap: the key 1..9
// presses that option while the focus is not in a text field or the terminal.
"use client";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  optionsLayout, primaryOption, screenLines, UNKNOWN_KEYS, type PromptKey, type PromptState,
} from "../lib/prompt";
import s from "./PromptCard.module.css";

// A number key presses an option only up to 9 (one key each).
const MAX_KEYED = 9;
// The keys go to the field or the terminal that has the focus, never to the card.
const TYPING = "input, textarea, select, [contenteditable], .xterm";

export function PromptCard({ prompt, who, busy, note, onPress }: {
  prompt: PromptState;
  // Who waits: "indexer", "Lead · console".
  who?: string;
  busy: boolean;
  note: string | null;
  // `rev` given: the keys are an option's, valid only for this card.
  onPress: (keys: PromptKey[], rev?: string) => void;
}) {
  const unknown = prompt.kind === "unknown";
  const primary = primaryOption(prompt);
  const lines = useMemo(() => (unknown ? screenLines(prompt.screenText) : []), [unknown, prompt.screenText]);
  // A dialog is at the bottom of the screen: show that end of a long text.
  const screen = useRef<HTMLPreElement | null>(null);
  useLayoutEffect(() => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [prompt.rev]);

  // The number keys. Not while a modal is open, and not while the card is
  // hidden (the pane stays mounted under the Docs view).
  const card = useRef<HTMLElement | null>(null);
  const keyed = unknown ? 0 : Math.min(prompt.options.length, MAX_KEYED);
  useEffect(() => {
    if (keyed === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (!/^[1-9]$/.test(e.key) || Number(e.key) > keyed) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || t.closest(TYPING))) return;
      if (!card.current || card.current.getClientRects().length === 0 || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      onPress(prompt.options[Number(e.key) - 1].keys, prompt.rev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyed, busy, onPress, prompt]);

  return (
    <section ref={card} className={s.card} data-kind={prompt.kind} aria-label="The agent waits on a prompt" aria-busy={busy}>
      <h3 className={s.question}>
        <span className={s.dot} aria-hidden />
        <span>{unknown ? `${who ?? "The agent"} waits on a prompt` : prompt.question}</span>
      </h3>
      {unknown ? (
        <>
          <pre className={s.screen} ref={screen} tabIndex={0} aria-label="The agent's screen">
            {lines.map((l, i) => (l.pointed ? <b key={i}>{l.text}{"\n"}</b> : <span key={i}>{l.text}{"\n"}</span>))}
          </pre>
          <div className={s.acts}>
            {UNKNOWN_KEYS.map((k) => (
              <button
                key={k.key} type="button" className={`${s.btn} ${s.key} ${k.key === "enter" ? s.pri : ""}`}
                aria-label={k.name} title={`Send ${k.name}`} disabled={busy} onClick={() => onPress([k.key])}
              >{k.label}</button>
            ))}
          </div>
        </>
      ) : (
        <>
          {prompt.detail && <pre className={s.detail}>{prompt.detail}</pre>}
          <div className={s.acts} data-layout={optionsLayout(prompt)}>
            {prompt.options.map((o, i) => (
              <button
                key={`${i}:${o.label}`} type="button"
                className={`${s.btn} ${i === primary ? s.pri : /^no\b/i.test(o.label.trim()) ? s.ghost : ""}`}
                disabled={busy} onClick={() => onPress(o.keys, prompt.rev)}
                aria-keyshortcuts={i < keyed ? String(i + 1) : undefined}
              >
                <span className={s.label}>{o.label}</span>
                {i < keyed && <span className={s.kbd} aria-hidden>{i + 1}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {note && <p className={s.note} role="status">{note}</p>}
      {/* No console line is typed while a dialog is on the screen (server/issues/reply.ts). */}
      <p className={s.held}>The console sends no line to this agent until you answer.</p>
    </section>
  );
}
