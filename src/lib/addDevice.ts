// src/lib/addDevice.ts — the browser's side of "Add a device" (server/chief/adddevice.ts): a
// paired device asks for a code, shows it as a picture and as text, and sees the new device
// come into the list. The new device opens the address of the picture and claims the code.
//
// The code is in the fragment of the address (after #). A browser never sends the fragment to
// a server, so the code is in no request line and in no log; the claim sends it in a POST body.
import { readDevices, type Device } from "./brain";
import { chiefFetch, claimCode, type CodeClaimError } from "./chief";
import { actionError } from "./settings";

export const ADD_DEVICE_ROUTE = "/api/chief/devices/add";
export const ADD_CLAIM_ROUTE = "/api/chief/devices/claim";
// The page of the new device (src/app/pair/page.tsx).
export const PAIR_PAGE = "/pair";

// An address that only this computer can open: the browser reached the console through a
// tunnel (localhost). A phone that opens it gets its own localhost, not the server.
export function loopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h) || h === "::1" || h === "0.0.0.0";
}

// What the code picture holds: the address of this console as this browser sees it, the page
// of the new device, and the code in the fragment.
export const pairLink = (origin: string, code: string): string => `${origin}${PAIR_PAGE}#code=${code}`;

// The code of a link's fragment, or "".
export function codeFromHash(hash: string): string {
  const m = /^#?code=([0-9A-Za-z-]{1,24})$/.exec(hash);
  return m ? m[1].toUpperCase() : "";
}

// A name for a device from what its browser says it is.
export function deviceKind(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): "phone" | "tablet" | "computer" {
  if (/iPhone|Android.+Mobile/.test(ua)) return "phone";
  if (/iPad|Android/.test(ua)) return "tablet";
  return "computer";
}

// What a person types as the name, as the server keeps it (auth.ts DEVICE_LABEL_RE): lower
// case, letters, digits, - and _, 32 at most. "" when nothing of the text can stay.
export function deviceName(typed: string): string {
  return typed.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 32).replace(/-+$/, "");
}

// The line the first device reads when the new one is in.
export function addedWords(label: string): string {
  const kind = /^(phone|tablet|computer)(-\d+)?$/.exec(label)?.[1];
  return kind ? `${kind[0].toUpperCase()}${kind.slice(1)} added` : "Device added";
}

// The devices of `now` that were not paired at `before`.
export function newDevices(before: Device[], now: Device[]): Device[] {
  return now.filter((d) => !before.some((b) => b.label === d.label && b.createdAt === d.createdAt));
}

// Time left as "4:07".
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Deps = { fetch?: typeof fetch };

// Ask for a code (USER only on the server). `ttlMs`: how long it works from now. `address`:
// the private address of the console (https://<name>) when the server has one, else null.
export async function mintAddCode(deps: Deps = {}): Promise<{ ok: true; code: string; ttlMs: number; address: string | null } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch(ADD_DEVICE_ROUTE, { method: "POST" }, deps);
    if (!res.ok) return { ok: false, error: await actionError(res, "Adding a device") };
    const b = (await res.json()) as { code?: unknown; ttlMs?: unknown; address?: unknown };
    if (typeof b.code !== "string" || !b.code || typeof b.ttlMs !== "number" || !(b.ttlMs > 0)) return { ok: false, error: "The console gave no code" };
    return { ok: true, code: b.code, ttlMs: b.ttlMs, address: typeof b.address === "string" && /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*$/.test(b.address) ? b.address : null };
  } catch {
    return { ok: false, error: "The console did not answer" };
  }
}

// The code panel closed: the server forgets the code. No answer is needed.
export async function cancelAddCode(deps: Deps = {}): Promise<void> {
  try { await chiefFetch(ADD_DEVICE_ROUTE, { method: "DELETE" }, deps); } catch { /* the code ends by its age */ }
}

// The paired devices, or null when the list cannot be read.
export async function pairedDevices(deps: Deps = {}): Promise<Device[] | null> {
  const r = await readDevices(deps);
  return r && "rows" in r ? r.rows : null;
}

export type AddClaimError = CodeClaimError;

// The new device claims the code (only from the [Pair this device] tap). Stores the token.
export const claimAddDevice = (code: string, label: string, deps?: { fetch?: typeof fetch; storage?: Pick<Storage, "setItem"> | null }) =>
  claimCode(ADD_CLAIM_ROUTE, code, label, deps);
