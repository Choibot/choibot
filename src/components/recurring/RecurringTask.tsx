// src/components/recurring/RecurringTask.tsx — one recurring task: its runs (a strip, oldest to
// newest, then one row per run that opens to its result) and what the task is (the "About"
// rail). Read only; it reads the runs again every 10 s.
// What a run says is text of the task's agent. The server checks it (server/cron/result.ts):
// the state is one of fixed values, the sentence is plain text, and a link is only a ticket of
// this console or a GitHub pull request address. This file shows all of it as plain text.
"use client";
import { useEffect, useState } from "react";
import { describeSchedule } from "../../../server/cron/schedule";
import {
  fetchCronRuns, fullWhen, nextWords, runState, runWhen, runsLine, stateWord, taskTitle, tellWords, tookWords,
  type CronJob, type CronRun, type RunLink,
} from "../../lib/cron";
import { AGENT_MAX, useRemembered, viewMemory } from "../../lib/viewCache";
import { ChevronIcon, ExternalIcon, InboxIcon } from "../SideIcons";
import s from "./Recurring.module.css";

// Each task's runs and open rows seen last (lib/viewCache): a task opened again shows them on
// the first frame, then reads the runs again.
const runsSeen = viewMemory<CronRun[] | null>(AGENT_MAX);
const openSeen = viewMemory<Set<number>>(AGENT_MAX);
const NONE = new Set<number>();

// The warm-up (lib/warmup): read a task's runs before its page opens.
export async function prefetchCronRuns(name: string): Promise<void> {
  if (runsSeen.has(name)) return;
  const runs = await fetchCronRuns(name);
  if (!runsSeen.has(name)) runsSeen.set(name, runs);
}

function Links({ links, onOpenTicket }: { links: RunLink[]; onOpenTicket?: (id: string) => void }) {
  if (links.length === 0) return null;
  return (
    <div className={s.links}>
      {links.map((l) => l.kind === "pr" ? (
        <a key={l.url} className={s.link} href={l.url} target="_blank" rel="noreferrer noopener">
          <ExternalIcon /><span>{l.label}</span>
        </a>
      ) : onOpenTicket ? (
        <button key={l.id} type="button" className={s.link} onClick={() => onOpenTicket(l.id)} title="Open the Queue">
          <InboxIcon /><span>Ticket · {l.title}</span><small>{l.open ? "waits for you" : "answered"}</small>
        </button>
      ) : (
        <span key={l.id} className={s.link}><InboxIcon /><span>Ticket · {l.title}</span><small>{l.open ? "waits for you" : "answered"}</small></span>
      ))}
    </div>
  );
}

// The runs of a task. `open`: the rows that show their result. `full`: the rows that also show
// the full text of the run (a run with no result line always shows it: it has nothing else).
export function RunList({ runs, open, full, onToggle, onFull, now, onOpenTicket }: {
  runs: CronRun[]; open: Set<number>; full: Set<number>; onToggle: (startedAt: number) => void; onFull: (startedAt: number) => void;
  now: number; onOpenTicket?: (id: string) => void;
}) {
  return (
    <>
      {/* The strip, oldest → newest: it reads as a time line. */}
      <div className={s.strip}>
        {[...runs].reverse().map((r) => {
          const label = `${stateWord(runState(r))}, ${runWhen(r.startedAt, now)}`;
          return (
            <button key={r.startedAt} type="button" className={s.cell} data-state={runState(r)} data-open={open.has(r.startedAt) ? "" : undefined}
              title={label} aria-label={label} aria-pressed={open.has(r.startedAt)} onClick={() => onToggle(r.startedAt)} />
          );
        })}
        <small className={s.stripLine}>{runsLine(runs)}</small>
      </div>
      <div className={s.runs}>
        {runs.map((r) => {
          const state = runState(r);
          const isOpen = open.has(r.startedAt);
          const said = state === "clear" || state === "needs";
          const showText = !said || full.has(r.startedAt);
          return (
            <div key={r.startedAt} className={s.run} data-run={r.startedAt} data-state={state}>
              <button type="button" className={s.runHead} onClick={() => onToggle(r.startedAt)} aria-expanded={isOpen}>
                <i className={s.dot} data-state={state} role="img" aria-label={stateWord(state)} title={stateWord(state)} />
                <span className={s.runWhen} title={fullWhen(r.startedAt)}>{runWhen(r.startedAt, now)}</span>
                <span className={s.runSaid}>{isOpen ? "" : state === "failed" ? `Did not finish.${r.sentence ? ` ${r.sentence}` : ""}` : r.sentence ?? stateWord(state)}</span>
                <span className={s.runTook}>{tookWords(r)}</span>
                <span className={s.caret} aria-hidden><ChevronIcon open={isOpen} /></span>
              </button>
              {isOpen && (
                <div className={s.card}>
                  <p className={s.cardSaid}><b>{stateWord(state)}</b>{r.sentence ? <span>{r.sentence}</span> : null}</p>
                  <Links links={r.links ?? []} onOpenTicket={onOpenTicket} />
                  {said && (
                    <button type="button" className={s.fullBtn} aria-expanded={showText} onClick={() => onFull(r.startedAt)}>
                      {showText ? "Hide the full text of the run" : "See the full text of the run"}
                    </button>
                  )}
                  {showText && <pre className={s.output}>{r.outputTail || "(the run wrote no text)"}</pre>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// What the task is. Every value is plain text; the repo is a name, never a path.
export function About({ j, zone, viewerZone, now }: { j: CronJob; zone: string | null; viewerZone: string | null; now: number }) {
  const when = describeSchedule(j.schedule, zone, viewerZone);
  const next = j.enabled ? nextWords(j.nextRun, now) : null;
  return (
    <dl className={s.about}>
      {j.prompt ? (<><dt>What it does</dt><dd className={s.aboutPrompt}>{j.prompt}</dd></>) : null}
      <dt>When</dt>
      <dd>
        <span title={when.custom ? j.schedule : undefined}>{when.words}</span>
        <small title={next && j.nextRun ? fullWhen(new Date(j.nextRun).getTime()) : undefined}>{!j.enabled ? "Paused" : next ? `Next run: ${next}` : "No next run yet"}</small>
      </dd>
      <dt>Repo</dt>
      <dd>{j.repo ?? "The work folder"}</dd>
      <dt>Tell me</dt>
      <dd>{tellWords(j.notify)}<small>On Telegram, when it is connected</small></dd>
      {j.createdAt ? (<><dt>Made</dt><dd title={fullWhen(j.createdAt)}>{new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(j.createdAt)}</dd></>) : null}
    </dl>
  );
}

export function RecurringTask({ name, j, zone, viewerZone, onOpenTicket }: {
  name: string;
  // The task in the list (undefined: the list is not read yet).
  j: CronJob | undefined; zone: string | null; viewerZone: string | null;
  // A ticket link of a run: open the Queue (absent: the console has no queue).
  onOpenTicket?: (id: string) => void;
}) {
  const [runs, setRuns] = useRemembered(runsSeen, name, null);
  const [error, setError] = useState(false);
  // The open rows are keyed by startedAt: a new read keeps them open.
  const [open, setOpen] = useRemembered(openSeen, name, NONE);
  const [full, setFull] = useState<Set<number>>(NONE);
  useEffect(() => {
    let live = true;
    setError(false);
    // The newest run starts open: it is what the user came to read (the first time only).
    let first = !openSeen.has(name);
    const load = () => {
      void fetchCronRuns(name)
        .then((r) => {
          if (!live) return;
          setError(false);
          setRuns(r);
          if (first && r.length > 0) { setOpen(new Set([r[0].startedAt])); first = false; }
        })
        .catch(() => { if (live) setError(true); });
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { live = false; clearInterval(t); };
  }, [name, setRuns, setOpen]);
  const flip = (set: Set<number>, at: number) => { const next = new Set(set); if (next.has(at)) next.delete(at); else next.add(at); return next; };
  const now = Date.now();
  return (
    <div className={s.split} aria-label={taskTitle(name)}>
      <div className={s.main}>
        {error && runs === null && <p className={s.note}>The runs did not load. The page tries again.</p>}
        {!error && runs === null && <p className={`${s.note} late`}>Loading…</p>}
        {runs?.length === 0 && <p className={s.note}>No run yet.</p>}
        {runs && runs.length > 0 && (
          <RunList runs={runs} open={open} full={full} now={now} onOpenTicket={onOpenTicket}
            onToggle={(at) => setOpen((prev) => flip(prev, at))} onFull={(at) => setFull((prev) => flip(prev, at))} />
        )}
      </div>
      {j && <aside className={s.rail} aria-label="About this task"><About j={j} zone={zone} viewerZone={viewerZone} now={now} /></aside>}
    </div>
  );
}
