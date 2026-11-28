// src/components/setup/FirstAgentStep.tsx — the open "Start the first agent" row of the Set-up
// list: the fixed first task, one button that starts the agent, and then the state of that
// agent in plain words. The row stays open until a pull request is on
// record (the check of the step list decides), so an agent that stops with no pull request is
// seen here, with what to press. The agent lives on the server: this page can close.
//
// On the stage (Stage.tsx), the part shows the signs of life while the agent works: what it does
// now (the open step of its thread), a band of time with the usual zone, and the marks "Started",
// "Pull request", "Ticket in the Queue". The first task goes into a closed "More".
"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchFirst, firstSay, startFirst, type FirstView } from "../../lib/setupActions";
import { AFTER_KEYS_MS, usePrompt } from "../../lib/usePrompt";
import { firstStart, rememberFirst, warmTicket } from "../../lib/setupMemory";
import { bandAt, milestones, nowLine, threadNow } from "../../lib/stage";
import { fetchThread } from "../../lib/thread";
import { cx as k, Dot } from "../settings/kit";
import { PromptCard } from "../PromptCard";
import { CheckIcon } from "../SideIcons";
import { Fold, MoreToggle, Pending } from "./Fold";
import c from "./Setup.module.css";

export const FIRST_POLL_MS = 4000;

// The first agent and its ticket, read when the row opens and then every few seconds. The row
// starts from the last view of this page load (lib/setupMemory) when `accept` takes it.
// `thread`: in the same poll, while the agent works, read the open step of its thread (`now`).
export function useFirst(accept?: (v: FirstView) => boolean, o: { thread?: boolean } = {}): {
  view: FirstView | null; err: string; set: (v: FirstView) => void; now: string | null;
} {
  const [view, setView] = useState<FirstView | null>(() => firstStart(accept));
  const [err, setErr] = useState("");
  const [now, setNow] = useState<string | null>(null);
  const set = useCallback((v: FirstView) => { rememberFirst(v); setView(v); }, []);
  const thread = o.thread === true;
  useEffect(() => {
    let live = true;
    const readNow = (v: FirstView) => {
      const a = v.agent;
      if (!thread || !a || a.state !== "working" || v.ticket) { setNow(null); return; }
      void fetchThread(a.id).then((r) => { if (live) setNow(threadNow(r)); }, () => { if (live) setNow(null); });
    };
    const read = () => fetchFirst().then((v) => { if (live) { set(v); setErr(""); readNow(v); } }, (e: Error) => { if (live) setErr(e.message); });
    void read();
    const tick = setInterval(() => { if (document.visibilityState === "visible") void read(); }, FIRST_POLL_MS);
    return () => { live = false; clearInterval(tick); };
  }, [set, thread]);
  return { view, err, set, now };
}

// The band of time: an axis of 8 minutes, the usual zone (3 to 6 minutes), and a mark at the time
// that passed. The mark is at the left of a track as wide as the band; the track moves.
function Band({ at }: { at: number }) {
  return (
    <div className={c.band} role="img" aria-label="Time since the start, on 8 minutes. A first task usually takes 3 to 6 minutes.">
      <i className={c.bandZone} />
      <span className={c.bandTrack} style={{ transform: `translateX(${(at * 100).toFixed(2)}%)` }}><b /></span>
    </div>
  );
}

function Marks({ view }: { view: FirstView }) {
  return (
    <ul className={c.marks} aria-label="Marks of the first agent">
      {milestones(view).map((m) => (
        <li key={m.label} data-done={m.done ? "" : undefined}>
          <span className={c.marksDot} aria-hidden>{m.done ? <CheckIcon size={11} /> : null}</span>{m.label}
        </li>
      ))}
    </ul>
  );
}

// The state of the first agent in one card, and the buttons for what the user can do now:
// start it, start a new one, or open its terminal (onOpenTerminal: the one way off the set-up
// page, for a first agent with no session and no known dialog; never its thread). A known dialog
// of Claude (the view's `dialog`) shows here as the agent pane's own card (PromptCard, usePrompt):
// the same read and the same keys route (POST /api/agents/:id/keys), no other way to type.
// `repo`: the repo of the "Change" control for the first start (a name of the list in the view;
// the server checks it against its own list).
// `stage`: the signs of life (`now`: the open step of its thread), and `more` in a closed fold
// whose switch is at the right of the buttons.
export function AgentState({ view, set, onChange, onOpenTerminal, repo, stage, more }: {
  view: FirstView; set: (v: FirstView) => void; onChange: () => void; onOpenTerminal?: (id: string) => void; repo?: string;
  stage?: { now: string | null }; more?: { label: string; body: ReactNode };
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const start = async (again: boolean) => {
    setBusy(true); setErr("");
    try { set(await startFirst(again ? { again: true } : { repo })); onChange(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const say = firstSay(repo && !view.agent ? { ...view, repo } : view);
  const agent = view.agent;
  const dialog = agent?.dialog ?? null;
  const ask = usePrompt(agent?.id ?? "", dialog !== null);
  // This page has no event stream: each new view that still names a dialog reads the card again.
  const askRefresh = ask.refresh;
  useEffect(() => { if (dialog) askRefresh(); }, [dialog, view.now, askRefresh]);
  const card = dialog && ask.prompt && ask.prompt.kind !== "unknown" ? ask.prompt : null;
  const answer = (keys: Parameters<typeof ask.press>[0], rev?: string) => void ask.press(keys, rev).then((o) => {
    // The answer is on the screen soon after: the view says so (the line, the scene).
    if (o.kind === "sent") setTimeout(() => void fetchFirst().then(set, () => {}), AFTER_KEYS_MS);
  });
  const now = stage ? nowLine(stage.now) : null;
  const band = stage ? bandAt(view) : null;
  // The marks while all goes well; a stop or an error shows the words of firstSay only.
  const marks = stage && agent && say.tone !== "warn";
  return (
    <>
      {agent ? (
        <div className={c.card} data-part="agent" role="status">
          <div className={c.agentLine}>
            <Dot tone={say.tone} />
            <span className={c.agentName}>{agent.name}</span>
            <span className={c.agentSay}>{say.line}</span>
          </div>
          {now && <p className={c.now}>{now}</p>}
          {band !== null && <Band at={band} />}
          {say.hint && <p className={c.quiet}>{say.hint}</p>}
          {marks && <Marks view={view} />}
        </div>
      ) : (
        <p className={say.tone === "warn" ? c.error : c.today}>{say.line}</p>
      )}
      {agent && card && <PromptCard prompt={card} who={agent.name} busy={ask.busy} note={ask.note} onPress={answer} />}
      {err && <p className={c.error} role="alert">{err}</p>}
      {(say.acts.length > 0 || more) && (
        <div className={c.acts}>
          {say.acts.map((act) => act === "terminal"
            ? (agent && onOpenTerminal && (
              <button key={act} type="button" className={`${k.btn} ${k.primary}`} onClick={() => onOpenTerminal(agent.id)}>Open its terminal</button>
            ))
            : (
              <button key={act} type="button" className={`${k.btn} ${say.acts[0] === act ? k.primary : ""}`} disabled={busy} onClick={() => void start(act === "again")}>
                {busy ? "Starting…" : act === "start" ? "Start the first agent" : "Try again"}
              </button>
            ))}
          {!agent && say.hint && <span className={c.quiet}>{say.hint}</span>}
          {more && <MoreToggle label={more.label} open={moreOpen} onToggle={() => setMoreOpen(!moreOpen)} />}
        </div>
      )}
      {more && <Fold open={moreOpen} frame={c.moreFrame} className={c.moreBody}>{more.body}</Fold>}
    </>
  );
}

export function FirstAgentStep({ onDone, stage = false, onOpenTerminal }: { onDone: () => Promise<void>; stage?: boolean; onOpenTerminal?: (id: string) => void }) {
  const { view, err, set, now } = useFirst(undefined, { thread: stage });
  const [picked, setPicked] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  // The list is read again when the agent or its ticket changes (it started, it stopped, the
  // pull request is there): the line of the step then says the same as this row.
  const mark = view ? `${view.agent?.id ?? ""} ${view.agent?.state ?? ""} ${view.ticket?.id ?? ""}` : null;
  // The pull request is there: its ticket is read now, so the next step opens with it.
  const ticket = view?.ticket?.state === "open" ? view.ticket.id : null;
  useEffect(() => { if (ticket) void warmTicket(ticket); }, [ticket]);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (mark === null) return;
    if (last.current !== null && last.current !== mark) void done.current();
    last.current = mark;
  }, [mark]);

  if (!view) return err ? <p className={c.error} role="alert">{err}</p> : <Pending className={c.today}>Reading the state of the agent…</Pending>;
  // The repo of the first start: the user's change while the list holds it, else the server's.
  const repo = !view.agent && picked && view.repos.includes(picked) ? picked : view.repo;
  const canChange = !view.agent && view.repos.length > 1;
  const task = (
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
  );
  // On the stage, once the agent is there: its state is the live part, the task is in "More".
  if (stage && view.agent) return <AgentState view={view} set={set} onChange={() => {}} onOpenTerminal={onOpenTerminal} stage={{ now }} more={{ label: "the task", body: task }} />;
  return (
    <>
      {task}
      <AgentState view={view} set={set} onChange={() => {}} onOpenTerminal={onOpenTerminal} repo={view.agent ? undefined : repo ?? undefined} />
    </>
  );
}
