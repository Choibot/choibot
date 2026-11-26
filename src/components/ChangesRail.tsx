// src/components/ChangesRail.tsx — the inspector on the right of an agent's
// panel (A · Inset): text tabs Changes / Plan / Docs, the branch line, the open
// PR's checks line, Review and Open in editor, then the body. Changes lists the
// agent's edited files in sections (Uncommitted, Committed); Plan renders the
// live task list or the newest superpowers plan doc as tasks/steps, polled so
// checkbox ticks show up live; Docs switches the center to the repo's docs.
// Workspace agents have no single worktree: no Plan and no Docs tab.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentChangedFiles, agentTasks, changedFilesMemory, discardAgentFile, type AgentTask, type ChangedFile } from "../lib/agents";
import { fetchAgentPr, fetchPrCi, type AgentPr, type PrCi } from "../lib/gh";
import { sortCheckRuns, formatDuration } from "../lib/cockpit";
import { planPointer, readFileContent, type PlanPointer } from "../lib/files";
import { parsePlan, planProgress, taskStates, type ParsedPlan } from "../lib/plan";
import { useFold } from "../lib/useFold";
import { checksLine, fileSections } from "../lib/rail";
import { AGENT_MAX, agentMemory, useRemembered, viewMemory } from "../lib/viewCache";
import { BranchIcon, GitStateBar } from "./GitStateBar";
import { CheckIcon, ChevronIcon, CloseIcon, ExternalIcon, Mark } from "./SideIcons";
import { AccountBar } from "./AccountBar";
import { UsageMeter } from "./UsageMeter";
import s from "./ChangesRail.module.css";

// Status → short glyph + color class. Mirrors git porcelain shorthand.
const GLYPH: Record<ChangedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

// Commit-state → the word shown on the right of each row.
const STATE_LABEL: Record<ChangedFile["state"], string> = {
  committed: "committed",
  uncommitted: "uncommitted",
  untracked: "untracked",
};

// Field-wise equality for the live-task poll: unchanged responses keep the
// previous array identity, so idle 2s ticks don't re-render the rail.
function sameTasks(a: AgentTask[], b: AgentTask[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) =>
    t.id === b[i].id && t.subject === b[i].subject &&
    t.activeForm === b[i].activeForm && t.status === b[i].status);
}

// What the rail showed of each agent the last time (lib/viewCache): an agent opened again shows
// its files, PR, checks and plan on the first frame, and a switch never shows the prior agent's.
const NO_FILES: ChangedFile[] = [];
const NO_TASKS: AgentTask[] = [];
const NO_POINTER: PlanPointer = {};
const prs = agentMemory<AgentPr | null>();
const tasksSeen = agentMemory<AgentTask[]>();
const pointers = viewMemory<PlanPointer>(AGENT_MAX); // by worktree
const plans = viewMemory<{ key: string; parsed: ParsedPlan } | null>(AGENT_MAX); // by worktree
const cis = viewMemory<PrCi | null>(AGENT_MAX); // by slug#number

function splitPath(rel: string): { dir: string; base: string } {
  const i = rel.lastIndexOf("/");
  return i < 0 ? { dir: "", base: rel } : { dir: rel.slice(0, i + 1), base: rel.slice(i + 1) };
}

export function ChangesRail({
  agentId,
  status,
  activeFile,
  onSelectFile,
  branch,
  branchTitle,
  onCopyBranch,
  worktree,
  onOpenEditor,
  onSeePr,
  reviewing,
  onToggleReview,
  docs,
  onToggleDocs,
  workspace,
  usage = true,
}: {
  agentId: string;
  status: string;
  activeFile?: string;
  onSelectFile: (rel: string) => void;
  branch?: string;
  branchTitle?: string;
  onCopyBranch?: () => void;
  worktree?: string;
  onOpenEditor?: () => void;
  // Jump to the agent's open PR in the cockpit. When set and the branch has an
  // open PR, the Editor button becomes "PR #n" targeting that row.
  onSeePr?: (pr: { slug: string; number: number }) => void;
  reviewing: boolean;
  onToggleReview: () => void;
  // Docs mode: the center pane shows the repo's .md files instead of the
  // terminal. The toggle lives here so all center-pane switches share one row.
  docs: boolean;
  onToggleDocs: () => void;
  // Workspace (no-repo) agent: no single HEAD/base, so the git-state bar is
  // meaningless and changed-file paths are namespaced `<repo>/<path>`.
  workspace?: boolean;
  // The usage section at the bottom (the phone's Changes sheet). The desktop shell shows usage in
  // the sidebar footer instead.
  usage?: boolean;
}) {
  const [files, setFiles] = useRemembered(changedFilesMemory, agentId, NO_FILES);
  // Slow the poll once the agent is settled — its tree changes rarely then.
  const interval = status === "done" || status === "error" ? 5000 : 2000;

  const liveRef = useRef(true);
  const reload = useCallback(() => {
    void agentChangedFiles(agentId)
      .then((r) => { if (liveRef.current) setFiles(r.files); })
      .catch(() => { /* transient — keep last good list */ });
  }, [agentId, setFiles]);

  useEffect(() => {
    liveRef.current = true;
    reload();
    const t = setInterval(reload, interval);
    return () => { liveRef.current = false; clearInterval(t); };
  }, [reload, interval]);

  // ---- Plan view state -----------------------------------------------------
  // Selected rail segment, persisted like the CI fold. Workspace agents have
  // no plan (no single worktree), so they are pinned to "changes".
  const [view, setViewRaw] = useState<"changes" | "plan">(() => {
    if (typeof window === "undefined") return "changes";
    try { return window.localStorage.getItem("rail.view") === "plan" ? "plan" : "changes"; }
    catch { return "changes"; }
  });
  const setView = (v: "changes" | "plan") => {
    setViewRaw(v);
    try { window.localStorage.setItem("rail.view", v); } catch { /* private mode */ }
  };

  // Newest plan pointer, polled on the rail's cadence (the `worktree` prop is
  // the poll root); content re-fetched and re-parsed only when the pointer
  // (path or mtime) actually changes, so checkbox ticks appear live without
  // reparsing every 2s.
  const [pointer, setPointer] = useRemembered(pointers, worktree ?? null, NO_POINTER);
  const [plan, setPlan] = useRemembered(plans, worktree ?? null, null);
  useEffect(() => {
    if (workspace || !worktree) return;
    let live = true;
    const load = () => {
      void planPointer(worktree)
        // Keep the previous identity when nothing changed so idle poll ticks
        // don't re-render the rail (and don't retrigger the content effect).
        .then((p) => {
          if (live) setPointer((cur) => (cur.path === p.path && cur.mtime === p.mtime ? cur : p));
        })
        .catch(() => { /* transient — keep last good pointer */ });
    };
    load();
    const t = setInterval(load, interval);
    return () => { live = false; clearInterval(t); };
  }, [worktree, interval, workspace, setPointer]);

  // Live harness tasks — the agent's own progress tracking. Tasks-first:
  // when present they are the PLAN source; the checkbox plan doc is the
  // fallback for sessions that don't use the task tools.
  const [liveTasks, setLiveTasks] = useRemembered(tasksSeen, agentId, NO_TASKS);
  useEffect(() => {
    if (workspace || !worktree) return;
    let live = true;
    const load = () => {
      void agentTasks(agentId)
        // Same identity-preservation as the pointer poll: unchanged list → no render.
        .then((r) => { if (live) setLiveTasks((cur) => (sameTasks(cur, r.tasks) ? cur : r.tasks)); })
        .catch(() => { /* transient — keep last good list */ });
    };
    load();
    const t = setInterval(load, interval);
    return () => { live = false; clearInterval(t); };
  }, [agentId, interval, workspace, worktree, setLiveTasks]);

  // Fetch + parse when the pointer changes identity. `key` ties the parse to
  // its pointer so a stale parse is never shown against a newer pointer, and
  // the header reads its filename back off that key.
  const pointerKey = pointer.path ? `${pointer.path}@${pointer.mtime}` : null;
  // Bumped after a failed read to re-run the effect. Without it a single blip
  // would strand the view: the pointer keeps reporting the same path@mtime, so
  // nothing else would ever re-trigger the fetch.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!pointerKey || !worktree || !pointer.path) { setPlan(null); return; }
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    void readFileContent(`${worktree}/${pointer.path}`)
      .then((r) => {
        if (!live) return;
        setPlan(r.content !== undefined ? { key: pointerKey, parsed: parsePlan(r.content) } : null);
      })
      .catch(() => {
        // Transient — keep the last good parse up and try again next tick.
        if (live) again = setTimeout(() => { if (live) setRetry((n) => n + 1); }, interval);
      });
    return () => { live = false; if (again) clearTimeout(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointerKey, worktree, interval, retry, setPlan]);

  // The document the body is actually describing. Sourced from the parse's own
  // key, never from `pointer`, so a failed re-read during a plan-doc swap can't
  // render the new filename above the old task list.
  const planPath = plan ? plan.key.slice(0, plan.key.lastIndexOf("@")) : undefined;

  // Expanded task indices; null = "auto" (only the active task open).
  const [openTasks, setOpenTasks] = useState<Set<number> | null>(null);
  // A different plan DOCUMENT means the indices name different tasks — drop
  // back to auto. Keyed on path only: mtime bumps (edits) keep the user's
  // expansion choices.
  useEffect(() => { setOpenTasks(null); }, [pointer.path]);
  const docTasks = plan?.parsed.tasks ?? [];
  const docStates = taskStates(docTasks);
  const docProgress = planProgress(docTasks);
  const tasksMode = liveTasks.length > 0;
  const liveProgress = { done: liveTasks.filter((t) => t.status === "completed").length, total: liveTasks.length };
  const progress = tasksMode ? liveProgress : docProgress;
  const showPlanTab = !workspace && !!worktree;
  const planView = showPlanTab && view === "plan";

  const discardFile = useCallback((rel: string) => {
    if (!window.confirm(`Discard all changes to ${rel}? This reverts the file and cannot be undone.`)) return;
    // Optimistically drop it; reload reconciles with the real tree on success.
    setFiles((prev) => prev.filter((f) => f.rel !== rel));
    void discardAgentFile(agentId, rel).finally(reload);
  }, [agentId, reload, setFiles]);

  // The branch's PR, if any. Each poll is a gh call to GitHub, so this runs on
  // a much slower clock than the local file/git polls above.
  const [pr, setPr] = useRemembered(prs, agentId, null);
  useEffect(() => {
    let live = true;
    const load = () => { void fetchAgentPr(agentId).then((p) => { if (live) setPr(p); }); };
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [agentId, setPr]);

  // Another agent: its own remembered lists show at once (useRemembered is keyed by agent), and
  // the expanded tasks go back to auto.
  const prevAgent = useRef(agentId);
  if (prevAgent.current !== agentId) {
    prevAgent.current = agentId;
    setOpenTasks(null);
  }

  const openPr = pr && pr.state === "OPEN" ? pr : null;

  // CI output for the open PR: check runs, deployment previews (Vercel et al),
  // failing-log tails. Keyed on slug#number — not the openPr object, which is a
  // fresh identity every PR poll — and on the same 60s clock (the server caches
  // the underlying gh calls for 60s anyway).
  // A new PR shows its own remembered checks (else none) at once.
  const prKey = openPr ? `${openPr.slug}#${openPr.number}` : null;
  const [ci, setCi] = useRemembered(cis, prKey, null);
  // Folded by default: the checks line says enough until you ask for each run.
  const [ciFold, toggleCiFold] = useFold("rail.ci.folded", true);
  useEffect(() => {
    if (!prKey) return;
    const [slug, number] = [prKey.slice(0, prKey.lastIndexOf("#")), Number(prKey.slice(prKey.lastIndexOf("#") + 1))];
    let live = true;
    const load = () => { void fetchPrCi(slug, number).then((d) => { if (live && d) setCi(d); }); };
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [prKey, setCi]);

  const sections = fileSections(files);
  // Not read yet for this agent (nothing remembered): no count and no "No changes yet." until the
  // first answer, so the rail does not say "none" and then list files.
  const filesKnown = files !== NO_FILES;
  const checks = ci ? checksLine(ci) : null;
  const ciRows = !!ci && (ci.deployments.length > 0 || ci.checkRuns.length > 0);
  // Changes and Plan switch the rail's body; Docs switches the center to the
  // repo's docs (the rail stays). One of the three is underlined.
  const pick = (v: "changes" | "plan") => { setView(v); if (docs) onToggleDocs(); };
  const tab = (on: boolean) => `${s.tab} ${on ? s.tabOn : ""}`;

  return (
    <div className={s.rail}>
      <div className={s.tabs} role="group" aria-label="Inspector">
        {/* Plain toggle buttons — deliberately NOT the ARIA tab pattern (that
            contract wants tabpanel wiring + arrow-key focus); aria-pressed
            describes exactly what these are. */}
        <button type="button" aria-pressed={!planView && !docs} className={tab(!planView && !docs)} onClick={() => pick("changes")}>
          Changes <span className={s.pill} style={filesKnown ? undefined : { visibility: "hidden" }}>{files.length}</span>
        </button>
        {showPlanTab && (
          <button type="button" aria-pressed={planView && !docs} className={tab(planView && !docs)} onClick={() => pick("plan")}>
            Plan {progress.total > 0 && <span className={s.pill}>{progress.done}/{progress.total}</span>}
          </button>
        )}
        {worktree && (
          <button type="button" aria-pressed={docs} className={tab(docs)} onClick={onToggleDocs}
            title={docs ? "Back to the thread" : "The repo's docs and shared pages, in the panel"}>Docs</button>
        )}
      </div>
      <div className={s.top}>
        {workspace
          ? branch && <div className={s.line} title={branchTitle}><BranchIcon /><span className={s.mono}>{branch}</span></div>
          : <GitStateBar agentId={agentId} status={status} branch={branch} title={branchTitle} onCopy={onCopyBranch} />}
        {/* The branch's open PR: its checks in one line (a click shows each
            run, the previews and failing-log tails), and a jump to its row in
            the GitHub view. */}
        {openPr && (
          <div className={s.ciWrap}>
            <div className={s.ciLine}>
              {ciRows ? (
                <button type="button" className={s.ciToggle} onClick={toggleCiFold} aria-expanded={!ciFold}
                  title={ciFold ? "Show each check" : "Hide the checks"}>
                  <i className={s.dot} data-tone={checks?.tone ?? "run"} aria-hidden />
                  <span className={s.ciText}>{checks?.text ?? "Checks"}</span>
                  <span className={s.caret} aria-hidden><ChevronIcon open={!ciFold} /></span>
                </button>
              ) : (
                <span className={s.ciToggle}>
                  <i className={s.dot} data-tone="idle" aria-hidden />
                  <span className={s.ciText}>{ci ? "No checks" : "Checks…"}</span>
                </span>
              )}
              {onSeePr && (
                <button type="button" className={s.prLink} onClick={() => onSeePr({ slug: openPr.slug, number: openPr.number })}
                  title={`Open PR #${openPr.number} in the GitHub view`}>PR #{openPr.number}</button>
              )}
            </div>
            {ci && ciRows && !ciFold && (
              <div className={s.ciBody}>
                {ci.deployments.map((d) => (
                  <a key={`${d.environment}-${d.url}`} className={s.ciRow} href={d.url} target="_blank" rel="noreferrer"
                    title={`${d.environment} — ${d.url}`}>
                    <span className={`${s.ciGlyph} ${d.state === "success" ? s.ciOk : d.state === "failure" || d.state === "error" ? s.ciBad : s.ciPend}`}>
                      <Mark kind={d.state === "success" ? "ok" : d.state === "failure" || d.state === "error" ? "fail" : "run"} />
                    </span>
                    <span className={s.ciName}>{d.environment}</span>
                    <span className={s.ciMeta}>preview <ExternalIcon size={10} /></span>
                  </a>
                ))}
                {sortCheckRuns(ci.checkRuns).map((r) => {
                  const inner = (
                    <>
                      <span className={`${s.ciGlyph} ${r.status === "passed" ? s.ciOk : r.status === "failed" ? s.ciBad : s.ciPend}`}>
                        <Mark kind={r.status === "passed" ? "ok" : r.status === "failed" ? "fail" : "run"} />
                      </span>
                      <span className={s.ciName}>{r.name}</span>
                      <span className={s.ciMeta}>{formatDuration(r.durationMs)}{r.url && <ExternalIcon size={10} />}</span>
                    </>
                  );
                  return r.url
                    ? <a key={`${r.name}-${r.url}`} className={s.ciRow} href={r.url} target="_blank" rel="noreferrer" title={r.name}>{inner}</a>
                    : <div key={r.name} className={s.ciRow} title={r.name}>{inner}</div>;
                })}
                {ci.logs.map((l) => (
                  <details key={l.runId} className={s.ciLogWrap}>
                    <summary className={s.ciLogSummary}><ChevronIcon dir="right" size={10} />Failing output · run {l.runId}</summary>
                    <pre className={s.ciLog}>{l.tail}</pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
        <div className={s.btns}>
          <button type="button" className={`${s.btn} ${s.pri}`} onClick={onToggleReview} aria-pressed={reviewing}>
            {reviewing ? "Close review" : "Review"}
          </button>
          {worktree && onOpenEditor && <button type="button" className={s.btn} onClick={onOpenEditor}>Open in editor</button>}
        </div>
      </div>
      <AccountBar agentId={agentId} status={status} />
      {!planView && (files.length === 0 ? (
        <div className={s.empty} style={filesKnown ? undefined : { visibility: "hidden" }}>No changes yet.</div>
      ) : (
        <div className={s.list}>
          {sections.map((sec) => (
            <section key={sec.label} aria-label={sec.label}>
              <h3 className={s.flh}>{sec.label}</h3>
              <ul className={s.files}>
                {sec.files.map((f) => {
                  const { dir, base } = splitPath(f.rel);
                  return (
                    <li key={f.rel} className={s.row}>
                      <button
                        type="button"
                        className={`${s.item} ${f.rel === activeFile ? s.itemActive : ""}`}
                        aria-current={f.rel === activeFile ? "true" : undefined}
                        onClick={() => onSelectFile(f.rel)}
                        title={`${f.rel} · ${STATE_LABEL[f.state]}`}
                      >
                        <span className={s.st} aria-label={f.status}>{GLYPH[f.status]}</span>
                        <span className={s.path}><bdi>{dir && <span className={s.dir}>{dir}</span>}<b className={s.base}>{base}</b></bdi></span>
                        <span className={s.nums}>
                          {!!f.add && <span className={s.add}>+{f.add}</span>}
                          {!!f.del && <span className={s.del}>{"\u2212"}{f.del}</span>}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={s.discard}
                        onClick={() => discardFile(f.rel)}
                        title="Discard this change"
                        aria-label={`Discard changes to ${f.rel}`}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ))}
      {planView && (
        !tasksMode && docTasks.length === 0 ? (
          <div className={s.empty}>No plan yet.</div>
        ) : (
          <div className={s.plan}>
            <div className={s.planMeta}>
              <span className={s.planFile} title={tasksMode ? "Claude Code task list" : planPath}>
                {tasksMode ? "Live tasks" : planPath?.split("/").pop()}
              </span>
              <span className={s.planCount}>{progress.done}/{progress.total} {tasksMode ? "tasks" : "steps"}</span>
            </div>
            <div className={s.planBarWrap} title={`${progress.done}/${progress.total} ${tasksMode ? "tasks" : "steps"}`}>
              <div className={s.planBar} style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} />
            </div>
            {tasksMode ? (
              <ul className={s.taskList}>
                {liveTasks.map((t) => (
                  <li key={t.id}>
                    <div className={`${s.task} ${s.taskStatic} ${t.status === "in_progress" ? s.taskActive : ""}`}>
                      <span className={`${s.taskGlyph} ${t.status === "completed" ? s.tDone : t.status === "in_progress" ? s.tActive : s.tPending}`}>
                        <Mark kind={t.status === "completed" ? "ok" : t.status === "in_progress" ? "run" : "todo"} />
                      </span>
                      <span className={s.taskTitle}>{t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className={s.taskList}>
                {docTasks.map((t, i) => {
                  const st = docStates[i];
                  const open = openTasks ? openTasks.has(i) : st === "active";
                  const did = t.steps.filter((x) => x.checked).length;
                  return (
                    <li key={`${t.title}-${i}`}>
                      <button
                        type="button"
                        className={`${s.task} ${st === "active" ? s.taskActive : ""}`}
                        onClick={() => setOpenTasks((cur) => {
                          // First interaction materializes the auto state.
                          const next = new Set(cur ?? docTasks.map((_, j) => j).filter((j) => docStates[j] === "active"));
                          if (next.has(i)) next.delete(i); else next.add(i);
                          return next;
                        })}
                        aria-expanded={open}
                      >
                        <span className={`${s.taskGlyph} ${st === "done" ? s.tDone : st === "active" ? s.tActive : s.tPending}`}>
                          <Mark kind={st === "done" ? "ok" : st === "active" ? "run" : "todo"} />
                        </span>
                        <span className={s.taskTitle}>{t.title}</span>
                        <span className={s.taskCount}>{did}/{t.steps.length}</span>
                      </button>
                      {open && (
                        <ul className={s.stepList}>
                          {t.steps.map((sp, j) => (
                            <li key={j} className={`${s.step} ${sp.checked ? s.stepDone : ""}`}>
                              <span className={s.stepBox} data-on={sp.checked ? "" : undefined}>{sp.checked && <CheckIcon size={10} />}</span>
                              <span className={s.stepText}>{sp.text}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )
      )}
      {/* Account-wide subscription usage (the phone's sheet only; the desktop
          shell has it in the sidebar footer), pinned to the bottom: the body
          above it flex-grows to fill the rail. */}
      {usage && <UsageMeter />}
    </div>
  );
}
