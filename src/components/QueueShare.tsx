// src/components/QueueShare.tsx — "Share outside" on a ticket (server/chief/queue/share.ts). A page
// for the user stays in the ticket; this is for a page the user gives to another person. The head
// of the ticket has one quiet action (ShareHead). A press opens the confirm step at the top of the
// ticket (SharePanel): what goes out, what the share tool's check found (each hit needs a tick),
// and that the page gets a password. Only the confirm sends the page out. Then the ticket shows
// "Shared · Copy link · Stop sharing". The one-tap link and the password come once: this tab
// keeps the link in memory only. With no share tool set, the action is a download of the same
// file. Every text of the tool and of the ticket renders as a React text node.
"use client";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import {
  downloadShare, hitWords, oneTaps, publishShare, readShare, shareToolSet, shareToolSub, stopShare, type Hit, type ShareView, type Shared,
} from "../lib/share";
import { ExternalIcon } from "./SideIcons";
import q from "./QueueView.module.css";
import s from "./QueueShare.module.css";

type Phase = "idle" | "reading" | "confirm" | "sharing" | "stopAsk" | "stopping";
type ShareState = NonNullable<QueueItem["share"]>;
type St = {
  phase: Phase; view: ShareView | null; ticked: string[]; error: string | null; note: string | null;
  // The publish's answer: the one-tap link and the password, shown once.
  done: Shared | null;
  // The share as our own answer gave it, until the item from the server catches up (undefined: the item's).
  local: ShareState | null | undefined;
  focus: number; // a press of "Shared" in the head: the panel takes focus
};
const EMPTY: St = { phase: "idle", view: null, ticked: [], error: null, note: null, done: null, local: undefined, focus: 0 };

// One state per ticket, for the head's button and the panel in the ticket.
const states = new Map<string, St>();
const subs = new Set<() => void>();
const sub = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
function put(id: string, patch: Partial<St>): void {
  states.set(id, { ...(states.get(id) ?? EMPTY), ...patch });
  for (const f of subs) f();
}
const get = (id: string): St => states.get(id) ?? EMPTY;
const useSt = (id: string): St => useSyncExternalStore(sub, () => get(id), () => EMPTY);
const useToolSet = (): boolean | null => useSyncExternalStore(shareToolSub, shareToolSet, () => null);

function shareOf(item: QueueItem, st: St): ShareState | null {
  if (st.local === undefined) return item.share ?? null;
  return st.local;
}

// An Esc that closed the confirm goes no further (the Queue's own Esc leaves the ticket on a phone).
function stopEsc(e: KeyboardEvent): void {
  e.stopPropagation();
  e.nativeEvent.stopImmediatePropagation();
}

async function begin(id: string): Promise<void> {
  if (get(id).phase !== "idle") return;
  put(id, { phase: "reading", error: null, note: null, view: null, ticked: [] });
  const r = await readShare(id);
  if (!r.ok) { put(id, { phase: "idle", error: r.error }); return; }
  put(id, { phase: "confirm", view: r.view, ...(r.view.shared ? { local: r.view.shared } : {}) });
}

/** The quiet action in the ticket's head. Absent on a device that is not paired. A phone's back bar
 *  is full: there it is "Share" at the end of the ticket's meta line (its full name in aria-label). */
export function ShareHead({ item, readOnly, phone = false }: { item: QueueItem; readOnly: boolean; phone?: boolean }) {
  const st = useSt(item.id);
  const tool = useToolSet();
  if (readOnly || tool === null) return null;
  const shared = shareOf(item, st);
  if (shared) {
    return (
      <button
        type="button" className={`${q.b} ${q.ghost} ${s.head}${phone ? ` ${s.phoneHead}` : ""}`} title="This ticket is shared outside"
        onClick={() => put(item.id, { focus: st.focus + 1 })}
      >
        <span className={s.dot} aria-hidden />Shared
      </button>
    );
  }
  return (
    <button
      type="button" className={`${q.b} ${q.ghost} ${s.head}${phone ? ` ${s.phoneHead}` : ""}`} disabled={st.phase !== "idle"}
      title={tool ? "Give this ticket to another person: a page with a password" : "Download this ticket as one HTML file"}
      aria-label={phone ? "Share outside" : undefined} onClick={() => void begin(item.id)}
    >
      {st.phase === "reading" ? "Checking…" : phone ? "Share" : "Share outside"}
    </button>
  );
}

const when = (at: number): string => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The confirm step and the shared row, at the top of the ticket. */
export function SharePanel({ item, readOnly }: { item: QueueItem; readOnly: boolean }) {
  const st = useSt(item.id);
  const id = item.id;
  const shared = shareOf(item, st);
  const boxRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  // The item from the server has the share now (or has none after a stop): follow it again.
  useEffect(() => {
    if (st.local !== undefined && (item.share ?? null)?.docId === st.local?.docId) put(id, { local: undefined });
  }, [id, item.share, st.local]);
  // The password is shown once: it goes when the ticket closes in this tab (the link stays for Copy).
  useEffect(() => () => { if (get(id).done) put(id, { done: null }); }, [id]);
  // A new confirm step or a press of "Shared": focus goes into the panel, never to the body.
  useLayoutEffect(() => {
    if (st.phase === "confirm" || st.focus > 0) {
      boxRef.current?.scrollIntoView({ block: "nearest" });
      firstRef.current?.focus({ preventScroll: true });
    }
  }, [st.phase, st.focus]);
  if (readOnly) return null;

  const cancel = () => put(id, { phase: "idle", view: null, ticked: [], error: null });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (st.phase === "confirm") { stopEsc(e); cancel(); }
    else if (st.phase === "stopAsk") { stopEsc(e); put(id, { phase: "idle" }); }
  };
  const download = async () => {
    put(id, { error: null, note: null });
    const r = await downloadShare(id);
    put(id, r.ok ? { note: "The file is in your downloads." } : { error: r.error });
  };
  const share = async () => {
    put(id, { phase: "sharing", error: null });
    const r = await publishShare(id, get(id).ticked);
    if (r.ok) { put(id, { phase: "idle", view: null, ticked: [], done: r, local: r.item.share ?? null }); return; }
    // The check found something new: show it again, with no tick.
    if (r.reason === "hits" && r.hits) { put(id, { phase: "confirm", view: { ...get(id).view!, hits: r.hits }, ticked: [], error: r.error }); return; }
    put(id, { phase: r.reason === "shared" ? "idle" : "confirm", error: r.error });
  };
  const stop = async () => {
    put(id, { phase: "stopping", error: null });
    const r = await stopShare(id);
    if (r.ok) { put(id, { phase: "idle", done: null, local: null, note: "Stopped. The link does not work any more." }); return; }
    put(id, { phase: "stopAsk", error: r.error });
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      put(id, { note: "Copied." });
    } catch {
      put(id, { note: `Copy did not work here. The link: ${text}` });
    }
  };

  const error = st.error ? <p className={s.err} role="alert">{st.error}</p> : null;
  const note = st.note ? <p className={s.note} role="status">{st.note}</p> : null;

  if (shared) {
    const tap = st.done?.oneTap ?? oneTaps.get(id) ?? null;
    return (
      <div ref={boxRef} className={s.row} data-queue-share="" onKeyDown={onKey}>
        {st.phase === "stopAsk" || st.phase === "stopping" ? (
          <>
            <p className={s.ask}><b>Stop sharing?</b> The link stops working for everyone who has it.</p>
            <span className={s.btns}>
              <button type="button" className={`${q.b} ${q.pri}`} disabled={st.phase === "stopping"} onClick={() => void stop()}>{st.phase === "stopping" ? "Stopping…" : "Stop sharing"}</button>
              <button ref={firstRef} type="button" className={q.b} disabled={st.phase === "stopping"} onClick={() => put(id, { phase: "idle", error: null })}>Cancel</button>
            </span>
          </>
        ) : (
          <>
            <p className={s.line}>
              <span className={s.dot} data-tone={shared.checked ? undefined : "warn"} aria-hidden />
              <b>Shared outside</b>
              <span className={s.meta}>{when(shared.at)}</span>
            </p>
            <span className={s.btns}>
              <button ref={firstRef} type="button" className={q.b} title={tap ? "The link with the password in it" : "The link asks for the password"} onClick={() => void copy(tap ?? shared.link)}>Copy link</button>
              <a className={q.b} href={tap ?? shared.link} target="_blank" rel="noopener noreferrer">Open <ExternalIcon size={10} /></a>
              <button type="button" className={`${q.b} ${q.ghost}`} onClick={() => put(id, { phase: "stopAsk", note: null, error: null })}>Stop sharing</button>
            </span>
            {st.done ? (
              <p className={s.once}>
                Copy the link now: it opens the page with no password to type. The console does not keep it.
                {st.done.password && <> Password, shown once: <code className={s.pw}>{st.done.password}</code></>}
              </p>
            ) : !tap && (
              <p className={s.hint}>This link asks for the password. The password was shown once, when you shared. To get a new link, stop sharing and share again.</p>
            )}
            {!shared.checked && <p className={s.warn}>The link did not open from your server. Open it to check it, or stop sharing.</p>}
          </>
        )}
        {error}{note}
      </div>
    );
  }

  if (st.phase === "reading") return <p className={s.reading} role="status">Checking what goes out…</p>;
  if ((st.phase !== "confirm" && st.phase !== "sharing") || !st.view) return error || note ? <div className={s.row} data-queue-share="">{error}{note}</div> : null;

  const v = st.view;
  const busy = st.phase === "sharing";
  const open = v.hits.filter((h) => !st.ticked.includes(h.text));
  const tick = (h: Hit, on: boolean) => put(id, { ticked: on ? [...st.ticked, h.text] : st.ticked.filter((t) => t !== h.text) });
  const parts = ["the title", ...(v.what.body ? ["the text of the ticket (first)"] : []), ...(v.what.page ? ["the page from the agent"] : [])];
  return (
    <div ref={boxRef} className={s.card} role="group" aria-label="Share outside" data-queue-share="" onKeyDown={onKey}>
      <h3 className={s.title}>{v.tool ? "Share this ticket outside?" : "Download this ticket"}</h3>
      <p className={s.what}>
        {v.tool ? "What goes out, as one page: " : "One HTML file with "}{parts.join(", ")}.
      </p>
      {v.tool ? (
        <>
          <p className={s.what}>The page gets a password. You get one link with the password in it: anyone who has that link can open the page.</p>
          {v.hits.length === 0 ? (
            <p className={s.clean}><span className={s.dot} aria-hidden />Your share tool found nothing that looks private.</p>
          ) : (
            <div className={s.hits}>
              <p className={s.hitsHead}>
                Your share tool found {v.hits.length === 1 ? "one thing" : `${v.hits.length} things`} that can be private. Tick each one to share it anyway.
              </p>
              <ul className={s.hitList}>
                {v.hits.map((h) => {
                  const w = hitWords(h);
                  const on = st.ticked.includes(h.text);
                  return (
                    <li key={h.text} className={s.hit}>
                      <label className={s.hitLabel}>
                        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => tick(h, e.currentTarget.checked)} />
                        <span className={s.hitText}><b>{w.what}</b> <span className={s.excerpt}>{w.text}</span></span>
                        <span className={s.anyway}>Share it anyway</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className={s.hint}>No share tool is set, so this ticket can only be downloaded. To share it with a link, set a share tool in Settings, Share outside.</p>
      )}
      {error}{note}
      <div className={s.btns}>
        {v.tool && (
          <button type="button" className={`${q.b} ${q.pri}`} disabled={busy || open.length > 0} title={open.length ? "Tick each thing the check found first" : undefined} onClick={() => void share()}>
            {busy ? "Sharing…" : "Share"}
          </button>
        )}
        <button type="button" className={v.tool ? q.b : `${q.b} ${q.pri}`} disabled={busy} onClick={() => void download()}>
          {v.tool ? "Download instead" : "Download as one HTML file"}
        </button>
        <button ref={firstRef} type="button" className={q.b} disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}
