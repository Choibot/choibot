// src/lib/accounts.test.ts — the page's side of the Claude login: the calls and the plain words.
import { describe, expect, it, vi } from "vitest";
import {
  claudeLoginDone, claudeLoginProblem, clockText, fetchClaudeLogin, freeLoginName, limitLine, limitTag, limitText, limitWord, loginMeta, loginToMoveTo, makeDefaultLogin, modelsText, moveAllAgents, moveChoices,
  moveFacts, movedText, sendClaudeLoginCode, signedOutText, signOutFacts, signOutLogin, signOutNote, startClaudeLogin, useText,
  type AccountInfo, type ClaudeLoginReason,
} from "./accounts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("the calls of the Claude login", () => {
  it("start names the account in the address and can ask for a new link", async () => {
    const f = vi.fn(async () => json(200, { state: "waiting", account: "login-2", url: "https://claude.com/x", leftMs: 900_000 }));
    expect((await startClaudeLogin("login-2", true, f as never)).state).toBe("waiting");
    expect(f).toHaveBeenCalledWith("/api/accounts/login-2/login", expect.objectContaining({ method: "POST", body: JSON.stringify({ fresh: true }) }));
  });

  it("the code goes in the body of one call, and the state comes back", async () => {
    const f = vi.fn(async () => json(200, { state: "checking", account: "default" }));
    expect(await sendClaudeLoginCode("abc-123#x", f as never)).toEqual({ state: "checking", account: "default" });
    expect(f).toHaveBeenCalledWith("/api/accounts/login/code", expect.objectContaining({ body: JSON.stringify({ code: "abc-123#x" }) }));
  });

  it("gives the plain line of the server for a refusal, and one line when there is no answer", async () => {
    await expect(sendClaudeLoginCode("x", (async () => json(409, { error: "This sign-in link is not open any more. Press New link." })) as never))
      .rejects.toThrow("This sign-in link is not open any more. Press New link.");
    await expect(fetchClaudeLogin((async () => { throw new Error("net"); }) as never)).rejects.toThrow("The console did not answer. Try again.");
    await expect(fetchClaudeLogin((async () => json(500, { error: "boom" })) as never)).rejects.toThrow("The console did not answer. Try again.");
  });

  it("a device that is not paired gets the pairing sentence", async () => {
    await expect(startClaudeLogin("default", false, (async () => json(403, { error: "pair-required", userAuth: "log" })) as never))
      .rejects.toThrow(/A Claude login needs a paired device/);
  });
});

describe("the words of the Claude login", () => {
  it("each reason says what to press, and none sends the user to a terminal for the login", () => {
    const reasons: ClaudeLoginReason[] = ["wrong-code", "expired", "no-answer", "not-saved", "failed"];
    for (const r of reasons) {
      expect(claudeLoginProblem(r), r).toMatch(/New link/);
      expect(claudeLoginProblem(r), r).not.toMatch(/terminal|\/login|`claude`/);
    }
    expect(claudeLoginProblem("no-claude")).toMatch(/not on your server/);
  });

  it("says who is logged in, with the plan when Claude names it", () => {
    expect(claudeLoginDone({ email: "ada@example.com", plan: "Max" })).toBe("Logged in as ada@example.com. Plan: Max.");
    expect(claudeLoginDone({ email: null, plan: null })).toBe("Logged in.");
  });
});

describe("freeLoginName", () => {
  it("is the first free name: the user gives none", () => {
    expect(freeLoginName(["default"])).toBe("login-2");
    expect(freeLoginName(["default", "login-2", "work", "login-3"])).toBe("login-4");
  });
});

describe("a login at its limit: the words", () => {
  const NOW = new Date(2026, 10, 20, 12, 0).getTime();
  const at = (h: number) => NOW + h * 3_600_000;

  it("says the time today, and the day when it is not today", () => {
    expect(clockText(at(2), NOW)).toBe("14:00");
    expect(clockText(at(26), NOW)).toBe("Sat 14:00");
  });

  it("the use of a login in one line", () => {
    expect(useText({ session: 42, week: 10, atLimit: false, until: null }, NOW)).toBe("5-hour window 42% · week 10%");
    expect(useText({ session: 100, week: 10, atLimit: true, until: at(2) }, NOW)).toBe("At its limit until 14:00");
    expect(limitText({ session: 100, week: null, atLimit: true, until: null }, NOW)).toBe("At its limit");
    expect(useText(null, NOW)).toBe("");
  });

  it("what a move did: how many moved, wait, stay and failed", () => {
    expect(movedText({ moved: 7, waits: 0, failed: 0 }, "ada@example.com")).toBe("7 agents moved to ada@example.com. They keep their conversations.");
    expect(movedText({ moved: 1, waits: 0, failed: 0 }, "ada@example.com")).toBe("1 agent moved to ada@example.com. It keeps its conversation.");
    expect(movedText({ moved: 1, waits: 1, failed: 0 }, "x")).toBe("1 agent moved to x. It keeps its conversation. 1 agent is busy now: it moves by itself when it is quiet.");
    expect(movedText({ moved: 0, waits: 2, failed: 1 }, "x")).toBe("No agent moved yet. 2 agents are busy now: they move by themselves when they are quiet. 1 agent did not move. Try again.");
    // A login that works: an agent that works now stays, so its turn is not cut.
    expect(movedText({ moved: 2, waits: 0, failed: 0, working: 1 }, "x")).toBe("2 agents moved to x. They keep their conversations. 1 agent works now, so it did not move. Move it when it is quiet.");
    expect(movedText({ moved: 0, waits: 0, failed: 0, working: 2 }, "x")).toBe("No agent moved yet. 2 agents work now, so they did not move. Move them when they are quiet.");
    expect(movedText({ moved: 0, waits: 0, failed: 0 }, "x")).toBe("No open agent was on this login.");
    // An older server gives no name: the line has none.
    expect(movedText({ moved: 2, waits: 0, failed: 0 })).toBe("2 agents moved. They keep their conversations.");
  });
});

describe("the move of all agents of a login (Settings, Claude accounts)", () => {
  const NOW = new Date(2026, 10, 24, 12, 0).getTime();
  const acct = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({ id, label: id, email: `${id}@example.com`, loggedIn: true, isDefault: id === "default", agents: 0, ...over });
  const use = (session: number, over: Partial<NonNullable<AccountInfo["use"]>> = {}) => ({ session, week: 0, atLimit: false, until: null, models: [], ...over });
  const signedOut = (agents: number) => acct("default", { email: null, loggedIn: false, signedOut: true, agents });
  const ids = (f: { choices: { id: string }[] }) => f.choices.map((c) => c.id);

  it("signed out with sessions: its agents can move; one other login is the one pick", () => {
    const from = signedOut(7);
    const f = moveFacts(from, [from, acct("work", { use: use(12) })], undefined, NOW);
    expect([f.n, f.why, ids(f), f.to?.id, f.to?.name]).toEqual([7, "signed-out", ["work"], "work", "work@example.com"]);
  });

  it("signed out with no session: nothing to move", () => {
    const from = signedOut(0);
    const f = moveFacts(from, [from, acct("work", { use: use(12) })], undefined, NOW);
    expect([f.n, f.why, f.choices, f.to]).toEqual([0, "signed-out", [], null]);
  });

  it("not logged in (never signed in, or its sign-in is gone) with sessions: the same move", () => {
    const from = acct("login-2", { loggedIn: false, agents: 2 });
    const f = moveFacts(from, [acct("default", { use: use(5) }), from], undefined, NOW);
    expect([f.why, ids(f), f.to?.id]).toEqual(["not-logged-in", ["default"], "default"]);
  });

  it("at its limit: as before", () => {
    const from = acct("default", { agents: 2, use: use(100, { atLimit: true }) });
    const f = moveFacts(from, [from, acct("work", { use: use(30) })], undefined, NOW);
    expect([f.why, ids(f), f.to?.id]).toEqual(["limit", ["work"], "work"]);
  });

  it("a login that works: its agents stay, so no move", () => {
    const from = acct("default", { agents: 3, use: use(40) });
    const f = moveFacts(from, [from, acct("work", { use: use(30) })], undefined, NOW);
    expect([f.why, f.choices, f.to]).toEqual([null, [], null]);
  });

  it("several logins: the most room first, a login at its limit last with its state in words; the user's pick wins while it is in the list", () => {
    const from = signedOut(4);
    const rows = [from, acct("a", { use: use(80) }), acct("b", { use: use(20) }), acct("c", { use: use(100, { atLimit: true, until: NOW + 2 * 3_600_000 }) }), acct("d", { loggedIn: false })];
    const f = moveFacts(from, rows, undefined, NOW);
    expect(ids(f)).toEqual(["b", "a", "c"]);
    expect(f.choices.map((c) => c.label)).toEqual(["b@example.com · 5-hour window 20%", "a@example.com · 5-hour window 80%", "c@example.com · at its limit until 14:00"]);
    expect(f.to?.id).toBe("b");
    expect(moveFacts(from, rows, "c", NOW).to?.id).toBe("c");
    expect(moveFacts(from, rows, "gone", NOW).to?.id).toBe("b");
  });

  it("the one other login is at its limit: no pick by the console, the user picks", () => {
    const from = signedOut(2);
    const f = moveFacts(from, [from, acct("work", { use: use(100, { atLimit: true }) })], undefined, NOW);
    expect([ids(f), f.to]).toEqual([["work"], null]);
  });

  it("no other login is logged in: no target", () => {
    const from = signedOut(5);
    const f = moveFacts(from, [from, acct("work", { loggedIn: false })], undefined, NOW);
    expect([f.why, f.choices, f.to]).toEqual(["signed-out", [], null]);
  });

  it("the second sign-in (your assistant's) never moves and is never a target", () => {
    const second = acct("persistent", { persistent: true, loggedIn: false, agents: 3 });
    const main = acct("default", { loggedIn: false, signedOut: true, agents: 2 });
    expect(moveFacts(second, [main, second], undefined, NOW).choices).toEqual([]);
    expect(moveFacts(main, [main, { ...second, loggedIn: true }], undefined, NOW).choices).toEqual([]);
  });

  it("the row says how many agents are on the login, also when it is signed out", () => {
    expect(loginMeta(signedOut(7), NOW)).toBe("7 agents");
    expect(loginMeta(signedOut(1), NOW)).toBe("1 agent");
    expect(loginMeta(signedOut(0), NOW)).toBe("");
    expect(loginMeta(acct("work", { agents: 2, use: use(42) }), NOW)).toBe("5-hour window 42% · week 0% · 2 agents");
    // The second sign-in that is not logged in: its line of waiting agents says it.
    expect(loginMeta(acct("persistent", { persistent: true, loggedIn: false, agents: 3 }), NOW)).toBe("");
  });
});

describe("a model with no room on a login", () => {
  const NOW = new Date(2026, 10, 20, 12, 0).getTime();
  const at = (h: number) => NOW + h * 3_600_000;
  const use = (models: { name: string; until: number | null }[]) => ({ session: 12, week: 30, atLimit: false, until: null, models });

  it("names the model and the time it comes back", () => {
    expect(modelsText(use([{ name: "Fable", until: at(26) }]), NOW)).toBe("No room for Fable until Sat 14:00");
    expect(modelsText(use([{ name: "Fable", until: at(2) }, { name: "Opus", until: at(26) }]), NOW)).toBe("No room for Fable and Opus until Sat 14:00");
    expect(modelsText(use([{ name: "Fable", until: null }]), NOW)).toBe("No room for Fable");
    expect(modelsText(use([]), NOW)).toBe("");
    expect(modelsText({ session: 1, week: 1, atLimit: false, until: null }, NOW)).toBe("");   // an older server
  });

  it("comes first in the line of the login; a login at its limit says only that", () => {
    expect(useText(use([{ name: "Fable", until: at(26) }]), NOW)).toBe("No room for Fable until Sat 14:00 · 5-hour window 12% · week 30%");
    expect(useText({ ...use([{ name: "Fable", until: at(26) }]), atLimit: true, until: at(2) }, NOW)).toBe("At its limit until 14:00");
  });

  it("the login to move to has room for that model", () => {
    const acct = (id: string, models: string[], session = 10): AccountInfo =>
      ({ id, label: id, email: null, loggedIn: true, isDefault: id === "default", use: { session, week: 0, atLimit: false, until: null, models: models.map((name) => ({ name, until: null })) } });
    const list = [acct("default", ["Fable"]), acct("a", ["Fable"], 1), acct("b", ["Opus"], 50)];
    expect(loginToMoveTo(list, "default", ["Fable"])?.id).toBe("b");
    expect(loginToMoveTo([acct("default", ["Fable"]), acct("a", ["Fable"])], "default", ["Fable"])).toBeNull();
    // A move for the whole login (at its limit) does not look at the models.
    expect(loginToMoveTo(list, "default")?.id).toBe("a");
  });
});

describe("loginToMoveTo", () => {
  const acct = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({ id, label: id, email: null, loggedIn: true, isDefault: id === "default", ...over });
  const use = (session: number, atLimit = false) => ({ session, week: 0, atLimit, until: null });

  it("is the login with the most room that is logged in and not at its limit", () => {
    const list = [acct("default", { use: use(100, true) }), acct("a", { use: use(80) }), acct("b", { use: use(20) }), acct("c", { use: use(100, true) }), acct("d", { loggedIn: false })];
    expect(loginToMoveTo(list, "default")?.id).toBe("b");
  });

  it("a login whose use is not known comes last; none with room: null", () => {
    expect(loginToMoveTo([acct("default"), acct("a", { use: null }), acct("b", { use: use(90) })], "default")?.id).toBe("b");
    expect(loginToMoveTo([acct("default"), acct("a", { use: null })], "default")?.id).toBe("a");
    expect(loginToMoveTo([acct("default"), acct("a", { use: use(100, true) }), acct("b", { loggedIn: false })], "default")).toBeNull();
  });
});

describe("the calls of the default login and of the move", () => {
  it("send the login in the body, and give the plain line of a refusal", async () => {
    const f = vi.fn(async () => json(200, { preferred: "work" }));
    expect(await makeDefaultLogin("work", f as never)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith("/api/accounts/default", expect.objectContaining({ body: JSON.stringify({ id: "work" }) }));
    expect(await moveAllAgents("default", "work", (async () => json(200, { moved: 3, waits: 1, failed: 0 })) as never)).toEqual({ ok: true, moved: 3, waits: 1, failed: 0, working: 0 });
    expect(await moveAllAgents("default", "work", (async () => json(200, { moved: 1, waits: 0, failed: 0, working: 2 })) as never)).toEqual({ ok: true, moved: 1, waits: 0, failed: 0, working: 2 });
    expect(await moveAllAgents("default", "work", (async () => json(409, { error: "That login is not logged in. Log in to it first." })) as never))
      .toEqual({ ok: false, error: "That login is not logged in. Log in to it first." });
    expect(await makeDefaultLogin("work", (async () => { throw new Error("net"); }) as never)).toEqual({ ok: false, error: "The console did not answer. Try again." });
  });
});

describe("moveChoices: the logins that the user can pick for a move", () => {
  const NOW = new Date(2026, 10, 20, 12, 0).getTime();
  const acct = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({ id, label: id, email: `${id}@example.com`, loggedIn: true, isDefault: id === "default", ...over });
  const use = (session: number, over: Partial<NonNullable<AccountInfo["use"]>> = {}) => ({ session, week: 0, atLimit: false, until: null, models: [], ...over });

  it("lists each other login that is logged in: the ones with room first, the most room first", () => {
    const list = [
      acct("default", { use: use(100, { atLimit: true }) }), acct("a", { use: use(80) }), acct("b", { use: use(20) }),
      acct("c", { use: use(100, { atLimit: true, until: NOW + 2 * 3_600_000 }) }), acct("d", { loggedIn: false }), acct("e", { use: null }),
    ];
    const c = moveChoices(list, "default", [], NOW);
    expect(c.map((x) => [x.id, x.room])).toEqual([["b", true], ["a", true], ["e", true], ["c", false]]);
    // The first one is the pick of the console.
    expect(c[0].id).toBe(loginToMoveTo(list, "default")?.id);
    expect(c.map((x) => x.label)).toEqual([
      "b@example.com · 5-hour window 20%", "a@example.com · 5-hour window 80%", "e@example.com · use not known", "c@example.com · at its limit until 14:00",
    ]);
  });

  it("for a model with no room: a login where that model is full too has no room, and says so", () => {
    const fable = { models: [{ name: "Fable", until: null }] };
    const c = moveChoices([acct("default", { use: use(10, fable) }), acct("a", { use: use(5, fable) }), acct("b", { use: use(50) })], "default", ["Fable"], NOW);
    expect(c.map((x) => [x.id, x.room, x.label])).toEqual([["b", true, "b@example.com · 5-hour window 50%"], ["a", false, "a@example.com · no room for Fable"]]);
  });

  it("no other login that is logged in: nothing to pick", () => {
    expect(moveChoices([acct("default"), acct("a", { loggedIn: false })], "default", [], NOW)).toEqual([]);
  });
});

describe("an agent with a limit in its way: the words", () => {
  const NOW = new Date(2026, 10, 20, 12, 0).getTime();
  const at = (h: number) => NOW + h * 3_600_000;
  const login = (use: AccountInfo["use"]): AccountInfo => ({ id: "default", label: "x", email: "ada@example.com", loggedIn: true, isDefault: true, use });
  const room = { session: 10, week: 5, atLimit: false, until: null, models: [] };
  const FABLE = "You've hit your Fable limit · resets Nov 23, 5pm (UTC)";

  it("the word of the list: not “your turn” for an agent that was cut or that waits", () => {
    expect(limitWord({ status: "idle", stop: { why: "limit", text: FABLE } })).toBe("stopped at a limit");
    expect(limitWord({ status: "idle", stop: { why: "model", text: "x" } })).toBe("stopped: model error");
    expect(limitWord({ status: "idle", stop: { why: "login", text: "OAuth token revoked · Please run /login" } })).toBe("its Claude login is signed out");
    expect(limitTag({ status: "idle", stop: { why: "login", text: "x" } })).toBe("signed out");
    expect(limitWord({ status: "idle", waitsLogin: { until: null } })).toBe("waits for a login");
    expect(limitWord({ status: "running", stop: { why: "limit", text: FABLE } })).toBeNull();   // it works again
    // The row of the list: the same in two words at most.
    expect(limitTag({ status: "idle", stop: { why: "limit", text: FABLE } })).toBe("at a limit");
    expect(limitTag({ status: "idle", stop: { why: "model", text: "x" } })).toBe("model error");
    expect(limitTag({ status: "idle", waitsLogin: { until: null } })).toBe("waits");
    expect(limitTag({ status: "running", stop: { why: "limit", text: FABLE } })).toBeNull();
    expect(limitTag({ status: "idle" })).toBeNull();
    expect(limitWord({ status: "idle" })).toBeNull();
  });

  it("an agent that waits for a login: it starts by itself, or on the login the user picks", () => {
    const l = limitLine({ agent: { status: "idle", waitsLogin: { until: at(2) } }, login: login({ ...room, atLimit: true, until: at(2) }), others: 1, now: NOW })!;
    expect(l.head).toBe("No Claude login has room now, so this agent did not start.");
    expect(l.quiet).toBe("It starts by itself when a login has room again (about 14:00). You can also start it now on the login you pick.");
    expect(l.act).toBe("start");
  });

  it("the login is at its limit: an agent that was cut goes on by itself after a move", () => {
    const lim = login({ ...room, atLimit: true, until: at(2) });
    const cut = limitLine({ agent: { status: "idle", stop: { why: "limit", text: FABLE } }, login: lim, others: 1, now: NOW })!;
    expect(cut.head).toBe("The Claude login of this agent (ada@example.com) is at its limit until 14:00.");
    expect(cut.quiet).toBe("Its last turn was cut. After a move the agent goes on by itself.");
    expect(limitLine({ agent: { status: "idle" }, login: lim, others: 1, now: NOW })!.quiet).toBe("The agent cannot work on it now.");
    expect(limitLine({ agent: { status: "idle" }, login: lim, others: 0, now: NOW })!.quiet).toMatch(/No other login is logged in\. Add a login in Settings, Claude accounts\.$/);
  });

  it("the login is signed out: the line says so, and what the user can do", () => {
    const l = limitLine({ agent: { status: "idle", stop: { why: "login", text: "OAuth token revoked · Please run /login" } }, login: { ...login(null), loggedIn: false, signedOut: true, use: null }, others: 1, now: NOW })!;
    expect(l.head).toBe("This agent stopped: its Claude login (ada@example.com) is signed out.");
    expect(l.quiet).toBe("Claude said: “OAuth token revoked · Please run /login”. Sign in to that login again in Settings, Claude accounts, or move the agent to another login. After a move the agent goes on by itself.");
    expect(l.act).toBe("move");
  });

  it("the usage does not show a limit, but the agent itself was cut: the line of Claude says why", () => {
    const l = limitLine({ agent: { status: "idle", stop: { why: "limit", text: FABLE } }, login: login(null), others: 1, now: NOW })!;
    expect(l.head).toBe("This agent stopped: its Claude login (ada@example.com) has no room.");
    expect(l.quiet).toContain(`Claude said: “${FABLE}”.`);
    expect(l.act).toBe("move");
    expect(limitLine({ agent: { status: "idle", stop: { why: "model", text: "no access" } }, login: login(room), others: 1, now: NOW })!.head)
      .toBe("This agent stopped: the model of its session does not work for its Claude login (ada@example.com).");
  });

  it("an agent that started on another login than the default one: a quiet line with no button; no limit: no line", () => {
    const l = limitLine({ agent: { status: "running", startedOn: { from: "ada@example.com", until: at(3) } }, login: { ...login(room), id: "login-2", email: "ada.work@example.com", isDefault: false }, others: 1, now: NOW })!;
    expect(l.head).toBe("The default login (ada@example.com) had no room until 15:00, so this agent started on ada.work@example.com.");
    expect(l.act).toBeNull();
    expect(limitLine({ agent: { status: "idle" }, login: login(room), others: 1, now: NOW })).toBeNull();
    // An agent that works again shows no stop line.
    expect(limitLine({ agent: { status: "running", stop: { why: "limit", text: FABLE } }, login: login(room), others: 1, now: NOW })).toBeNull();
  });
});

describe("the second sign-in in plain words", () => {
  it("its name, and the agents that wait for it, with no id", async () => {
    const { loginName, waitersText } = await import("./accounts");
    expect(loginName({ id: "persistent", email: null, isDefault: false, persistent: true })).toBe("Your assistant's sign-in");
    expect(loginName({ id: "persistent", email: "ada@example.invalid", isDefault: false, persistent: true })).toBe("Your assistant's sign-in (ada@example.invalid)");
    expect(waitersText(["fleet-master"])).toBe("The fleet master waits for this sign-in.");
    expect(waitersText(["fleet-master", "coordinator", "lead-app"])).toBe("The fleet master, the helper for tickets and the lead for app wait for this sign-in.");
    expect(waitersText([])).toBe("");
  });
});

describe("sign out of a login: the facts, the confirm text, the call and the result line", () => {
  const NOW = new Date(2026, 10, 25, 12, 0).getTime();
  const acct = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({ id, label: id, email: `${id}@example.com`, loggedIn: true, isDefault: id === "default", ...over });
  const R = { signedOut: true, moved: 0, waits: 0, working: 0, failed: 0, stopped: 0, notEnded: 0, waiting: [] as string[], restarted: [] as string[], recurring: [] as string[] };

  it("signOutFacts: no agent; agents and a login that works (move, the one with room first); agents and no other login (stop); the second sign-in (stop)", () => {
    const rows = [acct("default", { agents: 2 }), acct("work", { use: { session: 10, week: 0, atLimit: false, until: null } }), acct("full", { use: { session: 100, week: 0, atLimit: true, until: null } })];
    expect(signOutFacts(acct("work", { agents: 0 }), rows, undefined, NOW)).toMatchObject({ n: 0, mode: "none", choices: [] });
    const f = signOutFacts(rows[0], rows, undefined, NOW);
    expect([f.mode, f.n, f.choices.map((c) => c.id), f.to?.id]).toEqual(["move", 2, ["work", "full"], "work"]);
    expect(signOutFacts(rows[0], rows, "full", NOW).to?.id).toBe("full");
    expect(signOutFacts(acct("default", { agents: 1 }), [acct("default", { agents: 1 }), acct("off", { loggedIn: false })], undefined, NOW)).toMatchObject({ mode: "stop", n: 1, choices: [], to: null });
    const second = acct("persistent", { persistent: true, agents: 3 });
    expect(signOutFacts(second, [acct("default"), second], undefined, NOW)).toMatchObject({ mode: "stop", n: 3, choices: [] });
  });

  it("signOutNote: says what the press does; the main login of basic protection adds the sentence of the server's user", () => {
    expect(signOutNote({}, { n: 0, mode: "none" })).toBe("Your server forgets this login. To use it again, log in again on this page.");
    expect(signOutNote({}, { n: 2, mode: "move" }, "work@example.com"))
      .toBe("First its 2 agents move to work@example.com. They keep their conversations. Then your server forgets this login. An agent that works now does not move, and then nothing signs out: sign out when it is quiet.");
    expect(signOutNote({}, { n: 1, mode: "stop" }))
      .toBe("No other login works, so its agent stops. It keeps its conversation. Then your server forgets this login. When you log in again, your assistant (the fleet master), the leads and the helper for tickets start again by themselves; you start a worker again from its pane. While an agent works, nothing signs out: sign out when it is quiet.");
    expect(signOutNote({ persistent: true }, { n: 3, mode: "stop" }))
      .toBe("Your assistant (the fleet master), the leads and the helper for tickets stop. They start again by themselves after your next second sign-in. Your server forgets this sign-in.");
    expect(signOutNote({ userLogin: true }, { n: 0, mode: "none" })).toMatch(/This is the Claude login of your server's user: Claude also signs out there, for example in a terminal on your server/);
    expect(signOutNote({}, { n: 0, mode: "none" })).not.toMatch(/token|Anthropic|revoke/i);
  });

  it("signOutLogin: the login in the address, `to` in the body; a decided answer keeps its counts also with 409 or 502; a refusal gives its line", async () => {
    const f = vi.fn(async () => json(200, { ...R, moved: 2 }));
    expect(await signOutLogin("default", "work", f as never)).toEqual({ ok: true, ...R, moved: 2 });
    expect(f).toHaveBeenCalledWith("/api/accounts/default/logout", expect.objectContaining({ method: "POST", body: JSON.stringify({ to: "work" }) }));
    // Lists that are not lists read as empty.
    expect(await signOutLogin("x", undefined, (async () => json(200, { ...R, waiting: "fleet-master", restarted: [1, "lead-a"] })) as never)).toMatchObject({ waiting: [], restarted: ["lead-a"] });
    expect(await signOutLogin("work", undefined, (async () => json(409, { ...R, signedOut: false, working: 1, why: "busy" })) as never))
      .toEqual({ ok: true, ...R, signedOut: false, working: 1, why: "busy" });
    expect(await signOutLogin("work", undefined, (async () => json(502, { ...R, signedOut: false, why: "old-helper" })) as never)).toMatchObject({ ok: true, signedOut: false, why: "old-helper" });
    expect(await signOutLogin("work", undefined, (async () => json(409, { error: "This login is not signed in on your server." })) as never))
      .toEqual({ ok: false, error: "This login is not signed in on your server." });
    expect((await signOutLogin("work", undefined, (async () => json(403, { error: "pair-required", userAuth: "log" })) as never)).ok).toBe(false);
    expect(await signOutLogin("work", undefined, (async () => { throw new Error("net"); }) as never)).toEqual({ ok: false, error: "The console did not answer. Try again." });
  });

  it("signedOutText: each part only says what happened", () => {
    expect(signedOutText(R, "work@example.com")).toBe("work@example.com is signed out: your server forgot this login.");
    expect(signedOutText({ ...R, moved: 2 }, "Main login", "work@example.com"))
      .toBe("2 agents moved to work@example.com. They keep their conversations. Main login is signed out: your server forgot this login.");
    // A worker stopped, the fleet master waits, one agent did not stop, a Recurring run started.
    expect(signedOutText({ ...R, stopped: 2, waiting: ["fleet-master"], notEnded: 1, recurring: ["nightly"] }, "Main login"))
      .toBe("Main login is signed out: your server forgot this login. 1 agent stopped and keeps its conversation: start it again from its pane after you log in again. The fleet master waits and starts again by itself when you log in again. 1 agent did not stop: it works now. Stop it when it is quiet, else Claude can sign this login in again. The Recurring task \"nightly\" started on this login during the sign-out. If the login shows here again, sign out again.");
    // The second sign-in: its agents start after the next one.
    expect(signedOutText({ ...R, stopped: 3, waiting: ["fleet-master", "lead-web", "coordinator"] }, "Your assistant's sign-in", undefined, true))
      .toBe("Your assistant's sign-in is signed out: your server forgot this login. The fleet master, the lead for web and the helper for tickets wait and start again by themselves after your next second sign-in.");
    // Not signed out: the moves that happened, then "not signed out" and why. Never "signed out".
    const moves = signedOutText({ ...R, signedOut: false, moved: 1, working: 1, why: "moves" }, "Main login", "work@example.com");
    expect(moves).toBe("1 agent moved to work@example.com. It keeps its conversation. 1 agent works now, so it did not move. Move it when it is quiet. Main login is not signed out. Sign out again when each agent has moved.");
    expect(signedOutText({ ...R, signedOut: false, working: 2, why: "busy" }, "Main login")).toBe("Main login is not signed out. 2 agents work now. Sign out when they are quiet: a sign-out now would cut their turns.");
    expect(signedOutText({ ...R, signedOut: false, waits: 1, why: "busy" }, "Main login")).toBe("Main login is not signed out. 1 agent moved off this login a moment ago and runs on it until it is quiet. Sign out after that.");
    expect(signedOutText({ ...R, signedOut: false, recurring: ["a", "b"], why: "recurring" }, "x")).toBe("x is not signed out. The Recurring tasks \"a\", \"b\" run on this login now. Sign out when they end.");
    expect(signedOutText({ ...R, signedOut: false, why: "old-helper" }, "x")).toBe("x is not signed out. Your server needs its update before this login can sign out. Nothing changed.");
    // still-there: the agents had stopped already, and the text says it; the fleet master started again.
    expect(signedOutText({ ...R, signedOut: false, why: "still-there", stopped: 2, restarted: ["fleet-master"], notEnded: 1 }, "x"))
      .toBe("x is not signed out. Claude signed out, but the login was back on your server after two tries. Stop the agents and the Recurring tasks on it, then try again. 1 agent stopped and keeps its conversation: start it again from its pane. The fleet master stopped and started again at once. 1 agent did not stop: it works now.");
    // A failure after a move that did happen: the move is said, and never "Nothing changed".
    for (const why of ["failed", "old-helper", "no-claude"] as const) {
      const t = signedOutText({ ...R, signedOut: false, moved: 2, why }, "x", "work@example.com");
      expect(t, why).toMatch(/^2 agents moved to work@example\.com\. They keep their conversations\. x is not signed out\./);
      expect(t, why).not.toMatch(/Nothing changed/);
      expect(signedOutText({ ...R, signedOut: false, why }, "x"), why).toMatch(/Nothing changed/);
    }
    for (const why of ["busy", "moves", "recurring", "still-there", "no-claude", "old-helper", "failed"] as const) {
      for (const over of [{}, { stopped: 1 }, { moved: 1 }, { notEnded: 1 }]) {
        const t = signedOutText({ ...R, signedOut: false, why, ...over }, "x");
        expect(t, why).not.toMatch(/is signed out|forgot this login/);
        if (over.stopped) expect(t, why).toMatch(/1 agent stopped/);
        if (over.notEnded) expect(t, why).toMatch(/1 agent did not stop/);
      }
    }
  });
});
