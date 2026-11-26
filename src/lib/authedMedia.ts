// src/lib/authedMedia.ts — a picture of the console's API (a queue ticket's preview, GET
// /api/queue/:id/media/:name) read with chiefFetch and shown from an object URL. A plain <img src>
// sends no header, and a console behind a front proxy needs the paired device's token on every
// /api request (server/frontproxy.ts). A preview is at most 5 MB (server/chief/queue/media.ts),
// so it fits in memory.
import { chiefFetch } from "./chief";

export type MediaDeps = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
};

// The object URL of the picture, or null when it cannot be read (not 2xx, not an image, a
// network error or an abort). The caller revokes the URL with `revoke` when it is done.
export async function loadMedia(src: string, signal: AbortSignal, deps: MediaDeps = {}): Promise<{ url: string; revoke: () => void } | null> {
  const doFetch = deps.fetch ?? ((u: string, i?: RequestInit) => chiefFetch(u, i));
  const make = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const drop = deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  try {
    const res = await doFetch(src, { signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (signal.aborted || !blob.type.startsWith("image/")) return null;
    const url = make(blob);
    return { url, revoke: () => drop(url) };
  } catch {
    return null;
  }
}

// A picture that failed shows what a failed <img src> shows (the browser's broken picture and
// its alt text): an address that is never a picture.
export const BROKEN_SRC = "data:,";
