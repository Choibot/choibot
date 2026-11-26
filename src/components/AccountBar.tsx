// src/components/AccountBar.tsx — which Claude login the selected agent runs
// under, and the control to move it to another one (AccountBar); and the
// sidebar footer's account line (AccountLine). Sits in the right rail
// under the git-state bar. Only rendered once the box has a second login (or
// the agent is already on a named one): a one-login console never sees it.
//
// Switching relaunches a live agent under the new login with its conversation
// resumed (see server/agents/recovery.ts switchAccount). The in-flight turn of
// a RUNNING agent would be lost, so the control is disabled until the agent is
// idle — the rest of the rail already tells you when that is.
"use client";
import { useEffect, useState } from "react";
import { fetchAgent } from "../lib/agents";
import { agentMemory, useRemembered, viewMemory } from "../lib/viewCache";
import { fetchAccounts, fetchAccountsState, switchAgentAccount, accountShort, DEFAULT_ACCOUNT, type AccountInfo } from "../lib/accounts";
import { useUsageFold, useUsageWorst } from "../lib/useUsageFoot";
import { Dropdown } from "./Dropdown";
import { ChevronIcon } from "./SideIcons";
import s from "./AccountBar.module.css";

// What was seen last (lib/viewCache): the logins, each agent's login and the footer line show on
// the first frame when they mount again. A switch is checked by the server.
const accountsSeen = viewMemory<AccountInfo[] | null>(1);
const agentAccounts = agentMemory<string | null>();
const stateSeen = viewMemory<{ accounts: AccountInfo[]; preferred: string } | null>(1);

export function AccountBar({ agentId, status }: { agentId: string; status: string }) {
  const [accounts, setAccounts] = useRemembered(accountsSeen, "accounts", null);
  // null = not loaded; "" = not a Claude agent (no bar); else the account id. Keyed by agent: the
  // prior agent's login never shows under the new one.
  const [current, setCurrent] = useRemembered(agentAccounts, agentId, null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    setErr("");
    void fetchAccounts().then((a) => { if (live) setAccounts(a); }).catch(() => {});
    void fetchAgent(agentId)
      .then((a) => {
        if (!live) return;
        setCurrent(a.runtime && a.runtime !== "claude" ? "" : (a.account ?? DEFAULT_ACCOUNT));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [agentId, setAccounts, setCurrent]);

  if (!accounts || current === null || current === "") return null;
  if (accounts.length < 2 && current === DEFAULT_ACCOUNT) return null;

  const running = status === "running";
  const onPick = async (id: string) => {
    if (id === current || busy) return;
    setBusy(true); setErr("");
    try {
      await switchAgentAccount(agentId, id);
      setCurrent(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "switch failed");
    } finally {
      setBusy(false);
    }
  };

  const title = running
    ? "Wait until the agent is idle: switching relaunches it and would drop the turn in flight"
    : busy ? "Switching…" : "Switch this agent to another Claude login (the conversation resumes)";

  return (
    <div className={s.bar}>
      <div className={s.row}>
        <span className={s.label}>Account</span>
        <div className={s.pick}>
          <Dropdown
            value={current}
            placeholder="account…"
            options={accounts.map((a) => ({ value: a.id, label: accountShort(a) }))}
            onChange={(v) => void onPick(v)}
            disabled={running || busy}
            title={title}
          />
        </div>
      </div>
      {busy && <div className={s.note}>switching login — the session relaunches and resumes…</div>}
      {err && <div className={s.err}>{err}</div>}
    </div>
  );
}

// The sidebar footer's account line (desktop shell): the Claude login new agents start on, and how
// many logins the box has. An agent's own login is switched in its rail (AccountBar). It is also
// the header of the usage lines under it (UsageMeter): a press folds them, and the folded header
// shows a dot in the colour of the worst line.
export function AccountLine() {
  const [st, setSt] = useRemembered(stateSeen, "state", null);
  const worst = useUsageWorst();
  const [folded, toggleFold] = useUsageFold();
  useEffect(() => {
    let live = true;
    void fetchAccountsState().then((v) => { if (live) setSt(v); }).catch(() => {});
    return () => { live = false; };
  }, [setSt]);
  const a = st?.accounts.find((x) => x.id === st.preferred);
  const name = !st ? "" : a ? (a.id === DEFAULT_ACCOUNT && !a.email ? "Main account" : accountShort(a)) : st.preferred;
  const n = st?.accounts.length ?? 0;
  const sub = n > 1 ? `Claude · ${n} logins` : "Claude";
  const starts = a?.email ? `New agents start on ${a.email}` : "";
  const who = (
    <>
      <span className={s.avatar} aria-hidden />
      <span className={s.who}>
        <span className={s.whoName}>{name || "\u00A0"}</span>
        <span className={s.whoSub}>
          <span className={s.whoText}>{st ? sub : "\u00A0"}</span>
          {/* One mark: open, the chevron; folded, a dot in the colour of the worst line. */}
          {worst !== null && (folded
            ? <span className={`${s.dot} ${s[worst] ?? ""}`} aria-hidden />
            : <span className={s.fold} aria-hidden><ChevronIcon open size={10} /></span>)}
        </span>
      </span>
    </>
  );
  // No usage lines (no answer yet, or usage is not available): nothing to fold.
  if (worst === null) return <div className={s.line} title={starts || undefined}>{who}</div>;
  const state = worst === "limit" ? "A login is at its limit. " : worst === "close" ? "A login is close to its limit. " : "";
  return (
    <button type="button" className={`${s.line} ${s.lineBtn}`} onClick={toggleFold} aria-expanded={!folded} aria-controls="usage-lines"
      title={[starts, `${folded ? state : ""}${folded ? "Show" : "Hide"} the usage of ${n > 1 ? "each login" : "the login"}`].filter(Boolean).join("\n")}>
      {who}
    </button>
  );
}
