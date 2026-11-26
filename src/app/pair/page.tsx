// src/app/pair/page.tsx — the pairing screen of one more device. A paired device pressed "Add a
// device" and shows a code picture; this device opened the address of the picture, so the code
// is in the fragment of the address and fills the field. The user gives the device a short name
// and confirms with one press. With no picture, the user opens this page and types the code.
//
// The code never goes into a request line: the fragment stays in the browser, this page takes it
// out of the address at once, and the claim sends it in a POST body (server/chief/adddevice.ts).
"use client";
import { useEffect, useState, type FormEvent } from "react";
import { BrandMark } from "../../components/BrandMark";
import { claimAddDevice, codeFromHash, deviceKind, deviceName, pairedDevices, type AddClaimError } from "../../lib/addDevice";
import { hasUserToken } from "../../lib/chief";
import { DISPLAY_NAME } from "../../../server/brand";
import s from "../first-run/page.module.css";

const AGAIN = "Press “Add a device” again on a paired device.";
const ERRORS: Record<AddClaimError, string> = {
  wrong: "This code is not correct. Check it and try again.",
  gone: `This code does not work now. It was used, or it is older than 5 minutes. ${AGAIN}`,
  spent: `Too many wrong codes, so this code stopped. ${AGAIN}`,
  storage: "This browser cannot keep the pairing. Open this page in Safari or Chrome, not inside another app.",
  failed: "The pairing did not work. Try again.",
  name: "Use letters, digits and - for the name, 32 at most.",
  off: "This console does not pair a device with a code from a paired device.",
};

const openConsole = (): void => window.location.replace("/");

export default function PairPage() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  // What this browser says it is. Known in the browser only, so it is set after the first paint.
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AddClaimError | null>(null);
  // "as": the name the server gave. "already": this browser was paired before it came here.
  const [paired, setPaired] = useState<{ as: string } | "already" | null>(null);

  useEffect(() => {
    const fromLink = codeFromHash(window.location.hash);
    if (fromLink) setCode(fromLink);
    // The code goes out of the address bar and out of the history of this browser.
    if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
    setKind(deviceKind());
    setName(deviceKind());
    // A browser with a token that still works needs no second pairing: its code stays unused.
    let live = true;
    if (hasUserToken()) void pairedDevices().then((list) => { if (live && list) setPaired("already"); });
    return () => { live = false; };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    const label = deviceName(name) || kind || deviceKind();
    setBusy(true);
    const r = await claimAddDevice(code, label);
    setBusy(false);
    if (r.ok) setPaired({ as: r.label || label });
    else setError(r.error);
  };

  return (
    <main className={s.screen}>
      <div className={s.card}>
        <div className={s.head}>
          <BrandMark size={36} />
          <h1 className={s.title}>Add this device to {DISPLAY_NAME}</h1>
          <p className={s.lead}>
            {paired ? "Only paired devices can use this console." : "Pair this device to open the console. Only paired devices can use it."}
          </p>
        </div>
        {paired ? (
          <div className={s.form}>
            <p className={s.done} role="status">
              <i className={s.dot} aria-hidden />
              {paired === "already" ? "This device is paired already." : <>This device is paired as {paired.as}.</>}
            </p>
            <button type="button" className={s.btn} onClick={openConsole} autoFocus>Open {DISPLAY_NAME}</button>
          </div>
        ) : (
          <form className={s.form} onSubmit={(e) => void submit(e)} aria-label="Pair this device">
            <label className={s.field}>
              <span className={s.label}>Code from the paired device</span>
              <input
                className={s.input} value={code} placeholder="XXXX-XXXX" maxLength={24}
                autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                aria-invalid={error === "wrong" ? true : undefined} aria-describedby={error ? "pair-error" : undefined}
                onChange={(e) => { setCode(e.target.value); setError(null); }}
              />
            </label>
            <label className={s.field}>
              <span className={s.label}>Name of this device</span>
              <input
                className={`${s.input} ${s.name}`} value={name} placeholder={kind} maxLength={32}
                autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                aria-invalid={error === "name" ? true : undefined} aria-describedby={error ? "pair-error" : undefined}
                onChange={(e) => { setName(e.target.value); setError(null); }}
              />
            </label>
            {error && <p id="pair-error" className={s.err} role="alert">{ERRORS[error]}</p>}
            <button type="submit" className={s.btn} disabled={busy || !code.trim()}>Pair this device</button>
          </form>
        )}
        {!paired && (
          <p className={s.note}>
            The code comes from a device that is paired: in Settings, Devices, press “Add a device”. It works one time, for 5 minutes.
          </p>
        )}
      </div>
    </main>
  );
}
