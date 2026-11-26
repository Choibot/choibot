// src/lib/serverFiles.ts — the Files tab of the Server page: the reads (server/files/browse.ts)
// and the pure parts of the list (the path bar, the sort, the filter).
import type { ContentAnswer, Entry, ListAnswer } from "../../server/files/browse";
import { chiefFetch } from "./chief";

export type { ContentAnswer, Entry, ListAnswer };

// Why a read gave no answer: the server's own plain line, and whether pairing is what is missing.
export type Refused = { text: string; pairing: boolean };
export type Got<T> = { ok: true; value: T } | { ok: false; refused: Refused };

async function read<T>(url: string, init: RequestInit | undefined, deps: { fetch?: typeof chiefFetch }): Promise<Got<T>> {
  try {
    const res = await (deps.fetch ?? chiefFetch)(url, init);
    if (res.ok) return { ok: true, value: (await res.json()) as T };
    const body = (await res.json().catch(() => ({}))) as { error?: string; text?: string };
    const pairing = body.error === "needs-pairing" || body.error === "pair-required";
    return { ok: false, refused: { pairing, text: body.error === "pair-required" ? "The files of your server are shown to a paired device only. Add this device in Settings, under Devices." : body.text ?? "Your server did not answer." } };
  } catch {
    return { ok: false, refused: { pairing: false, text: "Your server did not answer." } };
  }
}

// path null: the home folder of the server's user.
export const fetchList = (path: string | null, deps: { fetch?: typeof chiefFetch } = {}): Promise<Got<ListAnswer>> =>
  read<ListAnswer>(`/api/server/files/list${path === null ? "" : `?path=${encodeURIComponent(path)}`}`, undefined, deps);

export const fetchContent = (path: string, deps: { fetch?: typeof chiefFetch } = {}): Promise<Got<ContentAnswer>> =>
  read<ContentAnswer>(`/api/server/files/content?path=${encodeURIComponent(path)}`, undefined, deps);

export const measureFolders = (path: string, deps: { fetch?: typeof chiefFetch } = {}): Promise<Got<{ measuring: boolean }>> =>
  read(`/api/server/files/sizes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }, deps);

// The private places that the user added: a place in the list is a locked row in the tab.
export type PrivateAnswer = { places: string[]; canChange: boolean };
export const fetchPrivate = (deps: { fetch?: typeof chiefFetch } = {}): Promise<Got<PrivateAnswer>> =>
  read<PrivateAnswer>("/api/server/files/private", undefined, deps);
export const savePrivate = (places: string[], deps: { fetch?: typeof chiefFetch } = {}): Promise<Got<PrivateAnswer>> =>
  read<PrivateAnswer>("/api/server/files/private", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ places }) }, deps);

export const childPath = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

// The path bar: one step per folder, from "/" down. The home folder is one step ("Home").
export type Crumb = { label: string; path: string };
export function crumbs(path: string, home: string): Crumb[] {
  const inHome = home !== "/" && (path === home || path.startsWith(`${home}/`));
  const out: Crumb[] = inHome ? [{ label: "Home", path: home }] : [{ label: "/", path: "/" }];
  const rest = (inHome ? path.slice(home.length) : path).split("/").filter(Boolean);
  let at = inHome ? home : "";
  for (const part of rest) {
    at = `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

export type SortKey = "name" | "size" | "changed";
export type Sort = { key: SortKey; down: boolean };

// A press on a column: that column, in its usual direction first (names up, the biggest and the
// newest first); a second press turns it.
export function nextSort(now: Sort, key: SortKey): Sort {
  return now.key === key ? { key, down: !now.down } : { key, down: key !== "name" };
}

const sizeOf = (e: Entry): number => (e.kind === "dir" ? e.bytes ?? -1 : e.size ?? -1);

// The rows to show: the filter on the name (any case), folders before files (by name), then the
// sort. A locked row has no size and no date: it keeps its place by its name, at the end otherwise.
export function shownRows(items: Entry[], filter: string, sort: Sort): Entry[] {
  const f = filter.trim().toLowerCase();
  const rows = f ? items.filter((e) => e.name.toLowerCase().includes(f)) : [...items];
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const dirFirst = (a: Entry, b: Entry) => Number(b.kind === "dir") - Number(a.kind === "dir");
  const dir = sort.down ? -1 : 1;
  return rows.sort((a, b) => {
    if (sort.key === "name") return dirFirst(a, b) || dir * byName(a, b);
    const va = sort.key === "size" ? sizeOf(a) : a.mtime ?? -1;
    const vb = sort.key === "size" ? sizeOf(b) : b.mtime ?? -1;
    // An entry with no value is at the end in both directions.
    if ((va < 0) !== (vb < 0)) return va < 0 ? 1 : -1;
    return dir * (va - vb) || byName(a, b);
  });
}

// "Today 14:05", "3 Nov", "3 Nov 2024".
export function changedWord(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const two = (v: number) => String(v).padStart(2, "0");
  if (d.toDateString() === n.toDateString()) return `Today ${two(d.getHours())}:${two(d.getMinutes())}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return d.getFullYear() === n.getFullYear() ? `${d.getDate()} ${month}` : `${d.getDate()} ${month} ${d.getFullYear()}`;
}
