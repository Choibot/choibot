// src/components/setup/Stage.tsx — the stage of the Set-up page (direction B): a rail with one
// part for each required step, one line with the step to do now, ONE step in the middle with its
// live part, and the full list in the fold "All steps" under it. The rules are pure (lib/stage.ts).
//
// The step that is done leaves (it goes up and fades), the next comes in after it. The rail part
// fills in the same 280 ms. No motion at the first render, from "Checking the steps…", or with
// reduced motion. The card of each step is the part of the list (SetupList StepAction), in its
// stage form: one live part, and the other help in a closed "More".
//
// A press on a row of the fold puts that step on the stage: a done step (to change it, for
// example the repo), or an optional step. "Back" gives the step to do now again.
"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { canStage, endOptions, railParts, rowNote, stageKey, stageStep, type StageShown } from "../../lib/stage";
import { headline, progress, setupRows, stateWord, type SetupRow } from "../../lib/setup";
import type { SetupView } from "../../lib/useSetup";
import type { StepId } from "../../../server/setup/steps";
import { CheckIcon, ChevronIcon, RefreshIcon } from "../SideIcons";
import { cx as k } from "../settings/kit";
import { ChoiScene } from "./ChoiScene";
import { Fold } from "./Fold";
import { StepAction, STAYS, STRONG_WORDS, type SetupNav } from "./SetupList";
import c from "./Setup.module.css";
import s from "./Stage.module.css";

export const STAGE_MS = 280;
const LEAVE: Keyframe[] = [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-30px) scale(.95)" }];
const ENTER: Keyframe[] = [{ opacity: 0, transform: "translateY(20px)" }, { opacity: 1, transform: "none" }];
const LEAVE_EASE = "cubic-bezier(.4, 0, .6, 1)";
const ENTER_EASE = "cubic-bezier(.2, 0, 0, 1)";

export const END_LINE = "Your first agent opened a pull request, and you merged it. From now on, each decision your agents need from you comes to the Queue as a ticket.";
const FOOT = "A step is done when its check passes on your server. Nothing else can mark a step done.";

const reduced = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// One part for each required step. The fill of a part moves (CSS); `still`: the first answer of
// the list, whose done parts are there at once (a hosted start has 4 of them).
function Rail({ rows, still }: { rows: SetupRow[]; still: boolean }) {
  const { done, total } = progress(rows);
  return (
    <div className={s.rail} role="progressbar" aria-label="Set-up steps" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
      aria-valuetext={`${done} of ${total} steps done`} data-still={still ? "" : undefined}>
      {railParts(rows).map((p) => <i key={p.id} data-state={p.state}><b /></i>)}
    </div>
  );
}

// The card on the stage changes: the old card stays in the same cell until it has left, and the
// new card comes in after it. The old card keeps its React state (same key), so it leaves as it was.
function Swap({ k: key, children }: { k: string; children: ReactNode }) {
  const [cur, setCur] = useState(key);
  const [gone, setGone] = useState<{ k: string; node: ReactNode } | null>(null);
  const last = useRef<ReactNode>(children);
  if (key !== cur) {
    setCur(key);
    setGone(cur === "checking" || reduced() ? null : { k: cur, node: last.current });
  }
  useLayoutEffect(() => { last.current = children; });
  const goneRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!gone) return;
    const out = goneRef.current, inn = curRef.current;
    if (!out || !inn || typeof out.animate !== "function") { setGone(null); return; }
    let live = true;
    const a = out.animate(LEAVE, { duration: STAGE_MS, easing: LEAVE_EASE, fill: "forwards" });
    const b = inn.animate(ENTER, { duration: STAGE_MS, delay: STAGE_MS, easing: ENTER_EASE, fill: "backwards" });
    b.onfinish = () => { if (live) setGone(null); };
    return () => { live = false; a.cancel(); b.cancel(); };
  }, [gone]);
  const cells = gone ? [{ k: gone.k, node: gone.node, old: true }, { k: cur, node: children, old: false }] : [{ k: cur, node: children, old: false }];
  return (
    <div className={s.swap}>
      {cells.map((x) => (
        <div key={x.k} className={s.cell} ref={x.old ? goneRef : curRef} aria-hidden={x.old || undefined} inert={x.old || undefined} data-gone={x.old ? "" : undefined}>
          {x.node}
        </div>
      ))}
    </div>
  );
}

function CheckAgain({ setup }: { setup: SetupView }) {
  return (
    <button type="button" className={k.btn} disabled={setup.checking} onClick={() => void setup.refresh()}>
      <RefreshIcon size={14} />{setup.checking ? "Checking…" : "Check again"}
    </button>
  );
}

function Card({ phone, children, ...data }: { phone: boolean; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return <section className={`${c.wrap} ${s.card}`} data-phone={phone ? "" : undefined} {...data}>{children}</section>;
}

function StageCard({ row, picked, nav, phone, onDone, onBack }: {
  row: SetupRow; picked: boolean; nav: SetupNav; phone: boolean; onDone: () => Promise<void>; onBack: () => void;
}) {
  return (
    <Card phone={phone} data-step={row.id} data-state={row.state}>
      <div className={s.cardHead}>
        <h2 className={s.cardTitle}>{row.title}</h2>
        {row.state !== "turn" && <span className={s.cardWord}>{stateWord(row)}</span>}
      </div>
      <p className={c.why}>{row.why}</p>
      {row.error && <p className={c.error}>{row.error}</p>}
      <StepAction row={row} nav={nav} onDone={onDone} stage />
      {picked && <div><button type="button" className={`${k.btn} ${k.link}`} onClick={onBack}>Back</button></div>}
    </Card>
  );
}

function CheckingCard({ setup, phone }: { setup: SetupView; phone: boolean }) {
  return (
    <Card phone={phone} data-checking="">
      {setup.failed
        ? <><p className={c.error} role="alert">The console did not answer. Press Check again.</p><div className={c.acts}><CheckAgain setup={setup} /></div></>
        : <p className={c.today} role="status">Checking the steps…</p>}
    </Card>
  );
}

function OptionLine({ r }: { r: SetupRow }) {
  return (
    <>
      <span className={c.mark} data-state={r.state} aria-hidden>{r.state === "done" && <CheckIcon size={12} />}</span>
      <span className={s.optTitle}>{r.title}</span>
      <span className={s.note}>{rowNote(r)}</span>
    </>
  );
}

// Every required step passes: one calm line, the optional steps (a press puts one on the stage),
// and the way to the console.
function EndCard({ rows, nav, phone, onPick }: { rows: SetupRow[]; nav: SetupNav; phone: boolean; onPick: (id: StepId) => void }) {
  const [all, setAll] = useState(false);
  const { shown, more } = endOptions(rows, all ? Infinity : 3);
  return (
    <Card phone={phone} data-end="">
      <h2 className={s.endTitle}><span className={s.endMark} aria-hidden><CheckIcon size={12} /></span>Set-up is done</h2>
      <p className={c.why}>{END_LINE}</p>
      <div className={s.end}>
        <h3 className={s.groupHead}>What next. Each one is optional.</h3>
        <ul className={s.options}>
          {shown.map((r) => (
            <li key={r.id} data-step={r.id}>
              {canStage(r)
                ? <button type="button" className={s.option} onClick={() => onPick(r.id)}><OptionLine r={r} /></button>
                : <div className={s.option}><OptionLine r={r} /></div>}
            </li>
          ))}
        </ul>
        {more > 0 && <div><button type="button" className={`${k.btn} ${k.link}`} onClick={() => setAll(true)}>+{more} more</button></div>}
      </div>
      {nav.onLeave && <div className={c.acts}><button type="button" className={`${k.btn} ${k.primary}`} onClick={nav.onLeave}>Open the console</button></div>}
    </Card>
  );
}

// The fold under the stage: every step, the optional steps after the end, Check again.
function AllSteps({ setup, rows, open, onToggle, onPick, onStage }: {
  setup: SetupView; rows: SetupRow[]; open: boolean; onToggle: () => void; onPick: (id: StepId) => void; onStage: StepId | null;
}) {
  const { done, total } = progress(rows);
  const line = (r: SetupRow) => {
    const note = rowNote(r);
    const inner = (
      <>
        <span className={c.mark} data-state={r.state} aria-hidden>{r.state === "done" && <CheckIcon size={12} />}</span>
        <span className={s.rowTitle}>{r.title}</span>
        {r.state === "turn" ? <span className={s.tag}>Your turn</span> : <span className={s.note}>{note}</span>}
      </>
    );
    return (
      <li key={r.id} data-step={r.id} data-state={r.state} aria-current={onStage === r.id ? "step" : undefined}>
        {canStage(r)
          ? <button type="button" className={s.row} onClick={() => onPick(r.id)}>{inner}</button>
          : <div className={s.row}>{inner}</div>}
      </li>
    );
  };
  return (
    <div className={s.all}>
      <button type="button" className={s.allBtn} aria-expanded={open} onClick={onToggle}>
        {setup.answer ? `All steps · ${done} of ${total} done` : "All steps"}<ChevronIcon open={open} size={11} />
      </button>
      <Fold open={open} frame={s.allFrame} className={s.allBody}>
        <ul className={s.rows}>{rows.filter((r) => !r.optional).map(line)}</ul>
        <h3 className={s.groupHead}>Optional, after the end</h3>
        <ul className={s.rows}>{rows.filter((r) => r.optional).map(line)}</ul>
        <div className={c.acts}><CheckAgain setup={setup} /></div>
        {setup.answer?.protection === "strong" && <p className={c.foot} data-protection="strong">{STRONG_WORDS}</p>}
        <p className={c.foot}>{FOOT}</p>
      </Fold>
    </div>
  );
}

// `tools`: at the right of the line under the rail (the Guide switch). `banner`: one line under
// it (the guide cannot answer).
export function SetupStage({ setup, nav, phone = false, tools, banner }: {
  setup: SetupView; nav: SetupNav; phone?: boolean; tools?: ReactNode; banner?: ReactNode;
}) {
  const rows = setupRows(setup.answer);
  const [picked, setPicked] = useState<StepId | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const shown: StageShown = stageStep(rows, picked);
  const area = useRef<HTMLDivElement>(null);
  // The rail moves from the second answer on: the first answer draws the done parts at once.
  const answered = setup.answer !== null;
  const [seen, setSeen] = useState(answered);
  useEffect(() => { if (answered) setSeen(true); }, [answered]);

  const pick = (id: StepId) => {
    setPicked(id);
    setAllOpen(false);
    requestAnimationFrame(() => area.current?.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" }));
  };
  const onDone = async () => {
    // The phone step and the Telegram step stay on the stage after their action (STAYS).
    if (!(shown.kind === "step" && shown.picked && STAYS.includes(shown.row.id))) setPicked(null);
    await setup.refresh();
  };
  const card = shown.kind === "step"
    ? <StageCard row={shown.row} picked={shown.picked} nav={nav} phone={phone} onDone={onDone} onBack={() => setPicked(null)} />
    : shown.kind === "end"
      ? <EndCard rows={rows} nav={nav} phone={phone} onPick={pick} />
      : <CheckingCard setup={setup} phone={phone} />;
  return (
    <div className={s.stage} data-phone={phone ? "" : undefined}>
      <div className={s.top}>
        <Rail rows={rows} still={!seen} />
        <div className={s.line}>
          <span className={s.lineText} role="status">{headline(rows)}</span>
          {tools}
        </div>
        {banner}
      </div>
      <div className={s.area} ref={area}>
        <ChoiScene rows={rows} phone={phone} />
        <Fold open frame={s.frame} className={s.framePart}>
          <Swap k={stageKey(shown)}>{card}</Swap>
        </Fold>
      </div>
      <AllSteps setup={setup} rows={rows} open={allOpen} onToggle={() => setAllOpen(!allOpen)} onPick={pick}
        onStage={shown.kind === "step" ? shown.row.id : null} />
    </div>
  );
}
