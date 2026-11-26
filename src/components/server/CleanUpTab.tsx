// src/components/server/CleanUpTab.tsx — the Clean-up tab of the Server page: an audit that lists
// what could be removed from your server and how much space each thing gives back. The user
// presses one button; some minutes later the list is there. The audit itself removes nothing.
// Each row has a "Remove" button with a confirm: the server then checks the thing again and
// removes it (one at a time).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ago } from "../../lib/server";
import {
  ageWord, aiLine, confirmAllLine, confirmLine, fetchAudit, headLine, removable, removeAllSafe, removeRow, rowsOf, startAudit, sum, sureWord,
  type AuditView, type Row,
} from "../../lib/serverAudit";
import { useRemembered, useScrollMemory, viewMemory } from "../../lib/viewCache";
import { size } from "../../../server/health/words";
import { cx as k } from "../settings/kit";
import s from "./Server.module.css";

const seen = viewMemory<AuditView | null>(1);
// While an audit runs, the page asks again at this pace.
const RUNNING_POLL_MS = 4000;

// What a row can do: remove (after a confirm), or why not now.
type RowActs = {
  // The id of the row that is removed now, and the row whose removal the server refused.
  removing: string | null;
  refused: { id: string; text: string } | null;
  // False: no button (an old result, an audit that runs).
  can: boolean;
  remove: (id: string) => void;
  // "Remove all" of the safe group.
  removeAll: () => void;
};

function AuditRow({ r, acts }: { r: Row; acts: RowActs }) {
  const [asking, setAsking] = useState(false);
  const facts = [ageWord(r.ageDays), sureWord(r.sure)].filter(Boolean).join(" · ");
  const busy = acts.removing === r.id;
  return (
    <div className={s.auditRow}>
      <div className={s.auditTop}>
        <span className={s.auditWhat}>{r.what}</span>
        <span className={s.num}>{size(r.bytes)}</span>
      </div>
      <span className={s.auditWhere}>{r.where}</span>
      <span className={s.auditText}>{r.effect}</span>
      {r.notes.map((n) => <span key={n} className={s.auditNote}>{n[0].toUpperCase() + n.slice(1)}.</span>)}
      <span className={s.auditFacts}>{facts}</span>
      {acts.refused?.id === r.id && <span className={s.auditNote} role="alert">Not removed. {acts.refused.text}</span>}
      {r.noRemove ? <span className={s.auditFacts}>{r.noRemove}</span>
        : busy ? <span className={s.auditFacts} role="status">Removing…</span>
        : asking ? (
          <div className={s.auditAsk} role="group" aria-label="Confirm">
            <span className={s.auditText}>{confirmLine(r)}</span>
            <span className={s.auditBtns}>
              <button type="button" className={`${k.btn} ${k.primary}`} onClick={() => { setAsking(false); acts.remove(r.id); }}>Remove for good</button>
              <button type="button" className={k.btn} onClick={() => setAsking(false)}>Cancel</button>
            </span>
          </div>
        ) : acts.can && <span className={s.auditBtns}><button type="button" className={k.btn} onClick={() => setAsking(true)} disabled={acts.removing !== null}>Remove</button></span>}
    </div>
  );
}

// all: the group has "Remove all" (the safe group only).
function Group({ title, help, rows, acts, all = false }: { title: string; help: string; rows: Row[]; acts: RowActs; all?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (rows.length === 0) return null;
  const many = all && acts.can && removable(rows).length > 1;
  return (
    <section className={k.block}>
      <div className={k.blockHead}>
        <h3 className={k.blockTitle}>{title}</h3>
        <span className={s.checked}>{size(sum(rows))}</span>
        {many && !asking && <button type="button" className={k.btn} onClick={() => setAsking(true)} disabled={acts.removing !== null}>Remove all</button>}
      </div>
      <p className={`${k.note} ${s.auditHelp}`}>{help}</p>
      {many && asking && (
        <div className={`${s.auditAsk} ${s.auditAskAll}`} role="group" aria-label="Confirm">
          <span className={s.auditText}>{confirmAllLine(rows)}</span>
          <span className={s.auditBtns}>
            <button type="button" className={`${k.btn} ${k.primary}`} onClick={() => { setAsking(false); acts.removeAll(); }}>Remove all for good</button>
            <button type="button" className={k.btn} onClick={() => setAsking(false)}>Cancel</button>
          </span>
        </div>
      )}
      <div className={k.list}>{rows.map((r) => <AuditRow key={r.id} r={r} acts={acts} />)}</div>
    </section>
  );
}

export function CleanUpTab({ phone }: { phone: boolean }) {
  const [view, setView] = useRemembered<AuditView | null>(seen, "audit", null);
  const [note, setNote] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const scroll = useScrollMemory<HTMLDivElement>("clean-up");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(async () => {
    const a = await fetchAudit();
    if (a.ok) setView(a.view);
    if (live.current) setNote(a.ok ? null : a.text);
  }, [setView]);
  useEffect(() => { void load(); }, [load]);
  const running = view?.state === "running" || !!view?.removing;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void load(); }, RUNNING_POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  const run = async () => {
    setAsked(true);
    const a = await startAudit();
    if (!a.ok && live.current) setNote(a.text);
    await load();
    if (live.current) setAsked(false);
  };

  const r = view?.result;
  const busy = view?.state === "running" || asked;
  const remove = async (id: string) => {
    if (!r) return;
    const a = await removeRow(id, r.checkedAt);
    if (!a.ok && live.current) setNote(a.text);
    await load();
  };
  const acts: RowActs = {
    removing: view?.removing ?? null, refused: view?.refused ?? null, can: !!r && !r.old && view?.state !== "running",
    remove: (id) => void remove(id),
    removeAll: () => void (async () => {
      if (!r) return;
      const a = await removeAllSafe(r.checkedAt);
      if (!a.ok && live.current) setNote(a.text);
      await load();
    })(),
  };
  const ai = r ? aiLine(r.ai) : null;
  const body = (
    <>
      <section className={s.auditHead}>
        <div className={k.stack}>
          <b className={s.auditTotal}>{r ? headLine(r) : "See what you can remove from your server."}</b>
          <span className={s.warnText}>
            {busy ? "The audit runs. It looks at the disk with a low priority: this takes some minutes. You can leave this page."
              : r ? `Checked ${ago(r.checkedAt, Date.now())}.${r.old ? " This result is old: run the audit again." : ""}`
              : "The audit looks at the build outputs, the installed parts, the downloads of tools, old copies of repos and temporary files. It takes some minutes."}
          </span>
          <span className={s.warnText}>The audit removes nothing. You remove a thing with its "Remove" button, after a confirm.</span>
          {r && r.freedCount > 0 && <span className={s.warnText}>You removed {r.freedCount} {r.freedCount === 1 ? "thing" : "things"} of this list: {size(r.freedBytes)} came back.</span>}
        </div>
        <button type="button" className={`${k.btn} ${k.primary}`} onClick={() => void run()} disabled={busy || view === null}>{busy ? "The audit runs…" : r ? "Run the audit again" : "Run the audit"}</button>
      </section>
      {note && <p className={k.err} role="alert">{note}</p>}
      {r?.partial && <p className={`${k.note} ${s.auditMsg}`}>The audit stopped at its time limit: the list is not complete.</p>}
      {ai && <p className={`${k.note} ${s.auditMsg}`}>{ai}</p>}
      {r && (
        <>
          <Group title="Safe to remove" help="A tool makes each of these again. Nothing of yours is lost." rows={rowsOf(r.rows, "safe")} acts={acts} all />
          <Group title="Check first" help="Look at each of these before you remove it. The audit cannot know if you need it. The Files tab shows what is in a folder." rows={rowsOf(r.rows, "check")} acts={acts} />
          <section className={k.block}>
            <div className={k.blockHead}><h3 className={k.blockTitle}>Not touched</h3></div>
            <p className={`${k.note} ${s.auditHelp}`}>Everything else is not in the list: your repos and their history, the folders of open agents, databases, keys, logins and private places, and what belongs to another user.</p>
          </section>
        </>
      )}
    </>
  );
  return phone
    ? <div className={s.phoneScroll} ref={scroll.ref} onScroll={scroll.onScroll}><div className={`${k.phoneBody} ${s.phoneBody}`}>{body}</div></div>
    : <div className={s.scroll} ref={scroll.ref} onScroll={scroll.onScroll}><div className={s.inner}>{body}</div></div>;
}
