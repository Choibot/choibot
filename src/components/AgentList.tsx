// src/components/AgentList.tsx
"use client";
import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { fetchAgents, resumeAgent, stopAgent, deleteAgent, closeAgent, reopenAgent, reorderAgents, CLOSED_TTL_MS, type AgentSession } from "../lib/agents";
import { getChiefState, pairSentence } from "../lib/chief";
import { limitTag, limitWord } from "../lib/accounts";
import { agentsWord, browserStore, closedDot, groupAgents, leadCount, leadsOf, leadSummary, markClosed, moveWithinSection, readLeadOpen, sectionOf, agentDot, statusDot, ticketsWord, writeLeadOpen, type Lead } from "../lib/agentGroups";
import { fetchLeadsState } from "../lib/leads";
import { FLEET_MASTER_ID } from "../lib/queueRow";
import { badgeLabel, badgeTitle, cancelReminder } from "../lib/reminders";
import type { RemindersProp } from "../lib/useReminders";
import { runtimeLabel } from "../lib/runtimes";
import { useEvents } from "../lib/useEvents";
import { AlarmIcon, CheckIcon, ChevronIcon, CloseIcon, DiamondIcon, GitHubIcon, GripIcon, InboxIcon, RepeatIcon, ServerIcon } from "./SideIcons";
import { LeadAvatar } from "./LeadAvatar";
import { StatusDot } from "./StatusDot";
import s from "./AgentSidebar.module.css";
import { prefetchThread } from "../lib/useThread";
import { useRemembered, viewMemory } from "../lib/viewCache";
import { recurringNames } from "../lib/useRecurring";
import { prefetchWidgets } from "./WidgetStrip";
import { prefetchCockpit } from "./CockpitPanel";
import { startWarmUp } from "./warmPlan";

// The chief queue's row and counts (spec §8b): present only while the queue is on (lib/queueRow).
// `open` is null while the count is unknown (misconfigured); `byAgent` is each agent's own open tickets.
// The Set-up row of a new install (the first row, until its first pull request is merged).
export type SetupRowProps = { selected: boolean; done: number; total: number; onSelect: () => void };
export type QueueRowProps = { open: number | null; byAgent: Record<string, number>; selected: boolean; onSelect: () => void };

// The list seen last (lib/viewCache): the phone's home list mounts again on each way back, and
// then shows its rows on the first frame, not one by one as the reads land.
const LIST = "agents";
const sessionsSeen = viewMemory<AgentSession[]>(1);
const leadsSeen = viewMemory<Lead[]>(1);
const unreadSeen = viewMemory<Record<string, number>>(1);
const NO_SESSIONS: AgentSession[] = [];
const NO_LEAD_ROWS: Lead[] = [];
const NO_UNREAD: Record<string, number> = {};
const HOLD_MS = 700;

// The list's own row of an agent: a first open shows its name, branch and status before
// GET /api/agents/:id answers.
export function listedAgent(id: string): AgentSession | undefined {
  return sessionsSeen.get(LIST)?.find((x) => x.id === id);
}

// The row's count column, the same on every row: its open tickets that wait for the user, as a
// quiet pill. The column is there with no count too, so a reminder's time never sits where a
// count sits.
function OpenCount({ n, title }: { n: number | undefined; title?: string }) {
  const label = n ? title ?? ticketsWord(n) : undefined;
  return <span className={s.cnt}>{n ? <span className={s.pill} title={label} aria-label={label}>{n}</span> : null}</span>;
}

// New output since the row was last opened: the name in the bright ink (no count). Screen readers
// hear it after the name.
const NEW_WORD = "new output";
function NewMark({ on }: { on: boolean }) {
  return on ? <span className={s.srOnly}>, {NEW_WORD}</span> : null;
}

// Time to the agent's next open reminder, muted, left of the count column (the clock says it is
// a time, not a count); the text in the tooltip (agent-written: plain text). Nothing without one,
// or with the chief off.
// On a paired device the badge is also the cancel control for that
// reminder (the one shown), so the narrow rail keeps the agent's name:
// hover shows × in place of the time, the first click arms it ("Sure?"), a
// second within 3 s cancels, as Delete does. Unpaired: the badge alone.
function RemindBadge({ r, id, armed, onCancel }: { r: RemindersProp | undefined; id: string; armed: string | null; onCancel: (agentId: string, reminderId: string) => void }) {
  const n = r?.byAgent[id];
  if (!r || !n) return null;
  const title = badgeTitle(n, r.now);
  const glyph = <span className={s.remindGlyph} aria-hidden><AlarmIcon /></span>;
  if (!r.paired) return <span className={s.remind} title={title} aria-label={title} data-remind="">{glyph} {badgeLabel(n.dueAt, r.now)}</span>;
  const arm = armed === `remind:${n.id}`;
  const hint = arm ? "Click again to cancel this reminder" : `${title} — click to cancel it`;
  return (
    <button
      className={`${s.remind} ${s.remindBtn} ${arm ? s.remindArm : ""}`}
      title={hint} aria-label={hint} data-remind="" data-remind-cancel=""
      onClick={() => onCancel(id, n.id)}
    >
      {arm ? "Sure?" : <>{glyph} <span className={s.remindWhen}><span className={s.remindTime}>{badgeLabel(n.dueAt, r.now)}</span><span className={s.remindX} aria-hidden><CloseIcon size={10} /></span></span></>}
    </button>
  );
}

// The sidebar, top to bottom: Queue, Fleet master, GitHub, Recurring, Server, Leads, Agents, Closed.
// `queue` pins the Queue row on top and adds the per-agent counts.
// `master` pins the fleet master under it: one row that opens its terminal in the main pane (it
// is not a worker, so it has no changes rail).
// `github` (desktop shell): the row that opens the GitHub cockpit in the work area.
// `recurring`: the row that opens the Recurring section (the tasks that run on a schedule). No
// number: a dot only while a task did not finish (red) or a change waits for the user (amber).
// `server`: the row that opens the Server page. No number: a dot in the warning or the error
// colour only while something on the server needs the user.
// `leads` (chief on): one section per lead (GET /api/leads) with the workers it spawned, then
// "Other agents". With no lead (or flag off: no `leads`, no request) the list is the one "Agents" section.
// `reminders` (chief on): each row's reminder badge; flag off it is undefined and no row has one.
// `phone`: the phone's home list (A · Inset): rows at touch size, and the row actions (Stop,
// Resume, Close, Reopen, Delete, the drag grip) behind the Agents heading's Edit button.
// `settled` false: the page does not know yet whether the chief queue is on (its row may come).
export function AgentList({ selected, onSelect, onDeleted, reloadSignal, master, queue, github, recurring, server, leads, reminders, setup, phone = false, settled = true }: { setup?: SetupRowProps; selected: string | null; onSelect: (id: string) => void; onDeleted?: (id: string) => void; reloadSignal?: number; master?: { selected: boolean; onSelect: () => void }; queue?: QueueRowProps; github?: { selected: boolean; onSelect: () => void }; recurring?: { selected: boolean; onSelect: () => void; needs: { level: "warn" | "error"; why: string } | null }; server?: { selected: boolean; onSelect: () => void; level: "ok" | "warn" | "error" | null }; leads?: { selected: string | null; onSelect: (lead: Lead) => void }; reminders?: RemindersProp; phone?: boolean; settled?: boolean }) {
  const [sessions, setSessions] = useRemembered(sessionsSeen, LIST, NO_SESSIONS);
  const [unread, setUnread] = useRemembered(unreadSeen, LIST, NO_UNREAD);
  // Inline double-confirm for delete: first click arms (id), second deletes.
  // Auto-disarms after 3s so a stray first click doesn't stay armed.
  const [armed, setArmed] = useState<string | null>(null);
  // Delete/resume refused because this browser is not paired: show the fixed sentence under the row.
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null);
  const refuse = (id: string) => {
    const st = getChiefState();
    if (st.pairRequired) setRefused({ id, text: pairSentence(st.userAuth) });
  };
  const [leadRows, setLeadRows] = useRemembered(leadsSeen, LIST, NO_LEAD_ROWS);
  const leadsOn = !!leads;
  const loadLeads = () => { void fetchLeadsState().then(({ rows }) => setLeadRows(leadsOf(rows))).catch(() => {}); };
  const refresh = () => { void fetchAgents().then((r) => setSessions(r.sessions)); if (leadsOn) loadLeads(); };
  const onDelete = (id: string) => {
    if (armed === id) {
      setArmed(null);
      setRefused(null);
      void deleteAgent(id).then((ok) => { if (!ok) refuse(id); else onDeleted?.(id); refresh(); });
    } else {
      setArmed(id);
      setTimeout(() => setArmed((c) => (c === id ? null : c)), 3000);
    }
  };
  // The reminder badge's × (paired device): the same two-click arm as Delete. A
  // refusal shows its line under the row; the badge updates on the
  // `reminders` event the cancel emits.
  const onCancelRemind = (agentId: string, reminderId: string) => {
    const key = `remind:${reminderId}`;
    if (armed === key) {
      setArmed(null);
      setRefused(null);
      void cancelReminder(reminderId).then((r) => { if (!r.ok) setRefused({ id: agentId, text: r.text }); });
    } else {
      setArmed(key);
      setTimeout(() => setArmed((c) => (c === key ? null : c)), 3000);
    }
  };
  const remindBadge = (id: string) => <RemindBadge r={reminders} id={id} armed={armed} onCancel={onCancelRemind} />;
  // Fetch on mount and whenever the parent bumps `reloadSignal` (e.g. right after
  // a spawn). This makes a freshly-started agent appear immediately instead of
  // depending on the SSE `agent-status` side channel, which can be missed/raced.
  useEffect(() => { refresh(); }, [reloadSignal]);
  // The lead rows load once the chief queue is known to be on (the page passes `leads` then).
  useEffect(() => { if (leadsOn) loadLeads(); else setLeadRows([]); }, [leadsOn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvents((e) => {
    const ev = e as { type: string; agentId?: string; status?: string };
    if (ev.type === "agent-status" && ev.agentId) {
      // Unknown agent (just spawned/resumed) → re-fetch so it appears in the rail
      // with full metadata; known agent → update its status dot in place. A lead
      // (not in GET /api/agents) updates its own row.
      if (leadRows.some((l) => l.id === ev.agentId)) setLeadRows((ls) => ls.map((l) => (l.id === ev.agentId ? { ...l, status: ev.status ?? l.status } : l)));
      else if (!sessions.some((x) => x.id === ev.agentId)) refresh();
      else setSessions((s) => s.map((x) => (x.id === ev.agentId ? { ...x, status: ev.status ?? x.status } : x)));
    }
    // A closed agent was used again: the server cleared closedAt.
    if (ev.type === "agent-reopened" && ev.agentId) {
      if (!sessions.some((x) => x.id === ev.agentId)) refresh();
      else setSessions((s) => s.map((x) => (x.id === ev.agentId ? { ...x, closedAt: undefined } : x)));
    }
    // Closed from elsewhere (its lead's `agents close`, another tab): the row moves to Closed.
    if (ev.type === "agent-closed" && ev.agentId) setSessions((s) => markClosed(s, ev.agentId!, Date.now()));
    if (ev.type === "agent-notify" && ev.agentId && ev.agentId !== selected) {
      setUnread((u) => ({ ...u, [ev.agentId!]: (u[ev.agentId!] ?? 0) + 1 }));
    }
  });
  const select = (id: string) => { setUnread((u) => ({ ...u, [id]: 0 })); onSelect(id); };
  // A pointer that rests on a row (or a finger that goes down on it) reads the agent's thread
  // before the click lands, so its pane opens with it (lib/useThread prefetchThread).
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  // A worker's widget list too: its pane waits for it on a first open (AgentPane).
  const fetchAhead = (id: string, worker: boolean): void => {
    void prefetchThread(id);
    if (worker) void prefetchWidgets(id).catch(() => {});
  };
  const intent = (id: string, worker = true) => ({
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType !== "mouse") return;
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => fetchAhead(id, worker), 80);
    },
    onPointerLeave: () => clearTimeout(hoverTimer.current),
    onPointerDown: () => fetchAhead(id, worker),
  });
  const onClose = (id: string) => {
    setSessions((ss) => markClosed(ss, id, Date.now()));
    void closeAgent(id).then(refresh);
  };
  // Reopen resumes the closed agent's same session (it was stopped on close)
  // and opens its tab.
  const onReopen = (id: string) => {
    setSessions((ss) => ss.map((x) => (x.id === id ? { ...x, closedAt: undefined } : x)));
    void reopenAgent(id).then(() => { refresh(); select(id); });
  };

  const groups = groupAgents(sessions, leadsOn ? leadRows : []);

  // The first load only (nothing remembered): the rows show together once the first reads are in
  // (the agents, the queue's state, the leads), or after HOLD_MS. Each read moved the rows that
  // were already there: the Queue row came last on top, the leads regrouped the agents.
  const [hold, setHold] = useState(() => !sessionsSeen.has(LIST));
  const ready = sessionsSeen.has(LIST) && settled && (!leadsOn || leadsSeen.has(LIST));
  useEffect(() => { if (hold && ready) setHold(false); }, [hold, ready]);
  // The rows are known: read what their first open shows, at idle (once per page load).
  useEffect(() => {
    if (hold || !ready) return;
    startWarmUp({
      master: !!master,
      leads: groups.leads.map((g) => ({ id: g.lead.id, status: g.lead.status, worker: false })),
      workers: [...groups.leads.flatMap((g) => g.workers), ...groups.other].map((a) => ({ id: a.id, status: a.status, worker: true })),
      cronJobs: recurring ? recurringNames() : [],
    });
  }, [hold, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hold) return;
    const t = setTimeout(() => setHold(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [hold]);
  const grouped = groups.leads.length > 0;

  // Drag-to-reorder with pointer events (HTML5 drag-and-drop does not fire on
  // touch). Pressing the grip starts a drag; each move finds the open row under
  // the pointer and moves the dragged agent there live, only inside its own
  // section (a lead's workers, the leads, other agents). Release saves the whole
  // open order. The move/up listeners sit on window, not on the grip: the live
  // reorder can move the grip's own row in the DOM, which drops pointer capture.
  const [dragId, setDragId] = useState<string | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const sectionRef = useRef<Record<string, string>>({});
  sectionRef.current = sectionOf(groups);
  const onGripDown = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
  };
  useEffect(() => {
    if (!dragId) return;
    let moved = false;
    const onMove = (e: PointerEvent) => {
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-open-agent]");
      const overId = row?.dataset.openAgent;
      if (!overId || overId === dragId || sectionRef.current[overId] !== sectionRef.current[dragId]) return;
      moved = true;
      setSessions((ss) => moveWithinSection(ss, dragId, overId, sectionRef.current));
    };
    const onUp = () => {
      setDragId(null);
      if (moved) void reorderAgents(sessionsRef.current.filter((x) => !x.closedAt).map((x) => x.id));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragId]);

  const { other: open, closed } = groups;
  const [closedOpen, setClosedOpen] = useState(false);
  // Phone: the row actions show only in edit mode (touch has no hover to reveal them).
  const [editing, setEditing] = useState(false);
  const hasActs = open.length > 0 || closed.length > 0 || groups.leads.some((g) => g.workers.length > 0);
  // Each lead section's open/closed state, per browser (default open).
  const [leadOpen, setLeadOpen] = useState<Record<string, boolean>>({});
  const isLeadOpen = (l: Lead) => leadOpen[l.area] ?? readLeadOpen(browserStore(), l.area);
  const toggleLead = (l: Lead) => {
    const v = !isLeadOpen(l);
    writeLeadOpen(browserStore(), l.area, v);
    setLeadOpen((m) => ({ ...m, [l.area]: v }));
  };
  const daysLeft = (closedAt: number) => Math.max(1, Math.ceil((closedAt + CLOSED_TTL_MS - Date.now()) / 86_400_000));
  // One open agent row: the status dot, the name, its reminder and open tickets; Stop or Resume and Close
  // show on hover (always on touch). The branch is in the row's title. `nested` indents a lead's worker.
  const openRow = (a: AgentSession, nested = false) => {
    const where = a.head ?? a.branch;
    const isNew = !!unread[a.id];
    return (
      <Fragment key={a.id}>
      <div data-open-agent={a.id} className={`${s.row} ${nested ? s.sub : ""} ${a.id === selected ? s.rowSel : ""} ${a.id === dragId ? s.rowDrag : ""}`}>
        <span
          className={s.grip}
          title="Drag to reorder"
          aria-label="Drag to reorder"
          onPointerDown={(e) => onGripDown(e, a.id)}
        ><GripIcon /></span>
        <button onClick={() => select(a.id)} className={s.pick} aria-current={a.id === selected || undefined}
          {...intent(a.id)} title={`${where ? `${a.label} · ${where}${a.baseBranch ? ` → ${a.baseBranch}` : ""}` : a.label}${isNew ? ` · ${NEW_WORD}` : ""}`}>
          <StatusDot status={agentDot(a)} />
          <span className={`${s.nm} ${isNew ? s.nmNew : ""}`}>{a.label}</span>
          <NewMark on={isNew} />
          {/* Only non-Claude agents and non-default logins are badged. */}
          {a.runtime && a.runtime !== "claude" && <span className={s.tag} title={`runtime: ${runtimeLabel(a.runtime)}`}>{runtimeLabel(a.runtime)}</span>}
          {a.account && a.account !== "default" && <span className={s.tag} title={`Claude account: ${a.account}`}>@{a.account}</span>}
          {limitTag(a) && <span className={s.tag} data-limit="" title={limitWord(a) ?? undefined}>{limitTag(a)}</span>}
        </button>
        {remindBadge(a.id)}
        {queue && <OpenCount n={queue.byAgent[a.id]} />}
        <span className={s.acts}>
          {(a.status === "running" || a.status === "idle") && (
            <button className={s.act} onClick={() => void stopAgent(a.id).then(refresh)}>Stop</button>
          )}
          {(a.status === "done" || a.status === "error") && (
            <button className={s.act} onClick={() => { setRefused(null); void resumeAgent(a.id).then(() => select(a.id), () => refuse(a.id)); }}>Resume</button>
          )}
          <button
            className={`${s.act} ${s.actIcon}`}
            title="Close (stops the session and moves it to Closed; deleted after 7 days)"
            aria-label="Close agent"
            onClick={() => onClose(a.id)}
          ><CloseIcon size={12} /></button>
        </span>
      </div>
      {refused?.id === a.id && <div className={s.none} role="alert">{refused.text}</div>}
      </Fragment>
    );
  };
  // A lead's own row heads its section: the chevron folds its workers (its title says how many);
  // then its avatar, with the lead's status dot on the avatar's corner, and its area name;
  // a click opens the lead's pane (as the Master pane's lead buttons do). On the right: its open
  // tickets (folded: the lead's and its agents'). A lead is persistent: no drag, Stop, Resume or
  // Close here.
  const leadRow = (l: Lead, expanded: boolean, sum: { agents: number; open: number }) => {
    const pickLead = () => { setUnread((u) => ({ ...u, [l.id]: 0 })); leads?.onSelect(l); };
    const count = leadCount(l.id, expanded, sum, queue?.byAgent ?? {});
    const isNew = !!unread[l.id];
    const fold = `${expanded ? "Collapse" : "Expand"} ${l.area} · ${agentsWord(sum.agents)}`;
    return (
      <>
      <div data-lead-row={l.id} className={`${s.row} ${s.leadRow} ${leads?.selected === l.id ? s.rowSel : ""}`}>
        <button
          className={s.fold} onClick={() => toggleLead(l)} aria-expanded={expanded}
          aria-label={fold} title={fold}
        ><ChevronIcon open={expanded} /></button>
        <button onClick={pickLead} {...intent(l.id, false)} className={s.pick} aria-current={leads?.selected === l.id || undefined} title={`Lead · ${l.area}${isNew ? ` · ${NEW_WORD}` : ""}`}>
          <LeadAvatar area={l.area} size={phone ? 36 : 24} status={statusDot(l.status)} />
          <span className={`${s.nm} ${isNew ? s.nmNew : ""}`}>{l.area}</span>
          <NewMark on={isNew} />
        </button>
        {remindBadge(l.id)}
        {queue && <OpenCount n={count.n} title={count.title} />}
      </div>
      {refused?.id === l.id && <div className={s.none} role="alert">{refused.text}</div>}
      </>
    );
  };
  return (
    <div className={s.list} data-phone={phone ? "" : undefined} data-editing={phone && editing ? "" : undefined} style={hold ? { visibility: "hidden" } : undefined}>
      {setup && (
        <div className={`${s.row} ${setup.selected ? s.rowSel : ""}`} data-setup-row="">
          <button onClick={setup.onSelect} className={s.pick} aria-current={setup.selected || undefined} title="The steps of the set-up">
            <span className={s.dotw}><CheckIcon size={16} /></span>
            <span className={s.nm}>Set-up</span>
            {setup.total > 0 && <span className={s.pill} aria-label={`${setup.done} of ${setup.total} steps done`}>{setup.done}/{setup.total}</span>}
          </button>
        </div>
      )}
      {queue && (
        <div className={`${s.row} ${queue.selected ? s.rowSel : ""}`} data-queue-row="">
          <button onClick={queue.onSelect} className={s.pick} aria-current={queue.selected || undefined} title="Decisions waiting on you">
            <span className={s.dotw}><InboxIcon /></span>
            <span className={s.nm}>Queue</span>
            {queue.open !== null && (
              <span className={`${s.pill} ${queue.open > 0 ? s.pillInv : ""}`} title={ticketsWord(queue.open)} aria-label={ticketsWord(queue.open)}>{queue.open}</span>
            )}
          </button>
        </div>
      )}
      {master && (
        <div className={`${s.row} ${master.selected ? s.rowSel : ""}`}>
          <button onClick={master.onSelect} {...intent(FLEET_MASTER_ID, false)} className={s.pick} aria-current={master.selected || undefined} title="Runs every agent and recurring task">
            <span className={s.dotw}><DiamondIcon /></span>
            <span className={s.nm}>Fleet master</span>
          </button>
          {remindBadge(FLEET_MASTER_ID)}
          {queue && <OpenCount n={queue.byAgent[FLEET_MASTER_ID]} />}
        </div>
      )}
      {master && refused?.id === FLEET_MASTER_ID && <div className={s.none} role="alert">{refused.text}</div>}
      {github && (
        <div className={`${s.row} ${github.selected ? s.rowSel : ""}`} data-github-row="">
          <button onClick={github.onSelect} onPointerDown={() => void prefetchCockpit()} className={s.pick} aria-current={github.selected || undefined}>
            <span className={s.dotw}><GitHubIcon /></span>
            <span className={s.nm}>GitHub</span>
          </button>
        </div>
      )}
      {recurring && (
        <div className={`${s.row} ${recurring.selected ? s.rowSel : ""}`} data-recurring-row="">
          <button onClick={recurring.onSelect} className={s.pick} aria-current={recurring.selected || undefined} title="The tasks that run by themselves on a schedule">
            <span className={s.dotw}><RepeatIcon /></span>
            <span className={s.nm}>Recurring</span>
            {recurring.needs && (
              <i className={s.needs} data-level={recurring.needs.level} role="img" aria-label={recurring.needs.why} title={recurring.needs.why} />
            )}
          </button>
        </div>
      )}
      {server && (
        <div className={`${s.row} ${server.selected ? s.rowSel : ""}`} data-server-row="">
          <button onClick={server.onSelect} className={s.pick} aria-current={server.selected || undefined}>
            <span className={s.dotw}><ServerIcon /></span>
            <span className={s.nm}>Server</span>
            {server.level && server.level !== "ok" && (
              <i className={s.needs} data-level={server.level} role="img" aria-label="Something on your server needs you" title="Something on your server needs you" />
            )}
          </button>
        </div>
      )}
      {grouped && (
        <>
          <h3 className={s.sec}>Leads</h3>
          {groups.leads.map(({ lead: l, workers }) => {
            const expanded = isLeadOpen(l);
            const sum = leadSummary(l, workers, queue?.byAgent ?? {});
            return (
              <Fragment key={l.id}>
                {leadRow(l, expanded, sum)}
                {expanded && workers.map((w) => openRow(w, true))}
              </Fragment>
            );
          })}
        </>
      )}
      <h3 className={s.sec}>
        Agents
        {phone && hasActs && (
          <button type="button" className={s.edit} aria-pressed={editing} onClick={() => setEditing((v) => !v)}
            title={editing ? "Hide the row actions" : "Show Stop, Close and the other row actions"}>{editing ? "Done" : "Edit"}</button>
        )}
      </h3>
      {open.length === 0 && <div className={s.none}>{grouped ? "No other agents." : "No agents yet."}</div>}
      {open.map((a) => openRow(a))}
      {closed.length > 0 && (
        <>
          {/* Its count is of closed agents, not tickets: in the label, not in the count column. */}
          <button className={`${s.row} ${s.closedH}`} onClick={() => setClosedOpen((v) => !v)} aria-expanded={closedOpen}
            title={`${closed.length} closed ${closed.length === 1 ? "agent" : "agents"}`}>
            <span className={s.dotw}><ChevronIcon open={closedOpen} /></span>
            <span className={s.nm}>Closed · {closed.length}</span>
          </button>
          {closedOpen && closed.map((a) => {
            // Close stops the session. Agents closed before that may still run.
            const live = a.status === "running" || a.status === "idle";
            // An open reminder keeps it from the purge and reopens it when due: no "Nd left" then.
            const held = !!reminders?.byAgent[a.id];
            return (
            <Fragment key={a.id}>
            <div data-closed-agent={a.id} className={`${s.row} ${s.rowClosed} ${a.id === selected ? s.rowSel : ""}`}>
              <button onClick={() => select(a.id)} {...intent(a.id)} className={s.pick} aria-current={a.id === selected || undefined}
                title={(a.head ?? a.branch) ? `${a.label} · ${a.head ?? a.branch}` : a.label}>
                <StatusDot status={closedDot(a.status)} />
                <span className={s.nm}>{a.label}</span>
                {!held && <span className={s.mt} title="Deleted for good when this reaches 0">{daysLeft(a.closedAt!)}d left</span>}
              </button>
              {remindBadge(a.id)}
              {queue && <OpenCount n={queue.byAgent[a.id]} />}
              <span className={`${s.acts} ${armed === a.id ? s.actsOn : ""}`}>
                {live && (
                  <button className={s.act} title="Stop the session (frees its memory)" onClick={() => void stopAgent(a.id).then(refresh)}>Stop</button>
                )}
                <button className={s.act} title="Resume the same session and move it back to Agents" onClick={() => onReopen(a.id)}>Reopen</button>
                <button
                  className={`${s.act} ${s.actDel} ${armed === a.id ? s.actArm : ""}`}
                  title={armed === a.id ? "Click again to delete (worktree, branch, history)" : "Delete now"}
                  aria-label={armed === a.id ? "Confirm delete agent" : "Delete agent now"}
                  onClick={() => onDelete(a.id)}
                >{armed === a.id ? "Sure?" : "Delete"}</button>
              </span>
            </div>
            {refused?.id === a.id && <div className={s.none} role="alert">{refused.text}</div>}
            </Fragment>
            );
          })}
        </>
      )}
    </div>
  );
}
