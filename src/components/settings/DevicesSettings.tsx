// src/components/settings/DevicesSettings.tsx — the Settings section "Devices": the paired
// devices (each one can act as the user) with Revoke (a second press confirms), "Add a device"
// (a code picture for one more device; AddDevice.tsx), and the protection level in plain words.
// The server checks: the list, Revoke and the new code are USER routes (gateUser). Device labels
// are untrusted: plain text only.
"use client";
import { useCallback, useEffect, useState } from "react";
import { devicesStatus, fetchBrain, protectionWords, readDevices, type BrainView, type Device } from "../../lib/brain";
import type { Read } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { AddDevice, DeviceRow } from "./AddDevice";
import { Block, cx as s, Empty, ErrorLine, Note, Row, StatusLine, type SectionProps } from "./kit";
import b from "./Brain.module.css";
import { USER_CLI } from "../../../server/brand";

const seen = viewMemory<Read<Device>>(1);
const brainSeen = viewMemory<BrainView>(1);

export function DevicesSettings(_: SectionProps) {
  const [read, setRead] = useRemembered<Read<Device>>(seen, "devices", null);
  const [brain, setBrain] = useRemembered<BrainView>(brainSeen, "devices", { state: "error" });
  const load = useCallback(async () => {
    const [next, v] = await Promise.all([readDevices(), fetchBrain()]);
    setRead((p) => (next && "error" in next && p && "rows" in p ? p : next));
    if (v.state !== "error") setBrain(v);
  }, [setRead, setBrain]);
  useEffect(() => { void load(); }, [load]);

  const rows = read && "rows" in read ? read.rows : [];
  const off = read !== null && "off" in read;
  const [err, setErr] = useState("");
  const now = Date.now();
  const words = brain.state === "on" ? protectionWords(brain.brain) : null;
  // Only a paired device gets the list, so only then is there a button to press.
  const paired = read !== null && "rows" in read;
  // How this console pairs one more device.
  const way = brain.state === "on" ? brain.brain.userAuth : null;

  return (
    <>
      <StatusLine status={devicesStatus(read)} />
      {!off && (
        <Block title="Paired devices">
          {rows.length === 0 && <Empty>{read === null ? "Reading the devices…" : "No paired devices."}</Empty>}
          {rows.map((d) => <DeviceRow key={d.label} d={d} now={now} onChange={load} onError={setErr} />)}
        </Block>
      )}
      <ErrorLine text={err} />
      {!off && way === "telegram" && <div className={s.block}><AddDevice auth="telegram" /></div>}
      {!off && way === "log" && paired && <div className={s.block}><AddDevice auth="log" onAdded={load} /></div>}
      {words && (
        <Block title="Protection">
          <Row><span className={b.text}>{words.level}</span></Row>
          <Row><span className={b.text}>{words.telegram}</span></Row>
        </Block>
      )}
      {!off && (
        <Note>
          A paired device acts as you.
          {way === "log" && !paired && <> To pair this device, press “Add a device” on a paired device. With no paired device at hand, run <code>{USER_CLI} brain pair &lt;name&gt;</code> on your server: it prints a link for this device.</>}
        </Note>
      )}
    </>
  );
}
