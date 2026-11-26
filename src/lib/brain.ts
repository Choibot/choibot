// src/lib/brain.ts — the client of the brain routes for the Settings sections Rules and Devices
// (pick A "Quiet rules", 2026-11-19), and GET /api/brain for the protection level and editorOff.
// All rule text and device labels are untrusted: callers render them as plain text.
import { chiefFetch, MISCONFIGURED_TEXT, refusalSentence } from "./chief";
import { plural, type Read, type SectionStatus } from "./settings";

export type BrainData = {
  hardened: boolean; userAuth: "telegram" | "log";
  // True in a hardened deployment: no code-server (overview decision 45).
  editorOff?: boolean;
};
// "error" = any other failure (500, network): callers keep their previous view.
export type BrainView = { state: "off" } | { state: "error" } | { state: "misconfigured" } | { state: "on"; brain: BrainData };

export type RuleScope = { area: string; repo?: string; kind?: string; audience?: "all" | "workers" | "master" };
export type RuleRow = {
  id: string; text: string; state: "candidate" | "active" | "retired"; scope: RuleScope; createdAt: number;
};
export type Device = { label: string; createdAt: number; lastUsedAt?: number };

type Deps = { fetch?: typeof fetch };
export type ActionResult = { ok: true } | { ok: false; error: string };

// 404 = flag off, 503 = misconfigured, any other failure = error.
export async function fetchBrain(deps: Deps = {}): Promise<BrainView> {
  try {
    const res = await chiefFetch("/api/brain", undefined, deps);
    if (res.status === 503) return { state: "misconfigured" };
    if (res.status === 404) return { state: "off" };
    if (!res.ok) return { state: "error" };
    return { state: "on", brain: (await res.json()) as BrainData };
  } catch {
    return { state: "error" };
  }
}

// Overview decision 45: hides the FileExplorer's VS Code (/editor) button.
// Flag off, misconfigured or any failure: false, the button shows as today.
export async function fetchEditorOff(deps: Deps = {}): Promise<boolean> {
  const v = await fetchBrain(deps);
  return v.state === "on" && v.brain.editorOff === true;
}

// Strong only when hardened; log mode is weak mode plus a log (spec §3).
export function userAuthLabel(b: { hardened: boolean }): "strong" | "weak" {
  return b.hardened ? "strong" : "weak";
}

// The protection level in plain words, for the Devices section.
export function protectionWords(b: BrainData): { level: string; telegram: string } {
  return {
    level: b.hardened
      ? "Strong. Your agents run under their own account on your server, so they cannot read the key of a paired device."
      : "Basic. Your agents and the console run under the same account on your server. A paired device is the only proof that an action comes from you. But the console cannot keep an agent out of its own files: give your agents only repos and tasks that you trust.",
    telegram: b.userAuth === "telegram"
      ? "Your Telegram account also counts as you: a tap on a card answers as you."
      : "Devices pair from your server, not from Telegram. When Telegram is connected, a tap on a ticket card there answers as you. The console never answers a ticket by itself.",
  };
}

// Who a rule is for, when it is not every agent; null for every agent.
export function scopeLabel(s: RuleScope): string | null {
  if (s.audience === "master") return "Master and leads";
  if (s.audience === "workers") return "Workers only";
  return s.area === "*" ? null : `Area ${s.area}`;
}

// ---- reads for the Settings sections: rows, off (flag off), or what went wrong ----

async function read<T>(url: string, deps: Deps): Promise<Read<T>> {
  try {
    const res = await chiefFetch(url, undefined, deps);
    if (res.status === 404) return { off: true };
    if (res.status === 503) return { error: MISCONFIGURED_TEXT };
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      // "This list": the sentence of a refusal names what was refused (it is not a merge).
      return { error: refusalSentence(res.status, b, "This list") ?? `the console answered ${res.status}` };
    }
    return { rows: (await res.json()) as T[] };
  } catch {
    return { error: "the console did not answer" };
  }
}

export const readActiveRules = (deps: Deps = {}) => read<RuleRow>("/api/brain/rules?state=active", deps);
export const readDevices = (deps: Deps = {}) => read<Device>("/api/brain/devices", deps);

export function rulesStatus(r: Read<RuleRow>): SectionStatus {
  if (r === null) return { tone: "load", text: "Reading the rules…" };
  if ("off" in r) return { tone: "off", text: "The chief of staff is off: agents get no rules." };
  if ("error" in r) return { tone: "err", text: `Cannot read the rules: ${r.error}` };
  if (r.rows.length === 0) return { tone: "off", text: "No rules yet." };
  return { tone: "ok", text: `${plural(r.rows.length, "rule")}. Agents get them in their prompt when they start.` };
}

export function devicesStatus(r: Read<Device>): SectionStatus {
  if (r === null) return { tone: "load", text: "Reading the devices…" };
  if ("off" in r) return { tone: "off", text: "The chief of staff is off: no device pairing." };
  if ("error" in r) return { tone: "err", text: `Cannot read the devices: ${r.error}` };
  if (r.rows.length === 0) return { tone: "off", text: "No paired devices." };
  return { tone: "ok", text: `${plural(r.rows.length, "paired device")}.` };
}

// ---- actions (USER only on the server) ----

async function post(url: string, body: unknown, deps: Deps = {}): Promise<ActionResult> {
  try {
    const res = await chiefFetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    }, deps);
    if (res.ok) return { ok: true };
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 409 && b?.error === "duplicate") return { ok: false, error: "This rule is there already." };
    return { ok: false, error: refusalSentence(res.status, b) ?? (typeof b?.error === "string" ? b.error : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

const ruleUrl = (id: string) => `/api/brain/rules/${encodeURIComponent(id)}`;

// A new rule for every agent: active at once (a USER add writes its confirm).
export const addRule = (text: string, deps?: Deps) =>
  post("/api/brain/rules", { text, scope: { area: "*" }, kind: "preference", via: "tab" }, deps);
// The user's new text is confirmed in the same write, so the rule stays fit for auto answers.
export const editRule = (id: string, text: string, deps?: Deps) => post(ruleUrl(id), { text, confirm: true, via: "tab" }, deps);
export const removeRule = (id: string, deps?: Deps) => post(ruleUrl(id), { retire: { why: "removed in Settings" }, via: "tab" }, deps);
export const revokeDevice = (label: string, deps?: Deps) => post(`/api/brain/devices/${encodeURIComponent(label)}/revoke`, {}, deps);
