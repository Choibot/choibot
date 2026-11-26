// src/components/WidgetFrame.tsx
// One agent widget box (spec 2026-10-22 "WidgetFrame"): the agent's HTML in an
// <iframe sandbox="allow-scripts"> (opaque origin: no console cookies, no API),
// behind the bootstrap from src/lib/widgets.ts, plus the console header, the
// ⋯ menu and the confirm bar. Message checks, call handling and the confirm
// flow are pure functions in src/lib/widgets.ts (unit-tested); this file only
// wires them to React and the DOM.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentKey, agentMemory } from "../lib/viewCache";
import { useTheme } from "../lib/theme";
import {
  ASK_TIMEOUT_MS, acceptFrameMessage, autoRefreshSeconds, bootstrapScript, deleteWidget,
  formatUpdated, getWidget, handleFrameCall, injectBootstrap, mergeHistory, newNonce,
  onFrameLoad, refreshWidget, type HistoryEntry, type RefreshReply, type WidgetInfo,
} from "../lib/widgets";
import { MoreIcon, RefreshIcon } from "./SideIcons";
import s from "./WidgetStrip.module.css";

type Loaded = { html: string; data: unknown; history: HistoryEntry[]; state: unknown };
// The last payload of each widget (lib/viewCache): a strip that opens again shows the frame at
// once, and keeps it when the fresh payload is the same (no second load of the frame).
const framesSeen = agentMemory<Loaded>(12);
const samePayload = (a: Loaded, b: Loaded): boolean =>
  a.html === b.html && JSON.stringify([a.data, a.history, a.state]) === JSON.stringify([b.data, b.history, b.state]);
// shownAt: Send ignores clicks in the first CONFIRM_ARM_MS, so a widget cannot
// open the bar under a click it baited and have that click land on Send.
type Pending = { text: string; resolve: (ok: boolean) => void; shownAt: number };
const CONFIRM_ARM_MS = 600;
// One mount = one srcdoc load with its own nonce and load counter.
type Mount = { key: string; nonce: string; loads: number; navigated: boolean };

export function WidgetFrame({
  agentId, info, size, autoActive, onChanged, onOpenLarge, onClose,
}: {
  agentId: string;
  info: WidgetInfo;
  size: "box" | "large";
  autoActive: boolean;
  onChanged: () => void;
  onOpenLarge?: () => void;
  onClose?: () => void;
}) {
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(() => framesSeen.get(agentKey(agentId, info.id)) ?? null);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remount, setRemount] = useState(0);
  // Bumped together with the full-fetch setLoaded, so the mount key changes in
  // the same render as the new html (never a new key on old html).
  const [htmlGen, setHtmlGen] = useState(0);
  // Parent callbacks live in refs so effect timers do not restart when the
  // parent passes new function identities (the strip polls every 3 s).
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const [pending, setPending] = useState<Pending | null>(null);
  const [armed, setArmed] = useState(false);
  const pendingRef = useRef<Pending | null>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // A new html mtime or a navigation remount makes a new mount (new React
  // key, new nonce, load counter back to 0).
  const frameKey = `${htmlGen}:${remount}`;
  const mountRef = useRef<Mount | null>(null);
  if (!mountRef.current || mountRef.current.key !== frameKey) {
    mountRef.current = { key: frameKey, nonce: newNonce(), loads: 0, navigated: false };
  }
  const mount = mountRef.current;

  // Target origin "*": a sandboxed srcdoc frame has an opaque origin. Once the
  // frame has navigated, nothing is posted to it (it is no longer our page).
  const post = useCallback((msg: Record<string, unknown>) => {
    const m = mountRef.current;
    if (!m || m.navigated) return;
    frameRef.current?.contentWindow?.postMessage({ ...msg, choibot: 1 }, "*");
  }, []);

  // Full payload (html included) on mount and on every html change.
  useEffect(() => {
    let live = true;
    getWidget(agentId, info.id)
      .then((p) => {
        if (!live) return;
        const next: Loaded = { html: p.html ?? "", data: p.data, history: p.history, state: p.state };
        framesSeen.set(agentKey(agentId, info.id), next);
        setLoadError(null);
        const cur = loadedRef.current;
        if (cur && samePayload(cur, next)) return; // the remembered frame is this payload already
        setLoaded(next);
        setHtmlGen((g) => g + 1);
      })
      .catch((e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [agentId, info.id, info.htmlMtime]);

  // New data.json: fetch only the new history entries and post them in.
  // Before the first full fetch returns there is nothing to update: the change
  // stays unseen and is applied when `hasLoaded` flips.
  const hasLoaded = loaded !== null;
  const seenDataMtime = useRef(info.dataMtime);
  useEffect(() => {
    if (info.dataMtime === seenDataMtime.current) return;
    const cur = loadedRef.current;
    if (!cur) return;
    seenDataMtime.current = info.dataMtime;
    setAskedAt(null);
    const since = cur.history.length ? cur.history[cur.history.length - 1].at : 0;
    let live = true;
    getWidget(agentId, info.id, since)
      .then((p) => {
        if (!live) return;
        const history = mergeHistory(loadedRef.current?.history ?? [], p.history);
        setLoaded((l) => (l ? { ...l, data: p.data, history } : l));
        post({ type: "data", data: p.data, history });
      })
      .catch(() => { /* the next data change tries again */ });
    return () => { live = false; };
  }, [agentId, info.id, info.dataMtime, hasLoaded, post]);

  useEffect(() => { post({ type: "theme", theme }); }, [theme, post]);

  // "asked agent…" ends when data.json changes (above) or after 5 min.
  useEffect(() => {
    if (askedAt === null) return;
    const t = setTimeout(() => setAskedAt(null), Math.max(0, askedAt + ASK_TIMEOUT_MS - Date.now()));
    return () => clearTimeout(t);
  }, [askedAt]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // Confirm bar: one question at a time; a second one is refused (Cancel).
  const askConfirm = useCallback((text: string) => new Promise<boolean>((resolve) => {
    if (pendingRef.current) { resolve(false); return; }
    const p = { text, resolve, shownAt: Date.now() };
    pendingRef.current = p;
    setPending(p);
  }), []);
  const answer = useCallback((ok: boolean) => {
    const p = pendingRef.current;
    if (ok && p && Date.now() - p.shownAt < CONFIRM_ARM_MS) return;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(ok);
  }, []);

  // Send is enabled CONFIRM_ARM_MS after the bar opens (the timer belongs to
  // this pending question only).
  useEffect(() => {
    setArmed(false);
    if (!pending) return;
    const t = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, [pending]);

  // Unmounting with a question open cancels it.
  useEffect(() => () => {
    const p = pendingRef.current;
    pendingRef.current = null;
    p?.resolve(false);
  }, []);

  // A new mount key (html change or navigation) ends any open question.
  useEffect(() => { answer(false); }, [frameKey, answer]);

  const onRefreshed = useCallback((r: RefreshReply) => {
    if (r.mode === "agent") setAskedAt(Date.now());
    onChangedRef.current();
  }, []);

  // Frame → parent. acceptFrameMessage checks the source window, this mount's
  // nonce and the navigation guard.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const m = mountRef.current;
      if (!m) return;
      const msg = acceptFrameMessage(ev, {
        frame: frameRef.current?.contentWindow ?? null, nonce: m.nonce, navigated: m.navigated,
      });
      if (!msg) return;
      if (msg.type === "ready") {
        const l = loadedRef.current;
        post({
          type: "init", data: l?.data ?? null, history: l?.history ?? [], state: l?.state ?? {},
          theme: themeRef.current, size, widgetId: info.id,
        });
        return;
      }
      void handleFrameCall(msg, { agentId, widgetId: info.id, confirm: askConfirm, onRefreshed, onUiChanged: () => onChangedRef.current() })
        .then((reply) => { if (mountRef.current === m && !m.navigated) post(reply); });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [agentId, info.id, size, post, askConfirm, onRefreshed]);

  // Navigation guard: a second load means the widget navigated away.
  const onLoad = () => {
    const m = mountRef.current;
    if (!m) return;
    const next = onFrameLoad(m.loads);
    m.loads = next.loads;
    if (next.navigated && !m.navigated) {
      m.navigated = true;
      answer(false);
      setRemount((n) => n + 1);
    }
  };

  // Auto-refresh (script mode only; the box frame only).
  const autoSecs = autoRefreshSeconds(info, autoActive);
  useEffect(() => {
    if (!autoSecs) return;
    const t = setInterval(() => {
      void refreshWidget(agentId, info.id, {}).then(() => onChangedRef.current()).catch(() => { /* status.json shows script errors */ });
    }, autoSecs * 1000);
    return () => clearInterval(t);
  }, [autoSecs, agentId, info.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // The console's own ⟳ and ⋯ → Refresh: a user action, so agent mode is
  // sent confirmed with no confirm bar (spec "User-facing behavior" 3).
  const consoleRefresh = async () => {
    setMenuOpen(false);
    try {
      const r = await refreshWidget(agentId, info.id, { confirmed: true });
      if (r.mode === "agent") setAskedAt(Date.now());
      onChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    if (!window.confirm(`Remove widget "${info.title}"? This deletes its folder.`)) return;
    try {
      await deleteWidget(agentId, info.id);
      onClose?.();
      onChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const menu = (
    <div className={s.menuWrap} ref={menuRef}>
      <button type="button" className={s.iconBtn} onClick={() => setMenuOpen((v) => !v)}
        aria-label="Widget menu" aria-expanded={menuOpen}><MoreIcon size={14} /></button>
      {menuOpen && (
        <div className={s.menu} role="menu">
          <button type="button" role="menuitem" onClick={() => void consoleRefresh()}>Refresh</button>
          {size === "box"
            ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenLarge?.(); }}>Open large</button>
            : <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onClose?.(); }}>Close large</button>}
          <button type="button" role="menuitem" onClick={() => void remove()}>Remove</button>
        </div>
      )}
    </div>
  );

  const updated = formatUpdated(info.status?.at ?? info.dataMtime);
  const boxStyle = size === "box"
    ? { width: info.width === "wide" ? "100%" : `${info.width}px`, height: `${info.height}px` }
    : undefined;
  const srcDoc = loaded ? injectBootstrap(loaded.html, bootstrapScript(mount.nonce)) : undefined;

  return (
    <div className={`${s.box} ${size === "large" ? s.large : ""}`} style={boxStyle}>
      {info.chrome ? (
        <header className={s.boxHead}>
          {info.status && !info.status.ok && (
            <span className={s.dot} title={info.status.error ?? "last refresh failed"} aria-label="last refresh failed" />
          )}
          <span className={s.title} title={info.title}>{info.title}</span>
          <span className={s.updated}>{askedAt !== null ? "asked agent…" : updated ? `updated ${updated}` : ""}</span>
          <button type="button" className={s.iconBtn} onClick={() => void consoleRefresh()} title="Refresh" aria-label="Refresh"><RefreshIcon size={12} /></button>
          {menu}
        </header>
      ) : (
        <div className={s.cornerMenu}>{menu}</div>
      )}
      {notice && <div className={s.notice} title={notice}>{notice}</div>}
      <div className={s.frameWrap}>
        {loadError ? (
          <div className={s.empty}>{loadError}</div>
        ) : srcDoc === undefined ? (
          <div className={`${s.empty} late`}>Loading…</div>
        ) : (
          <iframe
            key={mount.key}
            ref={frameRef}
            className={s.frame}
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            title={info.title}
            onLoad={onLoad}
          />
        )}
      </div>
      {pending && (
        <div className={s.confirm} role="alertdialog" aria-label="Send to agent?">
          <span className={s.confirmText}>{pending.text}</span>
          <button type="button" className={`${s.confirmBtn} ${s.confirmPrimary}`} disabled={!armed} onClick={() => answer(true)}>Send</button>
          <button type="button" className={s.confirmBtn} onClick={() => answer(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
