// src/components/setup/GithubStep.tsx — the open "Connect GitHub" row of the Set-up list: the
// code login of GitHub, started by a button and run on the server, and then one confirm for the
// name on commits when git has none. The row never says "connected" by itself: it reads the
// state of the login, and the check of the step list decides (onDone reads the list again).
// No password and no token is typed here or passes through this page. With the GitHub app switch
// on (the view has `app`), the login is the ChoiBot app's, with the same code. One action: the
// person chooses the app's repos in the next step, "Pick a repo" (RepoStep).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  appApproveLine, appReachLine, oneStepCard, fetchCommitName, fetchLogin, loginProblem, minutesLeft, needsCommitName, saveCommitName, startLogin,
  type CommitNameView, type LoginView,
} from "../../lib/setupActions";
import type { SetupRow } from "../../lib/setup";
import { ExternalIcon } from "../SideIcons";
import { cx as k } from "../settings/kit";
import c from "./Setup.module.css";

const POLL_MS = 3000;

// The name for commits: what the step will set, and one button to confirm.
function CommitName({ onDone }: { onDone: () => Promise<void> }) {
  const [view, setView] = useState<CommitNameView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    void fetchCommitName().then((v) => { if (live) setView(v); }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);
  const save = async () => {
    setBusy(true); setErr("");
    try { await saveCommitName(); await onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (!view) return err ? <p className={c.error} role="alert">{err}</p> : <p className={c.today}>Reading your GitHub account…</p>;
  if (!view.suggest) return <p className={c.today}>GitHub gave no account to take the name from. Press Check again.</p>;
  return (
    <>
      <p className={c.today}>Each commit of your agents carries a name and an e-mail. Your server has none yet. This takes them from your GitHub account:</p>
      <dl className={c.facts}>
        {!view.name && <><dt>Name</dt><dd>{view.suggest.name}</dd></>}
        {!view.email && <><dt>E-mail</dt><dd>{view.suggest.email}</dd></>}
      </dl>
      {!view.email && <p className={c.quiet}>This is the address GitHub gives your account for commits. It keeps your own e-mail private.</p>}
      {err && <p className={c.error} role="alert">{err}</p>}
      <div className={c.acts}>
        <button type="button" className={`${k.btn} ${k.primary}`} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Use this name"}</button>
      </div>
    </>
  );
}

// `place`: with the ChoiBot app (the view has `app`), step 2 says what the approval gives.
function CodeCard({ view, onFresh, busy, place }: { view: Extract<LoginView, { state: "waiting" }>; onFresh: () => void; busy: boolean; place: "setup" | "settings" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(view.code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the code can be selected by hand */ }
  };
  return (
    <div className={c.card} data-part="code">
      <div className={c.cardHead}><span>Your code</span><span className={c.waiting}><i className={c.pulse} aria-hidden />Waiting for your approval on GitHub</span></div>
      <div className={c.codeLine}>
        <output className={c.code} aria-label="One-time code">{view.code}</output>
        <button type="button" className={k.btn} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <ol className={c.steps}>
        <li>Open <b>github.com/login/device</b> on this device or on your phone.</li>
        <li>{view.app ? appApproveLine(place) : "Type the code, then approve."}</li>
      </ol>
      <div className={c.acts}>
        <a className={`${k.btn} ${k.primary}`} href={view.url} target="_blank" rel="noopener noreferrer">Open github.com/login/device<ExternalIcon /></a>
        <button type="button" className={`${k.btn} ${k.quiet}`} disabled={busy} onClick={onFresh}>New code</button>
      </div>
      <p className={c.quiet}>The code is valid for {minutesLeft(view.leftMs)}. This page checks every few seconds. You can close it and come back.</p>
    </div>
  );
}

// The name for commits with the ChoiBot app in Set-up: taken from the GitHub account with no
// confirm (the server sets it only where git has none). If that fails, the ask of today.
function AutoCommitName({ onDone }: { onDone: () => Promise<void> }) {
  const [ask, setAsk] = useState(false);
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    void saveCommitName().then(() => onDone(), () => setAsk(true));
  }, [onDone]);
  if (ask) return <CommitName onDone={onDone} />;
  return <p className={c.today}>Taking the name for your commits from GitHub…</p>;
}

// The one card "Connect GitHub" of the ChoiBot app in Set-up (oneStepCard has its words). Press 1
// is a link: it opens GitHub's device page with the code in it, and copies the code.
function OneStepCard({ view, pressed, onPress, onFresh, busy }: {
  view: LoginView | null; pressed: boolean; onPress: (code: string) => void; onFresh: () => void; busy: boolean;
}) {
  const card = oneStepCard(view, pressed);
  if (card.kind === "starting" || card.kind === "approved") return <p className={c.today}>{card.line}</p>;
  if (card.kind === "failed") {
    return (
      <>
        <p className={c.error} role="alert">{card.line}</p>
        <div className={c.acts}><button type="button" className={`${k.btn} ${k.primary}`} disabled={busy} onClick={onFresh}>{busy ? "Asking GitHub for a code…" : "New code"}</button></div>
      </>
    );
  }
  return (
    <div className={c.card} data-part="code">
      <div className={c.cardHead}>
        <span>Your code <b>{card.code}</b></span>
        {card.kind === "approve" && <span className={c.waiting}><i className={c.pulse} aria-hidden />Waiting for your approval</span>}
      </div>
      <p className={c.today}>{card.line}</p>
      <div className={c.acts}>
        <a className={`${k.btn} ${k.primary}`} href={card.href} target="_blank" rel="noopener noreferrer" onClick={() => onPress(card.code)}>{card.button}<ExternalIcon /></a>
        {card.kind === "approve" && <button type="button" className={`${k.btn} ${k.quiet}`} disabled={busy} onClick={onFresh}>New code</button>}
      </div>
    </div>
  );
}

// `place`: the Set-up list (the default) or Settings, for the line on what the app reaches.
export function GithubStep({ row, onDone, place = "setup" }: { row: SetupRow; onDone: () => Promise<void>; place?: "setup" | "settings" }) {
  const [view, setView] = useState<LoginView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const named = needsCommitName(row);
  // The one step of the ChoiBot app (src/lib/setup.ts oneGithubStep): only in Set-up.
  const oneStep = place === "setup" && row.app === true;
  const [pressed, setPressed] = useState(false);
  const autoStarted = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  // The step list is read again one time for each login that ends well.
  const told = useRef(false);
  const take = useCallback((next: LoginView) => {
    setView(next);
    if (next.state !== "done") { told.current = false; return; }
    if (!told.current) { told.current = true; void done.current(); }
  }, []);

  useEffect(() => {
    if (named) return;
    let live = true;
    // A login that ended before this row opened is old news: the check of the list decided.
    void fetchLogin().then((v) => { if (live) setView(v.state === "done" ? { state: "idle" } : v); }, () => { if (live) setView({ state: "idle" }); });
    return () => { live = false; };
  }, [named]);

  const waits = view?.state === "starting" || view?.state === "waiting";
  useEffect(() => {
    if (named || !waits) return;
    const tick = setInterval(() => { void fetchLogin().then(take, () => {}); }, POLL_MS);
    return () => clearInterval(tick);
  }, [named, waits, take]);

  const start = async (fresh: boolean) => {
    setBusy(true); setErr("");
    if (fresh) setPressed(false);
    try { take(await startLogin(fresh)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // The one step: the code is asked for when the card opens, so that press 1 has it.
  useEffect(() => {
    if (!oneStep || named || view?.state !== "idle" || autoStarted.current) return;
    autoStarted.current = true;
    void start(false);
  }, [oneStep, named, view]);

  const press = (code: string) => {
    setPressed(true);
    try { void navigator.clipboard?.writeText(code).catch(() => {}); } catch { /* the code is on the card */ }
  };

  if (named) return oneStep ? <AutoCommitName onDone={onDone} /> : <CommitName onDone={onDone} />;
  if (oneStep) {
    return (
      <>
        <OneStepCard view={view} pressed={pressed} busy={busy} onPress={press} onFresh={() => void start(true)} />
        {err && <p className={c.error} role="alert">{err}</p>}
      </>
    );
  }
  if (view === null) return <p className={c.today}>Reading the state of the login…</p>;
  if (view.state === "waiting") return <CodeCard view={view} busy={busy} place={place} onFresh={() => void start(true)} />;
  const failed = view.state === "failed" ? view.reason : null;
  const app = view.app ?? null;
  const again = failed !== null && failed !== "no-gh" && failed !== "env-token";
  return (
    <>
      {failed
        ? <p className={c.error} role="alert">{loginProblem(failed)}</p>
        : view.state === "done"
          ? <p className={c.today}>GitHub approved the login. The check runs now.</p>
          : app
            ? (
              <>
                <p className={c.today}>You get a short code. You type it on github.com and approve.</p>
                <p className={c.today}>{appReachLine(place)}</p>
              </>
            )
            : <p className={c.today}>You get a short code. You type it on github.com and approve. No password and no token passes through this page: GitHub gives your server its own key.</p>}
      {err && <p className={c.error} role="alert">{err}</p>}
      {failed !== "env-token" && (
        <div className={c.acts}>
          <button type="button" className={`${k.btn} ${k.primary}`} disabled={busy || view.state === "starting"} onClick={() => void start(again)}>
            {busy || view.state === "starting" ? "Asking GitHub for a code…" : again ? "New code" : "Connect GitHub"}
          </button>
        </div>
      )}
    </>
  );
}
