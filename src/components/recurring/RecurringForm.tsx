// src/components/recurring/RecurringForm.tsx — the form of a recurring task: "New task" and
// "Change". Fields: Describe it (with "Fill in"), Name, Repo, What to do, When, Tell me.
// The form sends plain fields only: a name, a repo of the server's list by its name, the text,
// the "When" as the plain-words model, a time zone name. The server makes the task of them.
// "Fill in" asks the server's model one time, on the press, and puts its answer in the fields:
// nothing is saved until the user presses Save. The form works with no "Fill in".
"use client";
import { useEffect, useState, type ReactNode } from "react";
import { DRAFT_TEXT_MAX, WHAT_MAX, nameOfTitle, nameProblem } from "../../../server/cron/form";
import { readSchedule, scheduleWords, zoneWords } from "../../../server/cron/schedule";
import { draftTask, fetchTaskForm, saveTask, taskTitle, type CronJob, type FormField } from "../../lib/cron";
import { DAY_LETTERS, DAY_NAMES, HOUR_STEPS, NEW_WHEN, WHEN_KINDS, whenModel, whenOf, whenReady, type WhenState } from "../../lib/taskForm";
import { PhoneHeader } from "../PhoneHeader";
import { BackIcon } from "../SideIcons";
import s from "./Recurring.module.css";

function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.label}>{label}</span>
      {children}
      {error ? <span className={s.fieldError} role="alert">{error}</span> : hint ? <span className={s.hint}>{hint}</span> : null}
    </div>
  );
}

// "When": a kind, then what the kind needs. `custom`: the task has a schedule that the form
// cannot show (Change): the first choice keeps it.
export function WhenField({ value, onChange, zone, viewerZone, custom }: {
  value: WhenState; onChange: (w: WhenState) => void; zone: string | null; viewerZone: string | null; custom: boolean;
}) {
  const model = whenModel(value);
  const set = (part: Partial<WhenState>) => onChange({ ...value, ...part });
  const time = <input className={s.input} type="time" aria-label="Time" value={value.time} onChange={(e) => set({ time: e.target.value })} />;
  const said = value.kind === "keep" ? "The schedule of the task stays as it is."
    : model ? `${scheduleWords(model)}${zone ? `, ${zoneWords(zone)}` : ""}.`
    : value.kind === "week" && value.days.length === 0 ? "Choose one day or more." : "Choose a time.";
  return (
    <>
      <div className={s.seg} role="group" aria-label="How often">
        {custom && <button type="button" aria-pressed={value.kind === "keep"} onClick={() => set({ kind: "keep" })}>Keep as it is</button>}
        {WHEN_KINDS.map((k) => <button key={k.kind} type="button" aria-pressed={value.kind === k.kind} onClick={() => set({ kind: k.kind })}>{k.label}</button>)}
      </div>
      {value.kind !== "keep" && (
        <div className={s.whenRow}>
          {value.kind === "week" && (
            <span className={s.days} role="group" aria-label="Days">
              {DAY_LETTERS.map((l, d) => (
                <button key={d} type="button" aria-pressed={value.days.includes(d)} aria-label={DAY_NAMES[d]} title={DAY_NAMES[d]}
                  onClick={() => set({ days: value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d] })}>{l}</button>
              ))}
            </span>
          )}
          {value.kind === "month" && (
            <label className={s.inline}>on day
              <select className={s.input} value={value.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
          {value.kind === "hours" ? (
            <label className={s.inline}>every
              <select className={s.input} value={value.every} onChange={(e) => set({ every: Number(e.target.value) })}>
                {HOUR_STEPS.map((h) => <option key={h} value={h}>{h === 1 ? "hour" : `${h} hours`}</option>)}
              </select>
            </label>
          ) : <label className={s.inline}>at {time}</label>}
        </div>
      )}
      <span className={s.hint} data-when-words="" title={zone && zone !== viewerZone ? `Times are in the zone ${zone}` : undefined}>{said}</span>
    </>
  );
}

export function RecurringForm({ task, serverZone, viewerZone, onSaved, onCancel, phone = false, start }: {
  // The task to change; null: a new task.
  task: CronJob | null;
  serverZone: string | null; viewerZone: string | null;
  onSaved: (name: string) => void; onCancel: () => void; phone?: boolean;
  // Test seam: the repos and "Fill in" as the server gave them (no read).
  start?: { repos: string[]; fillIn: boolean };
}) {
  const read = task ? readSchedule(task.schedule) : null;
  // A new task has its times in the zone of this browser. A change keeps the zone of the task.
  const zone = task ? read?.zone ?? serverZone ?? viewerZone : viewerZone;
  const [meta, setMeta] = useState<{ repos: string[]; fillIn: boolean } | null>(start ?? null);
  const [describe, setDescribe] = useState("");
  const [title, setTitle] = useState(task ? taskTitle(task.name) : "");
  const [repo, setRepo] = useState<string | null>(task?.repo ?? null);
  const [what, setWhat] = useState(task?.prompt ?? "");
  const [when, setWhen] = useState<WhenState>(task ? whenOf(read?.schedule ?? null) : NEW_WHEN);
  const [tell, setTell] = useState<"needs" | "always">(task && task.notify === "always" ? "always" : "needs");
  const [busy, setBusy] = useState<"fill" | "save" | null>(null);
  const [fillNote, setFillNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<{ field?: FormField; text: string } | null>(null);
  useEffect(() => {
    if (start) return;
    let live = true;
    void fetchTaskForm().then((m) => { if (live && m) setMeta(m); });
    return () => { live = false; };
  }, [start]);

  const custom = task !== null && whenOf(read?.schedule ?? null).kind === "keep";
  const name = task ? task.name : nameOfTitle(title);
  const nameBad = task ? null : title.trim() === "" ? null : nameProblem(name);
  const ready = name !== "" && !nameBad && what.trim() !== "" && what.length <= WHAT_MAX && whenReady(when);
  // The repo of the task stays a choice when the server's list does not have it now.
  const repos = [...new Set([...(meta?.repos ?? []), ...(task?.repo ? [task.repo] : [])])].sort();

  const fill = async () => {
    setBusy("fill"); setFillNote(null);
    const r = await draftTask(describe.trim());
    setBusy(null);
    if (!r.ok) { setFillNote({ ok: false, text: r.error }); return; }
    const d = r.draft;
    if (d.title) setTitle(d.title);
    if (d.what) setWhat(d.what);
    if (d.when) { const w = whenOf(d.when); if (w.kind !== "keep") setWhen(w); }
    if (d.repo && repos.includes(d.repo)) setRepo(d.repo);
    if (d.tell) setTell(d.tell);
    setFillNote({ ok: true, text: d.when ? "Filled in. Read each field, then save." : "Filled in, but not the time. Choose when it runs, then save." });
  };
  const save = async () => {
    setBusy("save"); setError(null);
    const r = await saveTask({ name, repo, what: what.trim(), when: whenModel(when), zone: when.kind === "keep" ? null : zone, tell }, task ? task.name : null);
    setBusy(null);
    if (r.ok) onSaved(r.name); else setError({ field: r.field, text: r.error });
  };
  const err = (f: FormField) => (error?.field === f ? error.text : null);
  const heading = task ? `Change · ${taskTitle(task.name)}` : "New recurring task";

  const body = (
    <form className={s.form} data-task-form="" onSubmit={(e) => { e.preventDefault(); if (ready && busy === null) void save(); }}>
      {!task && meta?.fillIn && (
        <Field label="Describe it" hint={fillNote ? undefined : "One sentence is enough. “Fill in” writes the fields below for you. You can also fill them in by hand."}
          error={fillNote && !fillNote.ok ? fillNote.text : null}>
          <div className={s.describe}>
            <textarea className={s.input} rows={2} maxLength={DRAFT_TEXT_MAX} value={describe} placeholder="Each weekday at 8, read the new errors and tell me what is new."
              onChange={(e) => setDescribe(e.target.value)} />
            <button type="button" className={s.btn} disabled={busy !== null || describe.trim() === ""} onClick={() => void fill()}>{busy === "fill" ? "Filling in…" : "Fill in"}</button>
          </div>
          {fillNote?.ok && <span className={s.hint} role="status">{fillNote.text}</span>}
        </Field>
      )}
      {!task && (
        <Field label="Name" error={nameBad ?? err("name")}>
          <input className={s.input} type="text" maxLength={60} value={title} placeholder="Morning error digest" onChange={(e) => setTitle(e.target.value)} />
        </Field>
      )}
      <Field label="Repo" error={err("repo")} hint={repo === null ? "The task can read every repo of the work folder." : undefined}>
        <select className={s.input} value={repo ?? ""} onChange={(e) => setRepo(e.target.value === "" ? null : e.target.value)}>
          <option value="">The work folder (no one repo)</option>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>
      <Field label="What to do" error={err("what") ?? (what.length > WHAT_MAX ? "The text is too long." : null)} hint="The instructions for the agent, at each run. Say what to check and what to report.">
        <textarea className={s.input} rows={6} value={what} placeholder="Read the errors of the last 24 hours. Report only the errors that are new or that grow fast." onChange={(e) => setWhat(e.target.value)} />
      </Field>
      <Field label="When" error={err("when")}>
        <WhenField value={when} onChange={setWhen} zone={zone} viewerZone={viewerZone} custom={custom} />
      </Field>
      <Field label="Tell me" error={err("tell")} hint="On Telegram, when it is connected. The page shows every run.">
        <div className={s.seg} role="group" aria-label="Tell me">
          <button type="button" aria-pressed={tell === "needs"} onClick={() => setTell("needs")}>When it needs me</button>
          <button type="button" aria-pressed={tell === "always"} onClick={() => setTell("always")}>After every run</button>
        </div>
      </Field>
      {error && !error.field && <p className={s.formError} role="alert">{error.text}</p>}
      <div className={s.formFoot}>
        <button type="submit" className={`${s.btn} ${s.btnMain}`} disabled={!ready || busy !== null}>{busy === "save" ? "Saving…" : task ? "Save the change" : "Save the task"}</button>
        <button type="button" className={`${s.btn} ${s.btnQuiet}`} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
  if (phone) {
    return (
      <div className={s.phonePage}>
        <PhoneHeader onBack={onCancel} backLabel="Cancel" title={task ? "Change" : "New recurring task"} sub={task ? taskTitle(task.name) : undefined} />
        <div className={s.phoneScroll}>{body}</div>
      </div>
    );
  }
  return (
    <div className={s.page}>
      <div className={s.head} data-back="">
        <button type="button" className={s.back} onClick={onCancel} aria-label="Cancel" title="Cancel"><BackIcon size={16} /></button>
        <h1 className={s.title}>{heading}</h1>
      </div>
      <div className={s.scroll}><div className={s.formCol}>{body}</div></div>
    </div>
  );
}
