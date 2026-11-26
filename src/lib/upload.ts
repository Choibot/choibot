// src/lib/upload.ts — one upload helper for the terminal view and the thread
// view. A file goes to POST /api/agents/:id/upload, which writes it into the
// agent's worktree and returns the worktree-relative path. The terminal types
// that path at its cursor; the composer puts it in its text.
import { chiefFetch } from "./chief";

// Mirror server/agents/upload.ts (upload.test.ts compares them).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const FILE_EXTS = ["pdf", "txt", "md", "csv", "tsv", "json", "log", "yaml", "yml"];
// For the file picker (the attach button).
export const UPLOAD_ACCEPT = ["image/*", ...FILE_EXTS.map((e) => `.${e}`)].join(",");

export type UploadResult = { path: string } | { error: string };

export function uploadPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/upload`;
}

// Upload one file. Never throws: the server's reason comes back as `error`.
export async function uploadFile(path: string, file: File): Promise<UploadResult> {
  // The server cuts a larger body off: the browser then sees a dropped
  // connection, not the reason. So say it here.
  if (file.size > MAX_UPLOAD_BYTES) return { error: `too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` };
  // An image the server knows goes as its own type. Any other file goes as
  // bytes with the extension of its name: the server holds the allow-list.
  const image = IMAGE_TYPES.includes(file.type);
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1] ?? "";
  try {
    const res = await chiefFetch(image ? path : `${path}?ext=${encodeURIComponent(ext)}`, {
      method: "POST",
      headers: { "Content-Type": image ? file.type : "application/octet-stream" },
      body: file,
    });
    const body = (await res.json().catch(() => null)) as { path?: unknown; error?: unknown; message?: unknown } | null;
    if (res.ok && typeof body?.path === "string") return { path: body.path };
    // A route answer has `error`; an answer of the server itself (413) has `message` too.
    const reason = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    return { error: reason };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "network error" };
  }
}

// True when the drag or the paste carries files (not text, not a link).
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

// Put paths into `text` in place of the selection [start, end): a space
// between paths, and a space on each side where the paths would touch the text.
export function insertPaths(text: string, start: number, end: number, paths: string[]): { text: string; cursor: number } {
  if (paths.length === 0) return { text, cursor: end };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const piece = (before && !/\s$/.test(before) ? " " : "") + paths.join(" ") + (/^\s/.test(after) ? "" : " ");
  return { text: before + piece + after, cursor: before.length + piece.length };
}

// A file dropped where nothing takes it must not make the browser open the
// file in place of the console. A handler that takes the drop calls
// preventDefault first: those drops are left alone.
export function guardFileDrops(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  const stop = (e: DragEvent) => {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  target.addEventListener("dragover", stop);
  target.addEventListener("drop", stop);
  return () => {
    target.removeEventListener("dragover", stop);
    target.removeEventListener("drop", stop);
  };
}
