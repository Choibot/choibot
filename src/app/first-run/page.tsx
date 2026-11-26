// src/app/first-run/page.tsx — the pairing screen of a new install. A console with no paired
// device serves this page at every address (server/chief/firstrun.ts) and answers nothing else.
// One field: the code that the set-up printed on the box ("your server" for the user). No Telegram, no password.
//
// A console with a claim link (server/chief/claimlink.ts; a hosted console) is opened with the
// secret in the fragment of the address: /first-run#k=<secret>. The page takes it out of the
// address at once, and one press ("This is my console") sends it in a POST body. A hosted console
// shows no code field: its owner has no terminal, and a new link comes from the dashboard.
"use client";
import { useEffect, useState, type FormEvent } from "react";
import { BrandMark } from "../../components/BrandMark";
import { deviceKind, deviceName } from "../../lib/addDevice";
import { claimFirstRun, firstRunState, linkFromHash, type FirstRunError, type FirstRunState } from "../../lib/chief";
import { DISPLAY_NAME, USER_CLI } from "../../../server/brand";
import s from "./page.module.css";

// The command as the user of this install types it (`choibot pair` after the install line).
const NEW_CODE = `${USER_CLI} pair`;

// Each text with backticks around a command.
const ERRORS: Record<FirstRunError, string> = {
  wrong: "This code is not correct. Check it and try again.",
  gone: `This code does not work now. It was used, or it is older than 10 minutes. For a new code, run \`${NEW_CODE}\` on your server.`,
  spent: `Too many wrong codes, so this code stopped. Get a new code on your server: run \`${NEW_CODE}\`.`,
  storage: "This browser cannot keep the pairing. Open this page in Safari or Chrome, not inside another app.",
  failed: "The pairing did not work. Try again.",
};

const withCode = (text: string) => text.split("`").map((t, n) => (n % 2 ? <code key={n}>{t}</code> : t));

// The claim link. A hosted console gets a new link from the dashboard of the service; a console
// of the owner's own server gets a code with the command.
const NEW_LINK = `Make a new link on your ${DISPLAY_NAME} dashboard.`;
const newKey = (hosted: boolean) => (hosted ? NEW_LINK : `For a code, run \`${NEW_CODE}\` on your server.`);
const linkErrors = (hosted: boolean): Record<FirstRunError, string> => ({
  wrong: "This link is not the link of this console. Open the link from your dashboard again.",
  gone: `This link does not work now. It was used, or it is too old. ${newKey(hosted)}`,
  spent: `Too many wrong links, so the link of this console stopped. ${newKey(hosted)}`,
  storage: ERRORS.storage,
  failed: ERRORS.failed,
});

// The console itself: this address when the server put the screen here, else the home.
function openConsole(): void {
  if (window.location.pathname === "/first-run") window.location.replace("/");
  else window.location.reload();
}

export default function FirstRunPage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FirstRunError | null>(null);
  const [paired, setPaired] = useState(false);
  // The claim link: its secret from the address, the name of this device, the state of the console.
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const [state, setState] = useState<FirstRunState | null>(null);

  // A console that is not locked has no use for this screen (a device paired in the meantime,
  // or this address opened by hand).
  useEffect(() => {
    setKind(deviceKind());
    setName(deviceKind());
    let live = true;
    // At the first paint, and when a link is opened in this tab on this same address (only the
    // part after "#" changes, so the page does not load again).
    const take = () => {
      const fromLink = linkFromHash(window.location.hash);
      // The secret goes out of the address bar and out of the history of this browser at once.
      if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
      setSecret(fromLink);
      setError(null);
      setState(null);
      void firstRunState().then((st) => {
        if (!live) return;
        if (!st.locked) openConsole();
        else setState(st);
      });
    };
    take();
    window.addEventListener("hashchange", take);
    return () => { live = false; window.removeEventListener("hashchange", take); };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    const r = await claimFirstRun(code, deviceKind());
    setBusy(false);
    if (r.ok) setPaired(true);
    else setError(r.error);
  };

  const claimLink = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !secret) return;
    setBusy(true);
    const r = await claimFirstRun(secret, deviceName(name) || kind || deviceKind(), {}, "claim");
    setBusy(false);
    if (r.ok) setPaired(true);
    else setError(r.error);
  };

  const hosted = state?.hosted === true;
  // What the screen shows: the press of the owner (a link that works, and its secret in the
  // address), a line for a hosted console, or the code field of today.
  const view = paired ? "paired"
    : state === null ? "wait"
    : secret && state.link === "open" ? "link"
    : hosted || (secret && state.link === "ended") ? "hosted"
    : "code";

  return (
    <main className={s.screen}>
      <div className={s.card}>
        <div className={s.head}>
          <BrandMark size={36} />
          <h1 className={s.title}>This is your new {DISPLAY_NAME}</h1>
          <p className={s.lead}>
            {view === "link" ? "You opened the link of your new console. This device becomes its first device. Only paired devices can use this console."
              : paired ? "Only paired devices can use this console." : "Pair this device to open it. Only paired devices can use this console."}
          </p>
        </div>
        {view === "paired" && (
          <div className={s.form}>
            <p className={s.done} role="status"><i className={s.dot} aria-hidden />This device is paired.</p>
            <button type="button" className={s.btn} onClick={openConsole} autoFocus>Open {DISPLAY_NAME}</button>
          </div>
        )}
        {view === "link" && (
          <form className={s.form} onSubmit={(e) => void claimLink(e)} aria-label="Pair this device">
            <label className={s.field}>
              <span className={s.label}>Name of this device</span>
              <input
                className={`${s.input} ${s.name}`} value={name} placeholder={kind} maxLength={32}
                autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                aria-describedby={error ? "first-run-error" : undefined}
                onChange={(e) => { setName(e.target.value); setError(null); }}
              />
            </label>
            {error && <p id="first-run-error" className={s.err} role="alert">{withCode(linkErrors(hosted)[error])}</p>}
            <button type="submit" className={s.btn} disabled={busy} autoFocus>This is my console</button>
          </form>
        )}
        {view === "link" && <p className={s.note}>The link works one time. It cannot pair a second device.</p>}
        {view === "hosted" && (
          <div className={s.form}>
            {state?.link === "open"
              ? <p className={s.lead} role="status">Open the link from your dashboard on this device. It pairs this device with one press.</p>
              : <p className={s.err} role="alert">{withCode(`The link of this console does not work now. It was used, or it is too old. ${newKey(hosted)}`)}</p>}
          </div>
        )}
        {view === "code" && (
          <form className={s.form} onSubmit={(e) => void submit(e)} aria-label="Pair this device">
            <label className={s.field}>
              <span className={s.label}>Code from your server</span>
              <input
                className={s.input} value={code} placeholder="XXXX-XXXX" maxLength={24} autoFocus
                autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                aria-invalid={error === "wrong" ? true : undefined} aria-describedby={error ? "first-run-error" : undefined}
                onChange={(e) => { setCode(e.target.value); setError(null); }}
              />
            </label>
            {error && <p id="first-run-error" className={s.err} role="alert">{withCode(ERRORS[error])}</p>}
            <button type="submit" className={s.btn} disabled={busy || !code.trim()}>Pair this device</button>
          </form>
        )}
        {view === "code" && (
          <p className={s.note}>
            {withCode(`The set-up printed the code on your server. It works one time, for 10 minutes. For a new code, run \`${NEW_CODE}\` on your server.`)}
          </p>
        )}
      </div>
    </main>
  );
}
