import { chiefFetch } from "./chief";
// src/lib/usage.ts
// Client for the account-wide subscription usage readout (see server/usage.ts),
// which merges every runtime the box is logged into — Claude Code today, plus
// ChatGPT when a Codex login is present. Which windows exist is entirely the
// server's call; this side just renders the list it is given, so a new runtime
// or a new window kind needs no change here.
//
// Always resolves — the server returns { ok:false } instead of erroring so the
// widget can show "unavailable" without a try/catch at the call site.
export type UsageWindow = {
  key: string;
  label: string;
  group: "session" | "weekly";
  percent: number;
  severity: "normal" | "warning" | "critical";
  resetsAt: string | null;
  active: boolean;
  account?: string; // set only when the box has several Claude logins; the meter groups by it
};
export type UsageResult =
  | { ok: true; windows: UsageWindow[] }
  | { ok: false; reason: string };

export async function fetchUsage(): Promise<UsageResult> {
  try {
    const r = await chiefFetch("/api/usage");
    if (!r.ok) return { ok: false, reason: `http_${r.status}` };
    return (await r.json()) as UsageResult;
  } catch {
    return { ok: false, reason: "network" };
  }
}

// Windows in the order the server sent them, bucketed by login. The server
// tags `account` only when the box has several Claude logins, so a one-login
// console yields a single untitled bucket and renders exactly as before.
// ChatGPT windows carry no account and land in the untitled bucket too.
export function groupByAccount(windows: UsageWindow[]): { account: string | null; windows: UsageWindow[] }[] {
  const out: { account: string | null; windows: UsageWindow[] }[] = [];
  for (const w of windows) {
    const key = w.account ?? null;
    const last = out[out.length - 1];
    if (last && last.account === key) last.windows.push(w);
    else out.push({ account: key, windows: [w] });
  }
  return out;
}

// The binding weekly window: the Fable cap (the binding constraint in practice), else the
// all-models Week window, else whichever window comes first.
export function primaryWindow(windows: UsageWindow[]): UsageWindow | undefined {
  return (
    windows.find((w) => /fable/i.test(w.label)) ??
    windows.find((w) => w.key.endsWith("weekly:all")) ??
    windows[0]
  );
}

// ---- the sidebar footer: one line per login ----
// The footer answers two questions at a glance: is a login at its limit or close to it, and
// which login has room. Each window, its percent and its reset time are in the tooltip of the
// line and in Settings, Claude accounts.

export type LineState = "normal" | "close" | "limit";
export type UsageLine = {
  id: string;             // the id of the login; "_" for a console with one login; "codex"
  name: string;           // the short name on the line
  full: string | null;    // the full name for the tooltip (the address); null: no name to tell
  window: UsageWindow;    // the window on the bar: the one that limits the login now
  windows: UsageWindow[]; // each window of the login, for the tooltip
  state: LineState;
  isDefault: boolean;     // new agents start on this login
};

const resetMs = (w: UsageWindow): number => {
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return Number.isFinite(t) ? t : 0;
};

// The window that limits a login now: the fullest one, the week window of one model included.
// Two windows equally full: the one that comes back last (the server does the same for
// "at its limit until", server/agents/loginuse.ts).
export function limitingWindow(windows: UsageWindow[]): UsageWindow | undefined {
  let best: UsageWindow | undefined;
  for (const w of windows) {
    if (!best || w.percent > best.percent || (w.percent === best.percent && resetMs(w) > resetMs(best))) best = w;
  }
  return best;
}

// At its limit: the window is full. Close to it: the severity that the server gives.
export function lineState(w: UsageWindow): LineState {
  return w.percent >= 100 ? "limit" : w.severity === "normal" ? "normal" : "close";
}

export const SHORT_NAME_MAX = 12;
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

// The name of a login in a tight spot: the part of the address before "@", cut with an
// ellipsis. A login with no address keeps its id.
export function shortName(label: string, max = SHORT_NAME_MAX): string {
  const at = label.indexOf("@");
  return cut((at > 0 ? label.slice(0, at) : label).trim(), max);
}

// Two logins with the same short name (ada@example.com, ada@example.org) show the address,
// so the user can tell them apart.
function lineNames(labels: string[]): string[] {
  const short = labels.map((l) => shortName(l));
  return short.map((n, i) => (short.indexOf(n) !== short.lastIndexOf(n) ? cut(labels[i], 2 * SHORT_NAME_MAX) : n));
}

const isCodex = (w: UsageWindow): boolean => w.key.startsWith("codex:");

// The lines of the footer, in the order of the server (the main login first). `preferred`:
// the id of the login that new agents start on. One login: the server names no login, so the
// line says which window it shows ("Session", "Week · Fable"). `codex`: the line of Codex,
// only when Codex is in use (one of its windows is above 0%).
export function usageLines(windows: UsageWindow[], preferred = "default"): { logins: UsageLine[]; codex: UsageLine | null } {
  const claude = groupByAccount(windows.filter((w) => !isCodex(w)));
  const labels = lineNames(claude.map((g) => g.account ?? ""));
  const logins: UsageLine[] = [];
  claude.forEach((g, i) => {
    const w = limitingWindow(g.windows);
    if (!w) return;
    // A window of a named login has the key "<id of the login>/<key of the window>".
    const id = g.account === null ? "_" : w.key.slice(0, Math.max(0, w.key.indexOf("/"))) || g.account;
    logins.push({
      id, name: g.account === null ? w.label : labels[i], full: g.account, window: w, windows: g.windows,
      state: lineState(w), isDefault: g.account === null || id === preferred,
    });
  });
  const cw = windows.filter(isCodex);
  const top = cw.some((w) => w.percent > 0) ? limitingWindow(cw) : undefined;
  const codex: UsageLine | null = top
    ? { id: "codex", name: "Codex", full: null, window: top, windows: cw, state: lineState(top), isDefault: false }
    : null;
  return { logins, codex };
}

export const FOOT_LINES_MAX = 3;

// Which logins the footer shows: the ones that matter first (at its limit, then the fullest),
// at most `max` lines. The login that new agents start on is always there: it takes the last
// line when it is not one of the first. `more`: the logins behind "+N more".
export function pickLines(lines: UsageLine[], max = FOOT_LINES_MAX): { shown: UsageLine[]; more: UsageLine[] } {
  const rank = (l: UsageLine) => (l.state === "limit" ? 0 : 1);
  const sorted = [...lines].sort((a, b) => rank(a) - rank(b) || b.window.percent - a.window.percent);
  if (sorted.length <= max) return { shown: sorted, more: [] };
  let shown = sorted.slice(0, max);
  const main = sorted.find((l) => l.isDefault);
  if (main && !shown.includes(main)) shown = [...shown.slice(0, max - 1), main];
  return { shown, more: sorted.filter((l) => !shown.includes(l)) };
}

// The state of the block when it is folded: the worst line.
export function worstState(lines: UsageLine[]): LineState {
  return lines.some((l) => l.state === "limit") ? "limit" : lines.some((l) => l.state === "close") ? "close" : "normal";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// When a window comes back: "14:00" today, "Fri 14:00" in the next 6 days, else "12 Dec".
// `short` (the line has little room): the day with no time, "Fri". Empty: not known, or the
// time is in the past (the next read shows the new window).
export function backText(iso: string | null, now: number, short = false): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now) return "";
  const d = new Date(t), n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return time;
  if (t - now < 6 * 86_400_000) return short ? DAYS[d.getDay()] : `${DAYS[d.getDay()]} ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// The right side of a line: the percent, or for a login at its limit when it comes back
// ("until 14:00", "until Fri": the exact time is in the tooltip).
export function lineText(line: UsageLine, now: number): string {
  const back = line.state === "limit" ? backText(line.window.resetsAt, now, true) : "";
  return back ? `until ${back}` : `${line.window.percent}%`;
}

// The tooltip of a line: the full name, then each window with its percent and its reset time.
export function lineTitle(line: UsageLine, now: number): string {
  const rows = line.windows.map((w) => {
    const back = backText(w.resetsAt, now);
    return `${w.label} ${w.percent}%${back ? ` \u00b7 resets ${back}` : ""}`;
  });
  return [line.full, ...rows].filter(Boolean).join("\n");
}

// The tooltip of "+N more": one login per row.
export function moreTitle(more: UsageLine[], now: number): string {
  return more.map((l) => `${l.full ?? l.name} ${lineText(l, now)}`).join("\n");
}
