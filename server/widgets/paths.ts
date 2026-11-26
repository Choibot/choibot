// server/widgets/paths.ts — where widgets live and which names are allowed.
// Agent ids and widget ids become path segments, so both are checked against
// a strict pattern before any filesystem call: no dots, no separators.
import { join, resolve } from "node:path";
import { widgetsDataDir } from "../layout.js";

// The agent id pattern lives in server/ids.ts; re-exported for old importers.
export { isAgentId } from "../ids.js";

export const WIDGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isWidgetId(v: unknown): v is string {
  return typeof v === "string" && WIDGET_ID_RE.test(v);
}

// WIDGETS_DATA_DIR, else the folder of this install's layout (server/layout.ts: `.widgets-data` in
// the console's cwd, or <install home>/widgets in the release layout), always absolute: the path
// goes into agent prompts and script env, where a relative path would resolve against the agent's
// cwd instead.
export function resolveWidgetsDataDir(env: Record<string, string | undefined> = process.env): string {
  return widgetsDataDir(env, process.cwd());
}

export function agentWidgetsDir(root: string, agentId: string): string {
  return join(root, agentId);
}

export function widgetDir(root: string, agentId: string, widgetId: string): string {
  return join(root, agentId, widgetId);
}

// Byte caps from the spec ("Storage layout", "Script contract", "Agent fallback").
export const LIMITS = {
  html: 1024 * 1024,
  data: 256 * 1024,
  history: 2 * 1024 * 1024,
  historyEntry: 64 * 1024,
  state: 64 * 1024,
  small: 64 * 1024, // meta.json, ui.json, status.json
  refreshOut: 256 * 1024,
  actionOut: 1024 * 1024,
  stderrTail: 4096,
  askText: 2000,
} as const;
