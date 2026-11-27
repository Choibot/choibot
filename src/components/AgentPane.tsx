// src/components/AgentPane.tsx — the middle column of one agent: the header
// (title, status, branch, the Thread | Terminal switch, Interrupt / Stop, the
// changed files; the Claude login of a lead or the fleet master), the widget line of a worker, then the thread (default) or
// the terminal, then the composer.
// The thread is built from the agent's Claude session file. One switch in the
// header goes to the raw terminal and back; the choice is kept per browser.
// With no session file to read (a Codex agent, a new agent with no session
// yet) the terminal shows, whatever the choice is.
// Two things the session file cannot tell come from elsewhere:
//   - a terminal dialog the agent waits on: the prompt card above the composer
//     (PromptCard, from the server's read of the agent's screen);
//   - a running agent that wrote nothing for 10 minutes: the amber "no output"
//     mark in the header and on the live line (quietMs in lib/thread.ts).
"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { XtermTerminal } from "./XtermTerminal";
import { AgentComposer, type ComposerHandle } from "./Composer";
import { ThreadView } from "./ThreadView";
import { useOutbox } from "../lib/useOutbox";
import { PromptCard } from "./PromptCard";
import { WidgetStrip, widgetsKnown } from "./WidgetStrip";
import { PhoneHeader, PhoneIconButton, PhonePillButton } from "./PhoneHeader";
import { LoginLimitLine } from "./LoginLimitLine";
import { LoginList, LoginPick, loginButtonText, useAgentLogin } from "./LoginPick";
import { CheckIcon, FileIcon, MoreIcon } from "./SideIcons";
import { threadKnown, useThread } from "../lib/useThread";
import { usePrompt } from "../lib/usePrompt";
import { chiefFetch } from "../lib/chief";
import { agentChangedFiles, agentModel, changedFilesMemory, fetchAgent, modelTag, renameAgent } from "../lib/agents";
import { TITLE_MAX } from "../../server/agents/title";
import { sendKeys } from "../lib/prompt";
import { hasFiles } from "../lib/upload";
import { answerImages, hasImage, ticketAt } from "../lib/answerImages";
import { PANE_MODE_KEY, quietLabel, quietMs, readPaneMode, shownMode, subsChip, type PaneMode } from "../lib/thread";
import type { UseQueue } from "../lib/useQueue";
import s from "./AgentPane.module.css";

// Idle means it is the user's turn.
const STATUS: Record<string, { text: string; tone: string }> = {
  running: { text: "Running", tone: "run" },
  idle: { text: "Waiting for you", tone: "turn" },
  done: { text: "Done", tone: "done" },
  error: { text: "Error", tone: "err" },
};
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

// How often the header looks at the clock for the quiet mark (it shows minutes).
const QUIET_TICK_MS = 10_000;
// How long a header button shows the result of its request.
const FLASH_MS = 1600;
// How often the header reads the count of changed files (the Changes rail has the list).
const FILES_POLL_MS = 5000;
// A first open of a worker: the thread waits for the widget list, so the two land in one frame (a
// strip that came later pushed the read thread down). At most this long after the thread is in,
// and this long in all.
const STRIP_AFTER_MS = 200;
const STRIP_WAIT_MS = 800;

// The clock, moving only while `on` (a running agent with a session time).
function useNow(on: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs]);
  return now;
}

// The number of changed files in the agent's worktree; null until known (the
// last list seen counts at first). A failed read keeps the last count.
function useChangedCount(agentId: string, on: boolean): number | null {
  const [n, setN] = useState<number | null>(() => changedFilesMemory.get(agentId)?.length ?? null);
  useEffect(() => {
    setN(changedFilesMemory.get(agentId)?.length ?? null);
    if (!on) return;
    let live = true;
    const read = () => void agentChangedFiles(agentId).then((r) => { changedFilesMemory.set(agentId, r.files); if (live) setN(r.files.length); }, () => {});
    read();
    const t = setInterval(read, FILES_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [agentId, on]);
  return n;
}

// `canStop` false: a persistent agent (a lead). The list has no Stop for it either.
// `queue`: the page's one useQueue(); the thread shows this agent's tickets from it.
// `activity`: the fleet master's pane: its chat hides the event digests and its "(quiet)" replies
// (lib/quietChecks.ts) unless `shown`; `toggle` is the one "Show activity" control (the header
// on the desktop, the menu on the phone).
// `onToggleFiles`: the header's files button shows or hides the Changes rail
// (`filesOpen` = it shows). With none the button only shows the count.
// `onBack` (the phone shell): the header is the phone screen's one header, with the back
// arrow; the Thread | Terminal switch, Interrupt and Stop move into its "more" menu.
// `headExtra`: a control of the pane's owner on a row of its own under the header line (the
// fleet master's lead switch); `metaExtra`: more text on the status line (the master's status line).
// `avatar`: a lead's avatar, before the title of the header.
// `idleText`: what an idle agent waits for when it is not the user (the Coordinator: the next event).
// `model`: the model the agent runs on (lib/agents agentModel), a quiet word on the status line.
// Not given (undefined) for an agent that is not a worker: the pane reads its record once.
// `account`: the Claude login it runs under, after the model ("opus · @choibot"); absent = the default.
// `onRenamed`: a worker's new title (its Rename here, or a rename from elsewhere), for the page.
export function AgentPane({ agentId, label, branch, status: statusHint, stateWord, canStop = false, queue, activity, filesOpen = false, onToggleFiles, onBack, headExtra, metaExtra, avatar, idleText, model, account, onRenamed }: {
  // `stateWord`: a limit is in the way of the agent ("stopped at a limit", "waits for a login").
  agentId: string; label?: string; branch?: string | null; status?: string; stateWord?: string | null; canStop?: boolean; queue?: UseQueue; activity?: { shown: boolean; toggle: () => void }; idleText?: string;
  filesOpen?: boolean; onToggleFiles?: () => void; onBack?: () => void; headExtra?: ReactNode; metaExtra?: string; avatar?: ReactNode;
  model?: string | null; account?: string | null; onRenamed?: (title: string) => void;
}) {
  // A worker (canStop): not a lead and not the master. Only a worker has a
  // Changes rail and widgets.
  const worker = canStop;
  const [pref, setPref] = useState<PaneMode>(() => {
    // Reading the storage object itself throws when the browser blocks it.
    try { return typeof window === "undefined" ? "thread" : readPaneMode(window.localStorage); } catch { return "thread"; }
  });
  // The card and the header actions are for the thread. A user who chose the
  // raw terminal sees the dialog there and has the keyboard.
  const threadPref = pref === "thread";
  const prompt = usePrompt(agentId, threadPref);
  // Rename (a worker): the title is edited in place; Enter saves, Escape leaves. `named`: the title
  // saved here or by a rename from elsewhere (the event), until the page's record has it.
  const [named, setNamed] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(nameTimer.current), []);
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;
  const thread = useThread(agentId, threadPref, {
    onEvent: (e) => {
      prompt.onEvent(e);
      if (e.type === "agent-renamed" && e.agentId === agentId) { setNamed(e.label); onRenamedRef.current?.(e.label); }
    },
    onOpen: prompt.refresh,
  });
  const mode = shownMode(pref, thread.available);
  // What the user sent and the agent's file does not show as its own entry yet.
  const outbox = useOutbox(agentId, thread.state, thread.status, thread.skew, thread.kick);
  const choose = useCallback((next: PaneMode) => {
    setPref(next);
    try { window.localStorage.setItem(PANE_MODE_KEY, next); } catch { /* storage blocked: the choice lasts for this page */ }
  }, []);

  const status = thread.status ?? statusHint ?? "";
  const running = status === "running";
  const card = running || status === "idle" ? prompt.prompt : null;

  // Quiet: no session entry for 10 minutes while running. With a dialog on
  // screen the cause is known (the agent waits on the user): the card says it.
  const now = useNow(running && thread.quietSince !== null, QUIET_TICK_MS);
  const quiet = card ? null : quietMs(status, thread.quietSince, now + thread.skew);

  // Between turns with subagents at work it is not the user's turn: the agent
  // goes on by itself when they end.
  const subsWork = subsChip(status, thread.state);
  // A limit in the way of the agent (its turn was cut, or it waits for a login): said in plain
  // words. Such an agent is not "Waiting for you".
  const st = stateWord && !card && status !== "running"
    ? { text: cap(stateWord), tone: "warn" }
    : card
    ? { text: "Waiting for you", tone: "turn" }
    : quiet !== null
      ? { text: cap(quietLabel(quiet)), tone: "warn" }
      : subsWork !== null
        ? { text: cap(subsWork), tone: "run" }
        : status === "idle" && idleText
          ? { text: idleText, tone: "done" }
          : STATUS[status] ?? { text: cap(status), tone: "run" };
  const chipTitle = card
    ? "The agent waits on a prompt. Answer it below."
    : quiet !== null
      ? "The session got no new entry for this long. A long tool run or a subagent can be the cause."
      : subsWork !== null
        ? "The agent is between turns. Its subagents still work, and it goes on when they end."
        : undefined;

  // Interrupt sends Esc, with no question first. With a dialog on screen Esc
  // would answer the dialog (in the trust dialog it exits): the card has the keys.
  const [flash, setFlash] = useState<{ what: "interrupt" | "stop"; ok: boolean } | null>(null);
  const [acting, setActing] = useState<"interrupt" | "stop" | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const show = useCallback((what: "interrupt" | "stop", ok: boolean) => {
    setActing(null);
    setFlash({ what, ok });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  const interrupt = useCallback(() => {
    setActing("interrupt");
    void sendKeys(agentId, ["esc"]).then((o) => show("interrupt", o.kind === "sent"));
  }, [agentId, show]);
  // Stop is the list's Stop: the same route, no question first. The status
  // event that follows updates the list and this header.
  const stop = useCallback(() => {
    setActing("stop");
    void chiefFetch(`/api/agents/${encodeURIComponent(agentId)}/stop`, { method: "POST" })
      .then((r) => show("stop", r.ok), () => show("stop", false));
  }, [agentId, show]);

  const title = named ?? label;
  const rename = useCallback((raw: string) => {
    setNaming(false);
    const next = raw.trim();
    if (!next || next === title) return;
    const before = named;
    setNamed(next);
    setNameErr(null);
    void renameAgent(agentId, next).then((why) => {
      if (!why) { onRenamedRef.current?.(next); return; }
      setNamed(before);
      setNameErr(why);
      clearTimeout(nameTimer.current);
      nameTimer.current = setTimeout(() => setNameErr(null), FLASH_MS * 3);
    });
  }, [agentId, named, title]);
  const nameInput = naming && (
    <TitleInput value={title ?? ""} onSave={rename} onLeave={() => setNaming(false)} />
  );

  // The model and the login: the page's words for a worker or a lead; else (the fleet master, the
  // Coordinator) the agent's own record, read once. Unknown: no word.
  const [own, setOwn] = useState<{ model?: string; account?: string }>({});
  useEffect(() => {
    if (model !== undefined || worker) return;
    let live = true;
    void fetchAgent(agentId).then((a) => { if (live) setOwn({ model: agentModel(a), account: a.account }); }, () => {});
    return () => { live = false; };
  }, [agentId, model, worker]);
  const tag = modelTag(model ?? own.model, account ?? own.account);
  const modelPart = tag && <><span className={s.sep} aria-hidden>·</span><span className={s.model} data-model-tag="" title={tag.title}>{tag.text}</span></>;

  // The phone menu closes on a press: the result shows on the header's status line.
  const flashText = !onBack ? null
    : nameErr ? "Not renamed"
    : !flash ? null
    : flash.what === "interrupt" ? (flash.ok ? "Interrupt sent" : "Interrupt not sent")
    : flash.ok ? null : "Not stopped";

  // Under the raw terminal (no session file yet) a known dialog still gets its
  // buttons. An unknown one would only repeat the terminal and its key bar.
  const showCard = card !== null && !(mode === "terminal" && card.kind === "unknown");
  const showInterrupt = threadPref && running;
  const showStop = threadPref && canStop && (running || status === "idle");
  const noThread = thread.available === false;
  const files = useChangedCount(agentId, worker);
  // The Claude login of a lead, the fleet master or the helper for tickets: on the phone a row of
  // the "more" menu opens its list (the header has no room for a button). The desktop has the
  // button in the header (LoginPick). A worker has it in its rail.
  const phoneLogin = useAgentLogin(agentId, !worker && onBack !== undefined);
  const [loginOpen, setLoginOpen] = useState(false);
  // A remembered thread shows at once (no wait: an empty pane is the worse blink).
  const [stripKnown, setStripKnown] = useState(() => !worker || widgetsKnown(agentId) || threadKnown(agentId));
  const onStripKnown = useCallback(() => setStripKnown(true), []);
  const threadIn = thread.available !== null;
  useEffect(() => {
    if (stripKnown) return;
    const t = setTimeout(() => setStripKnown(true), threadIn ? STRIP_AFTER_MS : STRIP_WAIT_MS);
    return () => clearTimeout(t);
  }, [stripKnown, threadIn]);
  const showFiles = worker && (onToggleFiles !== undefined || (files ?? 0) > 0);
  const filesText = files === null ? "Files" : files === 1 ? "1 file" : `${files} files`;
  // Not known yet: the button keeps the width of a count, so the buttons beside it do not move
  // when the count lands.
  const filesShown = files === null ? <span style={{ visibility: "hidden" }}>0 files</span> : filesText;

  // In the thread view a file dropped anywhere on the pane goes to the
  // composer, which uploads it and shows its path. (The terminal takes its own
  // drops.) While a file is over the pane a cover shows the target: the cover
  // takes the drag events, so leaving it is leaving the pane.
  // Over a ticket card that takes images (ThreadTicket), an image goes with that ticket's reply.
  const composerRef = useRef<ComposerHandle>(null);
  const [dropping, setDropping] = useState(false);
  const [dropTicket, setDropTicket] = useState(false);
  const dropZone = mode !== "terminal";
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    const ticket = ticketAt(e.clientX, e.clientY);
    if (ticket && hasImage(files)) answerImages.add(ticket, files);
    else composerRef.current?.attach(files);
  };
  return (
    <div
      className={s.pane} data-mode={mode} data-phone={onBack ? "" : undefined}
      onDragEnter={dropZone ? (e) => { if (hasFiles(e.dataTransfer)) setDropping(true); } : undefined}
      onDragOver={dropZone ? (e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); } : undefined}
      onDrop={dropZone ? (e) => { if (hasFiles(e.dataTransfer)) onDrop(e); } : undefined}
    >
      {dropZone && dropping && (
        <div
          className={s.drop}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropTicket(ticketAt(e.clientX, e.clientY) !== null); }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => { e.stopPropagation(); onDrop(e); }}
        >
          {dropTicket ? (
            <div className={s.dropBox}>
              <b>Drop to add to your answer</b>
              <span>The image goes with your answer to this ticket.</span>
            </div>
          ) : (
            <div className={s.dropBox}>
              <b>Drop to attach</b>
              <span>The file goes to the agent. Its path shows in the message box.</span>
            </div>
          )}
        </div>
      )}
      {onBack ? (
        <PhoneHeader
          onBack={onBack} icon={avatar} title={nameInput || (title ?? "Agent")}
          sub={<>
            <span className={s.dot} data-tone={flashText && (nameErr || !flash?.ok) ? "err" : st.tone} aria-hidden />
            <span className={s.state} data-tone={st.tone} title={nameErr ?? chipTitle} role={st.tone === "warn" || flashText ? "status" : undefined}>{flashText ?? (st.text || "\u00A0")}</span>
            {modelPart}
            {branch && <><span className={s.sep} aria-hidden>·</span><span className={s.branch} title={branch}>{branch}</span></>}
            {metaExtra && <><span className={s.sep} aria-hidden>·</span><span className={s.extra}>{metaExtra}</span></>}
          </>}
          right={<>
            <PaneMenu items={[
              { key: "thread", label: "Thread", checked: mode !== "terminal", disabled: noThread, onSelect: () => choose("thread") },
              { key: "terminal", label: "Terminal", checked: mode === "terminal", onSelect: () => choose("terminal") },
              ...(activity ? [{ key: "activity", label: "Show activity", sep: true, checked: activity.shown, disabled: mode === "terminal", onSelect: activity.toggle }] : []),
              ...(phoneLogin ? [{ key: "login", label: `Claude login: ${loginButtonText(phoneLogin, 14)}`, sep: true, onSelect: () => { void phoneLogin.load(); setLoginOpen(true); } }] : []),
              ...(worker ? [{ key: "rename", label: "Rename", sep: true, onSelect: () => setNaming(true) }] : []),
              ...(showInterrupt ? [{ key: "interrupt", label: "Interrupt", sep: true, disabled: acting !== null || card !== null, onSelect: interrupt }] : []),
              ...(showStop ? [{ key: "stop", label: "Stop", sep: !showInterrupt, disabled: acting !== null, onSelect: stop }] : []),
            ]} edge={!(worker && onToggleFiles)} />
            {/* The list of the menu's "Claude login" row, under the right end of the header. */}
            {loginOpen && phoneLogin && (
              <span className={s.loginAnchor}>
                <LoginList agentId={agentId} status={status} login={phoneLogin} onClose={() => setLoginOpen(false)} />
              </span>
            )}
            {worker && onToggleFiles && (
              <PhonePillButton onClick={onToggleFiles} pressed={filesOpen} label={filesText === "Files" ? "Changed files" : `${filesText} changed`}>
                <FileIcon />{files ?? ""}
              </PhonePillButton>
            )}
          </>}
          extra={headExtra}
        />
      ) : (
        <header className={s.head} data-acts={(showInterrupt ? 1 : 0) + (showStop ? 1 : 0)} data-files={showFiles ? "" : undefined}>
          <div className={s.line}>
            {avatar && <span className={s.avatar}>{avatar}</span>}
            <div className={s.ttl}>
              {/* Always there: the line keeps its height while the agent's record is read. */}
              {/* A worker's title is its Rename: a click edits it in place. */}
              {nameInput ? <b className={s.label}>{nameInput}</b>
                : worker ? <button type="button" className={`${s.label} ${s.labelBtn}`} title={title ? `${title} · Rename` : "Rename"} onClick={() => setNaming(true)}>{title ?? "\u00A0"}</button>
                : <b className={s.label} title={title}>{title ?? "\u00A0"}</b>}
              <small className={s.meta}>
                <span className={s.dot} data-tone={nameErr ? "err" : st.tone} aria-hidden />
                {nameErr ? <span className={s.state} data-tone="err" title={nameErr} role="status">Not renamed</span>
                  : st.text && <span className={s.state} data-tone={st.tone} title={chipTitle} role={st.tone === "warn" ? "status" : undefined}>{st.text}</span>}
                {modelPart}
                {branch && <><span className={s.sep} aria-hidden>·</span><span className={s.branch} title={branch}>{branch}</span></>}
                {metaExtra && <><span className={s.sep} aria-hidden>·</span><span className={s.extra} title={metaExtra}>{metaExtra}</span></>}
              </small>
            </div>
            {!worker && <LoginPick agentId={agentId} status={status} className={s.login} />}
            <div className={s.switch} role="group" aria-label="Agent view">
              <button
                type="button" className={s.seg} aria-pressed={mode !== "terminal"} disabled={noThread}
                title={noThread ? "No session file to read: the terminal only" : "The conversation, from the session file"}
                onClick={() => choose("thread")}
              >Thread</button>
              <button
                type="button" className={s.seg} aria-pressed={mode === "terminal"}
                title="The raw terminal" onClick={() => choose("terminal")}
              >Terminal</button>
            </div>
            {activity && mode !== "terminal" && (
              <button
                type="button" className={`${s.act} ${s.quietAct}`} aria-pressed={activity.shown} onClick={activity.toggle}
                title={activity.shown ? "Hide the event lines of the console and the (quiet) replies" : "Show what the console typed into this chat and the (quiet) replies"}
              >{activity.shown ? "Hide activity" : "Show activity"}</button>
            )}
            {showInterrupt && (
              <button
                type="button" className={s.act} onClick={interrupt}
                disabled={acting !== null || card !== null}
                data-failed={flash?.what === "interrupt" && !flash.ok ? "" : undefined}
                title={card ? "The agent waits on a prompt: answer it in the card" : "Send Esc to the agent: it stops the current step"}
              >{flash?.what === "interrupt" ? (flash.ok ? "Sent" : "Not sent") : "Interrupt"}</button>
            )}
            {showStop && (
              <button
                type="button" className={s.act} onClick={stop} disabled={acting !== null}
                data-failed={flash?.what === "stop" && !flash.ok ? "" : undefined}
                title="Stop the session (frees its memory)"
              >{flash?.what === "stop" && !flash.ok ? "Not stopped" : "Stop"}</button>
            )}
            {showFiles && (onToggleFiles ? (
              <button type="button" className={s.files} aria-pressed={filesOpen} onClick={onToggleFiles} title={filesOpen ? "Hide the changed files" : "Show the changed files"}>
                <FilesIcon />{filesShown}
              </button>
            ) : (
              <span className={s.files} title="Changed files in the worktree: see the Changes rail"><FilesIcon />{filesShown}</span>
            ))}
          </div>
          {headExtra && <div className={s.under}>{headExtra}</div>}
        </header>
      )}
      {/* The Claude login of this agent is at its limit: one line and the button that moves it. */}
      <LoginLimitLine agentId={agentId} />
      {worker && <WidgetStrip agentId={agentId} onKnown={onStripKnown} />}
      <div className={`${s.body} composerCol`}>
        {mode === "terminal" ? (
          <XtermTerminal wsPath={`/api/agents/${agentId}/terminal`} uploadPath={`/api/agents/${agentId}/upload`} keepKey={agentId} />
        ) : (
          <ThreadView
            state={stripKnown ? thread.state : null} status={thread.status} skew={thread.skew}
            loadingOlder={thread.loadingOlder} onLoadOlder={thread.loadOlder}
            quiet={quiet}
            agentId={agentId} queue={queue} hideActivity={activity ? !activity.shown : false} outbox={outbox}
          />
        )}
        {card && showCard && (
          <div className={s.prompt}>
            <PromptCard prompt={card} who={label} busy={prompt.busy} note={prompt.note} onPress={(keys, rev) => void prompt.press(keys, rev)} />
          </div>
        )}
        <div className={s.composer}><AgentComposer ref={composerRef} agentId={agentId} attachButton={dropZone} queueList={mode !== "thread" || !stripKnown} /></div>
      </div>
    </div>
  );
}

// The panel icon of the files button (the Changes rail on the right).
function FilesIcon() {
  return (
    <svg className={s.icon} viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" />
    </svg>
  );
}

// The title edited in place: the same font and line as the title. Enter saves, Escape leaves (and
// so does a press elsewhere: only Enter saves).
function TitleInput({ value, onSave, onLeave }: { value: string; onSave: (v: string) => void; onLeave: () => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const end = (f: () => void) => { if (done.current) return; done.current = true; f(); };
  return (
    <input
      ref={ref} className={s.nameInput} value={v} maxLength={TITLE_MAX} aria-label="Agent title" enterKeyHint="done"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); end(() => onSave(v)); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(onLeave); }
      }}
      onBlur={() => end(onLeave)}
    />
  );
}

type MenuItem = { key: string; label: string; checked?: boolean; disabled?: boolean; sep?: boolean; onSelect: () => void };

// The phone header's "more" menu: the view switch (a check on the one shown), then Interrupt and
// Stop. A press runs the item and closes the menu; a tap outside or Esc closes it.
// `edge`: no files pill after the button (a lead, the fleet master): the menu ends at the button,
// inside the screen, not under the pill.
function PaneMenu({ items, edge = false }: { items: MenuItem[]; edge?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className={s.menuWrap} ref={ref} data-edge={edge ? "" : undefined}>
      <PhoneIconButton label="More" expanded={open} onClick={() => setOpen((v) => !v)}><MoreIcon /></PhoneIconButton>
      {open && (
        <div className={s.menu} role="menu" aria-label="Agent actions">
          {items.map((i) => (
            <button
              key={i.key} type="button" role={i.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={i.checked} disabled={i.disabled} className={s.menuItem} data-sep={i.sep ? "" : undefined}
              onClick={() => { setOpen(false); i.onSelect(); }}
            >
              <span className={s.menuCheck} aria-hidden>{i.checked && <CheckIcon />}</span>
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
