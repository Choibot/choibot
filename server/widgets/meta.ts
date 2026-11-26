// server/widgets/meta.ts — parse the agent-written meta.json and the
// console-written ui.json. Both fail soft like .choibot/docs.json: bad JSON is an
// empty object, a value of the wrong type is dropped, a number out of range is
// clamped. ui.json wins over meta.json, so a widget can resize itself.
export type WidgetWidth = number | "wide";

export type WidgetMeta = {
  title?: string; width?: WidgetWidth; height?: number; chrome?: boolean;
  autoRefresh?: number; order?: number; historyMax?: number;
};

// autoRefresh null = turned off at run time (choibot.setAutoRefresh(null)).
export type WidgetUi = { width?: WidgetWidth; height?: number; autoRefresh?: number | null };

export type WidgetLayout = {
  title: string; width: WidgetWidth; height: number; chrome: boolean;
  autoRefresh: number | null; order: number; historyMax: number;
};

export const DEFAULT_LAYOUT = { width: 260, height: 180, chrome: true, order: 0, historyMax: 500 } as const;

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}

const width = (v: unknown): WidgetWidth | undefined => (v === "wide" ? "wide" : clampInt(v, 160, 1200));
const height = (v: unknown): number | undefined => clampInt(v, 80, 800);
// Upper bound one day: setInterval cannot hold much more than 24 days anyway.
const autoRefresh = (v: unknown): number | undefined => clampInt(v, 30, 86_400);

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseObj(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try { return asObj(JSON.parse(raw)); } catch { return {}; }
}

export function metaFromObject(v: unknown): WidgetMeta {
  const o = asObj(v);
  const m: WidgetMeta = {};
  if (typeof o.title === "string" && o.title.trim()) m.title = o.title.trim().slice(0, 80);
  const w = width(o.width); if (w !== undefined) m.width = w;
  const h = height(o.height); if (h !== undefined) m.height = h;
  if (typeof o.chrome === "boolean") m.chrome = o.chrome;
  const a = autoRefresh(o.autoRefresh); if (a !== undefined) m.autoRefresh = a;
  if (typeof o.order === "number" && Number.isFinite(o.order)) m.order = o.order;
  const hm = clampInt(o.historyMax, 10, 5000); if (hm !== undefined) m.historyMax = hm;
  return m;
}

export function parseMeta(raw: string | null): WidgetMeta {
  return metaFromObject(parseObj(raw));
}

export function uiFromObject(v: unknown): WidgetUi {
  const o = asObj(v);
  const u: WidgetUi = {};
  const w = width(o.width); if (w !== undefined) u.width = w;
  const h = height(o.height); if (h !== undefined) u.height = h;
  if (o.autoRefresh === null) u.autoRefresh = null;
  else { const a = autoRefresh(o.autoRefresh); if (a !== undefined) u.autoRefresh = a; }
  return u;
}

export function parseUi(raw: string | null): WidgetUi {
  return uiFromObject(parseObj(raw));
}

export function resolveLayout(id: string, meta: WidgetMeta, ui: WidgetUi): WidgetLayout {
  return {
    title: meta.title ?? id,
    width: ui.width ?? meta.width ?? DEFAULT_LAYOUT.width,
    height: ui.height ?? meta.height ?? DEFAULT_LAYOUT.height,
    chrome: meta.chrome ?? DEFAULT_LAYOUT.chrome,
    autoRefresh: ui.autoRefresh !== undefined ? ui.autoRefresh : (meta.autoRefresh ?? null),
    order: meta.order ?? DEFAULT_LAYOUT.order,
    historyMax: meta.historyMax ?? DEFAULT_LAYOUT.historyMax,
  };
}

// Strip order (spec meta.json "order"): lower first; then title; then id.
export function sortWidgets<T extends { id: string; title: string; order: number }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.order - b.order || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
