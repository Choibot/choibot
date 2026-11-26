// src/lib/answerImages.ts — the images that the user adds to the answer of a ticket
// (server/chief/queue/answerImages.ts). Each one goes up at once, alone, to
// POST /api/queue/:id/answer-image as bytes: the server reads the type from them and gives the
// draft's name. The answer then names the drafts. The list of one ticket lives in this page only
// (as the reply's text does): a send that the server took, or Esc, clears it.
"use client";
import { useSyncExternalStore } from "react";
import { chiefFetch } from "./chief";
import { IMAGE_TYPES, MAX_UPLOAD_BYTES } from "./upload";

// Mirror server/chief/queue/answerImages.ts (answerImages.test.ts compares them).
export const ANSWER_IMAGES_MAX = 4;
// The file picker: on an iPhone it offers the photo library and the camera, and Safari gives a
// JPEG for a HEIC photo because HEIC is not in the list.
export const ANSWER_IMAGE_ACCEPT = IMAGE_TYPES.join(",");

export type Attached = { key: string; url: string; label: string; state: "up" | "ok" | "err"; name?: string; error?: string };
type Upload = (itemId: string, file: File) => Promise<{ name: string } | { error: string }>;
type Deps = { upload?: Upload; createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };

// One image. Never throws: the server's reason comes back as `error`.
export async function uploadAnswerImage(itemId: string, file: File, deps: { fetch?: typeof chiefFetch } = {}): Promise<{ name: string } | { error: string }> {
  if (file.size > MAX_UPLOAD_BYTES) return { error: `too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` };
  try {
    const res = await (deps.fetch ?? chiefFetch)(`/api/queue/${encodeURIComponent(itemId)}/answer-image`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
    });
    const b = (await res.json().catch(() => null)) as { name?: unknown; error?: unknown; message?: unknown } | null;
    if (res.ok && typeof b?.name === "string") return { name: b.name };
    return { error: typeof b?.error === "string" ? b.error : typeof b?.message === "string" ? b.message : `HTTP ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "network error" };
  }
}

const EMPTY: Attached[] = [];

export function makeAnswerImages(d: Deps = {}) {
  const upload = d.upload ?? uploadAnswerImage;
  const make = d.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const drop = d.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  const lists = new Map<string, Attached[]>();
  // Why the last add left a file out (shown under the previews), per ticket.
  const notes = new Map<string, string>();
  const subs = new Set<() => void>();
  let n = 0;
  const get = (id: string): Attached[] => lists.get(id) ?? EMPTY;
  const ping = () => { for (const f of subs) f(); };
  const set = (id: string, list: Attached[]) => {
    if (list.length > 0) lists.set(id, list); else lists.delete(id);
    ping();
  };
  const patch = (id: string, key: string, p: Partial<Attached>) => {
    const list = get(id);
    if (list.some((a) => a.key === key)) set(id, list.map((a) => (a.key === key ? { ...a, ...p } : a)));
  };
  return {
    get,
    note: (id: string): string | null => notes.get(id) ?? null,
    subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; },
    // Adds what fits (images only, at most four in all) and starts their uploads. Returns why a
    // file was left out, or null; the same text is the ticket's note until the next change.
    add(id: string, files: File[]): string | null {
      const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
      const room = ANSWER_IMAGES_MAX - get(id).length;
      const taken = images.slice(0, Math.max(0, room));
      const added = taken.map((file): Attached => ({ key: `i${n++}`, url: make(file), label: file.name || "image", state: "up" }));
      if (added.length > 0) lists.set(id, [...get(id), ...added]); // one ping below, for the list and the note
      added.forEach((a, i) => {
        void upload(id, taken[i]!).then((r) => patch(id, a.key, "name" in r ? { state: "ok", name: r.name } : { state: "err", error: r.error }));
      });
      const why = images.length < files.length ? "Only PNG, JPEG, GIF and WebP images go with an answer."
        : taken.length < images.length ? `At most ${ANSWER_IMAGES_MAX} images in one answer.` : null;
      if (why) notes.set(id, why); else notes.delete(id);
      ping();
      return why;
    },
    remove(id: string, key: string): void {
      const a = get(id).find((x) => x.key === key);
      if (!a) return;
      drop(a.url);
      notes.delete(id);
      set(id, get(id).filter((x) => x.key !== key));
    },
    clear(id: string): void {
      const list = get(id);
      if (list.length === 0 && !notes.has(id)) return;
      for (const a of list) drop(a.url);
      notes.delete(id);
      set(id, []);
    },
    // The draft names of the images that went up (the answer's `images`).
    names: (id: string): string[] => get(id).flatMap((a) => (a.state === "ok" && a.name ? [a.name] : [])),
    // An upload still runs, or one failed: the answer waits (the user removes the failed one).
    blocked: (id: string): boolean => get(id).some((a) => a.state !== "ok"),
  };
}
export type AnswerImages = ReturnType<typeof makeAnswerImages>;

// The page's one list.
export const answerImages = makeAnswerImages();

export function useAnswerImages(id: string, store: AnswerImages = answerImages): Attached[] {
  return useSyncExternalStore(store.subscribe, () => store.get(id), () => EMPTY);
}
export function useAnswerNote(id: string, store: AnswerImages = answerImages): string | null {
  return useSyncExternalStore(store.subscribe, () => store.note(id), () => null);
}

// The ticket card of an agent's thread under a point that takes images (ThreadTicket sets
// data-answer-images): a file dropped there goes with that ticket's reply (AgentPane's cover).
export function ticketAt(x: number, y: number, doc: Pick<Document, "elementsFromPoint"> = document): string | null {
  for (const el of doc.elementsFromPoint(x, y)) {
    const card = (el as HTMLElement).closest?.("[data-answer-images]") as HTMLElement | null;
    if (card?.dataset.ticketCard) return card.dataset.ticketCard;
  }
  return null;
}
export const hasImage = (files: File[]): boolean => files.some((f) => IMAGE_TYPES.includes(f.type));

// The image files of a paste or a drop (a copied screenshot, a photo, a dragged file).
export const filesOf = (dt: DataTransfer | null | undefined): File[] => Array.from(dt?.files ?? []);
