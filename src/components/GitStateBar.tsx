// src/components/GitStateBar.tsx
"use client";
import { useEffect } from "react";
import { agentGitState, type GitState } from "../lib/agents";
import { agentMemory, useRemembered } from "../lib/viewCache";
import s from "./GitStateBar.module.css";

export const BranchIcon = () => (
  <svg className={s.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="5" cy="3.5" r="1.5" /><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="5.5" r="1.5" />
    <path d="M5 5v6M11 7c0 2.5-3 2.5-6 4" />
  </svg>
);

// The inspector's branch line: where the worktree's git actually IS — the live
// HEAD → the base, ahead/behind — plus a warning line when HEAD drifted off the
// agent's own branch and one when work is parked in a stash. This is what
// makes a phantom diff (HEAD on an unrelated branch) or an empty diff (work
// stashed) legible instead of mysterious. A click on the line copies the
// branch (`onCopy`); `branch` shows until the first git read lands.
// The last git state seen per agent: an agent opened again shows it on the first frame, and an
// agent switch never shows the prior agent's state (useRemembered keys it by agent).
const gitStates = agentMemory<GitState | null>();

export function GitStateBar({ agentId, status, branch, title, onCopy }: {
  agentId: string; status: string; branch?: string; title?: string; onCopy?: () => void;
}) {
  const [git, setGit] = useRemembered(gitStates, agentId, null);
  // Match the changes rail: poll slower once the agent has settled.
  const interval = status === "done" || status === "error" ? 5000 : 2000;

  useEffect(() => {
    let live = true;
    const load = () => {
      void agentGitState(agentId)
        .then((g) => { if (live) setGit(g); })
        .catch(() => { /* transient — keep last good state */ });
    };
    load();
    const t = setInterval(load, interval);
    return () => { live = false; clearInterval(t); };
  }, [agentId, interval, setGit]);

  if (!git || git.error) {
    return (
      <>
        {branch && <BranchLine head={branch} title={title} onCopy={onCopy} />}
        {git?.error && <div className={s.muted}>Git state unavailable</div>}
      </>
    );
  }

  const drifted = !git.onTracked;
  const position = git.detached ? `detached @ ${git.sha}` : git.head;
  const dirty = git.staged + git.unstaged + git.untracked;
  const abTitle = `${git.ahead} ahead / ${git.behind} behind base ${git.baseBranch}` +
    (dirty > 0 ? ` · ${git.staged} staged · ${git.unstaged} unstaged · ${git.untracked} untracked` : "");

  return (
    <>
      <BranchLine
        head={position} base={git.baseBranch} title={title ?? `Worktree HEAD is at ${position} (${git.sha})`} onCopy={onCopy}
        ab={<span className={s.ab} title={abTitle}>↑{git.ahead} ↓{git.behind}</span>}
      />
      {drifted && (
        <div
          className={s.warn}
          title={`The console created ${git.trackedBranch} for this agent, but the worktree is currently on ${position}. The diff you see reflects ${position}, not ${git.trackedBranch}.`}
        >
          Off the agent branch <code>{git.trackedBranch}</code>: the diff shows HEAD.
        </div>
      )}
      {git.stashes.length > 0 && (
        <div className={s.warn} title={`Stashed (repo-wide):\n${git.stashes.map((x) => `${x.ref}  ${x.message}`).join("\n")}`}>
          {git.stashes.length} stash{git.stashes.length > 1 ? "es" : ""} parked in the repo
        </div>
      )}
    </>
  );
}

function BranchLine({ head, base, ab, title, onCopy }: {
  head: string; base?: string; ab?: React.ReactNode; title?: string; onCopy?: () => void;
}) {
  const names = (
    <>
      <BranchIcon />
      <span className={s.ref}>{head}</span>
      {base && <><span className={s.arrow} aria-hidden>→</span><span className={`${s.ref} ${s.base}`}>{base}</span></>}
    </>
  );
  return (
    <div className={s.line}>
      {onCopy
        ? <button type="button" className={s.names} title={title} onClick={onCopy}>{names}</button>
        : <span className={s.names} title={title}>{names}</span>}
      {ab}
    </div>
  );
}
