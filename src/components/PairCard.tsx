"use client";
import { useState } from "react";
import { claimPairing } from "../lib/chief";
import s from "./PairCard.module.css";

// Shown for #pair=<code>. Loading the page never claims; only the [Pair] tap does.
export function PairCard({ code, onClose }: { code: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pair = async () => {
    setBusy(true);
    const r = await claimPairing(code);
    setBusy(false);
    if (r.ok) { setDone(true); setResult(r.label ? `Paired as ${r.label}` : "Paired"); }
    else setResult(r.error === "used" ? "This pairing code expired or was used" : "Pairing failed — try again");
  };
  return (
    <div className={s.overlay} role="dialog" aria-label="Pair this device">
      <div className={s.card}>
        <h2 className={s.title}>Pair this device</h2>
        {result && <p className={s.msg} role="status">{result}</p>}
        <div className={s.actions}>
          {!done && <button className={s.primary} onClick={() => void pair()} disabled={busy}>Pair</button>}
          <button className={s.secondary} onClick={onClose}>{done ? "Done" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
