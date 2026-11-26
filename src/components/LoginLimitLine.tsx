// src/components/LoginLimitLine.tsx — one line under the header of an agent whose Claude login
// is at its limit: "This login is at its limit until 14:00", and one button that moves the
// agent to a login with room. With more than one other login, the user picks which one: the
// login with the most room is the pick until the user changes it. The same line when one model has no room on the login ("no room
// for Fable until Fri 14:00"): the user decides if this agent moves. The agent keeps its conversation. The same line for a worker,
// a lead and the fleet master (the pane of each is AgentPane). With no login at its limit the
// line is not there.
//
// More cases of the same line (the record of the agent says them): the agent was cut by a
// limit and the usage read does not show it yet; the agent has no session yet because no
// login had room ("Start" on a login); the agent started on another login than the default.
// After a move of an agent that was cut, the console tells it to go on: the user types nothing.
//
// The server decides what "at its limit" is (server/agents/loginuse.ts) and does the move
// (POST /api/agents/:id/account: a lead and the fleet master move through the relaunch of the
// chief of staff).
"use client";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_ACCOUNT, fetchAccounts, limitLine, moveChoices, switchAgentAccount, type AccountInfo, type AgentLimitFacts,
} from "../lib/accounts";
import { Dropdown } from "./Dropdown";
import { fetchAgent } from "../lib/agents";
import s from "./LoginLimitLine.module.css";

// The usage of a login changes slowly, and the console reads it every 3 minutes.
const POLL_MS = 60_000;

export function LoginLimitLine({ agentId }: { agentId: string }) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  // null: not read yet. "": not a Claude agent. Else the login of this agent.
  const [current, setCurrent] = useState<string | null>(null);
  const [facts, setFacts] = useState<AgentLimitFacts>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  // The login that the user picked for the move. Null: the pick of the console (the most room).
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, agent] = await Promise.all([fetchAccounts().catch(() => null), fetchAgent(agentId).catch(() => null)]);
    if (list) setAccounts(list);
    if (agent) {
      setCurrent(agent.runtime && agent.runtime !== "claude" ? "" : (agent.account ?? DEFAULT_ACCOUNT));
      setFacts({ status: agent.status, stop: agent.stop, waitsLogin: agent.waitsLogin, startedOn: agent.startedOn });
    }
  }, [agentId]);

  useEffect(() => {
    setNote(""); setErr(""); setCurrent(null); setPicked(null); setFacts({});
    void load();
    const tick = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(tick);
  }, [load]);

  if (!accounts || !current) return null;
  const mine = accounts.find((a) => a.id === current) ?? null;
  const waits = !!facts.waitsLogin;
  // An agent that waits can start on each login, its own one too.
  const from = waits ? "" : current;
  const line = limitLine({ agent: facts, login: mine, others: accounts.filter((a) => a.id !== current && a.loggedIn).length, now: Date.now() });
  if (!line) return note ? <div className={s.line} role="status"><span className={`${s.text} ${s.quiet}`}>{note}</span></div> : null;

  // Each other login that is logged in, the ones with room first. The user's pick while it is
  // in the list, else the first one with room. No login with room: the user must pick.
  const choices = line.act ? moveChoices(accounts, from, line.models) : [];
  const to = choices.find((c) => c.id === picked) ?? choices.find((c) => c.room) ?? null;
  const wasCut = !!facts.stop;
  const move = async () => {
    if (!to || busy) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const outcome = await switchAgentAccount(agentId, to.id);
      setNote(waits ? `Started on ${to.name}.`
        : outcome === "waits" ? `The agent is busy now. It moves to ${to.name} when it is quiet.`
        : wasCut ? `Moved to ${to.name}. The agent goes on by itself.`
        : `Moved to ${to.name}. The agent keeps its conversation.`);
      setPicked(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error && / /.test(e.message) ? `The agent did not move: ${e.message}` : "The agent did not move. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const verb = line.act === "start" ? "Start" : "Move";

  return (
    <div className={s.line} role="status" data-part="login-limit" data-act={line.act ?? "none"}>
      <span className={s.text}>
        {line.act && <i className={s.dot} aria-hidden />}
        <span>
          {line.act ? line.head : <span className={s.quiet}>{line.head}</span>} <span className={s.quiet}>{line.quiet}</span>
          {note && <> <span className={s.quiet}>{note}</span></>}
        </span>
      </span>
      {/* One other login with room: one button that names it. More logins: the user picks. */}
      {choices.length === 1 && to && (
        <button type="button" className={s.btn} disabled={busy} onClick={() => void move()}>{busy ? `${verb === "Start" ? "Starting" : "Moving"}…` : `${verb} ${verb === "Start" ? "on" : "to"} ${to.name}`}</button>
      )}
      {(choices.length > 1 || (choices.length === 1 && !to)) && (
        <span className={s.pickRow}>
          <span className={s.quiet}>{verb} {verb === "Start" ? "on" : "to"}</span>
          <span className={s.pick}>
            <Dropdown
              value={to?.id ?? ""} placeholder="Pick a login…" disabled={busy}
              options={choices.map((c) => ({ value: c.id, label: c.label }))}
              onChange={setPicked} title={verb === "Start" ? "The login that this agent starts on." : "The login that this agent moves to. The agent keeps its conversation."}
            />
          </span>
          <button type="button" className={s.btn} disabled={busy || !to} onClick={() => void move()}>{busy ? `${verb === "Start" ? "Starting" : "Moving"}…` : verb}</button>
        </span>
      )}
      {err && <span className={s.err} role="alert">{err}</span>}
    </div>
  );
}
