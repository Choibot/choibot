// src/components/DeployPanel.tsx — the deploy ticket's own block (chief spec §5.7), in the Queue
// view's detail pane and on the ticket card in the thread: what is in the way, the run's steps,
// the result or the error, and the one Deploy button. On a device with no user token the button
// is replaced by "Pair this device to deploy". Every string renders as a React text node.
"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { runLine, short, stepWord, type DeployInfo } from "../../server/chief/deploy/ticket";
import { pairSentence } from "../lib/chief";
import { PAIR_TO_DEPLOY, pairHow, startDeploy, stepStates } from "../lib/deploy";
import { useUpdateProgress } from "../lib/useUpdateProgress";
import { Mark } from "./SideIcons";
import { UpdateProgress } from "./UpdateProgress";
import s from "./DeployPanel.module.css";

const MARK = { done: "ok", now: "run", todo: "todo", skipped: "skip" } as const;

type Props = {
  item: QueueItem; readOnly: boolean; userAuth: "telegram" | "log" | null;
  // The thread's shift guard: true when the card moved under the pointer a moment ago.
  blocked?: (byPointer: boolean) => boolean;
};

export function DeployPanel({ item, readOnly, userAuth, blocked }: Props) {
  const d = item.deploy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const run = d?.run;
  const runId = run?.id;
  const phase = run?.phase;
  // The run arrived on the ticket (or ended): the button's own state is done.
  useEffect(() => { setBusy(false); if (phase === "running") setError(null); }, [runId, phase]);
  if (!d) return null;
  if (d.release) return <UpdatePanel item={item} d={d} readOnly={readOnly} userAuth={userAuth} blocked={blocked} />;

  const open = item.status === "open" || item.status === "snoozed";
  const running = phase === "running";
  const go = async (e: MouseEvent): Promise<void> => {
    if (busy || running) return; // a second press does nothing
    if (blocked?.(e.detail !== 0)) { setMoved(true); return; }
    setMoved(false);
    setBusy(true);
    setError(null);
    const r = await startDeploy();
    // 409 "already runs": the ticket shows that run; it is not an error to show.
    if (!r.ok && !(r.status === 409 && /already runs/.test(r.error))) setError(r.error);
    if (!r.ok) setBusy(false);
  };

  return (
    <div className={s.box} data-deploy-phase={phase ?? "ready"}>
      {phase !== "done" && (
        <div className={s.commits}>
          <span>live <b>{short(d.live)}</b></span><span aria-hidden>→</span><span>main <b>{short(d.target)}</b></span>
          <span>{d.count} commit{d.count === 1 ? "" : "s"}</span>
        </div>
      )}
      {d.note && open && !running && <div className={s.note} role="status">{d.note}</div>}
      {run && running && (
        <ol className={s.steps} aria-label="Deploy steps">
          {stepStates(run).map((x) => (
            <li key={x.step} className={s.step} data-state={x.state}>
              <span className={s.mark} aria-hidden><Mark kind={MARK[x.state]} /></span>{stepWord(x.step)}{x.state === "skipped" ? " (not needed)" : ""}
            </li>
          ))}
        </ol>
      )}
      {run && phase === "failed" && (
        <div className={s.failed} role="alert">
          <div>{runLine(run)}</div>
          {run.tail && <pre className={s.tail}>{run.tail}</pre>}
        </div>
      )}
      {run && phase === "done" && (
        <div className={s.done} role="status">
          <span>{runLine(run)}</span>
          <button type="button" className={s.btn} onClick={() => window.location.reload()}>Reload this page</button>
        </div>
      )}
      {open && !running && (
        <div className={s.acts}>
          {readOnly ? (
            <>
              <button type="button" className={s.btn} disabled>{PAIR_TO_DEPLOY}</button>
              <span className={s.hint}>{pairHow(userAuth)}</span>
            </>
          ) : (
            <>
              <button type="button" className={`${s.btn} ${s.pri}`} disabled={busy} onClick={(e) => void go(e)}>
                {busy ? "Starting…" : phase === "failed" ? "Deploy again" : "Deploy"}
              </button>
              <span className={s.hint}>Fast-forward main, build, then restart the console. Agents keep running.</span>
            </>
          )}
        </div>
      )}
      {running && <div className={s.hint}>The console restarts at the end. This page reconnects by itself.</div>}
      {moved && <div className={s.hint} role="status">The thread moved. Press again.</div>}
      {error && <div className={s.error} role="alert">{error}</div>}
    </div>
  );
}

// The release variant (server/update): the Update button of a hosted console. The versions, then
// one place that is the button, the press's steps and its end (UpdateProgress): it changes at once
// on the press and keeps its height through the console's restart. No explaining paragraph.
function UpdatePanel({ item, d, readOnly, userAuth, blocked }: Omit<Props, "item"> & { item: QueueItem; d: DeployInfo }) {
  const r = d.release!;
  const { p, live, tracker } = useUpdateProgress({ item: item.id, run: d.update, closed: item.lastError ?? null, to: r.version });
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const pressing = useRef(false); // a second press, before the page re-renders, does nothing
  const stageRef = useRef<HTMLDivElement>(null);
  const open = item.status === "open" || item.status === "snoozed";
  const go = async (e: MouseEvent): Promise<void> => {
    if (pressing.current || p.t === "going") return;
    if (blocked?.(e.detail !== 0)) { setMoved(true); return; }
    if (!tracker.press({ item: item.id, from: r.running.version, to: r.version })) return;
    pressing.current = true;
    setMoved(false);
    setError(null);
    stageRef.current?.focus({ preventScroll: true }); // the pressed button hides: focus stays in the block
    const res = await startDeploy();
    pressing.current = false;
    const askedAt = res.ok ? res.item.deploy?.update?.askedAt : undefined;
    if (typeof askedAt === "number") return tracker.answered(askedAt);
    // Refused: the button again with the reason. 409 "already runs": another device asked; the
    // ticket shows that run.
    tracker.refused();
    if (!res.ok && !(res.status === 409 && /already runs/.test(res.error))) setError(res.error);
  };
  const button = (label: string) => (
    <button type="button" className={`${s.btn} ${s.pri}`} onClick={(e) => void go(e)}>{label}</button>
  );
  const action = !open ? null : readOnly ? (
    <div className={s.acts}>
      <button type="button" className={s.btn} disabled>Pair this device to update</button>
      <span className={s.hint}>{pairSentence(userAuth, "Update")}</span>
    </div>
  ) : button("Update");
  return (
    <div className={s.box} data-update-state={d.update?.state ?? "ready"} data-progress={p.t}>
      <div className={s.commits}><span>Version <b>{r.running.version}</b></span><span aria-hidden>→</span><span><b>{r.version}</b></span></div>
      {(open || p.t !== "idle") && (
        <div ref={stageRef} tabIndex={-1} className={s.stage}>
          <UpdateProgress p={p} live={live} action={action} again={open && !readOnly && p.t === "failed" ? button(p.again ? "Try again" : "Update") : undefined} />
        </div>
      )}
      {moved && <div className={s.hint} role="status">The thread moved. Press again.</div>}
      {error && <div className={s.error} role="alert">{error}</div>}
    </div>
  );
}
