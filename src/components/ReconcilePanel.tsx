// src/components/ReconcilePanel.tsx
"use client";
import { useEffect, useState } from "react";
import { agentMemory, useRemembered } from "../lib/viewCache";
import { DIFF_TOO_LARGE, agentDiff, mergeAgent, discardAgent } from "../lib/agents";
import { isRefusalText } from "../lib/chief";

import { suggestPr, openPr } from "../lib/gh";
import { DiffViewer } from "./DiffViewer";
import { CiBadge } from "./CiBadge";
import { ExternalIcon } from "./SideIcons";
import s from "./ReconcilePanel.module.css";

// The last diff seen per agent (lib/viewCache): Review opens with it, then reads the diff again.
// Merge, Discard and the PR go to the server, which works on the worktree as it is.
const diffs = agentMemory<string>(8);

export function ReconcilePanel({ agentId, onDone, onOpenEditor, focusFile, workspace }: { agentId: string; onDone: () => void; onOpenEditor?: () => void; focusFile?: string; workspace?: boolean }) {
  const [diff, setDiff] = useRemembered(diffs, agentId, "");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prNumber, setPrNumber] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void agentDiff(agentId).then(setDiff).catch((e: unknown) => {
      setDiff("(no diff)");
      if (e instanceof Error && e.message === DIFF_TOO_LARGE) { setOk(false); setMsg(DIFF_TOO_LARGE); }
    });
  }, [agentId, setDiff]);

  async function openDialog() {
    const sug = await suggestPr(agentId);
    if (sug.existing) { setPrUrl(sug.existing.url); setPrNumber(sug.existing.number ?? null); return; }
    setTitle(sug.title); setBody(sug.body); setDialog(true);
  }
  async function submitPr() {
    setBusy(true);
    const r = await openPr(agentId, { title, body, draft });
    setBusy(false);
    if (r.ok) { setPrUrl(r.url); setPrNumber(r.number); setDialog(false); setOk(true); setMsg(`opened PR #${r.number}`); }
    else { setOk(false); setMsg(r.error); }
  }

  return (
    <div className={s.root}>
      <div className={s.bar}>
        <b className={s.ttl}>Review</b>
        {msg && <span className={`${s.msg} ${ok ? s.ok : s.bad}`}>{msg}</span>}
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => onOpenEditor?.()}>Open in editor</button>
      </div>
      <div className={s.diff}>
        <DiffViewer patch={diff} focusFile={focusFile} />
      </div>
      {!workspace && (
        <div className={s.actions}>
          {prUrl ? (
            <>
              <a className={s.prlink} href={prUrl} target="_blank" rel="noreferrer">PR #{prNumber} <ExternalIcon size={10} /></a>
              <CiBadge agentId={agentId} />
            </>
          ) : (
            <button className={`${s.btn} ${s.pri}`} onClick={openDialog}>Push &amp; open PR</button>
          )}
          {!prUrl && (
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={async () => {
              const r = await mergeAgent(agentId);
              setOk(r.ok); setMsg(r.ok ? "merged into base" : isRefusalText(r.message) ? r.message! : `conflict: ${r.message ?? "resolve in editor"}`);
            }}>Merge locally (no PR)</button>
          )}
          <button className={`${s.btn} ${s.danger}`} onClick={async () => {
            if (await discardAgent(agentId)) onDone();
            else { setOk(false); setMsg("discard failed"); }
          }}>Discard</button>
        </div>
      )}
      {dialog && (
        <div className={s.dialog}>
          <input className={s.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PR title" />
          <textarea className={s.body} value={body} onChange={(e) => setBody(e.target.value)} placeholder="PR description" rows={6} />
          <label className={s.draft}><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft</label>
          <div className={s.dialogActions}>
            <button className={`${s.btn} ${s.pri}`} disabled={busy || !title.trim()} onClick={submitPr}>{busy ? "Opening…" : "Open PR"}</button>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setDialog(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
