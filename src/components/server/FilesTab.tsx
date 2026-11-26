// src/components/server/FilesTab.tsx — the Files tab of the Server page: every folder and file
// of your server that its user can read, from the home folder up to "/". Read only: no upload,
// no edit, no delete. A file or folder that holds a key or a login is a locked row with the
// reason; the server never sends its size, its date, its content or what is in it.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ago } from "../../lib/server";
import {
  changedWord, childPath, crumbs, fetchContent, fetchList, fetchPrivate, measureFolders, nextSort, savePrivate, shownRows,
  type ContentAnswer, type Entry, type ListAnswer, type PrivateAnswer, type Refused, type Sort, type SortKey,
} from "../../lib/serverFiles";
import { useRemembered, useScrollMemory, viewMemory } from "../../lib/viewCache";
import { size } from "../../../server/health/words";
import { FileContent } from "../FileContent";
import { ArrowDownIcon, ArrowUpIcon, BackIcon, ChevronIcon, FileIcon, FolderIcon, LinkIcon, LockIcon } from "../SideIcons";
import { cx as k } from "../settings/kit";
import s from "./Server.module.css";

// What each folder showed the last time: a folder that opens again is drawn at once.
const lists = viewMemory<ListAnswer | null>(40);
// Where the user was: the folder, the open file and the sort are kept while the page is loaded.
const place = viewMemory<{ path: string | null; file: string | null; sort: Sort }>(1);
const HOME_KEY = "\nhome";
const START = { path: null, file: null, sort: { key: "name", down: false } as Sort };

function rowIcon(e: Entry) {
  if (e.locked) return <LockIcon />;
  if (e.kind === "dir") return <FolderIcon />;
  if (e.kind === "link") return <LinkIcon />;
  return <FileIcon />;
}

function FileView({ path, onBack, onOpenExplorer, phone }: { path: string; onBack: () => void; onOpenExplorer: (folder: string, file?: string) => void; phone: boolean }) {
  const [got, setGot] = useState<ContentAnswer | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);
  useEffect(() => {
    let live = true;
    setGot(null);
    setRefused(null);
    void fetchContent(path).then((a) => {
      if (!live) return;
      if (a.ok) setGot(a.value);
      else setRefused(a.refused);
    });
    return () => { live = false; };
  }, [path]);
  const name = path.slice(path.lastIndexOf("/") + 1);
  // The text that is on the screen, as a file: nothing more leaves the server for it.
  const download = () => {
    if (!got || got.content === undefined) return;
    const url = URL.createObjectURL(new Blob([got.content], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  const facts = got ? `${size(got.size)} · changed ${changedWord(got.mtime, Date.now())}` : "";
  return (
    <div className={s.fileView}>
      <div className={s.fileBar}>
        <button type="button" className={`${k.btn} ${k.quiet} ${s.backBtn}`} onClick={onBack}><BackIcon size={14} />Back to the folder</button>
        <span className={s.fileName} title={path}>{name}</span>
        <span className={s.fileFacts}>{facts}</span>
        {got?.kind === "text" && <button type="button" className={k.btn} onClick={download}>Download</button>}
        {got?.explorer && <button type="button" className={k.btn} onClick={() => onOpenExplorer(got.explorer as string, got.path)}>Open in the code explorer</button>}
      </div>
      <div className={s.fileBody} data-phone={phone || undefined}>
        {refused && <p className={s.lone} role="status">{refused.text}</p>}
        {got?.kind === "text" && <FileContent path={got.path} content={got.content ?? ""} />}
        {got?.kind === "binary" && <p className={s.lone}>This is not a text file, so it is not shown. Size: {size(got.size)}.</p>}
        {got?.kind === "large" && <p className={s.lone}>This file is bigger than 1 MB, so it is not shown here. Size: {size(got.size)}.</p>}
        {got?.kind === "other" && <p className={s.lone}>This is not a file with content (a socket, a pipe or a device).</p>}
      </div>
    </div>
  );
}

// The private places of the user: the list, "Show again" for each, and a field to add one.
function PrivatePanel({ priv, save, note }: { priv: PrivateAnswer; save: (places: string[]) => Promise<void>; note: string | null }) {
  const [text, setText] = useState("");
  const add = async () => {
    const p = text.trim();
    if (!p) return;
    await save([...priv.places, p]);
    setText("");
  };
  return (
    <section className={s.privPanel} aria-label="Private places">
      <p className={s.privHelp}>A private place is a folder or a file that this tab never shows: it is a locked row. Use it for a place with keys that has no known name.</p>
      {priv.places.map((p) => (
        <div key={p} className={s.privRow}>
          <span className={s.privPath}>{p}</span>
          {priv.canChange && <button type="button" className={k.btn} onClick={() => void save(priv.places.filter((x) => x !== p))}>Show again</button>}
        </div>
      ))}
      {priv.places.length === 0 && <p className={s.privHelp}>No private place yet.</p>}
      {priv.canChange ? (
        <form className={s.privAdd} onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className={k.input} value={text} onChange={(e) => setText(e.target.value)} placeholder="/the/full/path/of/a/folder" aria-label="The full path of a folder or file to keep private" spellCheck={false} autoCapitalize="off" />
          <button type="submit" className={k.btn} disabled={!text.trim()}>Keep private</button>
        </form>
      ) : <p className={s.privHelp}>The list cannot change on this server.</p>}
      {note && <p className={k.err} role="alert">{note}</p>}
    </section>
  );
}

export function FilesTab({ phone, onOpenExplorer }: { phone: boolean; onOpenExplorer: (folder: string, file?: string) => void }) {
  const [at, setAt] = useRemembered(place, "at", START);
  const key = at.path ?? HOME_KEY;
  const [list, setList] = useRemembered<ListAnswer | null>(lists, key, null);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const scroll = useScrollMemory<HTMLDivElement>(`files:${key}`);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(async () => {
    const a = await fetchList(at.path);
    if (a.ok) {
      setList(a.value);
      lists.set(a.value.path, a.value); // the home folder also under its own path
      if (live.current) setRefused(null);
    } else if (live.current) setRefused(a.refused);
  }, [at.path, setList]);
  useEffect(() => { setRefused(null); setNote(null); void load(); }, [load]);
  // While the folders are measured, the list is read again until the sizes are there.
  const measuring = list?.sizes.state === "measuring";
  useEffect(() => {
    if (!measuring) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [measuring, load]);

  const go = (path: string | null) => { setFilter(""); setAt((p) => ({ ...p, path, file: null })); };

  // The private places: read when the tab opens; a change is in force at once.
  const [priv, setPriv] = useState<PrivateAnswer | null>(null);
  const [privOpen, setPrivOpen] = useState(false);
  const [privNote, setPrivNote] = useState<string | null>(null);
  useEffect(() => { void fetchPrivate().then((a) => { if (live.current && a.ok) setPriv(a.value); }); }, []);
  const saveIt = async (places: string[]): Promise<boolean> => {
    const a = await savePrivate(places);
    if (!live.current) return false;
    setPrivNote(a.ok ? null : a.refused.text);
    if (a.ok) setPriv(a.value);
    return a.ok;
  };
  const savePriv = async (places: string[]) => { if (await saveIt(places)) await load(); };
  // The folder on the screen becomes private: the tab goes to the folder above it.
  const keepPrivate = async () => {
    if (!list || !priv || list.parent === null) return;
    if (await saveIt([...priv.places, list.path])) go(list.parent);
    else setPrivOpen(true);
  };
  const privBtn = priv && (
    <button type="button" className={`${k.btn} ${k.quiet}`} onClick={() => setPrivOpen((v) => !v)} aria-expanded={privOpen}>
      Private places{priv.places.length ? ` (${priv.places.length})` : ""}
    </button>
  );
  const privPanel = priv && privOpen && <PrivatePanel priv={priv} save={savePriv} note={privNote} />;
  const measure = async () => {
    if (!list) return;
    const a = await measureFolders(list.path);
    setNote(a.ok ? null : a.refused.text);
    await load();
  };

  if (at.file) return <FileView path={at.file} phone={phone} onBack={() => setAt((p) => ({ ...p, file: null }))} onOpenExplorer={onOpenExplorer} />;

  // No list for this folder: the reason (a refusal, no access), with a way back.
  if (!list || (refused && !refused.pairing && at.path !== null && list.path !== at.path)) {
    return (
      <div className={s.files}>
        {refused && <p className={s.lone} role="status">{refused.text}</p>}
        {refused && !refused.pairing && at.path !== null && <p className={s.loneAct}><button type="button" className={k.btn} onClick={() => go(null)}>Go to the home folder</button></p>}
        {refused && !refused.pairing && <p className={s.loneAct}>{privBtn}</p>}
        {privPanel}
      </div>
    );
  }

  const rows = shownRows(list.items, filter, at.sort);
  const now = Date.now();
  const head = (label: string, sortKey: SortKey, cls?: string) => (
    <button type="button" className={`${s.th} ${cls ?? ""}`} onClick={() => setAt((p) => ({ ...p, sort: nextSort(p.sort, sortKey) }))} aria-pressed={at.sort.key === sortKey}>
      {label}{at.sort.key === sortKey && (at.sort.down ? <ArrowDownIcon size={10} /> : <ArrowUpIcon size={10} />)}
    </button>
  );
  const open = (e: Entry) => {
    const p = childPath(list.path, e.name);
    if (e.kind === "dir") go(p);
    else if (e.kind === "file") setAt((prev) => ({ ...prev, file: p }));
  };
  const sizesLine = list.sizes.state === "measuring" ? "Measuring the folders…"
    : list.sizes.state === "done" && list.sizes.checkedAt ? `Folder sizes checked ${ago(list.sizes.checkedAt, now)}`
    : list.sizes.state === "slow" ? "The folders took too long to measure. Open a folder and measure there." : "";
  const hasFolders = list.items.some((e) => e.kind === "dir" && !e.locked);
  return (
    <div className={s.files} data-phone={phone || undefined}>
      <div className={s.pathBar}>
        <nav className={s.crumbs} aria-label="Folder">
          {crumbs(list.path, list.home).map((c, i, all) => (
            <span key={c.path} className={s.crumb}>
              {i > 0 && <ChevronIcon dir="right" size={10} />}
              <button type="button" onClick={() => go(c.path)} aria-current={i === all.length - 1 ? "page" : undefined}>{c.label}</button>
            </span>
          ))}
        </nav>
        {list.parent !== null && <button type="button" className={`${k.btn} ${k.quiet}`} onClick={() => go(list.parent)} title="The folder above this one"><ArrowUpIcon />Up</button>}
        {list.path !== list.home && <button type="button" className={`${k.btn} ${k.quiet}`} onClick={() => go(null)}>Home</button>}
      </div>
      <div className={s.tools}>
        <input className={`${k.input} ${s.filter}`} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter this folder" aria-label="Filter this folder by name" />
        <span className={s.checked}>{note ?? sizesLine}</span>
        {hasFolders && <button type="button" className={k.btn} onClick={() => void measure()} disabled={measuring} title="Counts every file in each folder of this list. It can take a minute.">Measure the folders</button>}
      </div>
      <div className={s.privBar}>
        {privBtn}
        {priv?.canChange && list.parent !== null && <button type="button" className={`${k.btn} ${k.quiet}`} onClick={() => void keepPrivate()} title="This tab then shows this folder as a locked row">Keep this folder private</button>}
      </div>
      {privPanel}
      <div className={s.thead}>
        <span />{head("Name", "name")}{head("Size", "size", s.right)}{head("Changed", "changed", `${s.right} ${s.colChanged}`)}
      </div>
      <div className={s.rows} ref={scroll.ref} onScroll={scroll.onScroll}>
        {rows.map((e) => e.locked ? (
          <div key={e.name} className={`${s.fileRow} ${s.locked}`} title={list.why[e.locked]}>
            <span className={s.ic}><LockIcon /></span>
            <span className={s.nameCol}><span className={s.nm}>{e.name}</span><span className={s.why}>{list.why[e.locked]}</span></span>
          </div>
        ) : (
          <button key={e.name} type="button" className={s.fileRow} onClick={() => open(e)} disabled={e.kind !== "dir" && e.kind !== "file"}>
            <span className={s.ic}>{rowIcon(e)}</span>
            <span className={s.nameCol}>
              <span className={s.nm}>{e.name}{e.link && <span className={s.tagLink}>link</span>}</span>
              {phone && e.mtime !== undefined && <span className={s.why}>{changedWord(e.mtime, now)}</span>}
            </span>
            <span className={`${s.right} ${s.sizeCol}`}>{e.kind === "dir" ? (e.bytes !== undefined ? size(e.bytes) : "") : e.size !== undefined ? size(e.size) : ""}</span>
            <span className={`${s.right} ${s.colChanged}`}>{e.mtime !== undefined ? changedWord(e.mtime, now) : ""}</span>
          </button>
        ))}
        {rows.length === 0 && <p className={s.lone}>{filter ? "No name in this folder has this text." : "This folder is empty."}</p>}
        <p className={s.foot}>
          {list.truncated ? `This folder has ${list.total} entries. The first ${list.items.length} by name are shown. ` : ""}
          Read only: nothing on your server can be changed from this page.
        </p>
      </div>
    </div>
  );
}
