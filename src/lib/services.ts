import { chiefFetch } from "./chief";
// src/lib/services.ts
export type ServiceStatus = "stopped" | "running" | "crashed";

export type ServiceDef = {
  id: string; name: string; description: string; command: string; args: string[];
  cwd: string; env: Record<string, string>; requiresConfirm: boolean;
  confirmMessage: string; autoRestart: boolean; createdAt: number;
};
export type ServiceView = ServiceDef & {
  status: ServiceStatus; restartCount: number; lastExitCode: number | null; autoRestartDisabled: boolean;
};
export type ServiceInput = Omit<ServiceDef, "id" | "createdAt">;

export async function fetchServices(): Promise<{ services: ServiceView[] }> {
  const r = await chiefFetch("/api/services"); if (!r.ok) throw new Error("load services"); return r.json();
}
export async function createService(input: ServiceInput): Promise<{ ok: boolean; service?: ServiceDef; error?: string }> {
  const r = await chiefFetch("/api/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body.error ?? `failed (${r.status})` };
  return { ok: true, service: body.service };
}
export async function updateService(id: string, input: ServiceInput): Promise<{ ok: boolean; error?: string }> {
  const r = await chiefFetch(`/api/services/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body.error ?? `failed (${r.status})` };
  return { ok: true };
}
export async function deleteService(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await chiefFetch(`/api/services/${id}`, { method: "DELETE" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body.error ?? `failed (${r.status})` };
  return { ok: true };
}
export async function startService(id: string, confirm: boolean): Promise<{ ok: boolean; needsConfirm?: boolean; error?: string }> {
  const r = await chiefFetch(`/api/services/${id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, needsConfirm: body.needsConfirm, error: body.error ?? `failed (${r.status})` };
  return { ok: true };
}
export async function stopService(id: string): Promise<void> {
  await chiefFetch(`/api/services/${id}/stop`, { method: "POST" });
}
