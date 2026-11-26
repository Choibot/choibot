// src/components/settings/AddDevice.tsx — "Add a device": the paired user presses the button, and
// the page shows a code picture, the same code as text, and the time left. The new device opens
// the address of the picture, confirms with one press, and comes into the list of this page.
// Settings > Devices and the phone card of the Set-up page both draw this part.
//
// The server makes the code for a paired device only (server/chief/adddevice.ts). The picture is
// drawn here, in the page (qrcode.react): the code goes to no other service.
//
// When this browser reached the console at an address of this computer only (localhost through a
// tunnel), a picture cannot work: the part asks for no code and says what the phone needs first.
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  addedWords, cancelAddCode, countdown, loopbackHost, mintAddCode, newDevices, pairedDevices, pairLink, PAIR_PAGE,
} from "../../lib/addDevice";
import { fetchBrain, revokeDevice, type Device } from "../../lib/brain";
import { clockText } from "../../lib/queueInbox";
import { ACCESS_TODAY, fetchSetup } from "../../lib/setup";
import { DISPLAY_NAME } from "../../../server/brand";
import { ACCESS_READY, type StepStatus } from "../../../server/setup/steps";
import { cx as s, Dot, ErrorLine, Row } from "./kit";
import a from "./AddDevice.module.css";
import b from "./Brain.module.css";

// How often the page asks for the device list while a code is open.
const POLL_MS = 2_000;

// How this console pairs one more device. null: not known yet, or pairing is off.
export type PairWay = "log" | "telegram" | null;

// Text with `commands` in backticks.
const words = (text: string): ReactNode => text.split("`").map((t, n) => (n % 2 ? <code key={n}>{t}</code> : t));

// One paired device: its name, when it was paired, and Revoke (a second press confirms). The
// label is untrusted: plain text only.
export function DeviceRow({ d, now, onChange, onError }: {
  d: Device; now: number; onChange: () => void | Promise<void>; onError?: (text: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true); onError?.("");
    const r = await revokeDevice(d.label);
    setBusy(false);
    if (r.ok) setAsking(false); else onError?.(r.error);
    await onChange();
  };
  return (
    <Row>
      <span className={s.rowName}>{d.label}</span>
      <span className={s.rowMeta}>
        paired {clockText(d.createdAt, now)}{d.lastUsedAt ? ` · last used ${clockText(d.lastUsedAt, now)}` : ""}
      </span>
      {asking ? (
        <span className={b.act}>
          <span className={b.ask}>Revoke?</span>
          <button type="button" className={`${s.btn} ${b.small}`} disabled={busy} onClick={() => void revoke()}>Yes</button>
          <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} onClick={() => setAsking(false)}>No</button>
        </span>
      ) : (
        <span className={b.act} data-idle>
          <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} onClick={() => setAsking(true)}>Revoke</button>
        </span>
      )}
    </Row>
  );
}

type View =
  | { at: "idle" }
  | { at: "busy" }
  // This address works on this computer only. `step`: the state of the step that gives the
  // console a private address (null: the list gave no answer).
  | { at: "local"; step: StepStatus | null }
  // `until`: when the code stops, on the clock of this browser. `before`: the devices at that time.
  // `origin`: the private address of the server, when this browser is at an address that works
  // on this computer only (the SSH tunnel): the code is for that address.
  | { at: "code"; code: string; until: number; before: Device[]; origin?: string }
  | { at: "old" }
  | { at: "added"; device: Device };

export function AddDevice({ auth, what = "device", row = false, auto = false, onAdded }: {
  // Given by a place that knows it (Settings). Not given: the part asks the console itself.
  auth?: PairWay;
  // The words: the phone card of the Set-up page says "phone".
  what?: "device" | "phone";
  // After the add: the row of the new device with Revoke, for a place that has no device list.
  row?: boolean;
  // Start at once: the press that opened this part was the user's "add" (the card of the done screen).
  auto?: boolean;
  onAdded?: () => void | Promise<void>;
}) {
  const [asked, setAsked] = useState<PairWay>(null);
  useEffect(() => {
    if (auth !== undefined) return;
    let live = true;
    void fetchBrain().then((v) => { if (live && v.state === "on") setAsked(v.brain.userAuth); });
    return () => { live = false; };
  }, [auth]);
  const way = auth === undefined ? asked : auth;

  const [view, setView] = useState<View>({ at: "idle" });
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const noun = what === "phone" ? "phone" : "device";
  const theNew = what === "phone" ? "Your phone" : "A new device";

  const start = async () => {
    setErr("");
    setView({ at: "busy" });
    // This address works on this computer only (the SSH tunnel). A new device needs the private
    // address of the server. When the server has one, the code is for that address: the new
    // device pairs there, and so can this browser. When it has none, the part says what to do.
    const local = loopbackHost(window.location.hostname);
    let step: StepStatus | null = null;
    if (local) {
      step = await fetchSetup().then((r) => r.steps.find((x) => x.id === "access") ?? null, () => null);
      if (!(step?.state === "done" && step.text === ACCESS_READY)) { setView({ at: "local", step }); return; }
    }
    const before = await pairedDevices();
    const r = before ? await mintAddCode() : { ok: false as const, error: "The console did not give the device list" };
    if (!r.ok || !before) { setErr(r.ok ? "" : r.error); setView({ at: "idle" }); return; }
    if (local && !r.address) { void cancelAddCode(); setView({ at: "local", step }); return; }
    setNow(Date.now());
    setView({ at: "code", code: r.code, until: Date.now() + r.ttlMs, before, ...(local && r.address ? { origin: r.address } : {}) });
  };

  // While a code is open: the time left each second, and the device list each 2 seconds.
  useEffect(() => {
    if (view.at !== "code") return;
    let live = true;
    const clock = setInterval(() => {
      const t = Date.now();
      if (t >= view.until) setView({ at: "old" }); else setNow(t);
    }, 1_000);
    const poll = setInterval(() => {
      void pairedDevices().then((list) => {
        const fresh = live && list ? newDevices(view.before, list) : [];
        if (!fresh.length) return;
        setView({ at: "added", device: fresh[fresh.length - 1] });
        void onAdded?.();
      });
    }, POLL_MS);
    return () => { live = false; clearInterval(clock); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // The part goes away with a code open (the row closed, another section): the code ends.
  const open = useRef(false);
  open.current = view.at === "code";
  useEffect(() => () => { if (open.current) void cancelAddCode(); }, []);

  const close = () => { if (view.at === "code") void cancelAddCode(); setView({ at: "idle" }); };

  // `auto`: one start, when the part knows that this console pairs from the server.
  const started = useRef(false);
  useEffect(() => {
    if (!auto || started.current || way !== "log") return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, way]);

  if (way === "telegram") {
    return <p className={a.text}>This console pairs devices through Telegram. Send <code>/pair</code> and a name for the {noun} in the Master topic. Then open the link on the {noun}.</p>;
  }
  if (way !== "log") return null;

  const button = (label: string, primary = false) => (
    <button type="button" className={`${s.btn}${primary ? ` ${s.primary}` : ""}`} disabled={view.at === "busy"} onClick={() => void start()}>{label}</button>
  );

  if (view.at === "idle" || view.at === "busy") {
    return (
      <div className={a.wrap}>
        {button(view.at === "busy" ? "One moment…" : "Add a device")}
        <ErrorLine text={err} />
      </div>
    );
  }

  if (view.at === "local") {
    // The step is also done with the SSH tunnel only (a device is paired): then the server
    // has no private address yet, and a new device cannot come in.
    const ready = view.step?.state === "done" && view.step.text === ACCESS_READY;
    const tunnel = view.step?.state === "done" && !ready;
    return (
      <div className={a.panel} role="group" aria-label="Add a device" data-add="local">
        <h4 className={a.title}>{theNew} cannot open this address</h4>
        <p className={a.text}>
          This browser opens {DISPLAY_NAME} at <b>{window.location.host}</b>. That address works on this computer only.{" "}
          {theNew} needs the private address of your server first.{tunnel ? "" : ` That is the step “Open ${DISPLAY_NAME} from your devices”.`}
        </p>
        {view.step && (
          <div className={a.step}>
            <Dot tone={ready ? "ok" : "off"} />
            <span>
              <span className={a.stepName}>{view.step.title}</span>
              <span className={a.stepText}>{tunnel ? "This computer uses the SSH tunnel. Your server has no private address yet." : `${ready ? "Done" : "Not done"} · ${view.step.text}`}</span>
            </span>
          </div>
        )}
        <p className={a.text}>
          {ready
            ? "The console could not read its private address now. Press Check again."
            : words(ACCESS_TODAY)}
        </p>
        <div className={a.acts}>
          {button("Check again")}
          <button type="button" className={`${s.btn} ${s.quiet}`} onClick={close}>Close</button>
        </div>
      </div>
    );
  }

  if (view.at === "old") {
    return (
      <div className={a.panel} role="group" aria-label="Add a device" data-add="old">
        <p className={a.text}>This code is too old. A code works for 5 minutes.</p>
        <div className={a.acts}>
          {button("New code", true)}
          <button type="button" className={`${s.btn} ${s.quiet}`} onClick={close}>Close</button>
        </div>
      </div>
    );
  }

  if (view.at === "added") {
    return (
      <div className={a.panel} role="group" aria-label="Add a device" data-add="added">
        <p className={a.done} role="status"><Dot tone="ok" />{what === "phone" ? "Phone added" : addedWords(view.device.label)}</p>
        <p className={a.text}>It is paired as <b>{view.device.label}</b>. It can do what this device can do. To stop it, press Revoke on its row.</p>
        {row && (
          <div className={a.rows}>
            <DeviceRow d={view.device} now={now} onError={setErr} onChange={async () => { setView({ at: "idle" }); await onAdded?.(); }} />
          </div>
        )}
        <ErrorLine text={err} />
        <div className={a.acts}>
          <button type="button" className={s.btn} onClick={close}>Done</button>
        </div>
      </div>
    );
  }

  // The address that the new device opens: the private address of the server when this
  // browser is at the tunnel address, else the address of this page.
  const origin = view.origin ?? window.location.origin;
  const host = new URL(origin).host;
  return (
    <div className={a.panel} role="group" aria-label="Add a device" data-add="code" data-private={view.origin ? "" : undefined}>
      {view.origin && (
        <>
          <p className={a.text}>
            This browser opens {DISPLAY_NAME} at <b>{window.location.host}</b>. That address works on this computer only.
            The code below is for the private address of your server: <b>{host}</b>. A device opens that address when it has Tailscale with your account.
          </p>
          <p className={a.text}>
            To use this computer at the private address too, open it here. This browser then pairs there with one press. The code works one time: for one more device, press “Add a device” again.
          </p>
          <div className={a.acts}>
            <a className={s.btn} style={{ textDecoration: "none" }} href={pairLink(origin, view.code)} target="_blank" rel="noopener noreferrer" data-add-open>Open {host} on this computer</a>
          </div>
        </>
      )}
      <div className={a.cols}>
        <div className={a.qr}>
          <QRCodeSVG value={pairLink(origin, view.code)} size={168} level="M" marginSize={0} bgColor="#ffffff" fgColor="#000000" title="Code picture for the new device" />
        </div>
        <div className={a.side}>
          <h4 className={a.title}>Scan this code with {what === "phone" ? "your phone" : "the new device"}</h4>
          <p className={a.text}>Point the camera of the {noun} at the picture. The page that opens pairs the {noun} with one press.</p>
          <p className={a.text}>No camera? Open <b>{host}{PAIR_PAGE}</b> on the {noun} and type this code:</p>
          <span className={a.code} data-add-code>{view.code}</span>
        </div>
      </div>
      <div className={a.foot}>
        <span className={a.wait} role="status"><i className={a.pulse} aria-hidden />Waiting for the {noun}…</span>
        <span className={a.grow} />
        <span>One use · <time>{countdown(view.until - now)}</time> left</span>
        <button type="button" className={`${s.btn} ${s.quiet}`} onClick={close}>Cancel</button>
      </div>
    </div>
  );
}
