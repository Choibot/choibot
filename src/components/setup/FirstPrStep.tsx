// src/components/setup/FirstPrStep.tsx — the open "Merge the first PR" row of the Set-up list:
// the pull request ticket of the first agent, the same ticket as in the Queue, with the Merge
// button of the Queue (QueueMerge: the paired user only, one confirm in place, a fresh read of
// GitHub at the press). The row is done when GitHub says "merged": the check of the step list
// decides, here too. A merge on github.com counts the same.
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { QueueItem } from "../../../server/chief/queue/types"; // type-only
import { getChiefState, hasUserToken } from "../../lib/chief";
import { githubUrl, prSlug } from "../../lib/queueDetail";
import { checksWord } from "../../lib/queueInbox";
import { fetchTicket, mergeHint, startFirst } from "../../lib/setupActions";
import { hasTicket, keepSame, ticketMemory } from "../../lib/setupMemory";
import { useRemembered } from "../../lib/viewCache";
import { MergeButton, MergeHooksContext, MergeLine, type MergeHooks } from "../QueueMerge";
import { Md } from "../QueueView";
import { ExternalIcon } from "../SideIcons";
import { cx as k } from "../settings/kit";
import { AgentState, useFirst } from "./FirstAgentStep";
import { Pending } from "./Fold";
import c from "./Setup.module.css";

type Nav = { onOpenQueue?: () => void };

function Ticket({ item, onMerged }: { item: QueueItem; onMerged: () => void }) {
  const pr = item.pr && "url" in item.pr ? item.pr : null;
  const href = pr ? githubUrl(pr.url) : null;
  const hint = mergeHint(item);
  const hooks = useMemo<MergeHooks>(() => ({ commit: () => {}, merged: onMerged }), [onMerged]);
  const cs = getChiefState();
  const readOnly = cs.pairRequired || !hasUserToken();
  // The same element while the text stays: a poll that draws the row again does not set the
  // markdown of the body again (React sets innerHTML on each new prop object).
  const body = useMemo(() => <Md text={item.body} />, [item.body]);
  return (
    <div className={c.card} data-part="ticket">
      <div className={c.cardHead}><span>Pull request · a ticket of your Queue</span>{pr && <span>{prSlug(pr.url) ?? item.repo} #{pr.number}</span>}</div>
      <p className={c.task}>{item.title}</p>
      {pr?.checks && <p className={c.quiet} data-tone={checksWord(pr.checks).tone}>{checksWord(pr.checks).text.replace(/^./, (x) => x.toUpperCase())}</p>}
      <div className={c.ticketBody}>{body}</div>
      {hint && <p className={c.error}>{hint}</p>}
      <MergeHooksContext.Provider value={hooks}>
        <div className={c.ticketFoot}>
          <MergeLine item={item} />
          {/* phone: the `m` key belongs to the Queue view, so its hint stays off here. */}
          <MergeButton item={item} readOnly={readOnly} userAuth={cs.userAuth} phone />
          {href && <a className={k.btn} href={href} target="_blank" rel="noopener noreferrer">Open on GitHub<ExternalIcon /></a>}
        </div>
      </MergeHooksContext.Provider>
      <p className={c.quiet}>Read what the agent did, then press Merge. Later, each decision your agents need from you comes to the Queue as a ticket like this one.</p>
    </div>
  );
}

export function FirstPrStep({ onDone, nav }: { onDone: () => Promise<void>; nav: Nav }) {
  const { view, err, set } = useFirst(hasTicket);
  const [busy, setBusy] = useState(false);
  const [startErr, setStartErr] = useState("");
  const done = useRef(onDone);
  done.current = onDone;
  const id = view?.ticket?.id ?? null;
  const state = view?.ticket?.state ?? null;
  // The ticket itself (the copy of this page load first), read again on each poll (new checks, a
  // merge). A read with the same data draws nothing again.
  const [item, setItem] = useRemembered<QueueItem | null>(ticketMemory, id, null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void fetchTicket(id).then((i) => { if (live) setItem((prev) => keepSame(prev, i)); }, () => {});
    return () => { live = false; };
  }, [id, state, view?.now, setItem]);
  useEffect(() => { if (state === "merged") void done.current(); }, [state]);

  const again = async () => {
    setBusy(true); setStartErr("");
    try { set(await startFirst({ again: true })); await done.current(); } catch (e) { setStartErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!view) return err ? <p className={c.error} role="alert">{err}</p> : <Pending className={c.today}>Reading the pull request…</Pending>;
  if (state === "merged") return <p className={c.today}>GitHub says the pull request is merged. The check runs now.</p>;
  if (state === "open" && item) return <Ticket item={item} onMerged={() => { void done.current(); }} />;
  if (state === "open") return <Pending className={c.today}>Reading the ticket…</Pending>;
  if (state === "closed") {
    return (
      <>
        <p className={c.error}>The pull request of the first agent was closed and not merged. Start the first task again: a new agent opens a new pull request.</p>
        {startErr && <p className={c.error} role="alert">{startErr}</p>}
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.primary}`} disabled={busy} onClick={() => void again()}>{busy ? "Starting…" : "Start the first task again"}</button>
        </div>
      </>
    );
  }
  // A new first agent (after a pull request that was closed): its state, until its ticket comes.
  if (view.agent && view.ticket === null) return <AgentState view={view} set={set} onChange={() => {}} />;
  // The pull request on record is of another agent (one the user started): its ticket is in the Queue.
  return (
    <>
      <p className={c.today}>The pull request of your agent is in the Queue as a ticket. Read the ticket, then press Merge.</p>
      {nav.onOpenQueue && <div className={c.acts}><button type="button" className={k.btn} onClick={nav.onOpenQueue}>Open the Queue</button></div>}
    </>
  );
}
