// src/lib/share.ts — the client of "Share outside" (server/chief/queue/share.ts): the confirm step's
// read, the publish, Stop sharing, the download, and whether a share tool is set (Settings). The
// browser sends a ticket id and the hits the user ticked, never HTML. The one-tap link and the
// password come once, in the publish's answer: this tab keeps the link in memory only.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only: types.ts has a node:crypto import
import type { ShareView } from "../../server/chief/queue/share"; // type-only
import type { Hit } from "../../server/chief/queue/shareTool"; // type-only
import { chiefFetch, refusalSentence } from "./chief";

export type { Hit, ShareView };
type Deps = { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null };
type Body = Record<string, unknown> | null;

const url = (id: string, rest = ""): string => `/api/queue/${encodeURIComponent(id)}/share${rest}`;
const errorOf = (status: number, b: Body): string =>
  refusalSentence(status, b as { error?: string } | null, "Share outside") ?? (typeof b?.error === "string" ? b.error : `The console answered HTTP ${status}.`);
async function call(path: string, init: RequestInit | undefined, deps: Deps): Promise<{ status: number; ok: boolean; b: Body }> {
  const res = await chiefFetch(path, init, deps);
  return { status: res.status, ok: res.ok, b: (await res.json().catch(() => null)) as Body };
}
const failed = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : "network error" });
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export type ShareRead = { ok: true; view: ShareView } | { ok: false; error: string };
export async function readShare(id: string, deps: Deps = {}): Promise<ShareRead> {
  try {
    const { status, ok, b } = await call(url(id), undefined, deps);
    return ok && b && typeof b.tool === "boolean" ? { ok: true, view: b as unknown as ShareView } : { ok: false, error: errorOf(status, b) };
  } catch (e) { return failed(e); }
}

export type Shared = { item: QueueItem; link: string; oneTap: string | null; password: string | null };
export type ShareCall = ({ ok: true } & Shared) | { ok: false; error: string; reason?: string; hits?: Hit[] };
export async function publishShare(id: string, accept: string[], deps: Deps = {}): Promise<ShareCall> {
  try {
    const { status, ok, b } = await call(url(id), post({ accept }), deps);
    if (ok && b?.item && typeof b.link === "string") {
      const oneTap = typeof b.oneTap === "string" ? b.oneTap : null;
      if (oneTap) oneTaps.set(id, oneTap);
      return { ok: true, item: b.item as QueueItem, link: b.link, oneTap, password: typeof b.password === "string" ? b.password : null };
    }
    return {
      ok: false, error: errorOf(status, b),
      ...(typeof b?.reason === "string" ? { reason: b.reason } : {}),
      ...(Array.isArray(b?.hits) ? { hits: b.hits as Hit[] } : {}),
    };
  } catch (e) { return failed(e); }
}

export async function stopShare(id: string, deps: Deps = {}): Promise<{ ok: true; item: QueueItem | null } | { ok: false; error: string }> {
  try {
    const { status, ok, b } = await call(url(id, "/stop"), post({}), deps);
    if (ok) { oneTaps.delete(id); return { ok: true, item: (b?.item as QueueItem | null) ?? null }; }
    return { ok: false, error: errorOf(status, b) };
  } catch (e) { return failed(e); }
}

// The download: the same file, saved by the browser (the user token goes in a header, so the
// file comes through fetch, then a link to a blob).
export async function downloadShare(id: string, deps: Deps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch(url(id, "/file"), undefined, deps);
    if (!res.ok) return { ok: false, error: errorOf(res.status, (await res.json().catch(() => null)) as Body) };
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "ticket.html";
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href; a.download = name; a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return { ok: true };
  } catch (e) { return failed(e); }
}

// The one-tap links this tab got (ticket id → link). Never stored: after a reload, Copy link
// gives the plain link, which asks for the password.
export const oneTaps = new Map<string, string>();

// --- Settings ------------------------------------------------------------------------------

export type ShareSetting = { tool: string | null; problem: string | null; canSave: boolean; why: string | null };
export async function fetchShareSetting(deps: Deps = {}): Promise<ShareSetting> {
  const res = await chiefFetch("/api/settings/share", undefined, deps);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = (await res.json()) as ShareSetting;
  toolKnown(b.tool !== null && b.problem === null);
  return b;
}
export async function saveShareTool(tool: string | null, deps: Deps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { status, ok, b } = await call("/api/settings/share", post({ tool }), deps);
    if (!ok) return { ok: false, error: errorOf(status, b) };
    toolKnown(tool !== null);
    return { ok: true };
  } catch (e) { return failed(e); }
}

// Is a share tool set (and can it run)? null until the first read. The Queue reads it once per
// page load; a save in Settings tells it at once.
let toolSet: boolean | null = null;
let reading: Promise<unknown> | null = null;
const subs = new Set<() => void>();
function toolKnown(v: boolean): void {
  if (toolSet === v) return;
  toolSet = v;
  for (const f of subs) f();
}
export const shareToolSub = (f: () => void): (() => void) => {
  subs.add(f);
  reading ??= fetchShareSetting().catch(() => { reading = null; });
  return () => { subs.delete(f); };
};
export const shareToolSet = (): boolean | null => toolSet;

// "email: ...someone@example.invalid..." → { what: "An e-mail address", text: "...someone@example.invalid..." }: the kind of a hit in
// plain words, and the text the tool found. An unknown kind keeps its own word.
const KIND_WORDS: [RegExp, string][] = [
  [/^e-?mail$/i, "An e-mail address"], [/^blocked word/i, "A word on your blocked list"], [/^handle$/i, "A handle (@name)"],
  [/^private link$/i, "A private link"], [/^ip address$/i, "An IP address"], [/^placeholder$/i, "An unfinished part"],
];
export function hitWords(hit: Hit): { what: string; text: string } {
  const at = hit.text.indexOf(": ");
  const kind = at > 0 && at < 60 ? hit.text.slice(0, at) : "";
  const text = kind ? hit.text.slice(at + 2) : hit.text;
  const named = KIND_WORDS.find(([re]) => re.test(kind))?.[1];
  const word = /^blocked word\s+(.+)$/i.exec(kind)?.[1];
  return { what: named ? `${named}${word ? ` ${word}` : ""}` : kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Something", text };
}
