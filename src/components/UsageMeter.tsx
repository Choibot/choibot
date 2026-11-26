// src/components/UsageMeter.tsx
"use client";
import { useEffect } from "react";
import { useRemembered, viewMemory } from "../lib/viewCache";
import {
  fetchUsage, groupByAccount, lineText, lineTitle, moreTitle, pickLines, primaryWindow, usageLines, worstState,
  type UsageLine, type UsageResult, type UsageWindow,
} from "../lib/usage";
import { DEFAULT_ACCOUNT, fetchAccountsState } from "../lib/accounts";
import { latestRequest } from "../lib/latest-request";
import { useFold } from "../lib/useFold";
import { setUsageWorst, useUsageFold } from "../lib/useUsageFoot";
import { ChevronIcon, RefreshIcon } from "./SideIcons";
import s from "./UsageMeter.module.css";

// Account-wide subscription usage, rendered in the right rail directly beneath
// the changed-files list. Shows whatever windows the server reports — Claude's
// (Session, Week, per-model weekly caps like Fable/Opus) and ChatGPT's, merged
// into one list — stacked vertically and colored by the API's severity. Isolated
// from agent state, so it reads the same for every agent whatever its runtime.
const POLL_MS = 60_000; // server caches ~180s; this just keeps the strip fresh.

function fmtReset(iso: string | null): { short: string; title: string } {
  if (!iso) return { short: "", title: "" };
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { short: "", title: "" };
  const title = `resets ${new Date(iso).toLocaleString()}`;
  const ms = t - Date.now();
  if (ms <= 0) return { short: "resetting", title };
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return { short: `${mins}m`, title };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { short: `${hours}h ${mins % 60}m`, title };
  return { short: `${Math.round(hours / 24)}d`, title };
}

function Meter({ w }: { w: UsageWindow }) {
  const reset = fmtReset(w.resetsAt);
  const title = `${w.label}: ${w.percent}% used${reset.title ? ` · ${reset.title}` : ""}`;
  return (
    <div className={`${s.meter} ${s[w.severity]} ${w.active ? s.active : ""}`} title={title}>
      <div className={s.row}>
        <span className={s.label}>{w.label}</span>
        <span className={s.pct}>{w.percent}%</span>
      </div>
      <div className={s.track}>
        <div className={s.fill} style={{ width: `${w.percent}%` }} />
      </div>
      {reset.short && <div className={s.reset}><RefreshIcon size={10} />{reset.short}</div>}
    </div>
  );
}

// One footer line: the name, one thin bar, the percent (or when the login comes back). The colour
// says the state. Each window is in the title. A press opens Settings, Claude accounts.
function FootLine({ line, now, onOpen }: { line: UsageLine; now: number; onOpen?: () => void }) {
  return (
    <button type="button" className={`${s.fRow} ${s[line.state] ?? ""}`} title={lineTitle(line, now)} onClick={onOpen}>
      <span className={s.fName}>{line.name}</span>
      <span className={s.fTrack}><span className={s.fFill} style={{ width: `${line.window.percent}%` }} /></span>
      <span className={s.fPct}>{lineText(line, now)}</span>
    </button>
  );
}

// `foot`: the footer form (the sidebar, and the home list of the phone): one line per login, at
// most 3, then "+N more"; the header above it (AccountLine) folds the lines. `onOpen`: a press on
// a line opens Settings, Claude accounts. Without `foot`: the rail section.
// The last result: the meter is there on the first frame when it mounts again (the phone's home
// list and Changes sheet mount it on each open).
const usageSeen = viewMemory<UsageResult | null>(1);
// The login that new agents start on: the footer always shows its line.
const preferredSeen = viewMemory<string>(1);

export function UsageMeter({ foot = false, onOpen }: { foot?: boolean; onOpen?: () => void }) {
  const [data, setData] = useRemembered(usageSeen, "usage", null);
  const [preferred, setPreferred] = useRemembered(preferredSeen, "preferred", DEFAULT_ACCOUNT);
  const [folded, toggleFold] = useFold("rail.usage.folded", false);
  const [footFolded] = useUsageFold();

  useEffect(() => {
    let live = true;
    const loadUsage = latestRequest(fetchUsage, (u) => { if (live) setData(u); });
    const load = () => {
      loadUsage();
      if (foot) void fetchAccountsState().then((st) => { if (live) setPreferred(st.preferred); }).catch(() => {});
    };
    load();
    // Only poll while the tab is visible — no point refreshing a hidden console,
    // and it keeps us well under the endpoint's rate floor.
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { live = false; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [foot, setData, setPreferred]);

  // The lines of the footer. The header (AccountLine) shows the state of the worst one.
  const lines = foot && data?.ok ? usageLines(data.windows, preferred) : null;
  const all = lines ? [...lines.logins, ...(lines.codex ? [lines.codex] : [])] : [];
  const worst = all.length ? worstState(all) : null;
  useEffect(() => {
    if (!foot) return;
    setUsageWorst(worst);
    return () => setUsageWorst(null);
  }, [foot, worst]);

  // Render nothing until the first result lands, so we never reserve space for a
  // section that may turn out to be unavailable.
  if (!data) return null;
  if (foot) {
    if (!data.ok) return <div className={s.fNone}>Usage unavailable</div>;
    if (!lines || !all.length || footFolded) return null;
    const { shown, more } = pickLines(lines.logins);
    const now = Date.now();
    return (
      <div className={s.foot} id="usage-lines" role="group" aria-label="Usage of each login">
        {shown.map((l) => <FootLine key={l.id} line={l} now={now} onOpen={onOpen} />)}
        {more.length > 0 && (
          <button type="button" className={s.fMore} title={moreTitle(more, now)} onClick={onOpen}>+{more.length} more</button>
        )}
        {lines.codex && <FootLine line={lines.codex} now={now} onOpen={onOpen} />}
      </div>
    );
  }
  if (!data.ok) {
    return (
      <div className={s.strip}>
        <div className={s.head}>Usage</div>
        <span className={s.muted}>usage unavailable</span>
      </div>
    );
  }
  if (!data.windows.length) return null;
  const groups = groupByAccount(data.windows);
  const titled = groups.some((g) => g.account !== null);
  return (
    <div className={s.strip} role="group" aria-label="Subscription usage">
      <button type="button" className={s.headBtn} onClick={toggleFold} aria-expanded={!folded}>
        <span className={s.caret} aria-hidden><ChevronIcon open={!folded} size={10} /></span>
        Usage
      </button>
      {groups.map((g) => {
        // Folded: one meter per login (each is its own cap), else every window.
        const shown = folded ? [primaryWindow(g.windows)].filter((w): w is UsageWindow => !!w) : g.windows;
        return (
          <div key={g.account ?? "_"} className={s.group}>
            {titled && g.account && <div className={s.account} title={`Claude login ${g.account}`}>{g.account}</div>}
            {shown.map((w) => <Meter key={w.key} w={w} />)}
          </div>
        );
      })}
    </div>
  );
}
