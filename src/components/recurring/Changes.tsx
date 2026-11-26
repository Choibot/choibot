// src/components/recurring/Changes.tsx — "Changes that wait for you": on a protected install, a
// change of a recurring task that an agent asked for waits here for [Apply] [Reject]. The
// section is the first thing of the Recurring page, and it shows only while something waits.
"use client";
import { useCallback, useEffect, useState } from "react";
import {
  SPOOL_FRESH_MS, askedBy, changeWords, decideCronSpool, fetchCronSpool, spoolRowState, spoolSectionShown,
  trackSpool, visibleText, type CronSpoolRequest, type CronSpoolView, type SpoolTrack,
} from "../../lib/cron";
import s from "./Recurring.module.css";

function fmtAt(ms: number): string {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type CronSpoolState = { view: CronSpoolView | null; track: SpoolTrack; now: number; load: () => Promise<CronSpoolView> };

// The spool poll (Task 2c-8), one per page: the sidebar row shows a dot, the Recurring page
// shows the requests. GET /api/cron/spool answers 404 unless the install is protected: then
// polling stops after the first request. error: keep the last view.
export function useCronSpool(): CronSpoolState {
  const [view, setView] = useState<CronSpoolView | null>(null);
  const [track, setTrack] = useState<SpoolTrack>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async (): Promise<CronSpoolView> => {
    const v = await fetchCronSpool();
    if (v.state !== "error") {
      const t = Date.now();
      setView(v);
      setTrack((prev) => trackSpool(prev, v.state === "on" ? v.requests : [], t));
      setNow(t);
    }
    return v;
  }, []);
  // Re-render once a "new" row's wait is over, without waiting for the next poll.
  useEffect(() => {
    const pending = [...track.values()].map((t) => t.since + SPOOL_FRESH_MS - now).filter((ms) => ms > 0);
    if (pending.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...pending) + 50);
    return () => clearTimeout(timer);
  }, [track, now]);
  useEffect(() => {
    let alive = true; // per mount: a StrictMode remount must not inherit this poll
    let t: ReturnType<typeof setInterval> | undefined;
    void load().then((v) => {
      if (alive && v.state !== "off") t = setInterval(() => void load(), 5000);
    });
    return () => { alive = false; clearInterval(t); };
  }, [load]);
  return { view, track, now, load };
}

// Every field is agent-written and rendered as plain text, format and C1 characters escaped. A
// row that is new or changed since the previous poll keeps Apply off for SPOOL_FRESH_MS; one the
// console saw rewritten can only be rejected.
export function Changes({ spool }: { spool: CronSpoolState }) {
  const { view, track, now, load } = spool;
  const [busy, setBusy] = useState<string | null>(null);
  // The last apply or reject that failed (its request may be gone).
  const [notice, setNotice] = useState<string | null>(null);
  const decide = async (r: CronSpoolRequest, action: "apply" | "reject") => {
    setBusy(r.id);
    const res = await decideCronSpool(r, action);
    setBusy(null);
    setNotice(res.ok ? null : `${action === "apply" ? "Apply" : "Reject"} "${changeWords(r.op)}" of ${visibleText(r.name)}: ${visibleText(res.error)}`);
    await load();
  };
  if (!spoolSectionShown(view) && notice === null) return null;
  const requests = view?.state === "on" ? view.requests : [];
  return (
    <section className={s.changes} aria-label="Changes that wait for you">
      <h2 className={s.changesTitle}>
        Changes that wait for you
        {requests.length > 0 && <span className={s.changesCount}>{requests.length}</span>}
      </h2>
      <div className={s.changesList}>
        {notice !== null && (
          <div className={s.changeNotice} role="alert">
            <span>{notice}</span>
            <button type="button" className={s.btn} onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}
        {requests.map((r) => {
          const state = spoolRowState(r, track, now);
          return (
            <div key={r.id} className={s.change} data-change={r.id}>
              <div className={s.changeRow}>
                <span className={s.changeOp}>{changeWords(r.op)}</span>
                <span className={s.changeName}>{visibleText(r.name)}</span>
                <span className={s.changeMeta}>{r.by ? `${askedBy(r.by)} · ` : ""}{fmtAt(r.at)}</span>
                <button
                  type="button" className={s.btn} disabled={busy !== null || state !== "ready"}
                  title={state === "new" ? "New or changed: Apply in a moment" : undefined}
                  onClick={() => void decide(r, "apply")}
                >Apply</button>
                <button type="button" className={s.btn} disabled={busy !== null} onClick={() => void decide(r, "reject")}>Reject</button>
              </div>
              {state === "changed" && <div className={s.changeFlag}>Changed after it was shown. Reject it.</div>}
              {state === "new" && <div className={s.changeFlag}>New or changed. Apply in a moment.</div>}
              {r.cwd !== undefined && <div className={s.changeCwd}>runs in {visibleText(r.cwd)}</div>}
              {r.spec !== undefined && <pre className={s.changeSpec}>{visibleText(JSON.stringify(r.spec, null, 2))}</pre>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
