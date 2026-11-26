// src/components/AnswerImages.tsx — images in the answer of a ticket (lib/answerImages): the
// button that opens the file picker (on an iPhone: the photo library or the camera), the small
// previews before the send (each with a remove control), and the answer's images on a closed
// ticket (small; a press opens the zoom overlay). Paste and drop are the reply box's and the
// footer's own handlers (QueueView); they call `answerImages.add` too.
"use client";
import { useRef } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { ANSWER_IMAGE_ACCEPT, answerImages, useAnswerImages, useAnswerNote, type AnswerImages } from "../lib/answerImages";
import { previewSrc } from "../lib/queue";
import { AuthedImg } from "./AuthedImg";
import { CloseIcon } from "./SideIcons";
import s from "./AnswerImages.module.css";

// `onAdd`: after the picker gave files (the thread keeps its place).
export function AttachImages({ itemId, onAdd, store = answerImages }: { itemId: string; onAdd?: () => void; store?: AnswerImages }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={picker} type="file" multiple accept={ANSWER_IMAGE_ACCEPT} hidden
        onChange={(e) => { onAdd?.(); store.add(itemId, Array.from(e.target.files ?? [])); e.target.value = ""; }}
      />
      <button type="button" className={s.attach} title="Add images" aria-label="Add images" onClick={() => picker.current?.click()}>
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5" />
        </svg>
      </button>
    </>
  );
}

// The images that wait for the send. A failed one says why; the send waits until it is removed.
export function AttachedRow({ itemId, store = answerImages }: { itemId: string; store?: AnswerImages }) {
  const list = useAnswerImages(itemId, store);
  const note = useAnswerNote(itemId, store);
  const failed = list.find((a) => a.state === "err");
  const why = failed ? `Not uploaded: ${failed.error ?? "error"}. Remove it to send.` : note;
  if (list.length === 0 && !why) return null;
  return (
    <div className={s.row}>
      {list.length > 0 && (
        <ul className={s.list} aria-label="Images of the answer">
          {list.map((a, n) => (
            <li key={a.key} className={s.item} data-state={a.state} title={a.state === "err" ? a.error : a.label}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url} alt={`Image ${n + 1} of the answer`} />
              {a.state === "up" && <span className={s.wait} aria-label="Uploading" />}
              <button type="button" className={s.remove} aria-label={`Remove image ${n + 1}`} onClick={() => store.remove(itemId, a.key)}>
                <CloseIcon size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {why && <span className={s.note} role="status">{why}</span>}
    </div>
  );
}

// The images of the answer on a closed ticket.
export function AnswerThumbs({ item, onZoom }: { item: QueueItem; onZoom(name: string, n: number): void }) {
  const images = item.status !== "withdrawn" ? item.answer?.images ?? [] : [];
  if (images.length === 0) return null;
  return (
    <div className={s.thumbs} role="group" aria-label="Images of the answer">
      {images.map((x, n) => (
        <button key={x.name} type="button" className={s.thumb} aria-label={`Zoom answer image ${n + 1}`} onClick={() => onZoom(x.name, n + 1)}>
          <AuthedImg src={previewSrc(item, x.name)} alt={`Answer image ${n + 1}`} loading="lazy" />
        </button>
      ))}
    </div>
  );
}
