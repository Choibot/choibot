import { chiefFetch } from "./chief";
// src/lib/master.ts — Master tab API client.
export type MasterStatus = {
  queuedEvents: number; queuedMessages: number; telegram: boolean; surface: "tab" | "telegram";
  // True with the master's quiet policy on (chief on); absent otherwise.
  quiet?: boolean;
  // True when the Coordinator reads the events: the master has no event queue.
  coordinator?: boolean;
  // True while it waits for the second sign-in (server/chief/chiefwait.ts): no session yet.
  waits?: boolean;
  // That wait is for a Claude login that was signed out in Settings, not for the second sign-in.
  waitsLogin?: boolean;
};

// A message of the Master tab while the master waits for the second sign-in: kept for its
// start. The answer's one line ("Kept: …"), or the server's refusal as the error.
export async function keepForMaster(text: string): Promise<string> {
  const res = await chiefFetch("/api/master/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const json = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!res.ok) throw new Error(json?.error ?? `master message: ${res.status}`);
  return json?.text ?? "Kept.";
}

export async function ensureFleetMaster(): Promise<string> {
  const res = await chiefFetch("/api/master", { method: "POST" });
  if (!res.ok) throw new Error(`master: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

export async function fetchMasterStatus(): Promise<MasterStatus> {
  const res = await chiefFetch("/api/master/status");
  if (!res.ok) throw new Error(`master status: ${res.status}`);
  return (await res.json()) as MasterStatus;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function masterStatusLine(s: MasterStatus): string {
  const parts = s.coordinator ? [] : [plural(s.queuedEvents, "queued event")];
  if (s.queuedMessages) parts.push(plural(s.queuedMessages, "queued message"));
  parts.push(`Telegram ${s.telegram ? "on" : "off"}`);
  parts.push(`replies to ${s.surface === "telegram" ? "Telegram" : "tab"}`);
  return parts.join(" · ");
}
