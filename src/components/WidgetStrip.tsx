// src/components/WidgetStrip.tsx
// The widget strip under an agent's pane header (spec 2026-10-22 "WidgetStrip").
// Polls the agent's widget list every 3 s while mounted and renders nothing
// until the agent has a widget. Folded, it is one line: "Widgets" and a chip
// with the title of each widget; a click opens it (the choice is kept per
// agent in localStorage) and the widgets show as boxes in a row. "Open large"
// shows one widget over the pane. Auto-refresh runs only while the strip is
// open and the browser tab is visible.
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { latestRequest } from "../lib/latest-request";
import { listWidgets, readCollapsed, stripVisible, writeCollapsed, type WidgetInfo } from "../lib/widgets";
import { WidgetFrame } from "./WidgetFrame";
import s from "./WidgetStrip.module.css";

const POLL_MS = 3000;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

// Last list per agent. On a switch back the strip takes its space at once: if it
// arrived with the poll instead, the terminal would shrink and redraw the agent.
const lastWidgets = new Map<string, WidgetInfo[]>();

// The warm-up (lib/warmup): read the agent's widget list before its pane opens.
export async function prefetchWidgets(agentId: string): Promise<void> {
  if (lastWidgets.has(agentId)) return;
  const w = await listWidgets(agentId);
  if (!lastWidgets.has(agentId)) lastWidgets.set(agentId, w);
}

// The agent's widget list is known (seen once): the strip takes its place on the first frame.
export function widgetsKnown(agentId: string): boolean {
  return lastWidgets.has(agentId);
}

// `onKnown`: the first answer of the list (or its failure) is in, so the strip has its height.
export function WidgetStrip({ agentId, onKnown }: { agentId: string; onKnown?: () => void }) {
  const onKnownRef = useRef(onKnown);
  onKnownRef.current = onKnown;
  const [widgets, setWidgets] = useState<WidgetInfo[] | null>(() => lastWidgets.get(agentId) ?? null);
  // Read before the first paint: a strip the user opened must not open one frame late.
  const [collapsed, setCollapsed] = useState(() => (typeof window === "undefined" ? true : readCollapsed(storage(), agentId)));
  const [large, setLarge] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => { setCollapsed(readCollapsed(storage(), agentId)); }, [agentId]);

  // latestRequest: a slow reply never overwrites a newer one. A failed poll
  // (agent gone; a master agent is 404) keeps what is shown.
  const reload = useMemo(
    () => latestRequest(() => listWidgets(agentId).catch(() => null), (w) => {
      if (w) { lastWidgets.set(agentId, w); setWidgets(w); }
      onKnownRef.current?.();
    }),
    [agentId],
  );
  useEffect(() => {
    reload();
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  useEffect(() => {
    if (!large) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLarge(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [large]);

  if (!stripVisible(widgets)) return null;
  const list = widgets ?? [];
  const largeInfo = large ? list.find((w) => w.id === large) : undefined;
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(storage(), agentId, next);
  };

  return (
    <section className={s.strip} aria-label="Agent widgets">
      <button type="button" className={s.stripHead} onClick={toggle} aria-expanded={!collapsed} title={collapsed ? "Show the widgets" : "Fold the widgets"}>
        <svg className={s.chev} data-open={collapsed ? undefined : ""} viewBox="0 0 16 16" aria-hidden><path d="m6 4 4 4-4 4" /></svg>
        <span>Widgets</span>
        {collapsed && list.map((w) => (
          <span key={w.id} className={s.chip} title={w.status && !w.status.ok ? `${w.title}: the last refresh failed` : w.title}>
            {w.status && !w.status.ok && <i className={s.dot} aria-hidden />}
            <span className={s.chipText}>{w.title}</span>
          </span>
        ))}
      </button>
      {/* Hidden, not unmounted: collapsing keeps each frame's own state. */}
      <div className={s.row} style={{ display: collapsed ? "none" : "flex" }}>
        {list.map((w) => (
          <WidgetFrame
            key={w.id}
            agentId={agentId}
            info={w}
            size="box"
            autoActive={!collapsed && visible}
            onChanged={reload}
            onOpenLarge={() => setLarge(w.id)}
          />
        ))}
      </div>
      {largeInfo && (
        <>
          <div className={s.backdrop} onClick={() => setLarge(null)} />
          <div className={s.overlay}>
            <WidgetFrame
              key={`large-${largeInfo.id}`}
              agentId={agentId}
              info={largeInfo}
              size="large"
              autoActive={false}
              onChanged={reload}
              onClose={() => setLarge(null)}
            />
          </div>
        </>
      )}
    </section>
  );
}
