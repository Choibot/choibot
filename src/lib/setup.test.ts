import { describe, expect, it, vi } from "vitest";
import { STEPS, type StepStatus } from "../../server/setup/steps";
import { fetchSetup, fetchSetupHome, firstTurn, headline, progress, readHomeHint, setupRows, setupStatus, stateWord, writeHomeHint, SETUP_HOME_KEY, type SetupAnswer } from "./setup";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const step = (id: string, state: StepStatus["state"], text: string, extra: Partial<StepStatus> = {}): StepStatus =>
  ({ id, title: "t", why: "w", optional: false, state, text, ...extra } as StepStatus);
const answer = (steps: StepStatus[]): SetupAnswer => ({ steps, checkedAt: 1, home: true });

// A new install right after the pairing: 4 steps done, GitHub is the user's turn.
const HALF = answer([
  step("install", "done", "Node 22, the tools and the service are ready"), step("claude", "done", "Logged in"),
  step("access", "done", "The private address is ready"), step("pair", "done", "1 device paired"),
  step("github", "todo", "GitHub is not connected.", { error: "GitHub answered: not logged in." }),
  step("repo", "blocked", "First: Connect GitHub.", { blockedBy: "github" }),
  step("agent", "blocked", "First: Pick a repo."), step("merge", "blocked", "First: Start the first agent."),
  step("phone", "todo", "Only 1 device is paired."), step("telegram", "todo", "No Telegram bot is set up."),
  step("lead", "blocked", "First: Pick a repo."),
]);

describe("setupRows", () => {
  it("shows the whole list before any answer, and no step is done", () => {
    const rows = setupRows(null);
    // A step that a console may leave out (the second sign-in) waits for the answer that holds it.
    const always = STEPS.filter((s) => !s.sometimes);
    expect(rows.map((r) => r.id)).toEqual(always.map((s) => s.id));
    expect(rows.map((r) => r.title)).toEqual(always.map((s) => s.title));
    expect(rows.every((r) => r.state === "checking")).toBe(true);
    expect(headline(rows)).toBe("Checking the steps…");
    expect(progress(rows)).toEqual({ done: 0, total: 8 });
  });

  it("gives each step its state: done, your turn, waits, optional", () => {
    const rows = setupRows(HALF);
    expect(rows.map((r) => `${r.id}:${r.state}`)).toEqual([
      "install:done", "claude:done", "access:done", "pair:done", "github:turn", "repo:waits", "agent:waits", "merge:waits",
      "phone:optional", "telegram:optional", "lead:waits",
    ]);
    expect(rows.map(stateWord)).toEqual(["Done", "Done", "Done", "Done", "Your turn", "Waits", "Waits", "Waits", "Optional", "Optional", "Waits"]);
    expect(rows[4]).toMatchObject({ text: "GitHub is not connected.", error: "GitHub answered: not logged in." });
    expect(progress(rows)).toEqual({ done: 4, total: 8 });
    expect(firstTurn(rows)?.id).toBe("github");
    expect(headline(rows)).toBe("Step 5 of 8 · Connect GitHub");
  });

  it("takes its titles from the list, not from the answer, and never marks a step it did not get as done", () => {
    const rows = setupRows(answer([step("install", "done", "Ready", { title: "<b>x</b>" }), { id: "claude", state: "done" } as StepStatus]));
    expect(rows[0]).toMatchObject({ state: "done", title: STEPS[0].title });
    expect(rows[1].state).toBe("checking"); // no text: not a step of this list
    expect(rows[2].state).toBe("checking");
  });

  it("says when the set-up is done; the optional steps do not count", () => {
    const done = setupRows(answer(STEPS.map((s) => step(s.id, s.optional ? "todo" : "done", "x"))));
    expect(progress(done)).toEqual({ done: 8, total: 8 });
    expect(headline(done)).toBe("Set-up is done");
    expect(firstTurn(done)).toBeNull();
  });

  it("counts when every open step waits (the list was not checked here)", () => {
    const rows = setupRows(answer(STEPS.map((s) => step(s.id, "blocked", "First: x."))));
    expect(headline(rows)).toBe("0 of 8 steps done");
  });
});

describe("one step for GitHub with the ChoiBot app (githubApp)", () => {
  const app = (a: SetupAnswer): SetupAnswer => ({ ...a, githubApp: true });
  const withRepo = (gh: StepStatus, repo: StepStatus): SetupAnswer =>
    app({ ...HALF, steps: HALF.steps.map((x) => (x.id === "github" ? gh : x.id === "repo" ? repo : x)) });

  it("has no row 'Pick a repo': one step less, and what waited for it waits for Connect GitHub", () => {
    const rows = setupRows(app(HALF));
    expect(rows.map((r) => r.id)).not.toContain("repo");
    expect(progress(rows)).toEqual({ done: 4, total: 7 });
    expect(headline(rows)).toBe("Step 5 of 7 · Connect GitHub");
    expect(rows.find((r) => r.id === "github")).toMatchObject({ state: "turn", part: "github", app: true, text: "GitHub is not connected.", error: "GitHub answered: not logged in." });
    expect(rows.find((r) => r.id === "agent")?.text).toBe("First: Connect GitHub.");
    expect(rows.find((r) => r.id === "lead")?.text).toBe("First: Connect GitHub.");
  });

  it("after the approval, the same row is the choice of the repo; with both checks done it is done", () => {
    const approved = setupRows(withRepo(step("github", "done", "Connected as ana-dev"), step("repo", "todo", "No repo is on your server yet.")));
    expect(approved.find((r) => r.id === "github")).toMatchObject({ state: "turn", part: "repo", text: "No repo is on your server yet." });
    expect(approved.find((r) => r.id === "github")?.error).toBeUndefined();
    expect(progress(approved)).toEqual({ done: 4, total: 7 });
    const both = setupRows(withRepo(step("github", "done", "Connected as ana-dev"), step("repo", "done", "shop")));
    expect(both.find((r) => r.id === "github")).toMatchObject({ state: "done", text: "Connected as ana-dev · shop" });
    expect(progress(both)).toEqual({ done: 5, total: 7 });
  });

  it("the old gh login keeps its two rows", () => {
    const rows = setupRows(HALF);
    expect(rows.map((r) => r.id)).toContain("repo");
    expect(progress(rows)).toEqual({ done: 4, total: 8 });
    expect(rows.find((r) => r.id === "github")?.part).toBeUndefined();
  });

  it("reads the flag from the server's answer, and only a true", async () => {
    const f = vi.fn(async () => json(200, { steps: [], checkedAt: 1, home: true, githubApp: true }));
    expect((await fetchSetup({ fetch: f as never })).githubApp).toBe(true);
    const g = vi.fn(async () => json(200, { steps: [], checkedAt: 1, home: true, githubApp: "yes" }));
    expect((await fetchSetup({ fetch: g as never })).githubApp).toBeUndefined();
  });
});

describe("the Set-up row of Settings", () => {
  it("is green only when every required step is done, and quiet when steps are open", () => {
    expect(setupStatus(8, 8, true, false)).toEqual({ tone: "ok", text: "Set-up is done" });
    expect(setupStatus(3, 8, true, false)).toEqual({ tone: "off", text: "3 of 8 steps done" });
    expect(setupStatus(0, 8, false, false)).toEqual({ tone: "load", text: "Checking…" });
    expect(setupStatus(0, 8, false, true).tone).toBe("err");
    expect(setupStatus(3, 8, true, true).tone).toBe("off"); // the last list stays when a later read fails
  });
});

describe("the reads", () => {
  it("fetchSetup gives the list, and fails on an answer with no list", async () => {
    const ok = vi.fn(async () => json(200, HALF));
    expect(await fetchSetup({ fetch: ok as never })).toEqual({ ...HALF, protection: "basic" });
    expect((await fetchSetup({ fetch: (async () => json(200, { ...HALF, protection: "strong" })) as never })).protection).toBe("strong");
    expect((await fetchSetup({ fetch: (async () => json(200, { ...HALF, protection: "STRONG" })) as never })).protection).toBe("basic");
    expect(ok).toHaveBeenCalledWith("/api/setup/steps");
    await expect(fetchSetup({ fetch: (async () => json(403, { error: "pair-required" })) as never })).rejects.toThrow();
    await expect(fetchSetup({ fetch: (async () => json(200, {})) as never })).rejects.toThrow();
    expect((await fetchSetup({ fetch: (async () => json(200, { steps: [] })) as never })).home).toBe(false);
  });

  it("fetchSetupHome: true only when the server says so", async () => {
    const home = (status: number, body: unknown) => fetchSetupHome({ fetch: (async () => json(status, body)) as never });
    expect(await home(200, { home: true })).toBe(true);
    expect(await home(200, { home: false })).toBe(false);
    expect(await home(200, {})).toBe(false);
    expect(await home(404, {})).toBe(false);  // a server from before
    expect(await home(503, {})).toBeNull();   // no answer: keep what was known
    expect(await fetchSetupHome({ fetch: (async () => { throw new Error("down"); }) as never })).toBeNull();
  });

  it("keeps the last answer of home as a hint", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    expect(readHomeHint(store)).toBe(false);
    writeHomeHint(true, store);
    expect(data.get(SETUP_HOME_KEY)).toBe("1");
    expect(readHomeHint(store)).toBe(true);
    writeHomeHint(false, store);
    expect(readHomeHint(store)).toBe(false);
    expect(readHomeHint(null)).toBe(false);
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(readHomeHint(broken)).toBe(false);
    expect(() => writeHomeHint(true, broken)).not.toThrow();
  });
});

describe("the second sign-in's row", () => {
  it("is on the page only when the answer of the server holds it, as an optional row", () => {
    const without = setupRows(answer([step("install", "done", "Ready")]));
    expect(without.map((r) => r.id)).not.toContain("persistent");
    const withIt = setupRows(answer([step("install", "done", "Ready"), step("persistent", "todo", "The fleet master waits for this sign-in.")]));
    expect(withIt.find((r) => r.id === "persistent")).toMatchObject({ state: "optional", optional: true, text: "The fleet master waits for this sign-in.", title: "Sign in for your assistant" });
    // It never counts in the required steps.
    expect(progress(withIt).total).toBe(progress(without).total);
  });
});
