// src/components/UpdateProgress.tsx — the place of the Update button on a hosted console: the
// button, then the steps of the press (lib/updateProgress), then its end, in one cell that does
// not change its height. The update ticket's panel and the Settings page show this one block.
// Motion: transform and opacity only; with reduced motion, the same states with no motion.
"use client";
import type { ReactNode } from "react";
import { UPDATE_STEPS, type Progress } from "../lib/updateProgress";
import { Mark } from "./SideIcons";
import s from "./UpdateProgress.module.css";

type Props = {
  p: Progress;
  // The run was seen under way here: the end comes with its one motion.
  live: boolean;
  // The button of a ready ticket (the Update button, or the pair button with its hint).
  action?: ReactNode;
  // The button beside a failure that can be asked again ("Try again").
  again?: ReactNode;
};

export function UpdateProgress({ p, live, action, again }: Props) {
  const going = p.t === "going";
  const ended = p.t === "done" || p.t === "failed";
  return (
    <div className={s.stage} data-progress={p.t} aria-live="polite">
      {action !== undefined && (
        <div className={s.layer} data-on={p.t === "idle" ? "" : undefined}>{action}</div>
      )}
      <ol className={`${s.layer} ${s.steps}`} data-on={going ? "" : undefined} aria-label="Update steps" aria-hidden={going ? undefined : true}>
        {(going ? p.steps : STILL).map((x) => (
          <li key={x.key} className={s.step} data-state={x.state} aria-current={x.state === "now" ? "step" : undefined}>
            <span className={s.mark} aria-hidden>
              {x.state === "done" ? <Mark kind="ok" /> : x.state === "now" ? <span className={s.live} /> : <Mark kind="todo" />}
            </span>
            {x.word}
          </li>
        ))}
      </ol>
      {ended && (
        <div className={`${s.layer} ${s.end} ${live ? s.enter : ""}`} data-on="" key={p.t}>
          {p.t === "done" ? (
            <>
              <span className={s.line} role="status"><span className={`${s.dot} ${s.ok}`} aria-hidden />Updated to version {p.version}</span>
              <button type="button" className={s.btn} onClick={() => window.location.reload()}>Reload this page</button>
            </>
          ) : (
            <>
              <span className={s.line} role="alert"><span className={`${s.dot} ${s.err}`} aria-hidden />{p.line}{p.next ? ` ${p.next}` : ""}</span>
              {again}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The steps' row while it is hidden: it keeps its place in the cell (no jump when it shows).
const STILL = UPDATE_STEPS.map((x) => ({ ...x, state: "todo" as const }));
