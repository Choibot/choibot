// src/components/MasterView.tsx — Master tab: the fleet master's pane, the agents' one
// (AgentPane): the thread from the master's session file, the switch to the raw terminal, the
// prompt card and the quiet mark. The lead switch (Master and one segment per lead) is a row of
// its own under the pane's header line, and the master's status line is on the header's status
// line. A lead opened from the switch shows in the same pane.
// The master's id, status line and leads are remembered (lib/viewCache): the view opens with the
// pane, the status line and the lead switch in place, then reads them again.
"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { useRemembered, viewMemory } from "../lib/viewCache";
import { prefetchThread, threadKnown } from "../lib/useThread";
import { FLEET_MASTER_ID } from "../lib/queueRow";
import { AgentPane } from "./AgentPane";
import { LeadAvatar } from "./LeadAvatar";
import { PhoneHeader } from "./PhoneHeader";
import { ensureFleetMaster, fetchMasterStatus, masterStatusLine, type MasterStatus } from "../lib/master";
import { fetchLeadsState, reportAge, type LeadRow } from "../lib/leads";
import { statusDot } from "../lib/agentGroups";
import type { UseQueue } from "../lib/useQueue";
import s from "./MasterView.module.css";
import { WaitsForSignIn } from "./WaitsForSignIn";

const STATUS_POLL_MS = 5_000;
const VIEW = "master";
const NO_LEADS: LeadRow[] = [];
const masterIds = viewMemory<string | null>(1);
const statuses = viewMemory<MasterStatus | null>(1);
const leadLists = viewMemory<LeadRow[]>(1);

// The warm-up (lib/warmup): the status line and the lead switch, before the view opens.
export async function prefetchMasterView(): Promise<void> {
  await Promise.all([
    statuses.has(VIEW) ? null : fetchMasterStatus().then((st) => { if (!statuses.has(VIEW)) statuses.set(VIEW, st); }),
    leadLists.has(VIEW) ? null : fetchLeadsState().then(({ rows }) => { if (!leadLists.has(VIEW)) leadLists.set(VIEW, rows); }),
  ]);
}

// `queue`: the page's one useQueue(); the pane's thread shows the tickets of the master, or of
// the lead that is open, from it. `onBack` (the phone shell): the header's back arrow.
// onSetup: open the Set-up page (where the second sign-in is), for an agent that waits for it.
export function MasterView({ queue, onBack, onSetup }: { queue?: UseQueue; onBack?: () => void; onSetup?: () => void } = {}) {
  // The id is fixed: with its thread already read (the master exists), the pane shows at once
  // while the start call runs.
  const [masterId, setMasterId] = useRemembered(masterIds, VIEW, threadKnown(FLEET_MASTER_ID) ? FLEET_MASTER_ID : null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useRemembered(statuses, VIEW, null);
  const didInit = useRef(false); // StrictMode double-mount guard
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    // The master's id is fixed: its thread is read beside the start call, not after it.
    prefetchThread(FLEET_MASTER_ID);
    // A remembered id shows the pane at once; the answer replaces it (a failure drops it: no pane).
    void ensureFleetMaster().then(setMasterId).catch((e) => { setMasterId(null); setError(String(e)); });
  }, []);
  useEffect(() => {
    let live = true;
    const load = () => { void fetchMasterStatus().then((st) => { if (live) setStatus(st); }).catch(() => {}); };
    load();
    const t = setInterval(load, STATUS_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  const [leads, setLeads] = useRemembered(leadLists, VIEW, NO_LEADS);
  const [openLead, setOpenLead] = useState<string | null>(null); // lead id shown in the pane
  // "Show activity": the event digests and "(quiet)" replies of the fleet master's chat. Off at each load.
  const [showActivity, setShowActivity] = useState(false);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setInterval> | undefined;
    const load = () => {
      void fetchLeadsState().then(({ rows, missing }) => {
        if (!live) return;
        setLeads(rows);
        if (missing && t) { clearInterval(t); t = undefined; } // flag off: no routes, stop polling
      }).catch(() => {});
    };
    load();
    t = setInterval(load, STATUS_POLL_MS);
    return () => { live = false; if (t) clearInterval(t); };
  }, []);
  useEffect(() => {
    if (!openLead) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setOpenLead(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openLead]);
  const shownId = openLead ?? masterId;
  const shownLead = openLead ? leads.find((l) => l.leadId === openLead) : undefined;
  // The pane is made again for each lead (its key), and the switch with it: the row's scroll
  // position is kept here.
  const switchScroll = useRef(0);
  const leadSwitch = leads.length > 0 && <LeadSwitch leads={leads} openLead={openLead} onOpen={setOpenLead} scrollMemo={switchScroll} />;
  const statusText = status ? masterStatusLine(status) : undefined;
  return (
    <div className={s.view}>
      {/* Until the pane is up, the phone screen still needs its header (the back arrow). */}
      {!shownId && onBack && <PhoneHeader onBack={onBack} title="Fleet master" sub={statusText} extra={leadSwitch || undefined} />}
      <div className={s.center}>
        {!openLead && error && <div className={s.placeholder}>The fleet master did not start: {error}</div>}
        {!openLead && !error && !masterId && <div className={`${s.placeholder} late`}>Starting the fleet master…</div>}
        {/* It waits for the second sign-in: no session yet, so its card, not its pane. */}
        {!openLead && status?.waits && <WaitsForSignIn who="The fleet master" onSetup={onSetup} keep login={status.waitsLogin === true} />}
        {openLead && shownLead?.waits && <WaitsForSignIn who="This lead" onSetup={onSetup} login={shownLead.waitsLogin === true} />}
        {/* A master and a lead are persistent: the pane gets no Stop. */}
        {shownId && !(openLead ? shownLead?.waits : status?.waits) && (
          <div className={s.termHost}>
            <AgentPane
              key={shownId} agentId={shownId}
              label={openLead ? `Lead · ${shownLead?.area ?? "lead"}` : "Fleet master"}
              status={openLead ? shownLead?.status ?? undefined : undefined}
              queue={queue}
              // The fleet master's chat is the user's: the event digests and its "(quiet)" replies
              // are activity, shown only with "Show activity" (off at each load).
              activity={!openLead && status?.quiet === true ? { shown: showActivity, toggle: () => setShowActivity((v) => !v) } : undefined}
              headExtra={leadSwitch || undefined}
              metaExtra={statusText}
              // Phone: the open lead's avatar is beside the title. Desktop: the switch's active segment has it.
              avatar={shownLead && onBack ? <LeadAvatar area={shownLead.area} size={36} /> : undefined}
              onBack={onBack}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// The room kept between the open lead's segment and a cut edge of the row (the fade's width).
const SWITCH_FADE_PX = 28;

// The lead switch: Master, always in view, then one segment per lead (its avatar with the status
// dot, its area name). The leads scroll sideways when the row is too narrow: no scrollbar, a
// fade at each cut edge, and the open lead's segment always in view. The time of a lead's last
// report shows on the open lead's segment only; every segment has it in its tooltip.
function LeadSwitch({ leads, openLead, onOpen, scrollMemo }: {
  leads: LeadRow[]; openLead: string | null; onOpen: (leadId: string | null) => void; scrollMemo: MutableRefObject<number>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<"start" | "end" | "both" | undefined>(undefined);
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    scrollMemo.current = el.scrollLeft;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setCut(start && end ? "both" : start ? "start" : end ? "end" : undefined);
  }, [scrollMemo]);
  // Before the paint: the kept position, then the open lead's segment clear of the fades.
  const names = leads.map((l) => l.area).join("\n");
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = scrollMemo.current;
    const active = el.querySelector<HTMLElement>('[data-active="true"]');
    if (active) {
      const box = el.getBoundingClientRect();
      const seg = active.getBoundingClientRect();
      if (seg.left - SWITCH_FADE_PX < box.left) el.scrollLeft += seg.left - SWITCH_FADE_PX - box.left;
      else if (seg.right + SWITCH_FADE_PX > box.right) el.scrollLeft += seg.right + SWITCH_FADE_PX - box.right;
    }
    measure();
  }, [openLead, names, measure, scrollMemo]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <div className={s.leads} role="group" aria-label="Master and leads">
      <button
        type="button" className={s.lead} data-active={openLead === null}
        onClick={() => onOpen(null)} title="Back to the fleet master"
      >
        <span>Master</span>
      </button>
      <div
        className={s.scroll} ref={scroller} data-cut={cut} onScroll={measure}
        // A mouse wheel moves the row sideways (the header has nothing to scroll up or down).
        onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}
      >
        {leads.map((l) => {
          const open = !!l.leadId && l.leadId === openLead;
          const age = l.leadId ? reportAge(l.reportAt) : "not started";
          return (
            <button
              key={l.area} type="button" className={s.lead} disabled={!l.leadId || l.status == null}
              data-active={open}
              onClick={() => l.leadId && l.status != null && onOpen(l.leadId)}
              title={l.leadId ? `Open ${l.area} lead · ${l.reportAt ? `last report ${age}` : age} (Esc outside the terminal, or Master, returns)` : `${l.area}: no lead started`}
            >
              <LeadAvatar area={l.area} size={24} status={statusDot(l.status ?? "")} />
              <span>{l.area}</span>
              {open && <span className={s.age}>{age}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
