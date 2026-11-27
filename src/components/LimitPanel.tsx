// src/components/LimitPanel.tsx — the usage-limit ticket's block (server/chief/limit), in the
// Queue view's detail pane: one line per blocked agent (its name, its login, its state in a few
// words) with its buttons, then "Move all" and "Continue all". The server checks each press
// again; the rows change when the ticket changes (the hub's queue event). Every string renders as
// a React text node (an agent's name is untrusted text).
"use client";
import { useState, type MouseEvent } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { LIMIT_ALL, LIMIT_WORDS, rowCanContinue, rowCanMove, rowStateText, type LimitPress, type LimitRow } from "../../server/chief/limit/ticket";
import { pairSentence } from "../lib/chief";
import { limitClock, pressLimit } from "../lib/limit";
import s from "./LimitPanel.module.css";

type Props = {
  item: QueueItem; readOnly: boolean; userAuth: "telegram" | "log" | null;
  // The thread's shift guard: true when the card moved under the pointer a moment ago.
  blocked?: (byPointer: boolean) => boolean;
};

const pressKey = (p: LimitPress): string => `${p.row}:${p.act}`;
// The dot of a row: blue = it waits on you, grey = it goes on or moves by itself.
const tone = (r: LimitRow): "turn" | "run" => (r.state === "going-on" || r.state === "moves-when-quiet" ? "run" : "turn");

export function LimitPanel({ item, readOnly, userAuth, blocked }: Props) {
  const l = item.limit;
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  if (!l) return null;
  const open = item.status === "open" || item.status === "snoozed";
  const to = l.to;
  const live = open && !readOnly;
  const movable = l.rows.filter((r) => rowCanMove(r, to));
  const goable = l.rows.filter(rowCanContinue);

  const go = async (e: MouseEvent, p: LimitPress): Promise<void> => {
    if (busy) return; // one press at a time; a second press of the same button does nothing
    if (blocked?.(e.detail !== 0)) { setSaid({ text: "The thread moved. Press again.", bad: false }); return; }
    setBusy(pressKey(p));
    setSaid(null);
    const r = await pressLimit(item.id, p);
    setBusy(null);
    if (!r.ok) setSaid({ text: r.error, bad: true });
    else if (p.row === LIMIT_ALL && r.text) setSaid({ text: r.text, bad: false });
  };
  const btn = (p: LimitPress, label: string, pri = false) => (
    <button
      type="button" className={`${s.btn}${pri ? ` ${s.pri}` : ""}`} disabled={busy !== null} title={label}
      data-busy={busy === pressKey(p) ? "" : undefined} onClick={(e) => void go(e, p)}
    ><span className={s.label}>{label}</span></button>
  );

  return (
    <div className={s.box} data-limit="">
      <ol className={s.rows} aria-label="Blocked agents">
        {l.rows.map((r) => (
          <li key={r.key} className={s.row} data-state={r.state}>
            <span className={s.dot} data-tone={tone(r)} aria-hidden />
            <span className={s.who}>
              <b className={s.name}>{r.name}</b>
              <span className={s.meta}>{r.loginName} · {rowStateText(r, limitClock)}</span>
            </span>
            {live && (rowCanMove(r, to) || rowCanContinue(r)) && (
              <span className={s.acts}>
                {rowCanMove(r, to) && btn({ row: r.tag, act: "move", to: to.id }, LIMIT_WORDS.move(to.name))}
                {rowCanContinue(r) && btn({ row: r.tag, act: "continue" }, LIMIT_WORDS.continue)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {live && (movable.length > 1 || goable.length > 1) && (
        <div className={s.all}>
          {movable.length > 1 && to && btn({ row: LIMIT_ALL, act: "move", to: to.id }, LIMIT_WORDS.moveAll(to.name), true)}
          {goable.length > 1 && btn({ row: LIMIT_ALL, act: "continue" }, LIMIT_WORDS.continueAll, movable.length <= 1)}
        </div>
      )}
      {open && readOnly && <div className={s.hint}>{pairSentence(userAuth, "A move")}</div>}
      {live && !to && goable.length === 0 && <div className={s.hint}>No login has room now.</div>}
      {said && <div className={said.bad ? s.error : s.hint} role={said.bad ? "alert" : "status"}>{said.text}</div>}
    </div>
  );
}
