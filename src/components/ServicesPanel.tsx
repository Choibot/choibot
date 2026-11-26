// src/components/ServicesPanel.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import {
  fetchServices, createService, updateService, deleteService,
  startService, stopService,
  type ServiceView, type ServiceInput,
} from "../lib/services";
import { useEvents } from "../lib/useEvents";
import { ServiceTerminal } from "./ServiceTerminal";
import s from "./ServicesPanel.module.css";

const EMPTY: ServiceInput = {
  name: "", description: "", command: "", args: [], cwd: "", env: {},
  requiresConfirm: false, confirmMessage: "", autoRestart: false,
};

function badgeClass(status: string): string {
  return `${s.badge} ${status === "running" ? s.running : status === "crashed" ? s.crashed : s.stopped}`;
}

/** @deprecated Removed from the console nav (2026-07); kept for now. */
export function ServicesPanel() {
  const [services, setServices] = useState<ServiceView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServiceView | "new" | null>(null);
  const [confirmFor, setConfirmFor] = useState<ServiceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { setServices((await fetchServices()).services); } catch { /* transient */ }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  // Live status: refetch on any service-status event (cheap; list is small).
  useEvents((e) => { if (e.type === "service-status") void reload(); });

  const sel = services.find((x) => x.id === selected) ?? null;

  async function doStart(svc: ServiceView) {
    if (svc.requiresConfirm) { setConfirmFor(svc); return; }
    const r = await startService(svc.id, false);
    if (!r.ok) setError(r.error ?? "start failed");
    await reload();
  }
  async function confirmStart() {
    if (!confirmFor) return;
    const r = await startService(confirmFor.id, true);
    setConfirmFor(null);
    if (!r.ok) setError(r.error ?? "start failed");
    await reload();
  }
  async function doStop(svc: ServiceView) { await stopService(svc.id); await reload(); }
  async function doDelete(svc: ServiceView) {
    const r = await deleteService(svc.id);
    if (!r.ok) { setError(r.error ?? "delete failed"); return; }
    if (selected === svc.id) setSelected(null);
    await reload();
  }

  return (
    <div className={s.panel}>
      <div className={s.list}>
        <div className={s.actions}>
          <button className={s.btn} onClick={() => setEditing("new")}>+ New service</button>
        </div>
        {error && <div className={s.error}>{error}</div>}
        {services.map((svc) => (
          <div key={svc.id} className={`${s.row} ${selected === svc.id ? s.rowActive : ""}`} onClick={() => setSelected(svc.id)}>
            <span className={s.name}>{svc.name}</span>
            <span className={badgeClass(svc.status)}>{svc.status}</span>
          </div>
        ))}
      </div>

      <div className={s.detail}>
        {editing ? (
          <ServiceForm
            initial={editing === "new" ? EMPTY : toInput(editing)}
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              const r = editing === "new" ? await createService(input) : await updateService(editing.id, input);
              if (!r.ok) { setError(r.error ?? "save failed"); return; }
              setEditing(null); setError(null); await reload();
            }}
          />
        ) : sel ? (
          <>
            <div className={s.actions}>
              <strong>{sel.name}</strong>
              <span className={badgeClass(sel.status)}>{sel.status}</span>
              {sel.status === "running"
                ? <button className={s.btn} onClick={() => void doStop(sel)}>Stop</button>
                : <button className={s.btn} onClick={() => void doStart(sel)}>Start</button>}
              <button className={s.btn} onClick={() => setEditing(sel)} disabled={sel.status === "running"}>Edit</button>
              <button className={`${s.btn} ${s.danger}`} onClick={() => void doDelete(sel)} disabled={sel.status === "running"}>Delete</button>
              {sel.autoRestartDisabled && <span className={s.danger}>auto-restart disabled (crash loop)</span>}
            </div>
            <div className={s.term}>
              {sel.status === "running" || sel.status === "crashed"
                ? <ServiceTerminal key={`${sel.id}:${sel.status}`} serviceId={sel.id} />
                : <div>Service is {sel.status}. Start it to view logs.</div>}
            </div>
          </>
        ) : (
          <div>Select a service, or create one.</div>
        )}
      </div>

      {confirmFor && (
        <div className={s.dialog} onClick={() => setConfirmFor(null)}>
          <div className={s.dialogBox} onClick={(e) => e.stopPropagation()}>
            <strong>Start “{confirmFor.name}”?</strong>
            <p className={s.danger}>{confirmFor.confirmMessage || "This service is flagged as requiring confirmation."}</p>
            <div className={s.actions}>
              <button className={s.btn} onClick={() => setConfirmFor(null)}>Cancel</button>
              <button className={`${s.btn} ${s.danger}`} onClick={() => void confirmStart()}>Start anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function toInput(v: ServiceView): ServiceInput {
  const { name, description, command, args, cwd, env, requiresConfirm, confirmMessage, autoRestart } = v;
  return { name, description, command, args, cwd, env, requiresConfirm, confirmMessage, autoRestart };
}

function ServiceForm({ initial, onSave, onCancel }: { initial: ServiceInput; onSave: (i: ServiceInput) => void; onCancel: () => void }) {
  const [f, setF] = useState<ServiceInput>(initial);
  const [argsText, setArgsText] = useState(initial.args.join(" "));
  const [envText, setEnvText] = useState(Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join("\n"));

  function save() {
    const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const t = line.trim(); if (!t) continue;
      const i = t.indexOf("="); if (i < 0) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    onSave({ ...f, args, env });
  }

  return (
    <div className={s.form}>
      <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label>Command<input value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="/abs/path/to/run.sh" /></label>
      <label>Args (space-separated)<input value={argsText} onChange={(e) => setArgsText(e.target.value)} /></label>
      <label>Working dir<input value={f.cwd} onChange={(e) => setF({ ...f, cwd: e.target.value })} /></label>
      <label>Env (KEY=VALUE per line)<textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} /></label>
      <label><input type="checkbox" checked={f.requiresConfirm} onChange={(e) => setF({ ...f, requiresConfirm: e.target.checked })} /> Require confirmation to start</label>
      <label>Confirm message<input value={f.confirmMessage} onChange={(e) => setF({ ...f, confirmMessage: e.target.value })} /></label>
      <label><input type="checkbox" checked={f.autoRestart} onChange={(e) => setF({ ...f, autoRestart: e.target.checked })} /> Auto-restart on crash (with backoff + circuit breaker)</label>
      <div className={s.actions}>
        <button className={s.btn} onClick={onCancel}>Cancel</button>
        <button className={s.btn} onClick={save}>Save</button>
      </div>
    </div>
  );
}
