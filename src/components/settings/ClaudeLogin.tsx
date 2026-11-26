// src/components/settings/ClaudeLogin.tsx — the Claude login of one account, on the page. The
// console runs the login of Claude Code on your server (server/agents/claudelogin.ts): this
// card shows the sign-in link, takes the code that the page of Claude gives, and says who is
// logged in. No terminal. The code goes to your server one time and is not kept.
//
// The Claude accounts section of Settings and the "Log in to Claude" row of the Set-up list
// both draw this one part.
"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  cancelClaudeLogin, claudeLoginDone, claudeLoginProblem, fetchClaudeLogin, sendClaudeLoginCode, startClaudeLogin,
  type ClaudeLoginView,
} from "../../lib/accounts";
import { minutesLeft } from "../../lib/setupActions";
import { ExternalIcon } from "../SideIcons";
import { cx as k, Dot } from "./kit";
import c from "./TelegramConnect.module.css";

const POLL_MS = 2500;

// `account`: the login to log in to. `auto`: start at once (the user pressed the button that
// opened this card). `onDone`: a login ended well. `onClose`: the user closes the card.
export function ClaudeLogin({ account, auto = false, startLabel = "Log in to Claude", onDone, onClose }: {
  account: string; auto?: boolean; startLabel?: string; onDone?: () => void | Promise<void>; onClose?: () => void;
}) {
  const [view, setView] = useState<ClaudeLoginView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [code, setCode] = useState("");
  const done = useRef(onDone);
  done.current = onDone;
  // The caller hears one time of each login that ends well.
  const told = useRef(false);
  // The state of the server is for this card only when it is of this account.
  const take = useCallback((next: ClaudeLoginView) => {
    const mine = next.state === "idle" || next.account === account ? next : ({ state: "idle" } as const);
    setView(mine);
    if (mine.state !== "done") { told.current = false; return; }
    if (!told.current) { told.current = true; void done.current?.(); }
  }, [account]);

  const start = useCallback(async (fresh: boolean) => {
    setBusy(true); setErr(""); setCode("");
    try { take(await startClaudeLogin(account, fresh)); } catch (e) { setErr((e as Error).message); setView((v) => v ?? { state: "idle" }); } finally { setBusy(false); }
  }, [account, take]);

  const started = useRef(false);
  useEffect(() => {
    let live = true;
    void fetchClaudeLogin(undefined, account).then((v) => {
      if (!live) return;
      // A result of an earlier login is old news. A login of this account that waits is shown.
      const waits = v.state !== "idle" && v.account === account && (v.state === "waiting" || v.state === "starting" || v.state === "checking");
      if (waits) take(v);
      else if (auto && !started.current) { started.current = true; void start(false); }
      else setView({ state: "idle" });
    }, () => { if (live) setView({ state: "idle" }); });
    return () => { live = false; };
  }, [account, auto, start, take]);

  const open = view?.state === "starting" || view?.state === "waiting" || view?.state === "checking";
  useEffect(() => {
    if (!open) return;
    const tick = setInterval(() => { void fetchClaudeLogin(undefined, account).then(take, () => {}); }, POLL_MS);
    return () => clearInterval(tick);
  }, [open, take]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = code.trim();
    if (!text || busy) return;
    setBusy(true); setErr("");
    try { take(await sendClaudeLoginCode(text, undefined, account)); setCode(""); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const close = async () => {
    await cancelClaudeLogin(undefined, account).catch(() => {});
    setView({ state: "idle" }); setErr(""); setCode("");
    onClose?.();
  };

  if (view === null) return <p className={c.quiet}>Reading the state of the login…</p>;

  if (view.state === "waiting" || view.state === "checking") {
    const checking = view.state === "checking";
    return (
      <div className={c.card} data-part="claude-login">
        <div className={c.cardHead}>
          <span>Sign in to Claude</span>
          <span className={c.waiting}><i className={c.pulse} aria-hidden />{checking ? "Claude checks the code" : "Waiting for your code"}</span>
        </div>
        {view.state === "waiting" && (
          <>
            <ol className={c.steps}>
              <li>Open the sign-in page of Claude. Sign in with the account you want here, and approve.</li>
              <li>The page shows a code. Copy it.</li>
              <li>Paste the code here.</li>
            </ol>
            <div className={c.acts}>
              <a className={`${k.btn} ${k.primary}`} href={view.url} target="_blank" rel="noopener noreferrer">Open the sign-in page<ExternalIcon /></a>
            </div>
          </>
        )}
        <form className={c.codeLine} onSubmit={(e) => void send(e)} aria-label="Finish the login">
          <input className={k.input} style={{ flex: 1, minWidth: 0 }} type="password" value={code} placeholder="Paste the code of the Claude page" aria-label="Code of the Claude page"
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy || checking}
            onChange={(e) => { setCode(e.target.value); setErr(""); }} />
          <button type="submit" className={`${k.btn} ${k.primary}`} disabled={busy || checking || !code.trim()}>{checking ? "Checking…" : "Finish the login"}</button>
        </form>
        {err && <p className={c.bad} role="alert">{err}</p>}
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={busy || checking} onClick={() => void start(true)}>New link</button>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={busy} onClick={() => void close()}>Cancel</button>
        </div>
        {view.state === "waiting" && (
          <p className={c.quiet}>The link works for {minutesLeft(view.leftMs)}, and its code works one time. The code goes to your server and is not kept. A paid Claude plan is needed: Pro, Max, Team or Enterprise.</p>
        )}
      </div>
    );
  }

  if (view.state === "done") {
    return (
      <div className={c.card} data-part="claude-login" role="status">
        <p className={c.line}><Dot tone="ok" /><span>{claudeLoginDone(view)}</span></p>
        <p className={c.quiet}>Not the right account? Press Log in again, and sign in with the other account on the page of Claude.</p>
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.quiet}`} disabled={busy} onClick={() => void start(true)}>Log in again</button>
          {onClose && <button type="button" className={k.btn} onClick={() => void close()}>Done</button>}
        </div>
      </div>
    );
  }

  const failed = view.state === "failed" ? view.reason : null;
  const starting = busy || view.state === "starting";
  return (
    <>
      {failed && <p className={c.bad} role="alert">{claudeLoginProblem(failed)}</p>}
      {err && <p className={c.bad} role="alert">{err}</p>}
      {failed !== "no-claude" && (
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.primary}`} disabled={starting} onClick={() => void start(failed !== null)}>
            {starting ? "Getting the sign-in link…" : failed ? "New link" : startLabel}
          </button>
          {onClose && <button type="button" className={`${k.btn} ${k.quiet}`} disabled={busy} onClick={() => void close()}>Cancel</button>}
        </div>
      )}
    </>
  );
}
