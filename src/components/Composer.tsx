// src/components/Composer.tsx — a text box under an agent terminal. What the
// user sends is queued (src/lib/composer.ts) and typed into the agent as one
// prompt once the agent can take it, so typing right after a reload is never
// lost. The terminal above stays usable for direct typing.
// A file pasted here, picked with the paperclip button or handed over by the pane (a
// drop on the thread) is uploaded into the agent's worktree, and its path goes
// into the text at the cursor. The user sends it with the message.
"use client";
import { useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type Ref } from "react";
import { useIsMobile } from "../lib/useIsMobile";
import { composer, MAX_TEXT, type Composer, type ComposerItem } from "../lib/composer";
import { insertPaths, uploadFile, uploadPath, UPLOAD_ACCEPT } from "../lib/upload";
import { CloseIcon, RefreshIcon } from "./SideIcons";
import s from "./Composer.module.css";

const MAX_ROWS_SHOWN = 2;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const more = text.includes("\n") ? " …" : "";
  return line.trim() + more;
}

function stateLabel(it: ComposerItem): string {
  if (it.note) return it.note;
  return it.state === "sending" ? "sending" : "pending";
}

// Phones have no Shift+Enter: there Enter is a new line and Send sends.
function coarsePointer(): boolean {
  try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
}

export type ComposerHandle = { attach: (files: File[]) => void };

// `attachButton`: show the file picker button (the thread view; the terminal view has its own attach button).
// `queueList` false: the thread shows each message as a bubble with its state
// (lib/outbox.ts), so the list of queued messages above the box is not drawn.
export function AgentComposer({ agentId, attachButton = false, queueList = true, ref: handle }: {
  agentId: string; attachButton?: boolean; queueList?: boolean; ref?: Ref<ComposerHandle>;
}) {
  // Storage is browser-only: the draft and the queue load before the first
  // paint (a layout effect), so the box opens at its size and does not grow
  // one frame later.
  const [c, setC] = useState<Composer | null>(null);
  // Phone: the long hint does not fit one line of the box, so it is cut mid-word.
  const mobile = useIsMobile();
  const [text, setText] = useState("");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  // Where the cursor goes after a path insert, once the new text is in the box.
  const cursor = useRef<number | null>(null);

  useLayoutEffect(() => {
    const inst = composer();
    setC(inst);
    setText(inst.draft(agentId));
    const unsub = inst.subscribe(agentId, rerender);
    inst.kick(agentId);
    return unsub;
  }, [agentId]);

  // Auto-grow up to the CSS max-height.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    if (cursor.current === null) return;
    ta.setSelectionRange(cursor.current, cursor.current);
    cursor.current = null;
    // On a phone a focus opens the keyboard over the thread: leave it to the user.
    if (!coarsePointer()) ta.focus();
  }, [text]);

  const items = c?.items(agentId) ?? [];

  const change = (v: string) => {
    setText(v);
    c?.setDraft(agentId, v);
    if (error) setError(null);
  };

  // Upload the files, then put the paths of the good ones at the cursor. A
  // failed one adds no path: its reason shows above the box.
  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setUploading((n) => n + files.length);
    const results = await Promise.all(files.map((f) => uploadFile(uploadPath(agentId), f)));
    setUploading((n) => n - files.length);
    const paths = results.flatMap((r) => ("path" in r ? [r.path] : []));
    const ta = ref.current;
    if (ta) {
      const next = insertPaths(ta.value, ta.selectionStart, ta.selectionEnd, paths);
      if (paths.length) { cursor.current = next.cursor; change(next.text); }
    } else if (paths.length) {
      // The user went to another agent meanwhile: the paths wait in this agent's draft.
      const inst = composer();
      const draft = inst.draft(agentId);
      inst.setDraft(agentId, insertPaths(draft, draft.length, draft.length, paths).text);
    }
    const failed = results.flatMap((r, i) => ("error" in r ? [`${files[i].name}: ${r.error}`] : []));
    if (failed.length) setError(`Not uploaded — ${failed.join("; ")}`);
  };
  useImperativeHandle(handle, () => ({ attach: (files) => void attach(files) }));

  // A pasted file (a screenshot, a copied image) is uploaded. Text stays a normal paste.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  };

  const send = () => {
    if (!c || !text.trim() || uploading > 0) return;
    if (text.length > MAX_TEXT) { setError(`Too long: ${text.length} / ${MAX_TEXT} chars`); return; }
    if (!c.add(agentId, text)) { setError("Could not queue: browser storage is blocked"); return; }
    setText("");
    c.setDraft(agentId, "");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (coarsePointer()) return;
    e.preventDefault();
    send();
  };

  const shown = items.slice(0, MAX_ROWS_SHOWN);
  const hidden = items.length - shown.length;

  return (
    <div className={s.composer} data-composer>
      {queueList && items.length > 0 && (
        <ul className={s.queue} aria-label="Queued messages">
          {shown.map((it) => (
            <li key={it.id} className={s.item} data-state={it.state}>
              <span className={s.itemText}>{firstLine(it.text)}</span>
              <span className={s.itemState}>{stateLabel(it)}</span>
              {it.state === "failed" && (
                <button type="button" className={s.itemBtn} title="Retry" aria-label="Retry" onClick={() => c?.retry(agentId, it.id)}><RefreshIcon size={12} /></button>
              )}
              {it.state !== "sending" && (
                <button type="button" className={s.itemBtn} title="Remove" aria-label="Remove" onClick={() => c?.remove(agentId, it.id)}><CloseIcon size={12} /></button>
              )}
            </li>
          ))}
          {hidden > 0 && <li className={s.more}>+{hidden} more</li>}
        </ul>
      )}
      {error && <div className={s.error} role="alert">{error}</div>}
      {uploading > 0 && <div className={s.hint} role="status">Uploading {uploading === 1 ? "1 file" : `${uploading} files`}…</div>}
      {!error && uploading === 0 && c?.hint(agentId) && <div className={s.hint} role="status">{c.hint(agentId)}</div>}
      <div className={s.field}>
        {attachButton && (
          <>
            <input
              ref={picker} type="file" multiple accept={UPLOAD_ACCEPT} hidden
              onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }}
            />
            <button type="button" className={s.attach} title="Attach an image or a file" aria-label="Attach an image or a file" onClick={() => picker.current?.click()}>
              <svg className={s.icon} viewBox="0 0 16 16" aria-hidden>
                <path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5" />
              </svg>
            </button>
          </>
        )}
        <textarea
          ref={ref}
          className={s.input}
          rows={1}
          value={text}
          placeholder={mobile ? "Message the agent" : "Message the agent. It gets it when it is ready."}
          aria-label="Message the agent"
          spellCheck
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {/* A press on Send does not take the focus out of the box: on a phone the
            keyboard stays as it is (open while the user writes), so the thread
            does not change its height at the moment of the send. */}
        <button
          type="button" className={s.send} onClick={send} onMouseDown={(e) => e.preventDefault()}
          disabled={!text.trim() || uploading > 0} aria-label="Send" title="Send (Enter)"
        >
          <svg className={s.icon} viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M4 7l4-4 4 4" /></svg>
        </button>
      </div>
    </div>
  );
}
