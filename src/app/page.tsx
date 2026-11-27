// src/app/page.tsx
"use client";
import { useEffect, useState } from "react";
import { FileExplorer } from "../components/FileExplorer";
import { NewAgentDialog } from "../components/AgentLauncher";
import { AgentList, listedAgent } from "../components/AgentList";
import { AgentPane } from "../components/AgentPane";
import { LeadAvatar } from "../components/LeadAvatar";
import { dropAgentTerminal } from "../components/XtermTerminal";
import { guardFileDrops } from "../lib/upload";
import { ReconcilePanel } from "../components/ReconcilePanel";
import { DocsPanel } from "../components/DocsPanel";
import { ChangesRail } from "../components/ChangesRail";
import { ServicesPanel } from "../components/ServicesPanel";
import { CockpitPanel, type CockpitFocus } from "../components/CockpitPanel";
import { RecurringPage } from "../components/recurring/RecurringPage";
import { useCronSpool } from "../components/recurring/Changes";
import { MasterView } from "../components/MasterView";
import { QueueView } from "../components/QueueView";
import { ServerPage } from "../components/server/ServerPage";
import { useServerLevel } from "../lib/useServer";
import { PairCard } from "../components/PairCard";
import { holdPairLink } from "../lib/chief";
import { SetupPage } from "../components/setup/SetupPage";
import type { SetupNav } from "../components/setup/SetupList";
import { progress, setupRows } from "../lib/setup";
import { useSetup, useSetupHome } from "../lib/useSetup";
import { SettingsGear, SettingsHomeRow, SettingsPage } from "../components/settings/SettingsPage";
import { parseHashRoute } from "../lib/hashRoute";
import { ThemeToggle } from "../components/ThemeToggle";
import { AccountLine } from "../components/AccountBar";
import { UsageMeter } from "../components/UsageMeter";
import { FileIcon, PlusIcon } from "../components/SideIcons";
import { PhoneHeader, PhonePillButton } from "../components/PhoneHeader";
import { agentModel, fetchAgent, type AgentSession } from "../lib/agents";
import { limitWord } from "../lib/accounts";
import { fetchEditorOff } from "../lib/brain";
import { recurringLevel, spoolWaiting } from "../lib/cron";
import { useRecurring } from "../lib/useRecurring";
import { useQueue } from "../lib/useQueue";
import { useReminders } from "../lib/useReminders";
import { remindersEnabled } from "../lib/reminders";
import { useQueueKeys } from "../lib/useQueueKeys";
import { agentsCenter, FLEET_MASTER_ID, onQueueRow, openCounts, phoneScreen, queueRowShown, sideRow } from "../lib/queueRow";
import { COORDINATOR_ID } from "../lib/coordinator";
import type { Lead } from "../lib/agentGroups";
import { useIsMobile } from "../lib/useIsMobile";
import { RAIL_OPEN_KEY, readRailOpen } from "../lib/rail";
import { useVisualViewportHeight } from "../lib/useVisualViewportHeight";
import { agentMemory, forgetAgent, useScrollMemory } from "../lib/viewCache";
import { BrandMark } from "../components/BrandMark";
import { DISPLAY_NAME } from "../../server/brand";
import s from "./page.module.css";
import { WaitsForSignIn } from "../components/WaitsForSignIn";

// The last record of each agent opened: an agent seen before shows its name and branch at once.
const agentRecords = agentMemory<AgentSession>();

export default function Page() {
  const [tab, setTab] = useState<"editor" | "agents" | "services" | "cockpit" | "recurring" | "server" | "settings">("agents");
  // The open Settings section (null: the last one on desktop, the list of sections on the phone).
  const [settingsAt, setSettingsAt] = useState<string | null>(null);
  const openSettings = (section: string | null = null) => { setSettingsAt(section); setTab("settings"); };
  const [agentId, setAgentId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // Third center-pane mode next to terminal/review: browse the repo's .md docs.
  const [docsOpen, setDocsOpen] = useState(false);
  const [focusFile, setFocusFile] = useState<string | undefined>(undefined);
  const [editorFolder, setEditorFolder] = useState<string | undefined>(undefined);
  const [agentRecord, setSelectedAgent] = useState<AgentSession | null>(null);
  const isMobile = useIsMobile();
  // The phone's home list mounts again on each way back: it opens where the user left it.
  const homeScroll = useScrollMemory<HTMLDivElement>("phone-home");
  // Keep the shell above the mobile soft keyboard so the terminal's input line
  // and key bar stay visible/tappable while typing.
  useVisualViewportHeight();
  // Phone: the Changes bottom sheet (the files button of the agent's header).
  const [changesOpen, setChangesOpen] = useState(false);
  const closeOverlays = () => { setChangesOpen(false); };
  // "editor" and "services" are DEPRECATED: removed from the sidebar/drawer but
  // their panels stay renderable for now (editor is still reached via "Open in
  // editor" on an agent's rail).
  const TAB_LABEL: Record<typeof tab, string> = {
    agents: "Agents", editor: "Editor", services: "Services", cockpit: "GitHub", recurring: "Recurring", server: "Server", settings: "Settings",
  };
  // The Queue row in the Agents list exists only while the chief queue is on (404 hides it; 503
  // shows its misconfigured line). One useQueue() for the row, the counts and the queue view.
  const queue = useQueue();
  const queueShown = queueRowShown(queue.view);
  // The reminder badges: only once GET /api/queue answered 200 (flag off: no request).
  const reminders = useReminders(remindersEnabled(queue.view));
  const [queueOpen, setQueueOpen] = useState(false);
  useQueueKeys({
    active: queueShown,
    state: () => ({ onQueueTab: onQueueRow(tab, queueOpen), gPending: false, inReplyBox: false, voiceEnabled: false, voiceActive: false }),
    onAction: (a) => { if (a.t === "goQueue") { setTab("agents"); openQueue(); } },
  });
  // A lead row selected in the Agents list (chief on): its pane fills the center.
  const [leadSel, setLeadSel] = useState<Lead | null>(null);
  useEffect(() => {
    if (queueShown || queue.view === "loading") return;
    setQueueOpen(false); setLeadSel(null);
  }, [queueShown, queue.view]);
  // A file dropped outside of an agent pane must not open in place of the console.
  useEffect(() => guardFileDrops(window), []);
  // A deleted agent: its terminal and everything remembered of it go (lib/viewCache).
  const onAgentDeleted = (id: string) => { dropAgentTerminal(id); forgetAgent(id); if (id === agentId) selectAgent(null); };
  // The record shown is always the selected agent's: its last fetched record, else its row in the
  // agents list, then the fresh fetch. Never the previous agent's (so "Open in editor" cannot
  // briefly target its worktree), and no frame with no name in the header.
  const knownAgent = (id: string): AgentSession | null => agentRecords.get(id) ?? listedAgent(id) ?? null;
  const selectedAgent = !agentId ? null : agentRecord?.id === agentId ? agentRecord : knownAgent(agentId);
  // A worker's new title (its pane's Rename, or a rename from elsewhere): the remembered record and
  // the shown one take it, so a later open shows no old name first. The list updates itself.
  const onAgentRenamed = (id: string, title: string) => {
    const a = agentRecords.get(id);
    if (a) agentRecords.set(id, { ...a, label: title });
    setSelectedAgent((r) => (r && r.id === id ? { ...r, label: title } : r));
  };
  useEffect(() => {
    setSelectedAgent(agentId ? knownAgent(agentId) : null);
    if (!agentId) return;
    let live = true;
    void fetchAgent(agentId).then((a) => { agentRecords.set(agentId, a); if (live) setSelectedAgent(a); }).catch(() => {});
    return () => { live = false; };
  }, [agentId]);
  useEffect(() => {
    if (!changesOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChangesOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [changesOpen]);
  // Reset overlays when switching tabs so returning to a tab doesn't re-open the
  // last overlay/sheet.
  useEffect(() => { closeOverlays(); }, [tab]);
  const [editorFile, setEditorFile] = useState<string | undefined>(undefined);
  const openInEditor = (folder: string, file?: string) => { setEditorFolder(folder); setEditorFile(file); setTab("editor"); };
  // Overview decision 45: a hardened deployment has no code-server, so the
  // FileExplorer's VS Code (/editor) button hides (GET /api/brain editorOff;
  // flag off: shown as today).
  const [editorOff, setEditorOff] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchEditorOff().then((off) => { if (live) setEditorOff(off); });
    return () => { live = false; };
  }, []);
  // "PR #n" in an agent's rail → the cockpit, landed on that PR's row. seq
  // bumps per click so re-clicking the same PR re-scrolls.
  const [cockpitFocus, setCockpitFocus] = useState<CockpitFocus | null>(null);
  const seePr = (pr: { slug: string; number: number }) => {
    setCockpitFocus((f) => ({ ...pr, seq: (f?.seq ?? 0) + 1 }));
    setTab("cockpit");
  };
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [masterOpen, setMasterOpen] = useState(false);
  const selectAgent = (id: string | null) => { setMasterOpen(false); setQueueOpen(false); setLeadSel(null); setReviewing(false); setDocsOpen(false); setFocusFile(undefined); setAgentId(id); };
  const openMaster = () => { selectAgent(null); setMasterOpen(true); };
  const openQueue = () => { selectAgent(null); setQueueOpen(true); };
  const openLead = (l: Lead) => { selectAgent(null); setLeadSel(l); };
  // The Recurring section: its tasks (one read for the sidebar row's dot and the page), the
  // changes that wait for the user on a protected install, and the task that is open (null: the list).
  const recurring = useRecurring(tab === "recurring");
  const cronSpool = useCronSpool();
  const [recurringTask, setRecurringTask] = useState<string | null>(null);
  // The sidebar row always opens the list.
  const openRecurring = () => { setRecurringTask(null); setTab("recurring"); };
  // A ticket link of a run opens the Queue (no ticket link without a queue).
  const openRecurringTicket = queueShown ? () => { setTab("agents"); openQueue(); } : undefined;
  const recurringRow = { onSelect: openRecurring, needs: recurringLevel(recurring.jobs, spoolWaiting(cronSpool.view)) };
  // Also while the queue's state is unknown: the leads are read beside it, not after it (with
  // the queue off the read finds no leads).
  const leadRows = queueShown || queue.view === "loading" ? { selected: leadSel?.id ?? null, onSelect: openLead } : undefined;
  const masterRow = { selected: masterOpen, onSelect: openMaster };
  const counts = queue.view === "on" ? openCounts(queue.state.items, queue.now()) : null;
  const queueRow = queueShown ? { open: counts ? counts.total : null, byAgent: counts?.byAgent ?? {}, selected: queueOpen, onSelect: openQueue } : undefined;
  const center = agentsCenter({ agentId, leadId: leadSel?.id ?? null, masterOpen, queueOpen, queueShown });
  // A lead's pane: its thread, or its terminal (a lead is persistent: no changes rail).
  // `onBack`: the phone screen's back arrow.
  // The Coordinator has no row: its thread opens from Settings (Leads) or from one of its
  // tickets, in this same pane (a persistent agent, as a lead).
  const leadPane = (onBack?: () => void) => leadSel && (
    <div className={s.termStack}><div className={s.termFill}>
      {leadSel.id === COORDINATOR_ID
        ? <AgentPane key={leadSel.id} agentId={leadSel.id} label="Coordinator" idleText="Waiting for events" queue={queue} onBack={onBack} />
        : leadSel.waits ? <WaitsForSignIn who="This lead" onSetup={goHome} login={leadSel.waitsLogin === true} />
        : <AgentPane key={leadSel.id} agentId={leadSel.id} label={`Lead · ${leadSel.area}`} status={leadSel.status} model={leadSel.model} account={leadSel.account} queue={queue} onBack={onBack} avatar={<LeadAvatar area={leadSel.area} size={36} />} />}
    </div></div>
  );
  // "Open agent" on a ticket: the thread of its agent (a worker, a lead or the fleet master).
  const openTicketAgent = (id: string) => {
    if (id === FLEET_MASTER_ID) openMaster();
    else if (id === COORDINATOR_ID) openLead({ id, area: "", status: "" });
    else if (id.startsWith("lead-")) openLead({ id, area: id.slice("lead-".length), status: "" });
    else selectAgent(id);
  };
  const queueView = (onExit?: () => void) => <QueueView q={queue} onOpenAgent={openTicketAgent} onExit={onExit} />;
  // The Server page: the dot of its sidebar row, and "open its thread" on an agent's row.
  const serverLevel = useServerLevel();
  const openFromServer = (id: string) => { setTab("agents"); openTicketAgent(id); };
  // Hash routes (#pair=, #agent=&reconcile, #pr=, #recurring=, #brain=diff): act, then clear the hash.
  useEffect(() => {
    const apply = () => {
      const route = parseHashRoute(location.hash);
      if (!route) return;
      history.replaceState(null, "", location.pathname + location.search);
      if (route.kind === "pair") { holdPairLink(true); setPairCode(route.code); }
      else if (route.kind === "reconcile") { setTab("agents"); selectAgent(route.agentId); setReviewing(true); }
      else if (route.kind === "pr") seePr({ slug: route.slug, number: route.number });
      // The link of a run's Telegram message: the task's page (a name not in the list shows the list's own "not in the list" state).
      else if (route.kind === "recurring") { setRecurringTask(route.name); setTab("recurring"); }
      else openSettings("rules"); // #brain=diff (an old Telegram card): the rules are in Settings now
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleDocs = () => { setReviewing(false); setFocusFile(undefined); setDocsOpen((v) => !v); };
  // The Changes rail (desktop): the pane header's files button hides and shows
  // it, and each browser keeps its own choice (open by default on a wide
  // screen). The rail only renders once an agent is picked, on the client, so
  // reading storage here cannot differ from the server render. Review and Docs
  // are run from the rail, so it stays while either is open.
  const [railOpen, setRailOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return readRailOpen(window.localStorage, window.innerWidth); } catch { return readRailOpen(null, window.innerWidth); }
  });
  const toggleRail = () => setRailOpen((v) => {
    try { window.localStorage.setItem(RAIL_OPEN_KEY, v ? "0" : "1"); } catch { /* storage blocked: the choice lasts for this page */ }
    return !v;
  });
  const railShown = railOpen || reviewing || (docsOpen && !!selectedAgent?.worktree);
  // Bumped whenever an agent is spawned so AgentList re-fetches deterministically
  // (the SSE `agent-status` event can be raced/dropped), then selects it.
  const [agentReload, setAgentReload] = useState(0);
  const onSpawned = (id: string) => { setAgentReload((n) => n + 1); selectAgent(id); };
  // Desktop: the New agent form is a dialog opened by the sidebar's "+".
  const [launcherOpen, setLauncherOpen] = useState(false);
  // A new install: the Set-up page is the home of the console until its first pull request is
  // merged (lib/useSetup; always false on a console of today, which then asks for no step list).
  // Desktop: it fills the center while nothing is open. Phone: it is the first screen until the
  // user goes back to the home list, whose first row opens it again.
  const { home: setupHome, leave: leaveSetup } = useSetupHome();
  const setup = useSetup({ on: setupHome, pollMs: 30_000 });
  const setupCount = progress(setupRows(setup.answer));
  const [setupLeft, setSetupLeft] = useState(false);
  const setupNav: SetupNav = {
    go: (id) => openSettings(id),
    onNewAgent: () => setLauncherOpen(true),
    // The agent with no session file: its pane shows the terminal (lib/thread shownMode).
    onOpenTerminal: (id) => { setTab("agents"); selectAgent(id); },
    ...(queueShown ? { onOpenQueue: () => { setTab("agents"); openQueue(); } } : {}),
    onLeave: leaveSetup,
  };
  // A workspace (no-repo) agent runs at the workspace root: no branch/base, and
  // its review surface spans every repo rather than one worktree.
  const workspaceAgent = !!selectedAgent && !selectedAgent.repo;
  // The selected agent's center: its review, or its pane (with the widget strip) and docs.
  // Docs hides the terminal instead of unmounting it, so the client-side buffer (fuller than the
  // server's scrollback ring) survives a docs detour. `pane`: the files button's target (the
  // desktop rail or the phone sheet) and, on the phone, the header's back arrow.
  const agentWork = (pane: { filesOpen: boolean; onToggleFiles: () => void; onBack?: () => void }) => agentId && (reviewing
    ? <ReconcilePanel key={agentId} agentId={agentId} focusFile={focusFile} workspace={workspaceAgent} onOpenEditor={() => selectedAgent?.worktree && openInEditor(selectedAgent.worktree)} onDone={() => selectAgent(null)} />
    : (
      <>
        <div className={s.termStack} style={{ display: docsOpen && selectedAgent?.worktree ? "none" : "flex" }}>
          <div className={s.termFill}>
            <AgentPane key={agentId} agentId={agentId} label={selectedAgent?.label} branch={selectedAgent?.head ?? selectedAgent?.branch} status={selectedAgent?.status} stateWord={selectedAgent ? limitWord(selectedAgent) : null} model={selectedAgent ? agentModel(selectedAgent) : undefined} account={selectedAgent?.account} onRenamed={(t) => onAgentRenamed(agentId, t)} canStop queue={queue} {...pane} />
          </div>
        </div>
        {docsOpen && selectedAgent?.worktree && <DocsPanel key={agentId} root={selectedAgent.worktree} />}
      </>
    ));
  // The deprecated tabs: no sidebar or drawer entry, but they still render when the code sets them.
  const deprecatedTab = (
    <>
      {/* DEPRECATED as a nav destination; still reachable via "Open in editor". */}
      {/* Only openInEditor() opens this tab, and it always sets the folder first. */}
      {tab === "editor" && editorFolder && (
        <div className={s.editorHost}>
          <div className={s.editorModeBody}>
            <div style={{ height: "100%" }}>
              <FileExplorer root={editorFolder} editorOff={editorOff} file={editorFile} />
            </div>
          </div>
        </div>
      )}
      {/* DEPRECATED: the Services tab has no nav entry anymore. */}
      {tab === "services" && (
        <div className={s.editorHost}>
          <ServicesPanel />
        </div>
      )}
    </>
  );

  if (!isMobile) {
    // Desktop shell (A · Inset): one sidebar in place of the top bar and the agent column, and the
    // work area as one rounded panel. A sidebar row always lands on the Agents tab (GitHub on the
    // cockpit); while another tab is open no agent-side row is drawn selected.
    const side = sideRow(tab, center);
    const onAgents = (f: () => void) => () => { setTab("agents"); f(); };
    return (
      <div className={`${s.app} ${s.shell}`}>
        {pairCode && <PairCard key={pairCode} code={pairCode} onClose={() => { holdPairLink(false); setPairCode(null); }} />}
        <aside className={s.side} aria-label="Console">
          <div className={s.brand}>
            <BrandMark />
            <span className={s.brandName}>{DISPLAY_NAME}</span>
            <button type="button" className={s.newBtn} onClick={() => setLauncherOpen(true)} title="New agent" aria-label="New agent" aria-haspopup="dialog">
              <PlusIcon />
            </button>
          </div>
          <div className={s.sideScroll}>
            <AgentList
              setup={setupHome ? { ...setupCount, selected: tab === "agents" && center === "empty", onSelect: onAgents(() => selectAgent(null)) } : undefined}
              queue={queueRow && { ...queueRow, selected: side === "queue", onSelect: onAgents(openQueue) }}
              master={{ selected: side === "master", onSelect: onAgents(openMaster) }}
              github={{ selected: side === "github", onSelect: () => setTab("cockpit") }}
              recurring={{ ...recurringRow, selected: side === "recurring" }}
              server={{ selected: side === "server", onSelect: () => setTab("server"), level: serverLevel }}
              leads={leadRows && { selected: side === "lead" ? leadRows.selected : null, onSelect: (l) => { setTab("agents"); openLead(l); } }}
              reminders={reminders}
              selected={side === "agent" ? agentId : null} reloadSignal={agentReload} settled={queue.view !== "loading"}
              onSelect={(id) => { setTab("agents"); selectAgent(id); }} onDeleted={onAgentDeleted}
            />
          </div>
          <div className={s.foot}>
            <div className={s.acct}><AccountLine /><SettingsGear open={tab === "settings"} onClick={() => (tab === "settings" ? setTab("agents") : openSettings())} /><ThemeToggle /></div>
            <UsageMeter foot onOpen={() => openSettings("accounts")} />
          </div>
        </aside>
        <main className={s.panel}>
          {deprecatedTab}
          {tab === "cockpit" && <CockpitPanel focus={cockpitFocus} />}
          {tab === "recurring" && <RecurringPage data={recurring} spool={cronSpool} task={recurringTask} onTask={setRecurringTask} onOpenTicket={openRecurringTicket} />}
          {tab === "server" && <ServerPage onOpenAgent={openFromServer} onOpenExplorer={openInEditor} />}
          {tab === "settings" && <SettingsPage section={settingsAt} onSection={setSettingsAt} chief={queue.view} onOpenAgent={openFromServer} />}
          {tab === "agents" && (
            <div className={`${s.agents} ${agentId && railShown ? s.agentsActive : ""}`}>
              {agentId ? (
                <>
                  <div className={s.agentCenter}>{agentWork({ filesOpen: railShown, onToggleFiles: toggleRail })}</div>
                  {railShown && <ChangesRail
                    agentId={agentId}
                    status={selectedAgent?.status ?? "running"}
                    activeFile={reviewing ? focusFile : undefined}
                    onSelectFile={(rel) => { setFocusFile(rel); setDocsOpen(false); setReviewing(true); }}
                    branch={selectedAgent?.baseBranch ?? selectedAgent?.branch}
                    branchTitle={selectedAgent ? `Working on ${selectedAgent.baseBranch ?? selectedAgent.branch}${selectedAgent.baseBranch ? ` · agent branch ${selectedAgent.branch}` : ""} — click to copy` : undefined}
                    onCopyBranch={() => { const b = selectedAgent?.baseBranch ?? selectedAgent?.branch; if (b) void navigator.clipboard?.writeText(b); }}
                    worktree={selectedAgent?.worktree}
                    onOpenEditor={() => selectedAgent?.worktree && openInEditor(selectedAgent.worktree)}
                    onSeePr={seePr}
                    reviewing={reviewing}
                    onToggleReview={() => { setFocusFile(undefined); setDocsOpen(false); setReviewing((v) => !v); }}
                    docs={docsOpen}
                    onToggleDocs={toggleDocs}
                    workspace={workspaceAgent}
                    usage={false}
                  />}
                </>
              ) : center === "lead" ? (
                <div className={s.agentCenter}>{leadPane()}</div>
              ) : center === "queue" ? (
                <div className={s.agentCenter}>{queueView()}</div>
              ) : center === "master" ? (
                <div className={s.agentCenter}><MasterView queue={queue} onSetup={() => { setTab("agents"); selectAgent(null); }} /></div>
              ) : setupHome ? (
                <div className={s.agentCenter}><SetupPage setup={setup} nav={setupNav} /></div>
              ) : <div className={s.placeholder}>Select or start an agent.</div>}
            </div>
          )}
        </main>
        <NewAgentDialog open={launcherOpen} onClose={() => setLauncherOpen(false)} onManage={(at) => { setLauncherOpen(false); openSettings(at); }}
          onSpawned={(id) => { setLauncherOpen(false); setTab("agents"); onSpawned(id); }} />
      </div>
    );
  }

  // Phone (A · Inset): one screen at a time. The home list holds the sidebar's rows; a row opens
  // its screen, whose one header has the back arrow to the home list (lib/queueRow phoneScreen).
  const goHome = () => { closeOverlays(); setTab("agents"); selectAgent(null); };
  const screen = phoneScreen(tab, center);
  const agentTitle = selectedAgent?.label ?? "Agent";
  const filesBtn = (
    <PhonePillButton onClick={() => setChangesOpen((v) => !v)} pressed={changesOpen} label="Changed files"><FileIcon /></PhonePillButton>
  );
  return (
    <div className={s.app}>
      {pairCode && <PairCard key={pairCode} code={pairCode} onClose={() => { holdPairLink(false); setPairCode(null); }} />}
      <main className={s.phone}>
        {screen === "home" && setupHome && !setupLeft && (
          <div className={s.screen}><SetupPage setup={setup} nav={setupNav} onBack={() => setSetupLeft(true)} /></div>
        )}
        {screen === "home" && !(setupHome && !setupLeft) && (
          <div className={s.screen}>
            <div className={s.homeHead}>
              <BrandMark />
              <h1 className={s.homeTitle}>{DISPLAY_NAME}</h1>
              <button type="button" className={s.round} onClick={() => setLauncherOpen(true)} title="New agent" aria-label="New agent" aria-haspopup="dialog">
                <PlusIcon />
              </button>
            </div>
            <div className={s.homeScroll} ref={homeScroll.ref} onScroll={homeScroll.onScroll}>
              <AgentList
                phone setup={setupHome ? { ...setupCount, selected: false, onSelect: () => setSetupLeft(false) } : undefined}
                master={masterRow} queue={queueRow} github={{ selected: false, onSelect: () => setTab("cockpit") }}
                recurring={{ ...recurringRow, selected: false }}
                server={{ selected: false, onSelect: () => setTab("server"), level: serverLevel }}
                leads={leadRows} reminders={reminders} selected={null} reloadSignal={agentReload} settled={queue.view !== "loading"}
                onSelect={(id) => selectAgent(id)} onDeleted={onAgentDeleted}
              />
              <SettingsHomeRow onClick={() => openSettings()} />
              <div className={s.homeFoot}>
                <div className={s.acct}><AccountLine /><ThemeToggle /></div>
                <UsageMeter foot onOpen={() => openSettings("accounts")} />
              </div>
            </div>
          </div>
        )}
        {screen === "github" && (
          <div className={s.screen}>
            <div className={s.screenBody}><CockpitPanel focus={cockpitFocus} onBack={goHome} /></div>
          </div>
        )}
        {screen === "recurring" && <div className={s.screen}><RecurringPage data={recurring} spool={cronSpool} task={recurringTask} onTask={setRecurringTask} onOpenTicket={openRecurringTicket} onBack={goHome} /></div>}
        {screen === "server" && <div className={s.screen}><ServerPage onBack={goHome} onOpenAgent={openFromServer} onOpenExplorer={openInEditor} /></div>}
        {screen === "tab" && (
          <div className={s.screen}>
            <PhoneHeader onBack={goHome} title={TAB_LABEL[tab]} />
            <div className={s.screenBody}>{deprecatedTab}</div>
          </div>
        )}
        {screen === "settings" && <div className={s.screen}><SettingsPage phone section={settingsAt} onSection={setSettingsAt} onBack={goHome} chief={queue.view} onOpenAgent={openFromServer} /></div>}
        {screen === "queue" && <div className={s.screen}>{queueView(goHome)}</div>}
        {screen === "master" && <div className={s.screen}><MasterView queue={queue} onBack={goHome} onSetup={goHome} /></div>}
        {screen === "lead" && <div className={s.screen}>{leadPane(goHome)}</div>}
        {screen === "agent" && (
          <div className={s.screen}>
            {/* The review and the docs have no pane header: theirs goes back to the pane. */}
            {reviewing ? (
              <PhoneHeader onBack={() => { setFocusFile(undefined); setReviewing(false); }} title={agentTitle} sub="Review" right={filesBtn} />
            ) : docsOpen && selectedAgent?.worktree ? (
              <PhoneHeader onBack={() => setDocsOpen(false)} title={agentTitle} sub="Docs" right={filesBtn} />
            ) : null}
            <div className={s.screenBody}>
              {agentWork({ filesOpen: changesOpen, onToggleFiles: () => setChangesOpen((v) => !v), onBack: goHome })}
            </div>
          </div>
        )}
      </main>
      {/* The Changes sheet: the rail of the desktop, from the bottom. */}
      {changesOpen && agentId && screen === "agent" && (
        <>
          <div className={s.sheetBackdrop} onClick={() => setChangesOpen(false)} />
          <div className={s.sheet} role="dialog" aria-label="Changes">
            <button type="button" className={s.grabber} onClick={() => setChangesOpen(false)} aria-label="Close the changes" title="Close">
              <span aria-hidden />
            </button>
            <div className={s.sheetBody}>
              <ChangesRail
                agentId={agentId}
                status={selectedAgent?.status ?? "running"}
                activeFile={reviewing ? focusFile : undefined}
                onSelectFile={(rel) => { setFocusFile(rel); setDocsOpen(false); setReviewing(true); setChangesOpen(false); }}
                branch={selectedAgent?.baseBranch ?? selectedAgent?.branch}
                branchTitle={selectedAgent ? `Working on ${selectedAgent.baseBranch ?? selectedAgent.branch}` : undefined}
                onCopyBranch={() => { const b = selectedAgent?.baseBranch ?? selectedAgent?.branch; if (b) void navigator.clipboard?.writeText(b); }}
                worktree={selectedAgent?.worktree}
                onOpenEditor={() => { if (selectedAgent?.worktree) { openInEditor(selectedAgent.worktree); setChangesOpen(false); } }}
                onSeePr={(pr) => { seePr(pr); setChangesOpen(false); }}
                reviewing={reviewing}
                onToggleReview={() => { setFocusFile(undefined); setDocsOpen(false); setReviewing((v) => !v); setChangesOpen(false); }}
                docs={docsOpen}
                onToggleDocs={() => { toggleDocs(); setChangesOpen(false); }}
                workspace={workspaceAgent}
                usage={false}
              />
            </div>
          </div>
        </>
      )}
      <NewAgentDialog open={launcherOpen} onClose={() => setLauncherOpen(false)} onManage={(at) => { setLauncherOpen(false); openSettings(at); }}
        onSpawned={(id) => { setLauncherOpen(false); setTab("agents"); onSpawned(id); }} />
    </div>
  );
}
