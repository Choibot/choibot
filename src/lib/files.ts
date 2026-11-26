import { chiefFetch } from "./chief";
// src/lib/files.ts — thin client for the view-only files API.
export type FileEntry = { name: string; path: string; type: "dir" | "file" };

export async function listDir(path?: string): Promise<{ path: string; items: FileEntry[] }> {
  const r = await chiefFetch(`/api/files/list?path=${encodeURIComponent(path ?? "")}`);
  if (!r.ok) throw new Error("list failed");
  return r.json();
}

export async function readFileContent(
  path: string,
): Promise<{ path: string; content?: string; tooLarge?: boolean; binary?: boolean; size: number }> {
  const r = await chiefFetch(`/api/files/content?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error("read failed");
  return r.json();
}

// ---- navigation helpers (Changes / Quick Open / Search / go-to-definition) ----
export type Change = { path: string; rel: string; status: string };
export type SearchHit = { path: string; rel: string; line: number; text: string };

export async function fileChanges(root: string): Promise<{ git: boolean; changes: Change[] }> {
  const r = await chiefFetch(`/api/files/changes?root=${encodeURIComponent(root)}`);
  if (!r.ok) throw new Error("changes failed");
  return r.json();
}

export async function allFiles(root: string): Promise<{ files: string[] }> {
  const r = await chiefFetch(`/api/files/all?root=${encodeURIComponent(root)}`);
  if (!r.ok) throw new Error("all failed");
  return r.json();
}

export async function searchFiles(root: string, q: string): Promise<{ results: SearchHit[] }> {
  const r = await chiefFetch(
    `/api/files/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`,
  );
  if (!r.ok) throw new Error("search failed");
  return r.json();
}

// ---- shared docs (agent-published via .choibot/docs.json) ----
export type SharedDoc = { path: string; title: string; kind: "md" | "html"; mtime: number; size: number };

export async function sharedDocs(root: string): Promise<{ docs: SharedDoc[] }> {
  const r = await chiefFetch(`/api/files/docs?root=${encodeURIComponent(root)}`);
  if (!r.ok) throw new Error("docs failed");
  return r.json();
}

export async function findDefinition(
  root: string,
  symbol: string,
): Promise<{ candidates: SearchHit[] }> {
  const r = await chiefFetch(
    `/api/files/definition?root=${encodeURIComponent(root)}&symbol=${encodeURIComponent(symbol)}`,
  );
  if (!r.ok) throw new Error("definition failed");
  return r.json();
}

// ---- plan pointer (newest superpowers plan doc, for the rail's Plan view) ----
export type PlanPointer = { path?: string; mtime?: number };

export async function planPointer(root: string): Promise<PlanPointer> {
  const r = await chiefFetch(`/api/files/plan?root=${encodeURIComponent(root)}`);
  if (!r.ok) throw new Error("plan failed");
  return r.json();
}
