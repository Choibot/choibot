// src/components/recurring/RecurringPage.tsx — the Recurring section: the tasks that run by
// themselves on a schedule. One list (what needs you first, the paused tasks last); a row opens
// the task (RecurringTask.tsx: its runs and what it is; TaskActions.tsx: Run now, Pause,
// Resume, Delete). On a protected install the changes that wait for the user are the
// first thing of the list. "New task" and "Change" open the form (RecurringForm.tsx).
// Desktop: a 52 px head and one column. Phone: one screen with the back arrow.
"use client";
import { describeSchedule } from "../../../server/cron/schedule";
import {
  fullWhen, lastWords, nextWords, recurringHeadline, sortTasks, stateWord, taskSentence, taskState, taskTitle, type CronJob,
} from "../../lib/cron";
import type { Recurring } from "../../lib/useRecurring";
import { useScrollMemory } from "../../lib/viewCache";
import { PhoneHeader } from "../PhoneHeader";
import { BackIcon } from "../SideIcons";
import { Changes, type CronSpoolState } from "./Changes";
import { RecurringTask, prefetchCronRuns } from "./RecurringTask";
import { TaskActions } from "./TaskActions";
import { RecurringForm } from "./RecurringForm";
import { PlusIcon } from "../SideIcons";
import { PhoneIconButton } from "../PhoneHeader";
import { useState } from "react";
import s from "./Recurring.module.css";

// The browser's zone: a time of the page is in it, and a tooltip names it.
function viewerZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

// "When" of a task. The tooltip of a schedule that the page cannot say in words is its timer line.
function whenOf(j: CronJob, serverZone: string | null): { words: string; title: string | undefined } {
  const d = describeSchedule(j.schedule, serverZone, viewerZone());
  return { words: d.words, title: d.custom ? j.schedule : d.zone ? `Times are in the zone ${d.zone}` : undefined };
}

function StateDot({ j }: { j: CronJob }) {
  const state = taskState(j);
  return <i className={s.dot} data-state={state} role="img" aria-label={stateWord(state)} title={stateWord(state)} />;
}

function TaskRow({ j, zone, now, onOpen }: { j: CronJob; zone: string | null; now: number; onOpen: () => void }) {
  const when = whenOf(j, zone);
  const next = j.enabled ? nextWords(j.nextRun, now) : null;
  return (
    <button type="button" className={s.row} data-task={j.name} data-state={taskState(j)} onClick={onOpen}
      onPointerDown={() => void prefetchCronRuns(j.name).catch(() => {})}>
      <span className={s.task}>
        <StateDot j={j} />
        <span className={s.taskText}><b>{taskTitle(j.name)}</b><span>{taskSentence(j)}</span></span>
      </span>
      <span className={s.when} title={when.title}>{when.words}</span>
      <span className={s.last} title={j.lastRun ? fullWhen(j.lastRun.finishedAt) : undefined}>{j.running ? "Runs now" : j.lastRun ? lastWords(j.lastRun.finishedAt, now) : "—"}</span>
      <span className={s.next} title={next && j.nextRun ? fullWhen(new Date(j.nextRun).getTime()) : undefined}>{next ?? "—"}</span>
    </button>
  );
}

export function RecurringPage({ data, spool, task, onTask, onBack, onOpenTicket }: {
  data: Recurring; spool: CronSpoolState;
  // The open task (its name), or null: the list.
  task: string | null; onTask: (name: string | null) => void;
  // Phone: the back arrow to the home list.
  onBack?: () => void;
  // A ticket link of a run: open the Queue (absent: the console has no queue).
  onOpenTicket?: (id: string) => void;
}) {
  const scroll = useScrollMemory<HTMLDivElement>("recurring");
  // The open form: a new task, or the change of the open task.
  const [form, setForm] = useState<"new" | "change" | null>(null);
  const now = Date.now();
  const { jobs, timeZone } = data;
  const phone = !!onBack;

  if (form === "new" || (form === "change" && task !== null && jobs?.some((x) => x.name === task))) {
    const changed = form === "change" ? jobs!.find((x) => x.name === task)! : null;
    return (
      <RecurringForm key={changed?.name ?? ""} task={changed} serverZone={timeZone} viewerZone={viewerZone()} phone={phone}
        onCancel={() => setForm(null)} onSaved={(name) => { setForm(null); void data.refresh(); onTask(name); }} />
    );
  }

  if (task !== null) {
    const j = jobs?.find((x) => x.name === task);
    const when = j ? whenOf(j, timeZone) : null;
    const next = j?.enabled ? nextWords(j.nextRun, now) : null;
    const nextLine = !j ? "" : !j.enabled ? "Paused" : next ? `Next run: ${next}` : "";
    const body = jobs !== null && !j
      ? <p className={s.lone} role="status">This task is not in the list now.</p>
      : <RecurringTask key={task} name={task} j={j} zone={timeZone} viewerZone={viewerZone()} onOpenTicket={onOpenTicket} />;
    const actions = (onPhone: boolean) => j && <TaskActions key={task} j={j} phone={onPhone} onChanged={data.refresh} onDeleted={() => onTask(null)} onChange={() => setForm("change")} />;
    if (phone) {
      return (
        <div className={s.phonePage} data-task-page={task}>
          <PhoneHeader onBack={() => onTask(null)} backLabel="Back to the tasks" title={taskTitle(task)} sub={[when?.words, nextLine].filter(Boolean).join(" · ")} />
          {body}
          {actions(true)}
        </div>
      );
    }
    return (
      <div className={s.page} data-task-page={task}>
        <div className={s.head} data-back="">
          <button type="button" className={s.back} onClick={() => onTask(null)} aria-label="Back to the tasks" title="Back to the tasks"><BackIcon size={16} /></button>
          <h1 className={s.title}>{taskTitle(task)}</h1>
          {when && <span className={s.headLine} title={when.title}>{when.words}</span>}
          <span className={s.headRight} title={next && j?.nextRun ? fullWhen(new Date(j.nextRun).getTime()) : undefined}>{j?.running ? "Runs now" : nextLine}</span>
          {actions(false)}
        </div>
        {body}
      </div>
    );
  }

  const list = jobs === null ? <p className={`${s.lone} late`}>Loading…</p>
    : jobs.length === 0 ? <p className={s.lone}>No recurring tasks yet. Press “New task” to make the first one.</p>
    : (
      <div className={s.list}>
        <div className={s.cols} aria-hidden><span>Task</span><span>When</span><span>Last run</span><span>Next run</span></div>
        {sortTasks(jobs).map((j) => <TaskRow key={j.name} j={j} zone={timeZone} now={now} onOpen={() => onTask(j.name)} />)}
      </div>
    );
  const headline = recurringHeadline(jobs);
  if (phone) {
    return (
      <div className={s.phonePage}>
        <PhoneHeader onBack={onBack} title="Recurring" sub={headline} right={<PhoneIconButton onClick={() => setForm("new")} label="New task"><PlusIcon size={20} /></PhoneIconButton>} />
        <div className={s.phoneScroll} ref={scroll.ref} onScroll={scroll.onScroll}><Changes spool={spool} />{list}</div>
      </div>
    );
  }
  return (
    <div className={s.page}>
      <div className={s.head}>
        <h1 className={s.title}>Recurring</h1>
        <span className={s.headLine}>{headline}</span>
        <button type="button" className={`${s.btn} ${s.btnMain} ${s.newBtn}`} onClick={() => setForm("new")}><PlusIcon size={14} />New task</button>
      </div>
      <div className={s.scroll} ref={scroll.ref} onScroll={scroll.onScroll}><div className={s.inner}><Changes spool={spool} />{list}</div></div>
    </div>
  );
}
