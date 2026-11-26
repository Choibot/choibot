import { describe, it, expect } from "vitest";
import {
  backText, groupByAccount, limitingWindow, lineState, lineText, lineTitle, moreTitle, pickLines, primaryWindow, shortName, usageLines, worstState,
  type UsageLine, type UsageWindow,
} from "./usage";

const w = (key: string, account?: string): UsageWindow =>
  ({ key, label: key, group: "session", percent: 1, severity: "normal", resetsAt: null, active: false, account });

describe("groupByAccount", () => {
  it("keeps a single untitled bucket when no window carries an account", () => {
    expect(groupByAccount([w("session"), w("weekly:all")])).toEqual([
      { account: null, windows: [w("session"), w("weekly:all")] },
    ]);
  });
  it("buckets consecutive windows by login, in server order, and parks untagged ChatGPT windows in their own bucket", () => {
    const list = [w("default/session", "a@x.io"), w("default/weekly:all", "a@x.io"), w("work/session", "work"), w("chatgpt:week")];
    expect(groupByAccount(list).map((g) => [g.account, g.windows.length])).toEqual([
      ["a@x.io", 2], ["work", 1], [null, 1],
    ]);
  });
});

const win = (key: string, label: string, group: UsageWindow["group"]): UsageWindow =>
  ({ key, label, group, percent: 1, severity: "normal", resetsAt: null, active: false });

describe("primaryWindow", () => {
  it("prefers the Fable cap, then the all-models week, then the first window", () => {
    const s = win("session", "Session", "session"), wk = win("weekly:all", "Week", "weekly"), f = win("weekly:fable", "Fable week", "weekly");
    expect(primaryWindow([s, wk, f])).toBe(f);
    expect(primaryWindow([s, wk])).toBe(wk);
    expect(primaryWindow([s])).toBe(s);
    expect(primaryWindow([])).toBeUndefined();
  });
});

// ---- the sidebar footer: one line per login ----

// Local times, so the tests give the same text in each time zone.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(2026, 11, 20, 10, 0); // a Friday

const uw = (key: string, percent: number, more: Partial<UsageWindow> = {}): UsageWindow => ({
  key, label: key, group: key.includes("session") ? "session" : "weekly", percent,
  severity: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal", resetsAt: null, active: false, ...more,
});
// The windows of one named login, as the server tags them: "<id>/<key>" and the address.
const login = (id: string, address: string, session: number, week: number, more: UsageWindow[] = []): UsageWindow[] => [
  uw(`${id}/session`, session, { label: "Session", account: address }),
  uw(`${id}/weekly:all`, week, { label: "Week", account: address }),
  ...more.map((w) => ({ ...w, key: `${id}/${w.key}`, account: address })),
];

describe("limitingWindow: the window on the bar", () => {
  it("is the fullest window of the login", () => {
    const s = uw("session", 51), wk = uw("weekly:all", 14);
    expect(limitingWindow([s, wk])).toBe(s);
    expect(limitingWindow([uw("session", 3), wk])).toBe(wk);
  });
  it("counts the week window of one model", () => {
    const f = uw("weekly:Fable", 100, { label: "Week \u00b7 Fable" });
    expect(limitingWindow([uw("session", 40), uw("weekly:all", 60), f])).toBe(f);
  });
  it("of two windows equally full, takes the one that comes back last", () => {
    const s = uw("session", 100, { resetsAt: iso(at(2026, 11, 20, 14)) }), wk = uw("weekly:all", 100, { resetsAt: iso(at(2026, 11, 23, 9)) });
    expect(limitingWindow([s, wk])).toBe(wk);
    expect(limitingWindow([wk, s])).toBe(wk);
    // A known time wins over no time: the line can then say when the login comes back.
    expect(limitingWindow([uw("weekly:all", 100), s])).toBe(s);
  });
  it("has no window for a login with none", () => {
    expect(limitingWindow([])).toBeUndefined();
  });
});

describe("lineState", () => {
  it("is the limit at 100%, close with the severity of the server, else normal", () => {
    expect(lineState(uw("session", 100))).toBe("limit");
    expect(lineState(uw("session", 95))).toBe("close");
    expect(lineState(uw("session", 80))).toBe("close");
    expect(lineState(uw("session", 50, { severity: "warning" }))).toBe("close");
    expect(lineState(uw("session", 74))).toBe("normal");
  });
});

describe("shortName", () => {
  it("is the part of the address before the @", () => {
    expect(shortName("ada@example.com")).toBe("ada");
    expect(shortName("team@example.org")).toBe("team");
  });
  it("cuts a long name with an ellipsis", () => {
    expect(shortName("a.very.long.name@example.com")).toBe("a.very.long\u2026");
    expect(shortName("a.very.long.name@example.com")).toHaveLength(12);
    expect(shortName("twelve.chars@example.com")).toBe("twelve.chars");
  });
  it("keeps the id of a login with no address", () => {
    expect(shortName("login-2")).toBe("login-2");
    expect(shortName("@odd")).toBe("@odd");
  });
});

describe("usageLines", () => {
  it("gives one line per login, with the id of the login, its short name and its fullest window", () => {
    const list = [...login("default", "ada@example.com", 51, 14), ...login("login-2", "team@example.org", 3, 0)];
    const { logins, codex } = usageLines(list);
    expect(logins.map((l) => [l.id, l.name, l.full, l.window.label, l.window.percent, l.isDefault])).toEqual([
      ["default", "ada", "ada@example.com", "Session", 51, true],
      ["login-2", "team", "team@example.org", "Session", 3, false],
    ]);
    expect(logins[0].windows).toHaveLength(2);
    expect(codex).toBeNull();
  });
  it("marks the login that new agents start on", () => {
    const list = [...login("default", "ada@example.com", 1, 1), ...login("login-2", "team@example.org", 1, 1)];
    expect(usageLines(list, "login-2").logins.map((l) => l.isDefault)).toEqual([false, true]);
  });
  it("with one login, names the window (the server names no login)", () => {
    const { logins } = usageLines([uw("session", 20, { label: "Session" }), uw("weekly:Fable", 64, { label: "Week \u00b7 Fable" })]);
    expect(logins.map((l) => [l.id, l.name, l.full, l.isDefault])).toEqual([["_", "Week \u00b7 Fable", null, true]]);
  });
  it("shows the address of two logins with the same short name", () => {
    const list = [...login("default", "ada@example.com", 1, 1), ...login("login-2", "ada@example.org", 1, 1), ...login("login-3", "ops@example.net", 1, 1)];
    expect(usageLines(list).logins.map((l) => l.name)).toEqual(["ada@example.com", "ada@example.org", "ops"]);
  });
  it("has a line for Codex only when Codex is in use", () => {
    const claude = [uw("session", 20, { label: "Session" })];
    expect(usageLines([...claude, uw("codex:weekly", 0, { label: "Codex \u00b7 30d" })]).codex).toBeNull();
    const used = usageLines([...claude, uw("codex:session", 4, { label: "Codex \u00b7 5h" }), uw("codex:weekly", 37, { label: "Codex \u00b7 7d" })]);
    expect(used.logins).toHaveLength(1);
    expect(used.codex && [used.codex.id, used.codex.name, used.codex.window.percent, used.codex.windows.length]).toEqual(["codex", "Codex", 37, 2]);
    // Codex only: no line of a Claude login.
    expect(usageLines([uw("codex:weekly", 5)]).logins).toEqual([]);
  });
});

describe("pickLines: the order and \"+N more\"", () => {
  const lines = (...use: [string, number, number][]): UsageLine[] =>
    usageLines(use.flatMap(([id, session, week]) => login(id, `${id}@example.com`, session, week))).logins;
  const ids = (l: UsageLine[]) => l.map((x) => x.id);

  it("puts a login at its limit first, then the fullest", () => {
    const { shown, more } = pickLines(lines(["default", 51, 14], ["b", 3, 0], ["c", 20, 100]));
    expect(ids(shown)).toEqual(["c", "default", "b"]);
    expect(more).toEqual([]);
  });
  it("shows each login up to 3, with no \"more\" line", () => {
    expect(pickLines(lines(["default", 5, 5])).shown).toHaveLength(1);
    expect(pickLines(lines(["default", 5, 5], ["b", 9, 1], ["c", 2, 2])).more).toEqual([]);
  });
  it("shows 3 lines of 6 logins and counts the others", () => {
    const { shown, more } = pickLines(lines(["default", 60, 10], ["b", 100, 5], ["c", 10, 82], ["d", 1, 0], ["e", 30, 2], ["f", 0, 12]));
    expect(ids(shown)).toEqual(["b", "c", "default"]);
    expect(ids(more)).toEqual(["e", "f", "d"]);
  });
  it("always shows the login that new agents start on: it takes the last line", () => {
    const { shown, more } = pickLines(lines(["default", 1, 0], ["b", 100, 5], ["c", 10, 82], ["d", 70, 0], ["e", 30, 2]));
    expect(ids(shown)).toEqual(["b", "c", "default"]);
    expect(ids(more)).toEqual(["d", "e"]);
  });
  it("keeps the order of the server for logins equally full", () => {
    expect(ids(pickLines(lines(["default", 0, 0], ["b", 0, 0], ["c", 0, 0])).shown)).toEqual(["default", "b", "c"]);
  });
});

describe("worstState", () => {
  it("is the worst line: the limit, then close, then normal", () => {
    const of = (...p: number[]) => worstState(usageLines(p.flatMap((v, i) => login(`l${i}`, `l${i}@example.com`, v, 0))).logins);
    expect(of(10, 20)).toBe("normal");
    expect(of(10, 80)).toBe("close");
    expect(of(100, 80)).toBe("limit");
    expect(worstState([])).toBe("normal");
  });
});

describe("backText: when a window comes back", () => {
  it("is the time today, the day and the time this week, else the date", () => {
    expect(backText(iso(at(2026, 11, 20, 14, 0)), NOW)).toBe("14:00");
    expect(backText(iso(at(2026, 11, 23, 9, 5)), NOW)).toBe("Mon 09:05");
    expect(backText(iso(at(2026, 12, 12, 9, 0)), NOW)).toBe("12 Dec");
  });
  it("in its short form, gives the day with no time", () => {
    expect(backText(iso(at(2026, 11, 20, 14, 0)), NOW, true)).toBe("14:00");
    expect(backText(iso(at(2026, 11, 23, 9, 5)), NOW, true)).toBe("Mon");
    expect(backText(iso(at(2026, 12, 12, 9, 0)), NOW, true)).toBe("12 Dec");
  });
  it("is empty when the time is not known or is in the past", () => {
    expect(backText(null, NOW)).toBe("");
    expect(backText("no date", NOW)).toBe("");
    expect(backText(iso(at(2026, 11, 20, 9, 0)), NOW)).toBe("");
  });
});

describe("lineText and lineTitle", () => {
  const fable = uw("weekly:Fable", 100, { label: "Week \u00b7 Fable", resetsAt: iso(at(2026, 11, 23, 9, 0)) });
  it("says the percent of a login with room", () => {
    const [l] = usageLines(login("default", "ada@example.com", 51, 14)).logins;
    expect(lineText(l, NOW)).toBe("51%");
  });
  it("says when a login at its limit comes back, in place of the percent", () => {
    const [l] = usageLines(login("default", "ada@example.com", 3, 0, [fable])).logins;
    expect(l.state).toBe("limit");
    expect(lineText(l, NOW)).toBe("until Mon");
    expect(lineTitle(l, NOW)).toContain("Week \u00b7 Fable 100% \u00b7 resets Mon 09:00");
    const today = usageLines(login("default", "ada@example.com", 100, 0).map((w) => ({ ...w, resetsAt: iso(at(2026, 11, 20, 14, 0)) }))).logins[0];
    expect(lineText(today, NOW)).toBe("until 14:00");
  });
  it("says 100% when the console does not know the time", () => {
    const [l] = usageLines(login("default", "ada@example.com", 100, 0)).logins;
    expect(lineText(l, NOW)).toBe("100%");
  });
  it("names the address and each window in the tooltip", () => {
    const list = login("default", "ada@example.com", 51, 14, [fable]);
    list[0] = { ...list[0], resetsAt: iso(at(2026, 11, 20, 14, 0)) };
    const [l] = usageLines(list).logins;
    expect(lineTitle(l, NOW)).toBe("ada@example.com\nSession 51% \u00b7 resets 14:00\nWeek 14%\nWeek \u00b7 Fable 100% \u00b7 resets Mon 09:00");
  });
  it("has no name row for a console with one login", () => {
    const [l] = usageLines([uw("session", 20, { label: "Session" })]).logins;
    expect(lineTitle(l, NOW)).toBe("Session 20%");
  });
  it("lists the logins behind \"+N more\"", () => {
    const { logins } = usageLines([...login("default", "ada@example.com", 51, 14), ...login("b", "team@example.org", 3, 0)]);
    expect(moreTitle(logins, NOW)).toBe("ada@example.com 51%\nteam@example.org 3%");
  });
});
