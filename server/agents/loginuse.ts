// server/agents/loginuse.ts — how much of its plan one Claude login has used, and whether it is
// at its limit now, from the usage that the console reads for its meter (server/usage.ts).
// Pure functions: the callers give the usage and the time.
//
// "At its limit": the 5-hour window or the week window of the whole plan is full. A week
// window of one model alone is not the limit of the login: other models still work. It is
// named apart (`models`), because an agent that uses that model waits.
import type { UsageResult, UsageWindow } from "../usage.js";

export type LoginUse = {
  // Percent of the 5-hour window and of the week window. Null: not known.
  session: number | null;
  week: number | null;
  atLimit: boolean;
  // When the login works again (epoch ms): the last reset of the windows that are full.
  // Null: not at its limit, or the time is not known.
  until: number | null;
  // The models whose own week window is full on this login ("Fable"), with the time each one
  // comes back (null: not known). Empty: each model has room.
  models: { name: string; until: number | null }[];
};

// The windows of one login. With one login on the server the keys have no prefix; with more,
// each key starts with "<id>/" (usage.ts tagAccount). The other runtime's windows have their
// own prefix ("codex:") and are never a Claude login's.
function windowsOf(usage: UsageResult | null, id: string, logins: number): UsageWindow[] {
  if (!usage || !usage.ok) return [];
  if (logins > 1) return usage.windows.filter((w) => w.key.startsWith(`${id}/`)).map((w) => ({ ...w, key: w.key.slice(id.length + 1) }));
  return usage.windows.filter((w) => !w.key.includes("/") && !w.key.startsWith("codex:"));
}

// Null: the console has no usage of this login (not logged in, or the read failed).
export function loginUse(usage: UsageResult | null, id: string, logins: number, nowMs: number): LoginUse | null {
  const mine = windowsOf(usage, id, logins);
  const session = mine.find((w) => w.key === "session") ?? null;
  const week = mine.find((w) => w.key === "weekly:all") ?? null;
  if (!session && !week && !mine.some((w) => w.key.startsWith("weekly:"))) return null;
  const full = [session, week].filter((w): w is UsageWindow => w !== null && w.percent >= 100);
  // A full window whose reset is in the past is old news: the next read shows it empty.
  const open = full.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > nowMs);
  const times = open.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN));
  // The week window of one model: its key is "weekly:<name of the model>" (usage.ts fromLimit).
  const models = mine
    .filter((w) => w.key.startsWith("weekly:") && w.key !== "weekly:all" && w.key !== "weekly:scoped" && w.percent >= 100)
    .filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > nowMs)
    .map((w) => ({ name: w.key.slice("weekly:".length).slice(0, 40), until: w.resetsAt ? Date.parse(w.resetsAt) : null }));
  return {
    session: session?.percent ?? null,
    week: week?.percent ?? null,
    atLimit: open.length > 0,
    until: open.length > 0 && times.every((t) => Number.isFinite(t)) ? Math.max(...times) : null,
    models,
  };
}

// The login for a new agent that names none.
//   id     the login to start on.
//   from   the usual login had no room, so the agent starts on another one (`id`): the usual
//          login and the time it comes back (null: not known).
//   waits  no login has room: the agent must not start now (its session would stop at once).
//          `until`: when the first login comes back (null: not known).
export type LoginPick = { id: string; from?: { id: string; until: number | null }; waits?: { until: number | null } };

// A login has no room when its plan is at its limit, or when one model of it has no room: the
// console does not know which model an agent will use.
const full = (u: LoginUse): boolean => u.atLimit || u.models.length > 0;
const room = (u: LoginUse): number => 100 - (u.session ?? 0);
// The same two rules for the usage-limit ticket (chief/limit/service.ts): a login has room, and
// how much of its 5-hour window is left.
export const hasRoom = (u: LoginUse): boolean => !full(u);
export const roomLeft = room;
// When a login with no room has room again.
export function backAt(u: LoginUse): number | null {
  if (u.atLimit) return u.until;
  const times = u.models.map((m) => m.until);
  return times.length > 0 && times.every((t): t is number => t !== null) ? Math.min(...times) : null;
}

// `first`: the usual login (the default one). `others`: the other logins that are logged in.
//   1. The usual login has room, or nothing is known about it: the usual login, as before.
//   2. Else the other login with the most room.
//   3. Else, when only a model of the usual login has no room: the usual login (its other models work).
//   4. Else another login that is not at its limit (only a model of it has no room), or one
//      whose use is not known.
//   5. Else each login is at its limit: wait.
export function pickLogin(first: string, others: string[], use: (id: string) => LoginUse | null): LoginPick {
  const u = use(first);
  if (!u || !full(u)) return { id: first };
  const from = { id: first, until: backAt(u) };
  const rest = others.map((id) => ({ id, u: use(id) }));
  const known = rest.filter((o): o is { id: string; u: LoginUse } => o.u !== null);
  const best = (list: { id: string; u: LoginUse }[]) => [...list].sort((a, b) => room(b.u) - room(a.u))[0];
  const free = known.filter((o) => !full(o.u));
  if (free.length) return { id: best(free).id, from };
  if (!u.atLimit) return { id: first };
  const partly = known.filter((o) => !o.u.atLimit);
  if (partly.length) return { id: best(partly).id, from };
  const unknown = rest.find((o) => o.u === null);
  if (unknown) return { id: unknown.id, from };
  const times = [u, ...known.map((o) => o.u)].map((x) => x.until);
  return { id: first, waits: { until: times.every((t): t is number => t !== null) ? Math.min(...times) : null } };
}
