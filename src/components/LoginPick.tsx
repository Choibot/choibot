// src/components/LoginPick.tsx — the Claude login of one persistent agent (the fleet master, a
// lead, the helper for tickets) on its pane, and its move to another login. A worker has the same
// control in its Changes rail (AccountBar). On the desktop a button in the pane header shows the
// short name of the login; on the phone the header has no room for it, so the "more" menu has one
// row ("Claude login: <name>"). Both open the same list of logins (lib/loginPick.ts).
// The move is the paired user's (POST /api/agents/:id/account): a lead and the fleet master move
// through the relaunch of the chief of staff and keep their conversations. moveGate says when a
// move is on: not while the agent works on a login that works (a move then would cut its turn).
// No control with one login only, or with strong protection's second sign-in.
"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { fetchAccounts, loginName, switchAgentAccount, DEFAULT_ACCOUNT, type AccountInfo } from "../lib/accounts";
import { fetchAgent } from "../lib/agents";
import { loginPickRows, loginShort, moveGate, movedOneText, type LoginPickRow } from "../lib/loginPick";
import { CheckIcon, ChevronIcon } from "./SideIcons";
import s from "./LoginPick.module.css";

// The use of a login changes slowly; the list is read again when it opens.
const POLL_MS = 60_000;

// The login of an agent and the rows of its control. Null: no control (not read yet, not a Claude
// agent, one login only, or `on` is false).
export type AgentLogin = { accounts: AccountInfo[]; current: string; mine: AccountInfo | undefined; rows: LoginPickRow[]; load: () => Promise<void>; setCurrent: (id: string) => void };
export function useAgentLogin(agentId: string, on = true): AgentLogin | null {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  // null: not read yet. "": not a Claude agent. Else the login of this agent.
  const [current, setCurrent] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [list, agent] = await Promise.all([fetchAccounts().catch(() => null), fetchAgent(agentId).catch(() => null)]);
    if (list) setAccounts(list);
    if (agent) setCurrent(agent.runtime && agent.runtime !== "claude" ? "" : (agent.account ?? DEFAULT_ACCOUNT));
  }, [agentId]);
  useEffect(() => {
    if (!on) return;
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load, on]);
  if (!on || !accounts || !current) return null;
  const rows = loginPickRows(accounts, current, Date.now());
  return rows.length ? { accounts, current, mine: accounts.find((a) => a.id === current), rows, load, setCurrent } : null;
}

// The name of the login on the button and in the phone menu, cut after `max` characters.
export function loginButtonText(l: AgentLogin, max = 24): string {
  const t = loginShort(l.mine, l.current);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The desktop control: the button in the pane header, and the list under it.
export function LoginPick({ agentId, status, className }: { agentId: string; status: string; className?: string }) {
  const login = useAgentLogin(agentId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  if (!login) return null;
  const name = login.mine ? loginName(login.mine) : login.current;
  const out = !!login.mine && !login.mine.loggedIn;
  return (
    <div className={`${s.wrap} ${className ?? ""}`} ref={ref}>
      <button
        type="button" className={s.btn} aria-haspopup="menu" aria-expanded={open} data-part="login-pick"
        onClick={() => { if (!open) void login.load(); setOpen((v) => !v); }}
        title={`Claude login of this agent: ${name}${out ? (login.mine?.signedOut ? " (signed out)" : " (not logged in)") : ""}. Press to move it to another login.`}
      >
        {out && <i className={s.dot} aria-hidden />}
        <span className={s.name}>{loginButtonText(login)}</span>
        <ChevronIcon dir={open ? "up" : "down"} size={10} />
      </button>
      {open && <LoginList agentId={agentId} status={status} login={login} within={ref} onClose={() => setOpen(false)} />}
    </div>
  );
}

// The list of logins (the desktop button and the phone menu row open it). A press outside
// `within` (default: the list) or Esc closes it. Esc is taken here: it does not also close the
// open lead of the Master tab.
export function LoginList({ agentId, status, login, within, onClose }: {
  agentId: string; status: string; login: AgentLogin; within?: RefObject<HTMLElement | null>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: true } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = () => within?.current ?? menuRef.current;
    const onDown = (e: PointerEvent) => { if (!box()?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [within, onClose]);
  // The list stays inside the screen.
  useLayoutEffect(() => {
    const m = menuRef.current;
    if (!m) return;
    m.style.right = "0px";
    const r = m.getBoundingClientRect();
    const edge = 12;
    const shift = r.left < edge ? r.left - edge : r.right > window.innerWidth - edge ? r.right - (window.innerWidth - edge) : 0;
    if (shift) m.style.right = `${shift}px`;
  }, []);

  const gate = moveGate(status, login.mine);
  const move = async (id: string) => {
    if (busy || !gate.on) return;
    const to = login.accounts.find((a) => a.id === id);
    setBusy(true); setNote(null);
    try {
      const outcome = await switchAgentAccount(agentId, id);
      setNote({ text: movedOneText(outcome, to ? loginName(to) : id) });
      if (outcome !== "waits") login.setCurrent(id);
      await login.load();
    } catch (e) {
      setNote({ text: e instanceof Error && / /.test(e.message) ? `The agent did not move: ${e.message}` : "The agent did not move. Try again.", err: true });
    } finally {
      setBusy(false);
    }
  };
  const says = busy ? "Moving… The session starts again on the new login."
    : note ? note.text
    : gate.note ?? "A move keeps the conversation of the agent.";
  return (
    <div className={s.menu} ref={menuRef} role="menu" aria-label="Claude login of this agent">
      <div className={s.head}>Claude login</div>
      {login.rows.map((r) => (
        <button
          key={r.id} type="button" role="menuitemradio" aria-checked={r.current} className={s.item}
          disabled={!r.pick || !gate.on || busy} onClick={() => void move(r.id)}
          title={r.current ? "The login of this agent now" : r.pick ? "Move this agent to this login" : "Log in to it first in Settings, Claude accounts"}
        >
          <span className={s.check} aria-hidden>{r.current && <CheckIcon size={12} />}</span>
          <span className={s.text}>
            <span className={s.label}>{r.name}</span>
            <span className={s.state}>{r.state}</span>
          </span>
        </button>
      ))}
      <div className={s.note} role="status" data-err={note?.err ? "" : undefined}>{says}</div>
    </div>
  );
}
