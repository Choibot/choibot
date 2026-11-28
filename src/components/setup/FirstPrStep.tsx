// src/components/setup/FirstPrStep.tsx — the "Merge the first PR" step: the card of the pull
// request, and the merge on it. The card shows where the PR is, its title, its checks in one
// line, ONE Merge, and "Open on GitHub" as a quiet second action. Merge is the Merge of the Queue
// (QueueMerge: the paired user only, one confirm in place, a fresh read of GitHub at the press,
// the route of the ticket and its gates), so the ticket closes as a merge in the Queue closes it.
// The step is done when GitHub says "merged": the check of the step list decides, here too (a
// merge on github.com counts the same). Nothing here goes to the Queue or to an agent's thread.
//
// The ticket: the first agent's while it waits or is merged; else the ticket of another agent
// that waits (one the user started); else the first agent's ticket that was closed.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueueItem } from "../../../server/chief/queue/types"; // type-only
import { getChiefState, hasUserToken } from "../../lib/chief";
import { githubUrl, prSlug } from "../../lib/queueDetail";
import { checksLine, fetchTicket, startFirst, type FirstView } from "../../lib/setupActions";
import { hasTicket, keepSame, ticketMemory } from "../../lib/setupMemory";
import { useRemembered } from "../../lib/viewCache";
import { MergeButton, MergeHooksContext, MergeLine, type MergeHooks } from "../QueueMerge";
import { Md } from "../QueueView";
import { CheckIcon, ExternalIcon } from "../SideIcons";
import { cx as k } from "../settings/kit";
import { AgentState, useFirst } from "./FirstAgentStep";
import { More, Pending } from "./Fold";
import c from "./Setup.module.css";

type Shown = { id: string; state: "open" | "merged" | "closed" } | null;

/** The ticket the card shows, from the view of the first agent. */
export function shownTicket(v: FirstView | null): Shown {
  const mine = v?.ticket ?? null;
  if (mine && mine.state !== "closed") return mine;
  return v?.other ? { id: v.other.id, state: "open" } : mine;
}

const closedMerged = (i: QueueItem): boolean => i.status === "withdrawn" && i.lastError === "merged";

// The card of the pull request. `merged`: GitHub says merged (the card stays until the stage
// moves on). `stage`: on the stage, the agent's own words are in a closed More.
export function MergeCard({ item, merged = false, stage = false, onMerged }: {
  item: QueueItem; merged?: boolean; stage?: boolean; onMerged: (i: QueueItem) => void;
}) {
  const pr = item.pr && "url" in item.pr ? item.pr : null;
  const href = pr ? githubUrl(pr.url) : null;
  const line = merged ? null : checksLine(item);
  const hooks = useMemo<MergeHooks>(() => ({ commit: () => {}, merged: onMerged }), [onMerged]);
  const cs = getChiefState();
  const readOnly = cs.pairRequired || !hasUserToken();
  // The same element while the text stays: a poll that draws the card again does not set the
  // markdown of the body again (React sets innerHTML on each new prop object).
  const body = useMemo(() => <div className={c.ticketBody}><Md text={item.body} /></div>, [item.body]);
  return (
    <div className={c.card} data-part="ticket" data-merged={merged ? "" : undefined}>
      <div className={c.cardHead}><span>Pull request</span>{pr && <span>{prSlug(pr.url) ?? item.repo} #{pr.number}</span>}</div>
      <p className={c.task}>{item.title}</p>
      {line && <p className={c.quiet} data-tone={line.tone} data-part="checks">{line.text}</p>}
      <MergeHooksContext.Provider value={hooks}>
        <div className={c.ticketFoot}>
          {merged ? <span className={c.nextDone} role="status"><CheckIcon size={12} />Merged</span> : (
            <>
              <MergeLine item={item} />
              {/* phone: the `m` key belongs to the Queue view, so its hint stays off here. */}
              <MergeButton item={item} readOnly={readOnly} userAuth={cs.userAuth} phone methods={false} />
            </>
          )}
          {href && <a className={`${k.btn} ${k.quiet}`} href={href} target="_blank" rel="noopener noreferrer">Open on GitHub<ExternalIcon /></a>}
        </div>
      </MergeHooksContext.Provider>
      {stage ? <More label="what the agent did">{body}</More> : body}
    </div>
  );
}

export function FirstPrStep({ onDone, stage = false }: { onDone: () => Promise<void>; stage?: boolean }) {
  const { view, err, set } = useFirst(hasTicket);
  const [busy, setBusy] = useState(false);
  const [startErr, setStartErr] = useState("");
  // The ticket this card merged: it stays merged on the card until the stage moves on, also when
  // the next view has no word of it (another agent's ticket is not "other" once it is closed).
  const [done, setDone] = useState<QueueItem | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const shown = shownTicket(view);
  const id = shown?.id ?? null;
  const state = shown?.state ?? null;
  // The ticket itself (the copy of this page load first), read again on each poll (new checks, a
  // merge). A read with the same data draws nothing again.
  const [item, setItem] = useRemembered<QueueItem | null>(ticketMemory, id, null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void fetchTicket(id).then((i) => { if (live) setItem((prev) => keepSame(prev, i)); }, () => {});
    return () => { live = false; };
  }, [id, state, view?.now, setItem]);
  useEffect(() => { if (state === "merged") void doneRef.current(); }, [state]);
  const onMerged = useCallback((i: QueueItem) => {
    if (closedMerged(i)) setDone(i);
    void doneRef.current();
  }, []);

  const again = async () => {
    setBusy(true); setStartErr("");
    try { set(await startFirst({ again: true })); await doneRef.current(); } catch (e) { setStartErr((e as Error).message); } finally { setBusy(false); }
  };

  if (done) return <MergeCard item={done} merged stage={stage} onMerged={onMerged} />;
  if (!view) return err ? <p className={c.error} role="alert">{err}</p> : <Pending className={c.today}>Reading the pull request…</Pending>;
  if (state === "merged" && item) return <MergeCard item={item} merged stage={stage} onMerged={onMerged} />;
  if (state === "merged") return <p className={c.today}>GitHub says the pull request is merged. The check runs now.</p>;
  if (state === "open" && item) return <MergeCard item={item} stage={stage} onMerged={onMerged} />;
  if (state === "open") return <Pending className={c.today}>Reading the pull request…</Pending>;
  // A new first agent (after a pull request that was closed): its state, until its ticket comes.
  if (view.agent && view.ticket === null) return <AgentState view={view} set={set} onChange={() => {}} />;
  // The pull request was closed and not merged, and no other one waits: a new agent opens a new one.
  return (
    <>
      <p className={c.error}>{state === "closed"
        ? "The pull request of the first agent was closed and not merged. Start the first task again: a new agent opens a new pull request."
        : "No pull request waits for a merge. Start the first task again: a new agent opens a new pull request."}</p>
      {startErr && <p className={c.error} role="alert">{startErr}</p>}
      <div className={c.acts}>
        <button type="button" className={`${k.btn} ${k.primary}`} disabled={busy} onClick={() => void again()}>{busy ? "Starting…" : "Start the first task again"}</button>
      </div>
    </>
  );
}
