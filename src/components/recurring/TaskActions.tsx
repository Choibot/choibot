// src/components/recurring/TaskActions.tsx — what the user does to a recurring task from its
// page: Run now, Pause or Resume, Change (it opens the form), Delete. The page sends the task's name and one of 4 fixed
// words; the server refuses everybody but the paired user. Delete asks a second press.
"use client";
import { useEffect, useRef, useState } from "react";
import { taskAction, type CronJob, type TaskAction } from "../../lib/cron";
import s from "./Recurring.module.css";

const ARM_MS = 3000;     // the time for the second press of Delete
const STARTED_MS = 8000; // "Started" shows until the runner's own mark is read

export function TaskActions({ j, onChanged, onDeleted, onChange, phone = false }: {
  j: CronJob;
  // After a change: read the list again.
  onChanged: () => void | Promise<void>;
  onDeleted: () => void;
  // Open the form of the task ("Change").
  onChange?: () => void;
  phone?: boolean;
}) {
  const [busy, setBusy] = useState<TaskAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [started, setStarted] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (f: () => void, ms: number) => { timers.current.push(setTimeout(f, ms)); };

  const act = async (action: TaskAction) => {
    setBusy(action);
    setError(null);
    const r = await taskAction(j.name, action);
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    if (action === "delete") { onDeleted(); void onChanged(); return; }
    if (action === "run") { setStarted(true); later(() => setStarted(false), STARTED_MS); }
    await onChanged();
  };
  const onDelete = () => {
    if (armed) { setArmed(false); void act("delete"); return; }
    setArmed(true);
    later(() => setArmed(false), ARM_MS);
  };
  const running = j.running === true;
  return (
    <div className={s.actions} data-phone={phone ? "" : undefined} data-task-actions="">
      <div className={s.actionRow}>
        <button type="button" className={`${s.btn} ${phone ? s.btnMain : ""}`} disabled={busy !== null || !j.enabled || running || started}
          title={!j.enabled ? "This task is paused. Resume it first." : undefined} onClick={() => void act("run")}>
          {running ? "Runs now…" : busy === "run" ? "Starting…" : started ? "Started" : "Run now"}
        </button>
        {j.enabled
          ? <button type="button" className={s.btn} disabled={busy !== null} onClick={() => void act("pause")}>Pause</button>
          : <button type="button" className={s.btn} disabled={busy !== null} onClick={() => void act("resume")}>Resume</button>}
        {onChange && <button type="button" className={s.btn} disabled={busy !== null} onClick={onChange}>Change</button>}
        <button type="button" className={`${s.btn} ${armed ? s.btnArmed : s.btnQuiet}`} disabled={busy !== null} onClick={onDelete}
          title={armed ? "Press again to delete the task and its runs" : "Delete the task and its runs"}>
          {armed ? "Delete for good?" : "Delete"}
        </button>
      </div>
      {error !== null && <p className={s.actionError} role="alert">{error}</p>}
    </div>
  );
}
