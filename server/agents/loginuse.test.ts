import { describe, expect, it } from "vitest";
import type { UsageResult, UsageWindow } from "../usage.js";
import { loginUse, pickLogin } from "./loginuse.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const win = (key: string, percent: number, resetsAt: string | null = at(2)): UsageWindow =>
  ({ key, label: key, group: key.includes("weekly") ? "weekly" : "session", percent, severity: "normal", resetsAt, active: true });
const usage = (...windows: UsageWindow[]): UsageResult => ({ ok: true, windows });

describe("loginUse", () => {
  it("one login on the server: the windows have no prefix", () => {
    expect(loginUse(usage(win("session", 42), win("weekly:all", 10, at(50)), win("weekly:opus", 100)), "default", 1, NOW))
      .toEqual({ session: 42, week: 10, atLimit: false, until: null, models: [{ name: "opus", until: NOW + 2 * 3_600_000 }] });
  });

  it("more logins: each one reads only its own windows", () => {
    const u = usage(win("default/session", 100, at(3)), win("default/weekly:all", 20, at(50)), win("login-2/session", 5), win("login-2/weekly:all", 7));
    expect(loginUse(u, "default", 2, NOW)).toEqual({ session: 100, week: 20, atLimit: true, until: NOW + 3 * 3_600_000, models: [] });
    expect(loginUse(u, "login-2", 2, NOW)).toEqual({ session: 5, week: 7, atLimit: false, until: null, models: [] });
    expect(loginUse(u, "login-3", 2, NOW)).toBeNull();
  });

  it("the 5-hour window and the week window both full: the login works again after the last reset", () => {
    expect(loginUse(usage(win("session", 100, at(1)), win("weekly:all", 100, at(30))), "default", 1, NOW)?.until).toBe(NOW + 30 * 3_600_000);
  });

  it("a week window of one model alone is not the limit of the login: the model is named apart", () => {
    const u = loginUse(usage(win("session", 30), win("weekly:all", 60), win("weekly:Fable", 100, at(50)), win("weekly:Opus", 80)), "default", 1, NOW);
    expect(u).toMatchObject({ atLimit: false, until: null, models: [{ name: "Fable", until: NOW + 50 * 3_600_000 }] });
    // With more logins, each one names only its own models.
    const two = usage(win("default/session", 10), win("default/weekly:Fable", 100, null), win("work/session", 10), win("work/weekly:Fable", 40));
    expect(loginUse(two, "default", 2, NOW)?.models).toEqual([{ name: "Fable", until: null }]);
    expect(loginUse(two, "work", 2, NOW)?.models).toEqual([]);
    // A full model window whose reset is in the past is old news. A window with no model name is not named.
    expect(loginUse(usage(win("session", 1), win("weekly:Fable", 100, at(-1)), win("weekly:scoped", 100)), "default", 1, NOW)?.models).toEqual([]);
  });

  it("a full window with no reset time: at its limit, the time is not known", () => {
    expect(loginUse(usage(win("session", 100, null)), "default", 1, NOW)).toMatchObject({ atLimit: true, until: null });
  });

  it("a full window whose reset is in the past is old news", () => {
    expect(loginUse(usage(win("session", 100, at(-1))), "default", 1, NOW)?.atLimit).toBe(false);
  });

  it("no usage, a failed read, or only the windows of the other runtime: not known", () => {
    expect(loginUse(null, "default", 1, NOW)).toBeNull();
    expect(loginUse({ ok: false, reason: "http_429" }, "default", 1, NOW)).toBeNull();
    expect(loginUse(usage(win("codex:session", 100)), "default", 1, NOW)).toBeNull();
  });
});

describe("pickLogin: the login of a new agent that names none", () => {
  const H = 3_600_000;
  const u = (o: { session?: number; atLimit?: boolean; until?: number | null; models?: string[] } = {}) =>
    ({ session: o.session ?? 10, week: 0, atLimit: o.atLimit === true, until: o.until ?? null, models: (o.models ?? []).map((name) => ({ name, until: NOW + 50 * H })) });
  const use = (map: Record<string, ReturnType<typeof u> | null>) => (id: string) => map[id] ?? null;

  it("keeps the usual login when it has room, or when nothing is known", () => {
    expect(pickLogin("default", ["b"], use({ default: u(), b: u() }))).toEqual({ id: "default" });
    expect(pickLogin("default", ["b"], use({ default: null, b: u() }))).toEqual({ id: "default" });
  });

  it("the usual login is at its limit: the other login with the most room, and the reason", () => {
    const map = { default: u({ atLimit: true, until: NOW + 2 * H }), a: u({ session: 80 }), b: u({ session: 20 }), c: u({ atLimit: true }) };
    expect(pickLogin("default", ["a", "b", "c"], use(map))).toEqual({ id: "b", from: { id: "default", until: NOW + 2 * H } });
  });

  it("a model of the usual login has no room (the week window of Fable): the same, with the time that model comes back", () => {
    const map = { default: u({ models: ["Fable"] }), b: u({ session: 30 }) };
    expect(pickLogin("default", ["b"], use(map))).toEqual({ id: "b", from: { id: "default", until: NOW + 50 * H } });
    // No other login has full room: the usual login stays (its other models work).
    expect(pickLogin("default", ["b"], use({ default: u({ models: ["Fable"] }), b: u({ models: ["Fable"] }) }))).toEqual({ id: "default" });
    expect(pickLogin("default", [], use({ default: u({ models: ["Fable"] }) }))).toEqual({ id: "default" });
  });

  it("the usual login is at its limit and no other has full room: one that is not at its limit, else one whose use is not known", () => {
    const lim = u({ atLimit: true, until: NOW + H });
    expect(pickLogin("default", ["a", "b"], use({ default: lim, a: u({ atLimit: true }), b: u({ models: ["Opus"] }) })).id).toBe("b");
    expect(pickLogin("default", ["a", "b"], use({ default: lim, a: u({ atLimit: true }), b: null }))).toEqual({ id: "b", from: { id: "default", until: NOW + H } });
  });

  it("each login is at its limit: the agent waits, until the first one comes back", () => {
    const map = { default: u({ atLimit: true, until: NOW + 5 * H }), b: u({ atLimit: true, until: NOW + 2 * H }) };
    expect(pickLogin("default", ["b"], use(map))).toEqual({ id: "default", waits: { until: NOW + 2 * H } });
    expect(pickLogin("default", [], use({ default: u({ atLimit: true, until: NOW + 5 * H }) }))).toEqual({ id: "default", waits: { until: NOW + 5 * H } });
    // A time that is not known: the wait has no time.
    expect(pickLogin("default", ["b"], use({ default: u({ atLimit: true }), b: u({ atLimit: true, until: NOW + H }) }))).toEqual({ id: "default", waits: { until: null } });
  });
});
