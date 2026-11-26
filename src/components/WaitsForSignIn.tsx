"use client";
// src/components/WaitsForSignIn.tsx — the card of a persistent agent (the fleet master, a lead)
// that waits for the second sign-in (server/chief/chiefwait.ts). One quiet line and the way to
// the sign-in, never "Needs you", "Stopped" or a Resume that does nothing. For the fleet master
// also a message that is kept for its start (POST /api/master/message). `login`: the wait is for a
// Claude login that was signed out in Settings (server/agents/loginhold.ts), not the second sign-in.
import { useState } from "react";
import { keepForMaster } from "../lib/master";
import s from "./WaitsForSignIn.module.css";

export function WaitsForSignIn({ who, onSetup, keep = false, login = false }: { who: string; onSetup?: () => void; keep?: boolean; login?: boolean }) {
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try { setSaid(await keepForMaster(t)); setText(""); } catch (e) { setSaid((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={s.wait} data-part="waits-sign-in">
      <p className={s.line}><span className={s.dot} aria-hidden />Waits for its sign-in</p>
      {login
        ? <p className={s.help}>{who} starts again by itself when you log in again: Settings, Claude accounts.</p>
        : <p className={s.help}>{who} starts after &ldquo;Sign in for your assistant&rdquo; on the Set-up page: a second sign-in, with the same Claude account and plan.</p>}
      {onSetup && !login && <div className={s.acts}><button type="button" className={s.btn} onClick={onSetup}>Open the Set-up page</button></div>}
      {keep && (
        <div className={s.form}>
          <textarea className={s.box} value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
            placeholder="Write to the fleet master. It gets your message when it starts." aria-label="A message for the fleet master" />
          <div className={s.acts}>
            <button type="button" className={s.btn} disabled={busy || !text.trim()} onClick={() => void send()}>Keep it for the fleet master</button>
            {said && <p className={s.said} role="status">{said}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
