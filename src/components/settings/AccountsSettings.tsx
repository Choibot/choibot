// src/components/settings/AccountsSettings.tsx — the Claude logins of your server (GET
// /api/accounts): which one new agents start on, which ones are not logged in, and the whole
// login on this page (ClaudeLogin: the sign-in link and the code, no terminal). "Add a login"
// makes a new login and starts its sign-in at once. "Sign out" makes your server forget a login
// (its agents move or stop first; a confirm block says which). With chief on, the paired user only.
"use client";
import { useCallback, useEffect, useState } from "react";
import {
  createAccount, deleteAccount, fetchAccountsState, freeLoginName, loginMeta, loginName, makeDefaultLogin, moveAllAgents, moveFacts, movedText, waitersText,
  signOutFacts, signOutLogin, signOutNote, signedOutText,
  DEFAULT_ACCOUNT, type AccountInfo, type MoveChoice,
} from "../../lib/accounts";
import { Dropdown } from "../Dropdown";
import { accountsStatus, type Read } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { PlusIcon } from "../SideIcons";
import { ClaudeLogin } from "./ClaudeLogin";
import { Block, cx as s, Empty, ErrorLine, Note, Row, StatusLine, type SectionProps } from "./kit";
import b from "./Brain.module.css";
import m from "../LoginLimitLine.module.css";

type Seen = { read: Read<AccountInfo>; preferred: string };
const seen = viewMemory<Seen>(1);
const NONE: Seen = { read: null, preferred: DEFAULT_ACCOUNT };

const nameOf = loginName;
// The use of a login is read again this often while the section is open.
const POLL_MS = 60_000;

export function AccountsSettings(_: SectionProps) {
  const [st, setSt] = useRemembered(seen, "accounts", NONE);
  const load = useCallback(async () => {
    try {
      const { accounts, preferred } = await fetchAccountsState();
      setSt({ read: { rows: accounts }, preferred });
    } catch {
      setSt((p) => (p.read && "rows" in p.read ? p : { ...p, read: { error: "the console did not answer" } }));
    }
  }, [setSt]);
  useEffect(() => {
    void load();
    const tick = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(tick);
  }, [load]);

  const rows = st.read && "rows" in st.read ? st.read.rows : [];
  const now = Date.now();
  const [said, setSaid] = useState("");
  // "Make default": new agents start on this login. Agents that run keep theirs.
  const makeDefault = async (id: string) => {
    setBusy(true); setErr(""); setSaid("");
    const r = await makeDefaultLogin(id);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "The default login did not change."); return; }
    await load();
  };
  // "Move its agents": each agent of a login that is signed out, not logged in or at its limit
  // goes to another login: workers, leads, the fleet master and the helper for tickets. The login
  // that the user picked for the agents of a login (by the id of that login). No pick: the login
  // with the most room.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const moveAll = async (from: AccountInfo, to: MoveChoice) => {
    setBusy(true); setErr(""); setSaid("");
    const r = await moveAllAgents(from.id, to.id);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setSaid(movedText(r, to.name));
    setPicks((p) => { const { [from.id]: _gone, ...rest } = p; return rest; });
    await load();
  };
  // The login whose sign-in card is open.
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // A new login: the console makes it, and its sign-in starts at once. The user gives no
  // name: after the login, the e-mail of the account is its name.
  const add = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    const r = await createAccount(freeLoginName(rows.map((a) => a.id))).catch(() => ({ ok: false as const, error: "The console did not answer", account: undefined }));
    setBusy(false);
    if (!r.ok || !r.account) { setErr(r.error ?? "The login was not made."); return; }
    await load();
    setOpen(r.account.id);
  };
  const remove = async (id: string) => {
    setBusy(true); setErr("");
    const r = await deleteAccount(id).catch(() => ({ ok: false as const, error: "The console did not answer" }));
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "The login was not removed."); return; }
    if (open === id) setOpen(null);
    await load();
  };
  const opened = rows.find((a) => a.id === open) ?? null;
  // The login whose "move its agents" form is open under the list, and what the form needs
  // (filled while the rows are drawn). The form has the room for the list of logins.
  const [moving, setMoving] = useState<string | null>(null);
  // A login with agents that must move (lib/accounts.ts moveFacts): where they can go.
  const factsOf = (a: AccountInfo) => moveFacts(a, rows, picks[a.id], now);
  const from = rows.find((a) => a.id === moving) ?? null;
  const facts = from ? factsOf(from) : null;
  const mover = from && facts && facts.choices.length > 0 ? { from, ...facts } : null;
  // The login whose sign-out block is open, and the login its agents move to (the user's pick).
  const [signing, setSigning] = useState<string | null>(null);
  const [outPicks, setOutPicks] = useState<Record<string, string>>({});
  const out = rows.find((a) => a.id === signing && a.loggedIn) ?? null;
  const outFacts = out ? signOutFacts(out, rows, outPicks[out.id], now) : null;
  const signOut = async (a: AccountInfo, to: MoveChoice | null) => {
    setBusy(true); setErr(""); setSaid("");
    const r = await signOutLogin(a.id, to?.id);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setSaid(signedOutText(r, nameOf(a), to?.name, a.persistent === true));
    if (r.signedOut) setSigning(null);
    await load();
  };

  return (
    <>
      <StatusLine status={accountsStatus(st.read, st.preferred)} />
      <Block title="Logins" right={(
        <button type="button" className={s.btn} disabled={busy} onClick={() => void add()}><PlusIcon size={14} />Add a login</button>
      )}>
        {rows.length === 0 && <Empty>{st.read === null ? "Reading the logins…" : "No logins found."}</Empty>}
        {rows.map((a) => {
          const { n, choices, to } = factsOf(a);
          const meta = loginMeta(a, now);
          const moveWord = n === 1 ? "Move its agent" : `Move its ${n} agents`;
          return (
          <Row key={a.id} title={nameOf(a)} className={s.loginRow}>
            <span className={s.rowName}>{nameOf(a)}</span>
            {a.id === st.preferred && <span className={s.tag}>Default for new agents</span>}
            {!a.loggedIn && <span className={s.tag} title={a.signedOut ? "Claude said that this login is signed out. No agent starts on it until you log in again." : undefined}>{a.signedOut ? "Signed out" : "Not logged in"}</span>}
            {a.persistent && !a.loggedIn && (a.waits?.length ?? 0) > 0 && <span className={s.rowMeta} data-part="waits">{waitersText(a.waits!)}</span>}
            {meta && <span className={s.rowMeta} data-part="use">{meta}</span>}
            {/* A login that needs the user (not logged in, or agents to move): its buttons always
                show. Else they show on hover, as in the other lists. */}
            <span className={b.act} data-part="acts" data-idle={!a.loggedIn || choices.length > 0 ? undefined : ""}>
              {/* One other login: one button that names it. More: the user picks the login. */}
              {choices.length === 1 && to && (
                <button type="button" className={`${s.btn} ${b.small}`} disabled={busy} onClick={() => void moveAll(a, to)} data-part="move-all"
                  title={`Each agent of this login moves to ${to.name} and keeps its conversation`}>
                  {moveWord} to {to.name}
                </button>
              )}
              {(choices.length > 1 || (choices.length === 1 && !to)) && moving !== a.id && (
                <button type="button" className={`${s.btn} ${b.small}`} disabled={busy} onClick={() => { setMoving(a.id); setOpen(null); setSigning(null); }}
                  title="Pick the login that the agents of this login move to">{moveWord}…</button>
              )}
              {a.loggedIn && a.id !== st.preferred && !a.persistent && (
                <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} onClick={() => void makeDefault(a.id)}
                  title="New agents start on this login">Make default</button>
              )}
              {open !== a.id && (
                <button type="button" className={`${s.btn} ${a.loggedIn ? s.quiet : ""} ${b.small}`} disabled={busy} onClick={() => { setOpen(a.id); setSigning(null); }}>
                  {a.loggedIn ? "Log in again" : "Log in"}
                </button>
              )}
              {!a.isDefault && !a.loggedIn && !a.persistent && (
                <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} onClick={() => void remove(a.id)}>Remove</button>
              )}
              {a.loggedIn && signing !== a.id && (
                <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} data-part="sign-out"
                  onClick={() => { setSigning(a.id); setMoving(null); setOpen(null); setSaid(""); }}
                  title="Your server forgets this login. The page says first what happens to its agents.">Sign out</button>
              )}
            </span>
          </Row>
          );
        })}
      </Block>
      <ErrorLine text={err} />
      {said && <Note>{said}</Note>}
      {mover && (() => {
        const { from, n, choices, to } = mover;
        return (
          <Block title={`Move the agents of ${nameOf(from)}`}>
            <div className={s.form} data-part="move-agents">
              <span className={m.pickRow}>
                <span className={m.quiet}>Move to</span>
                <span className={m.pick} data-part="move-to">
                  <Dropdown
                    value={to?.id ?? ""} placeholder="Pick a login…" disabled={busy}
                    options={choices.map((c) => ({ value: c.id, label: c.label }))}
                    onChange={(id) => setPicks((p) => ({ ...p, [from.id]: id }))}
                    title="The login that the agents move to"
                  />
                </span>
              </span>
              <Note>Each agent of {nameOf(from)} moves to the login you pick and keeps its conversation: the workers, the leads, the fleet master and the helper for tickets. A lead or the fleet master that is busy moves when it is quiet.</Note>
              <div className={s.actions}>
                <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy || !to}
                  onClick={() => { if (to) void moveAll(from, to).then(() => setMoving(null)); }}>
                  {busy ? "Moving…" : n === 1 ? "Move 1 agent" : `Move ${n} agents`}
                </button>
                <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={() => setMoving(null)}>Cancel</button>
              </div>
            </div>
          </Block>
        );
      })()}
      {out && outFacts && (() => {
        const { n, mode, choices, to } = outFacts;
        const word = mode === "move" ? `Move ${n === 1 ? "1 agent" : `${n} agents`} and sign out`
          : mode === "stop" ? `Stop ${n === 1 ? "1 agent" : `${n} agents`} and sign out` : "Sign out";
        return (
          <Block title={`Sign out of ${nameOf(out)}`}>
            <div className={s.form} data-part="sign-out-form">
              {mode === "move" && choices.length > 1 && (
                <span className={m.pickRow}>
                  <span className={m.quiet}>Move its agents to</span>
                  <span className={m.pick}>
                    <Dropdown
                      value={to?.id ?? ""} placeholder="Pick a login…" disabled={busy}
                      options={choices.map((c) => ({ value: c.id, label: c.label }))}
                      onChange={(id) => setOutPicks((p) => ({ ...p, [out.id]: id }))}
                      title="The login that the agents move to"
                    />
                  </span>
                </span>
              )}
              <Note>{signOutNote(out, outFacts, to?.name)}</Note>
              <div className={s.actions}>
                <button type="button" className={`${s.btn} ${s.primary}`} disabled={busy || (mode === "move" && !to)}
                  onClick={() => void signOut(out, mode === "move" ? to : null)}>
                  {busy ? "Signing out…" : word}
                </button>
                <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={() => setSigning(null)}>Cancel</button>
              </div>
            </div>
          </Block>
        );
      })()}
      {opened && (
        <Block title={`Claude login: ${nameOf(opened)}`}>
          <div className={s.form}>
            {/* key: a card for each login, so the state of one never shows for another. */}
            <ClaudeLogin key={opened.id} account={opened.id} auto onDone={load} onClose={() => { setOpen(null); void load(); }} />
          </div>
        </Block>
      )}
      {rows.some((a) => a.persistent) && (
        <Note>Your assistant (the fleet master), the leads and the helper that turns events into tickets have a sign-in of their own. Use the same Claude account and plan: this is a second sign-in, not a second plan. Then your agents cannot act as them.</Note>
      )}
      <Note>You log in on this page: the console shows the sign-in page of Claude and takes its code. New agents start on the default login. When that login is at its limit, a new agent starts on a login with room. When a login is signed out or at its limit, its row has a button that moves all its agents to another login. Sign out makes your server forget a login: the page says first what happens to its agents.</Note>
    </>
  );
}
