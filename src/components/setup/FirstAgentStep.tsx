// src/components/setup/FirstAgentStep.tsx — the open "Start the first agent" row of the Set-up
// list: the fixed first task, one button that starts the agent, and then the state of that
// agent in plain words, with a way to its thread. The row stays open until a pull request is on
// record (the check of the step list decides), so an agent that stops with no pull request is
// seen here, with what to press. The agent lives on the server: this page can close.
"use client";
import { useEffect, useRef, useState } from "react";
import { fetchFirst, firstSay, startFirst, type FirstView } from "../../lib/setupActions";
import { cx as k, Dot } from "../settings/kit";
import c from "./Setup.module.css";

export const FIRST_POLL_MS = 4000;

// The first agent and its ticket, read when the row opens and then every few seconds.
export function useFirst(): { view: FirstView | null; err: string; set: (v: FirstView) => void } {
  const [view, setView] = useState<FirstView | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => fetchFirst().then((v) => { if (live) { setView(v); setErr(""); } }, (e: Error) => { if (live) setErr(e.message); });
    void read();
    const tick = setInterval(() => { if (document.visibilityState === "visible") void read(); }, FIRST_POLL_MS);
    return () => { live = false; clearInterval(tick); };
  }, []);
  return { view, err, set: setView };
}

// The state of the first agent in one card, and the buttons for what the user can do now:
// start it, start a new one, open its thread. `repo`: the repo of the "Change" control for
// the first start (a name of the list in the view; the server checks it against its own list).
export function AgentState({ view, set, onChange, onOpenAgent, repo }: {
  view: FirstView; set: (v: FirstView) => void; onChange: () => void; onOpenAgent?: (id: string) => void; repo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const start = async (again: boolean) => {
    setBusy(true); setErr("");
    try { set(await startFirst(again ? { again: true } : { repo })); onChange(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const say = firstSay(repo && !view.agent ? { ...view, repo } : view);
  const agent = view.agent;
  return (
    <>
      {agent ? (
        <div className={c.card} data-part="agent" role="status">
          <div className={c.agentLine}>
            <Dot tone={say.tone} />
            <span className={c.agentName}>{agent.name}</span>
            <span className={c.agentSay}>{say.line}</span>
          </div>
          {say.hint && <p className={c.quiet}>{say.hint}</p>}
        </div>
      ) : (
        <p className={say.tone === "warn" ? c.error : c.today}>{say.line}</p>
      )}
      {err && <p className={c.error} role="alert">{err}</p>}
      {say.acts.length > 0 && (
        <div className={c.acts}>
          {say.acts.map((act) => act === "thread"
            ? (agent && onOpenAgent && <button key={act} type="button" className={k.btn} onClick={() => onOpenAgent(agent.id)}>Open its thread</button>)
            : (
              <button key={act} type="button" className={`${k.btn} ${say.acts[0] === act ? k.primary : ""}`} disabled={busy} onClick={() => void start(act === "again")}>
                {busy ? "Starting…" : act === "start" ? "Start the first agent" : "Try again"}
              </button>
            ))}
          {!agent && say.hint && <span className={c.quiet}>{say.hint}</span>}
        </div>
      )}
    </>
  );
}

export function FirstAgentStep({ onDone, onOpenAgent }: { onDone: () => Promise<void>; onOpenAgent?: (id: string) => void }) {
  const { view, err, set } = useFirst();
  const [picked, setPicked] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  // The list is read again when the agent or its ticket changes (it started, it stopped, the
  // pull request is there): the line of the step then says the same as this row.
  const mark = view ? `${view.agent?.id ?? ""} ${view.agent?.state ?? ""} ${view.ticket?.id ?? ""}` : null;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (mark === null) return;
    if (last.current !== null && last.current !== mark) void done.current();
    last.current = mark;
  }, [mark]);

  if (!view) return err ? <p className={c.error} role="alert">{err}</p> : <p className={c.today}>Reading the state of the agent…</p>;
  // The repo of the first start: the user's change while the list holds it, else the server's.
  const repo = !view.agent && picked && view.repos.includes(picked) ? picked : view.repo;
  const canChange = !view.agent && view.repos.length > 1;
  return (
    <>
      <div className={c.card} data-part="task">
        <div className={c.cardHead}>
          <span>The first task</span>
          {repo && (
            <span className={c.repoPick}>
              {canChange && changing ? (
                <select className={k.input} aria-label="Repo of the first task" value={repo} autoFocus
                  onChange={(e) => { setPicked(e.target.value); setChanging(false); }} onBlur={() => setChanging(false)}>
                  {view.repos.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              ) : <span>{repo}</span>}
              {canChange && !changing && <button type="button" className={`${k.btn} ${k.link}`} onClick={() => setChanging(true)}>Change</button>}
            </span>
          )}
        </div>
        <p className={c.task}>{view.task}</p>
        <p className={c.quiet}>The agent reads the repo and changes only the README. No app code changes. It ends with a pull request for you to read and merge.</p>
      </div>
      <AgentState view={view} set={set} onChange={() => {}} onOpenAgent={onOpenAgent} repo={view.agent ? undefined : repo ?? undefined} />
    </>
  );
}
