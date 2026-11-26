// src/components/CockpitPanel.tsx — the GitHub cockpit: one urgency-sorted
// table of every open PR/issue across the workspace repos, actionable in place.
// A · Inset: a 52 px head, one line of counts in ink, colour only at dot size.
"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useRemembered, useScrollMemory, viewMemory } from "../lib/viewCache";
import {
  fetchCockpit, fetchPrCi, mergePr, closePr, closeIssue, comment,
  type CockpitRepo, type CockpitPr, type CockpitIssue, type PrCi,
} from "../lib/gh";
import {
  flattenCockpit, filterItems, groupByRepo, formatAge, ageDays, sortCheckRuns, formatDuration,
  type Group, type RepoGroup,
} from "../lib/cockpit";
import { PrDiffPanel } from "./PrDiffPanel";
import { PhoneHeader } from "./PhoneHeader";
import { ChevronIcon, ExternalIcon, Mark } from "./SideIcons";
import s from "./CockpitPanel.module.css";

type Kind = "all" | "prs" | "issues";

// A status dot: ok = green, err = red, wait = amber, none = hollow.
type Tone = "ok" | "err" | "wait" | "none";
const Dot = ({ tone }: { tone: Tone }) => <i className={s.dot} data-tone={tone} aria-hidden />;

function ChecksCell({ p }: { p: CockpitPr }) {
  const c = p.checks;
  if (!c || c.total === 0) return <span className={s.chkDim}>—</span>;
  if (c.rollup === "failure") return <span className={s.state}><Dot tone="err" />{c.failed}/{c.total}<small>failing</small></span>;
  if (c.rollup === "pending") return <span className={s.state}><Dot tone="wait" />{c.pending}<small>running</small></span>;
  return <span className={s.state}><Dot tone="ok" />{c.passed}/{c.total}</span>;
}

const chip = (tone: Tone, text: string) => <span className={s.state}><Dot tone={tone} />{text}</span>;

function PrChip({ p, group }: { p: CockpitPr; group: Group }) {
  if (p.reviewDecision === "APPROVED") return chip("ok", "approved");
  if (p.reviewDecision === "CHANGES_REQUESTED") return chip("err", "changes req");
  if (p.mergeable === "CONFLICTING") return chip("err", "conflicts");
  if (group === "failing") return chip("err", "failing");
  if (group === "inflight") return chip("wait", "checks");
  if (p.mergeable === "MERGEABLE") return chip("ok", "mergeable");
  return chip("none", "open");
}

function IssueChip({ i, now }: { i: CockpitIssue; now: number }) {
  const d = ageDays(i.createdAt, now);
  if (d >= 10) return chip("wait", `stale ${d}d`);
  return chip("none", "issue");
}

// One count of the counts line: "<dot> 2 ready to merge · checks pass · no conflicts".
function Count({ tone, n, label, foot }: { tone: Tone; n: number; label: string; foot: string }) {
  return (
    <span className={s.countItem}>
      <Dot tone={n > 0 ? tone : "none"} /><b>{n}</b> {label}<span className={s.countFoot}>{foot}</span>
    </span>
  );
}

const KIND_LABEL: Record<Kind, string> = { all: "All", prs: "PRs", issues: "Issues" };

// A jump target set by "PR #n" in an agent's changes rail: land on that PR's
// row. `seq` bumps on every click so re-clicking the same PR re-scrolls.
export type CockpitFocus = { slug: string; number: number; seq: number };

// What the view showed last (lib/viewCache): it opens with those rows and the repos the user
// opened, then reads GitHub again. Each action still goes to the server, which checks the PR.
const VIEW = "cockpit";
const reposSeen = viewMemory<{ repos: CockpitRepo[]; at: number } | null>(1);
const openedSeen = viewMemory<Set<string>>(1);
const NONE_OPEN = new Set<string>();

// The warm-up (lib/warmup): read the list once before the view opens.
export async function prefetchCockpit(): Promise<void> {
  if (reposSeen.has(VIEW)) return;
  const repos = await fetchCockpit();
  // An empty answer is also what a failed read gives: the view reads it itself.
  if (repos.length && !reposSeen.has(VIEW)) reposSeen.set(VIEW, { repos, at: Date.now() });
}

// `onBack` (the phone shell): the head is the phone screen's one header, with the back arrow.
export function CockpitPanel({ focus, onBack }: { focus?: CockpitFocus | null; onBack?: () => void }) {
  const [seen, setSeen] = useRemembered(reposSeen, VIEW, null);
  const repos = seen?.repos ?? null;
  const fetchedAt = seen?.at ?? null;
  const [loading, setLoading] = useState(false);
  const scroll = useScrollMemory<HTMLDivElement>(VIEW);
  const [, setTick] = useState(0); // re-render so ages/refreshed-ago stay honest
  const [q, setQ] = useState("");
  const [repoF, setRepoF] = useState("");
  const [kindF, setKindF] = useState<Kind>("all");
  const [review, setReview] = useState<string | null>(null); // key of the open inline review
  const [busy, setBusy] = useState<string | null>(null); // key of the row acting
  const [confirm, setConfirm] = useState<string | null>(null); // `close:${key}`
  const [commenting, setCommenting] = useState<string | null>(null); // key
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<string | null>(null); // merge-method menu open for key
  const [actErr, setActErr] = useState<{ key: string; msg: string } | null>(null);
  const [opened, setOpened] = useRemembered(openedSeen, VIEW, NONE_OPEN); // expanded repo slugs — all collapsed by default
  const [ciOpen, setCiOpen] = useState<string | null>(null); // key of the open per-check CI view
  // Lazy CI detail (deployment previews + failed-run log tails) for the open key.
  // state: "loading" while in flight; "error" when the fetch failed (never show
  // an eternal spinner for a dead endpoint).
  const [ci, setCi] = useState<{ key: string; state: "loading" | "error" | "ok"; data?: PrCi } | null>(null);
  useEffect(() => {
    if (!ciOpen) { setCi(null); return; }
    const [slug, num] = [ciOpen.slice(0, ciOpen.lastIndexOf("#")), Number(ciOpen.slice(ciOpen.lastIndexOf("#") + 1))];
    let live = true;
    setCi({ key: ciOpen, state: "loading" });
    void fetchPrCi(slug, num).then((d) => {
      if (live) setCi(d ? { key: ciOpen, state: "ok", data: d } : { key: ciOpen, state: "error" });
    });
    return () => { live = false; };
  }, [ciOpen]);

  const load = () => {
    setLoading(true);
    void fetchCockpit().then((r) => { setSeen({ repos: r, at: Date.now() }); setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  // Land on the focused PR: un-collapse its repo, then scroll its row into view
  // once the data holding it has rendered. Scroll once per click (seq), not on
  // every refresh.
  const focusKey = focus ? `${focus.slug}#${focus.number}` : null;
  const [scrolledSeq, setScrolledSeq] = useState(-1);
  useEffect(() => {
    if (!focus || !repos || scrolledSeq === focus.seq) return;
    setOpened((o) => { const n = new Set(o); n.add(focus.slug); return n; });
    setScrolledSeq(focus.seq);
    // rAF: the row may only exist after the un-collapse re-render.
    requestAnimationFrame(() => {
      document.getElementById(`cockpit-${focus.slug}#${focus.number}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [focus, repos, scrolledSeq]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  async function act(key: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(key); setConfirm(null); setMenu(null); setActErr(null);
    const r = await fn();
    setBusy(null);
    if (r.ok) { setCommenting(null); setDraft(""); load(); }
    else setActErr({ key, msg: r.error ?? "action failed" });
  }

  const now = Date.now();
  const items = useMemo(() => flattenCockpit(repos ?? []), [repos]);
  const visible = useMemo(() => filterItems(items, { q, repo: repoF, kind: kindF }), [items, q, repoF, kindF]);
  // Nothing seen yet: the header is there at once (the phone's back arrow too), the rows land below.
  if (!repos) {
    return (
      <div className={s.root}>
        {onBack ? <PhoneHeader onBack={onBack} title="GitHub" sub={"\u00A0"} /> : <div className={s.head}><b className={s.headTitle}>GitHub</b></div>}
        <div className={`${s.hint} late`}>{loading ? "Loading…" : ""}</div>
      </div>
    );
  }

  const prCount = items.filter((i) => i.kind === "pr").length;
  const issueCount = items.length - prCount;
  const byGroup = (g: Group) => items.filter((i) => i.group === g);
  const ready = byGroup("ready"), failing = byGroup("failing"), inflight = byGroup("inflight"), issues = byGroup("issues");
  const failedChecks = failing.reduce((n, i) => n + (i.kind === "pr" ? i.pr.checks?.failed ?? 0 : 0), 0);
  const conflicts = failing.filter((i) => i.kind === "pr" && i.pr.mergeable === "CONFLICTING").length;
  const runningChecks = inflight.reduce((n, i) => n + (i.kind === "pr" ? i.pr.checks?.pending ?? 0 : 0), 0);
  const oldest = issues[issues.length - 1]; // issues sort newest-first
  const errored = repos.filter((r) => r.error);
  const repoOptions = [...new Set(items.map((i) => i.slug))].sort();

  // Repo-first: one collapsible section per repo, urgency order inside.
  // Collapsed by default — the header chips already say what's inside — and a
  // live search overrides collapse so matches can't hide in a folded repo.
  const groups: RepoGroup[] = groupByRepo(visible);
  const searching = q.trim().length > 0;
  const isClosed = (slug: string) => !searching && !opened.has(slug);
  const toggleRepo = (slug: string) =>
    setOpened((o) => { const n = new Set(o); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });

  return (
    <div className={s.root}>
      {onBack ? (
        <PhoneHeader
          onBack={onBack} title="GitHub" sub={`${repos.length} ${repos.length === 1 ? "repo" : "repos"} · ${prCount} PRs · ${issueCount} issues`}
          right={<button type="button" className={s.refresh} onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>}
        />
      ) : (
      <div className={s.head}>
        <b className={s.headTitle}>GitHub</b>
        <span className={s.headLine}>{repos.length} {repos.length === 1 ? "repo" : "repos"} · {prCount} PRs · {issueCount} issues</span>
        <span className={s.statusRight}>
          <span className={s.live}><Dot tone="ok" />Live</span>
          {fetchedAt ? (() => { const ago = formatAge(new Date(fetchedAt).toISOString(), now); return ago === "now" ? "refreshed just now" : `refreshed ${ago} ago`; })() : ""}
          <button type="button" className={s.refresh} onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </span>
      </div>
      )}

      <div className={s.body} ref={scroll.ref} onScroll={scroll.onScroll}>
        <div className={s.counts}>
          <Count tone="ok" n={ready.length} label="ready to merge" foot="checks pass · no conflicts" />
          <Count tone="err" n={failing.length} label="failing" foot={failing.length ? `${failedChecks} checks red · ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : "all clear"} />
          <Count tone="wait" n={inflight.length} label="in flight" foot={runningChecks ? `${runningChecks} checks running` : "nothing queued"} />
          <Count tone="none" n={issues.length} label="open issues" foot={oldest && oldest.kind === "issue" ? `oldest ${formatAge(oldest.issue.createdAt, now)} · ${oldest.repo}` : "none open"} />
        </div>

        {errored.map((r) => (
          <div key={r.slug} className={s.errBanner}>{r.slug} — couldn’t load: {r.error}</div>
        ))}

        <div className={s.filters}>
          <div className={s.search}>
            <svg className={s.searchIcon} viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
            <input className={s.searchInput} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, repo, author…" />
          </div>
          <select className={s.select} value={repoF} onChange={(e) => setRepoF(e.target.value)}>
            <option value="">All repos</option>
            {repoOptions.map((slug) => <option key={slug} value={slug}>{slug}</option>)}
          </select>
          <div className={s.seg}>
            {(["all", "prs", "issues"] as const).map((k) => (
              <button key={k} type="button" className={`${s.segBtn} ${kindF === k ? s.segOn : ""}`} aria-pressed={kindF === k} onClick={() => setKindF(k)}>{KIND_LABEL[k]}</button>
            ))}
          </div>
          <span className={s.count}>{visible.length} / {items.length} items</span>
        </div>

        {items.length === 0 && <div className={s.hint}>Nothing open across your repos.</div>}

      {groups.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Item</th><th>Title</th><th>Checks</th><th>State</th><th>Author</th>
                <th className={s.thRight}>Age</th><th className={s.thRight}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.slug}>
                  <tr className={s.repoRow}>
                    <td colSpan={7}>
                      <button type="button" className={s.repoBtn} onClick={() => toggleRepo(g.slug)}
                        aria-expanded={!isClosed(g.slug)}>
                        <svg className={s.caret} viewBox="0 0 16 16" aria-hidden><path d="m6 4 4 4-4 4" /></svg>
                        <span className={s.repoSlug}>{g.slug}</span>
                        {g.counts.ready > 0 && <span className={s.rc}><Dot tone="ok" />{g.counts.ready} ready</span>}
                        {g.counts.failing > 0 && <span className={s.rc}><Dot tone="err" />{g.counts.failing} failing</span>}
                        {g.counts.inflight > 0 && <span className={s.rc}><Dot tone="wait" />{g.counts.inflight} running</span>}
                        {g.counts.issues > 0 && <span className={s.rc}><Dot tone="none" />{g.counts.issues} issue{g.counts.issues === 1 ? "" : "s"}</span>}
                      </button>
                    </td>
                  </tr>
                  {!isClosed(g.slug) && g.items.map((it) => {
                if (it.kind === "pr") {
                  const p = it.pr;
                  const key = `${it.slug}#${p.number}`;
                  const open = review === key;
                  const ciState = ci?.key === key ? ci : undefined;
                  const ciData = ciState?.data;
                  return (
                    <Fragment key={key}>
                      <tr id={`cockpit-${key}`} className={focusKey === key ? s.rowFocus : undefined}>
                        <td className={s.repoCell}><span className={s.num}>#{p.number}</span></td>
                        <td className={s.ttl} title={p.title}>{p.title}</td>
                        <td className={s.chk}>
                          {(p.checkRuns?.length ?? 0) > 0 ? (
                            <button type="button" className={s.chkToggle} title="Show CI runs"
                              aria-expanded={ciOpen === key}
                              onClick={() => setCiOpen(ciOpen === key ? null : key)}>
                              <ChecksCell p={p} /> <span className={s.chkCaret}><ChevronIcon dir={ciOpen === key ? "up" : "down"} size={10} /></span>
                            </button>
                          ) : <ChecksCell p={p} />}
                        </td>
                        <td><PrChip p={p} group={it.group} /></td>
                        <td className={s.author}>{p.author}</td>
                        <td className={`${s.age} ${s.tdRight}`}>{formatAge(p.updatedAt, now)}</td>
                        <td className={s.acts}>
                          {it.group === "ready" && (
                            <span className={s.mergeWrap}>
                              <button type="button" className={`${s.btn} ${s.btnGo}`} disabled={busy === key}
                                onClick={() => setMenu(menu === key ? null : key)}>Merge <ChevronIcon dir="down" size={10} /></button>
                              {menu === key && (
                                <span className={s.menu}>
                                  {(["squash", "merge", "rebase"] as const).map((m) => (
                                    <button key={m} type="button" className={s.menuItem}
                                      onClick={() => act(key, () => mergePr(it.slug, p.number, m))}>{m[0].toUpperCase() + m.slice(1)}</button>
                                  ))}
                                </span>
                              )}
                            </span>
                          )}
                          <button type="button" className={s.btn} onClick={() => setReview(open ? null : key)}>{open ? "Hide" : "Review"}</button>
                          <button type="button" className={s.btn}
                            onClick={() => { setCommenting(commenting === key ? null : key); setDraft(""); }}>Comment</button>
                          {confirm === `close:${key}` ? (
                            <span className={s.confirmBox}>
                              Close?
                              <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={() => act(key, () => closePr(it.slug, p.number))}>Yes</button>
                              <button type="button" className={s.btn} onClick={() => setConfirm(null)}>No</button>
                            </span>
                          ) : (
                            <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={busy === key} onClick={() => setConfirm(`close:${key}`)}>Close</button>
                          )}
                          <a className={s.btn} href={p.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub"><ExternalIcon /></a>
                        </td>
                      </tr>
                      {ciOpen === key && (
                        <tr key={`${key}-ci`} className={s.expand}><td colSpan={7}>
                          <div className={s.ciWrap}>
                            {(ciData?.deployments?.length ?? 0) > 0 && (
                              <div className={s.ciSection}>
                                <div className={s.ciHead}>Deployments</div>
                                {ciData!.deployments.map((d) => (
                                  <div key={`${d.environment}-${d.url}`} className={s.ciRow}>
                                    <span className={`${s.ciGlyph} ${d.state === "success" ? s.chkGreen : d.state === "failure" || d.state === "error" ? s.chkRed : s.chkAmber}`}>
                                      <Mark kind={d.state === "success" ? "ok" : d.state === "failure" || d.state === "error" ? "fail" : "run"} />
                                    </span>
                                    <span className={s.ciEnv}>{d.environment}</span>
                                    <a className={s.ciLink} href={d.url} target="_blank" rel="noreferrer">{d.url.replace(/^https?:\/\//, "")}</a>
                                    <a className={s.btn} href={d.url} target="_blank" rel="noreferrer">Open <ExternalIcon size={10} /></a>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className={s.ciSection}>
                              <div className={s.ciHead}>Checks</div>
                              {sortCheckRuns(ciData?.checkRuns ?? p.checkRuns ?? []).map((r) => (
                                <div key={`${r.name}-${r.url}`} className={s.ciRow}>
                                  <span className={`${s.ciGlyph} ${r.status === "passed" ? s.chkGreen : r.status === "failed" ? s.chkRed : s.chkAmber}`}>
                                    <Mark kind={r.status === "passed" ? "ok" : r.status === "failed" ? "fail" : "run"} />
                                  </span>
                                  <span className={s.ciName}>{r.name}</span>
                                  <span className={s.ciDur}>{formatDuration(r.durationMs)}</span>
                                  {r.url ? <a className={s.btn} href={r.url} target="_blank" rel="noreferrer">Run <ExternalIcon size={10} /></a> : null}
                                </div>
                              ))}
                              {ciState?.state === "loading" && <div className={s.ciLoading}>Loading deployments and logs…</div>}
                              {ciState?.state === "error" && <div className={s.ciLoading}>Could not load deployments and logs</div>}
                            </div>
                            {(ciData?.logs ?? []).map((l) => (
                              <div key={l.runId} className={s.ciSection}>
                                <div className={s.ciHead}>Failing output — run {l.runId}</div>
                                <pre className={s.ciLog}>{l.tail}</pre>
                              </div>
                            ))}
                          </div>
                        </td></tr>
                      )}
                      {actErr?.key === key && (
                        <tr key={`${key}-err`} className={s.expand}><td colSpan={7}>
                          <div className={s.rowErr}><span>{actErr.msg}</span><button type="button" className={s.btn} onClick={() => setActErr(null)}>Dismiss</button></div>
                        </td></tr>
                      )}
                      {commenting === key && (
                        <tr key={`${key}-comment`} className={s.expand}><td colSpan={7}>
                          <div className={s.commentBox}>
                            <input className={s.commentInput} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Leave a comment…" />
                            <button type="button" className={s.btn} disabled={busy === key || !draft.trim()}
                              onClick={() => act(key, () => comment(it.slug, "pr", p.number, draft))}>Post</button>
                          </div>
                        </td></tr>
                      )}
                      {open && (
                        <tr key={`${key}-review`} className={s.expand}><td colSpan={7}>
                          <div className={s.review}><PrDiffPanel repo={it.slug} pr={p.number} /></div>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                }
                const i = it.issue;
                const key = `${it.slug}#i${i.number}`;
                return (
                  <Fragment key={key}>
                    <tr>
                      <td className={s.repoCell}><span className={s.num}>#{i.number}</span></td>
                      <td className={s.ttl} title={i.title}>{i.title}</td>
                      <td className={s.chk}><span className={s.chkDim}>—</span></td>
                      <td><IssueChip i={i} now={now} /></td>
                      <td className={s.author}>{i.author}</td>
                      <td className={`${s.age} ${s.tdRight}`}>{formatAge(i.createdAt, now)}</td>
                      <td className={s.acts}>
                        <button type="button" className={s.btn}
                          onClick={() => { setCommenting(commenting === key ? null : key); setDraft(""); }}>Comment</button>
                        {confirm === `close:${key}` ? (
                          <span className={s.confirmBox}>
                            Close?
                            <button type="button" className={`${s.btn} ${s.btnDanger}`} onClick={() => act(key, () => closeIssue(it.slug, i.number))}>Yes</button>
                            <button type="button" className={s.btn} onClick={() => setConfirm(null)}>No</button>
                          </span>
                        ) : (
                          <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={busy === key} onClick={() => setConfirm(`close:${key}`)}>Close</button>
                        )}
                        <a className={s.btn} href={i.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub"><ExternalIcon /></a>
                      </td>
                    </tr>
                    {actErr?.key === key && (
                      <tr key={`${key}-err`} className={s.expand}><td colSpan={7}>
                        <div className={s.rowErr}><span>{actErr.msg}</span><button type="button" className={s.btn} onClick={() => setActErr(null)}>Dismiss</button></div>
                      </td></tr>
                    )}
                    {commenting === key && (
                      <tr key={`${key}-comment`} className={s.expand}><td colSpan={7}>
                        <div className={s.commentBox}>
                          <input className={s.commentInput} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Leave a comment…" />
                          <button type="button" className={s.btn} disabled={busy === key || !draft.trim()}
                            onClick={() => act(key, () => comment(it.slug, "issue", i.number, draft))}>Post</button>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </div>
  );
}
