import { describe, expect, it, vi } from "vitest";
import { accountsStatus, actionError, areaNameError, areaNameFrom, AREA_RE, newLeadStart, leadsStatus, leadWord, reposStatus, sameRepos, toggleRepo } from "./settings";
import { AREA_RE as SERVER_AREA_RE } from "../../server/chief/leads/areas";
import { daysAgo, githubStatusLine, rateLine, targetIds, targetState, targetWhere, telegramStatus, usedFrom, type TelegramView } from "./settings";
import { telegramConfig } from "../../server/settings/telegram";

const lead = (area: string, status: string | null, repos = ["app"]) => ({ area, repos, leadId: `lead-${area}`, status, reportAt: null });
const acct = (id: string, over: Partial<{ loggedIn: boolean; isDefault: boolean; email: string | null; signedOut: boolean }> = {}) =>
  ({ id, label: id, email: null, loggedIn: true, isDefault: id === "default", ...over });

describe("leadsStatus", () => {
  it("is checking before the first read", () => {
    expect(leadsStatus(null).tone).toBe("load");
  });
  it("says leads are off when the chief is off (the route is missing), in plain words", () => {
    expect(leadsStatus({ off: true })).toEqual({ tone: "off", text: "Not set up: leads are off on this console" });
  });
  it("is not set up with no areas", () => {
    expect(leadsStatus({ rows: [] })).toEqual({ tone: "off", text: "No leads yet" });
  });
  it("counts the leads and the live ones", () => {
    expect(leadsStatus({ rows: [lead("app", "running"), lead("web", "idle"), lead("ops", "done")] }))
      .toEqual({ tone: "ok", text: "3 leads · 2 live" });
  });
  it("warns on a lead that stopped with an error, naming it", () => {
    expect(leadsStatus({ rows: [lead("app", "error"), lead("web", "idle")] })).toEqual({ tone: "warn", text: "Lead app stopped with an error" });
  });
  it("warns on an area with no repos (its lead spawns nothing)", () => {
    expect(leadsStatus({ rows: [lead("app", "idle", [])] }).tone).toBe("warn");
  });
  it("says a read failed", () => {
    expect(leadsStatus({ error: "x" }).tone).toBe("err");
  });
});

describe("leadWord", () => {
  it("has a word for each lead state and for no record", () => {
    expect(["running", "idle", "done", "error", null].map((x) => leadWord(x))).toEqual(["Working", "Waiting", "Stopped", "Error", "Not started"]);
  });
  it("a lead that waits for the second sign-in: that, whatever its status (never Stopped or Error)", () => {
    for (const x of ["idle", "done", "error", null]) expect(leadWord(x, true)).toBe("Waits for its sign-in");
  });
});

describe("accountsStatus", () => {
  it("is connected with the logins counted", () => {
    expect(accountsStatus({ rows: [acct("default")] }, "default")).toEqual({ tone: "ok", text: "Connected · 1 login" });
  });
  it("warns on a login that is not logged in yet", () => {
    expect(accountsStatus({ rows: [acct("default"), acct("work", { loggedIn: false })] }, "default").text).toContain("1 not logged in yet");
    expect(accountsStatus({ rows: [acct("default", { loggedIn: false }), acct("work")] }, "default").text).toContain("1 not logged in yet");
  });
  it("a login that Claude signed out is “signed out”, not “not logged in yet”", () => {
    const rows = [acct("default", { loggedIn: false, signedOut: true }), acct("work"), acct("new", { loggedIn: false })];
    expect(accountsStatus({ rows }, "work")).toEqual({ tone: "warn", text: "Connected · 3 logins · 1 signed out · 1 not logged in yet" });
    expect(accountsStatus({ rows: rows.slice(0, 2) }, "work")).toEqual({ tone: "warn", text: "Connected · 2 logins · 1 signed out" });
  });
  it("says so when no login is logged in: the login is on this page", () => {
    expect(accountsStatus({ rows: [acct("default", { loggedIn: false })] }, "default")).toEqual({ tone: "warn", text: "Not logged in to Claude. Press Log in." });
  });
  it("warns when the default login does not exist", () => {
    expect(accountsStatus({ rows: [acct("default")] }, "gone")).toEqual({ tone: "warn", text: 'The default login "gone" does not exist' });
  });
});

describe("reposStatus", () => {
  it("counts the repos, and is not set up with none", () => {
    expect(reposStatus({ rows: [{ name: "a", path: "/w/a", branch: "main" }] })).toEqual({ tone: "ok", text: "1 repo in the workspace" });
    expect(reposStatus({ rows: [] }).tone).toBe("off");
  });
});

describe("the New lead form is filled in", () => {
  it("makes a valid area name from a repo name, and not one that is taken", () => {
    expect(areaNameFrom("hello", [])).toBe("hello");
    expect(areaNameFrom("My_Shop.Web", [])).toBe("my-shop-web");
    expect(areaNameFrom("hello", ["hello", "hello-2"])).toBe("hello-3");
    expect(areaNameFrom("...", [])).toBe("");
    const long = areaNameFrom("a".repeat(40), ["a".repeat(32)]);
    expect(long).toBe(`${"a".repeat(30)}-2`);
    for (const n of ["hello", "My_Shop.Web", "x".repeat(50), "-lead-"]) expect(areaNameError(areaNameFrom(n, []), []), n).toBeNull();
  });

  it("starts with the first repo that no lead has, and the name from it", () => {
    expect(newLeadStart(["hello", "shop"], [])).toEqual({ name: "hello", repos: ["hello"] });
    expect(newLeadStart(["hello", "shop"], [{ area: "hello", repos: ["hello"] }])).toEqual({ name: "shop", repos: ["shop"] });
    // The name is free also when a lead has it for another repo.
    expect(newLeadStart(["hello", "shop"], [{ area: "shop", repos: ["hello"] }])).toEqual({ name: "shop-2", repos: ["shop"] });
    // Each repo has a lead, or there is no repo: an empty form.
    expect(newLeadStart(["hello"], [{ area: "app", repos: ["hello"] }])).toEqual({ name: "", repos: [] });
    expect(newLeadStart([], [])).toEqual({ name: "", repos: [] });
  });
});

describe("areaNameError", () => {
  it("keeps the server's area rule", () => {
    expect(AREA_RE.source).toBe(SERVER_AREA_RE.source);
  });
  it("refuses an empty, a bad and a taken name", () => {
    expect(areaNameError("", [])).toMatch(/Type a name/);
    expect(areaNameError("App", [])).toMatch(/lowercase/);
    expect(areaNameError("-x", [])).toMatch(/lowercase/);
    expect(areaNameError("a".repeat(33), [])).toMatch(/lowercase/);
    expect(areaNameError("app", ["app"])).toMatch(/exists/);
    expect(areaNameError("app-2", ["app"])).toBeNull();
  });
});

describe("toggleRepo", () => {
  const all = ["a", "b", "c"];
  it("adds in the workspace order and removes", () => {
    expect(toggleRepo([], "c", all)).toEqual(["c"]);
    expect(toggleRepo(["c"], "a", all)).toEqual(["a", "c"]);
    expect(toggleRepo(["a", "c"], "a", all)).toEqual(["c"]);
  });
  it("keeps a repo the workspace does not have, at the end", () => {
    expect(toggleRepo(["gone", "b"], "a", all)).toEqual(["a", "b", "gone"]);
  });
  it("sameRepos ignores the order", () => {
    expect(sameRepos(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameRepos(["a"], ["a", "b"])).toBe(false);
  });
});

describe("actionError", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it("gives the pairing sentence for a pair-required refusal", async () => {
    expect(await actionError(res(403, { error: "pair-required", userAuth: "log" }), "Starting a lead"))
      .toBe("Starting a lead needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server");
  });
  it("gives the server's error text, else the status", async () => {
    expect(await actionError(res(400, { error: "invalid body" }), "x")).toBe("invalid body");
    expect(await actionError(new Response("nope", { status: 500 }), "x")).toBe("failed (500)");
  });
  it("is used by saveLead (a fetch that throws is 'did not answer')", async () => {
    const { saveLead } = await import("./settings");
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down"));
    expect(await saveLead("app", ["a"])).toEqual({ ok: false, error: "The console did not answer" });
    spy.mockRestore();
  });
});


const tgView = (env: Record<string, string>, bot: TelegramView["bot"] = { ok: true, username: "hb", name: "H" }): TelegramView => ({
  ...telegramConfig(env, { active: true, problem: null }), bot, chief: "on", chiefProblem: null, userAuth: "log", devices: 1, canTest: true,
});
const FULL_TG = {
  TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ISSUES_USER_ID: "1", TELEGRAM_MASTER_CHAT_ID: "-100", TELEGRAM_MASTER_THREAD_ID: "2", TELEGRAM_CHAT_ID: "-5",
};

describe("telegramStatus", () => {
  it("no token: not connected, in plain words", () => {
    expect(telegramStatus({ rows: [tgView({}, null)] })).toEqual({ tone: "off", text: "Not connected: the console has no bot yet" });
  });
  it("says a token that getMe refuses does not work", () => {
    expect(telegramStatus({ rows: [tgView(FULL_TG, { ok: false, error: "Unauthorized" })] })).toEqual({ tone: "err", text: "The bot token does not work: Unauthorized" });
  });
  it("is connected as the bot, and names the targets that are not set up", () => {
    expect(telegramStatus({ rows: [tgView(FULL_TG)] })).toEqual({ tone: "ok", text: "Connected as @hb" });
    const { TELEGRAM_CHAT_ID: _c, ...noChat } = FULL_TG;
    expect(telegramStatus({ rows: [tgView(noChat)] })).toEqual({ tone: "warn", text: "Connected as @hb · Recurring results, Agent notifications not set up" });
  });
  it("says what a target needs in plain words, never a key name", () => {
    const { TELEGRAM_CHAT_ID: _c, ...noChat } = FULL_TG;
    const v = tgView(noChat);
    const by = Object.fromEntries(v.targets.map((t) => [t.id, targetState(t)]));
    expect(by.master).toEqual({ word: "Ready", tone: "ok", needs: null });
    expect(by.notify).toEqual({ word: "Not set up", tone: "warn", needs: "Needs a chat to post in." });
    expect(by.cron.needs).toBe("Needs a group and topic of its own, or the agent notifications chat.");
    const none = tgView({}, null);
    expect(none.targets.map((t) => targetState(t).needs)).toEqual(Array(4).fill("Needs the bot first."));
    const m = tgView({ TELEGRAM_BOT_TOKEN: "x" }).targets[0];
    expect(targetState(m).needs).toBe("Needs your Telegram account, a group and a topic.");
    for (const t of [...v.targets, ...none.targets]) expect(JSON.stringify(targetState(t))).not.toMatch(/TELEGRAM_|CHIEF_/);
  });
  it("targetWhere names the target it shares; the ids are only in the fold (targetIds)", () => {
    const v = tgView(FULL_TG);
    expect(targetWhere(v, v.targets[0])).toBe("");
    expect(targetWhere(v, v.targets[1])).toBe("In the fleet master chat");
    expect(targetIds(v.targets[0])).toBe("chat -100 · topic 2");
  });
});

describe("githubStatusLine", () => {
  const base = { rate: { limit: 5000, remaining: 4000, reset: 0 }, repos: [], checkedAt: 1 };
  it("not logged in is not set up; another error is an error", () => {
    expect(githubStatusLine({ rows: [{ ...base, login: null, error: "gh is not logged in" }] }).tone).toBe("off");
    expect(githubStatusLine({ rows: [{ ...base, login: null, error: "gh is not installed on your server" }] })).toEqual({ tone: "err", text: "gh is not installed on your server" });
  });
  it("warns on a repo it cannot read and on a low rate", () => {
    expect(githubStatusLine({ rows: [{ ...base, login: "o", repos: [{ name: "a", slug: "o/a", read: false, push: null }] }] }).text).toBe("Connected as o · cannot read 1 repo");
    expect(githubStatusLine({ rows: [{ ...base, login: "o", rate: { limit: 5000, remaining: 10, reset: 0 } }] }).tone).toBe("warn");
    expect(githubStatusLine({ rows: [{ ...base, login: "o" }] })).toEqual({ tone: "ok", text: "Connected as o" });
  });
  it("with the ChoiBot app: its key decides, never another login", () => {
    const app = (key: object): { app: { key: never } } => ({ app: { key: key as never } });
    expect(githubStatusLine({ rows: [{ ...base, login: null, error: "ChoiBot is not connected", ...app({ state: "none" }) }] }))
      .toEqual({ tone: "off", text: "Not connected: ChoiBot is not connected" });
    expect(githubStatusLine({ rows: [{ ...base, login: null, ...app({ state: "signed-out", why: "refused" }) }] }))
      .toEqual({ tone: "err", text: "GitHub no longer takes the key of your server. Connect again." });
    expect(githubStatusLine({ rows: [{ ...base, login: null, ...app({ state: "signed-out", why: "ended" }) }] }).text).toMatch(/ran out/);
    expect(githubStatusLine({ rows: [{ ...base, login: "o", ...app({ state: "ok", accessLeftMs: 1, refreshLeftMs: 1, unsaved: true }) }] }).tone).toBe("warn");
    expect(githubStatusLine({ rows: [{ ...base, login: "o", ...app({ state: "ok", accessLeftMs: 1, refreshLeftMs: 1 }) }] }))
      .toEqual({ tone: "ok", text: "Connected as o" });
  });
  it("names where a used repo was seen, and how long ago", () => {
    expect(usedFrom(["agents", "recurring", "tickets"])).toBe("agents · a Recurring task · tickets");
    expect([daysAgo(3_600_000), daysAgo(86_400_000), daysAgo(5 * 86_400_000)]).toEqual(["today", "yesterday", "5 days ago"]);
  });
  it("rateLine", () => {
    expect(rateLine(null)).toBe("Unknown");
    expect(rateLine({ limit: 5000, remaining: 4900, reset: 0 })).toBe("4,900 of 5,000 left");
  });
});

describe("the Claude accounts status with the second sign-in", () => {
  it("does not ask for the second sign-in until an agent waits for it", async () => {
    const { accountsStatus } = await import("./settings");
    const first = { id: "default", label: "a", email: "a@example.invalid", loggedIn: true, isDefault: true };
    const second = { id: "persistent", label: "persistent", email: null, loggedIn: false, isDefault: false, persistent: true as const };
    expect(accountsStatus({ rows: [first, { ...second, waits: [] }] }, "default")).toEqual({ tone: "ok", text: "Connected · 2 logins" });
    expect(accountsStatus({ rows: [first, { ...second, waits: ["fleet-master"] }] }, "default")).toEqual({ tone: "warn", text: "Connected · 2 logins · 1 not logged in yet" });
  });
});
