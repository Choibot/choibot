// src/lib/loginPick.test.ts — the logins in the login control of one agent on its pane (the fleet
// master, a lead, the helper for tickets).
import { describe, expect, it } from "vitest";
import { switchAgentAccount, type AccountInfo } from "./accounts";
import { loginPickRows, loginShort, moveGate, movedOneText } from "./loginPick";

const NOW = new Date(2026, 10, 24, 12, 0).getTime();
const acct = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({ id, label: id, email: `${id}@example.com`, loggedIn: true, isDefault: id === "default", ...over });
const use = (session: number, over: Partial<NonNullable<AccountInfo["use"]>> = {}) => ({ session, week: 0, atLimit: false, until: null, models: [], ...over });

describe("loginPickRows", () => {
  it("its own login first, then the others with room (the most room first), then the full ones; a login that is not logged in cannot be picked", () => {
    const list = [
      acct("default", { use: use(30) }), acct("a", { use: use(80) }), acct("b", { use: use(20) }),
      acct("c", { use: use(100, { atLimit: true, until: NOW + 2 * 3_600_000 }) }), acct("d", { loggedIn: false }), acct("e", { loggedIn: false, signedOut: true }),
    ];
    expect(loginPickRows(list, "default", NOW)).toEqual([
      { id: "default", name: "default@example.com", state: "5-hour window 30%", current: true, pick: false },
      { id: "b", name: "b@example.com", state: "5-hour window 20%", current: false, pick: true },
      { id: "a", name: "a@example.com", state: "5-hour window 80%", current: false, pick: true },
      { id: "c", name: "c@example.com", state: "at its limit until 14:00", current: false, pick: true },
      { id: "d", name: "d@example.com", state: "not logged in", current: false, pick: false },
      { id: "e", name: "e@example.com", state: "signed out", current: false, pick: false },
    ]);
  });

  it("an agent on a login that is signed out: its row says so, and the others can be picked", () => {
    const rows = loginPickRows([acct("default", { loggedIn: false, signedOut: true }), acct("work")], "default", NOW);
    expect(rows.map((r) => [r.id, r.state, r.pick])).toEqual([["default", "signed out", false], ["work", "use not known", true]]);
  });

  it("one login only: no control", () => {
    expect(loginPickRows([acct("default")], "default", NOW)).toEqual([]);
  });

  it("an agent on a login that is gone: its id, and the others", () => {
    expect(loginPickRows([acct("default")], "old", NOW).map((r) => [r.id, r.name, r.state, r.current])).toEqual([["old", "old", "not known", true], ["default", "default@example.com", "use not known", false]]);
  });

  it("strong protection with the second sign-in: these agents are on it only, so no control", () => {
    expect(loginPickRows([acct("default"), acct("persistent", { persistent: true })], "persistent", NOW)).toEqual([]);
  });
});

describe("moveGate: can the user move the agent now", () => {
  const msg = { quiet: null, working: "The agent works now. Wait until it is quiet: a move now would cut its turn." };
  it("on a login that works: yes while the agent is quiet, no while it works (a move would cut its turn)", () => {
    expect(moveGate("idle", acct("default", { use: use(30) }))).toEqual({ on: true, note: msg.quiet });
    expect(moveGate("running", acct("default", { use: use(30) }))).toEqual({ on: false, note: msg.working });
    expect(moveGate("running", acct("default", { use: null }))).toEqual({ on: false, note: msg.working });
  });
  it("on a login that cannot work: yes, also while the agent works (a turn cannot go on there), and the note says why", () => {
    expect(moveGate("running", acct("default", { loggedIn: false, signedOut: true }))).toEqual({ on: true, note: "This login is signed out. Move the agent to a login that works." });
    expect(moveGate("idle", acct("default", { loggedIn: false, signedOut: true }))).toEqual({ on: true, note: "This login is signed out. Move the agent to a login that works." });
    expect(moveGate("running", acct("default", { loggedIn: false }))).toEqual({ on: true, note: "This login is not logged in. Move the agent to a login that works." });
    expect(moveGate("running", acct("default", { use: use(100, { atLimit: true }) }))).toEqual({ on: true, note: "This login is at its limit. Move the agent to a login with room." });
  });
  it("its login is not known (gone): the rule of a login that works", () => {
    expect(moveGate("running", undefined)).toEqual({ on: false, note: msg.working });
    expect(moveGate("", undefined)).toEqual({ on: true, note: msg.quiet });
  });
});

describe("the words of the control", () => {
  it("the short name of a login on the button", () => {
    expect(loginShort(acct("default"))).toBe("default");
    expect(loginShort(acct("default", { email: null }))).toBe("Main login");
    expect(loginShort(acct("login-2", { email: null }))).toBe("login-2");
    expect(loginShort(undefined, "old")).toBe("old");
  });

  it("what a move did", () => {
    expect(movedOneText("resumed", "bea@example.com")).toBe("Moved to bea@example.com. The agent keeps its conversation.");
    expect(movedOneText("patched", "bea@example.com")).toBe("Moved to bea@example.com. The agent keeps its conversation.");
    expect(movedOneText("waits", "bea@example.com")).toBe("The agent is busy now. It moves to bea@example.com when it is quiet.");
    expect(movedOneText("unchanged", "bea@example.com")).toBe("The agent is on bea@example.com already.");
  });
});

describe("the move of one agent", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it("gives the outcome; a device that is not paired gets the pairing sentence; the plain line of the server stays", async () => {
    expect(await switchAgentAccount("fleet-master", "work", (async () => json(202, { id: "fleet-master", outcome: "waits" })) as never)).toBe("waits");
    await expect(switchAgentAccount("fleet-master", "work", (async () => json(403, { error: "pair-required", userAuth: "log" })) as never))
      .rejects.toThrow(/^A move of this agent needs a paired device/);
    await expect(switchAgentAccount("lead-app", "work", (async () => json(409, { error: "That login is signed out. Log in to it again first." })) as never))
      .rejects.toThrow("That login is signed out. Log in to it again first.");
  });
});
