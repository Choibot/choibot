// server/setup/api.test.ts — GET /api/setup/steps: the whole list with its state, kept for a
// few seconds, and nothing in the answer but plain words.
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { makesStale, registerSetupApi, STEPS_TTL_MS } from "./api.js";
import { CHECK_FAILED, STEPS, type BoxFacts, type Probes } from "./steps.js";

const BOX: BoxFacts = {
  linux: true, node: "22.11.0", userServices: true, missingTools: [], checkout: true, settings: true,
  queue: true, staysOn: true, unknownFailures: 0, service: "running", answers: true,
};
function probes(over: Partial<Probes> = {}): Probes {
  return {
    box: async () => BOX,
    claude: async () => ({ installed: true, loggedIn: true }),
    access: async () => ({ state: "ready" }),
    github: async () => ({ installed: true, login: "ada-dev", commitName: true }),
    repos: async () => ({ onBox: 1, canPush: "shop" }),
    devices: async () => ({ pairing: true, count: 1 }),
    agents: async () => ({ started: 0, running: 0, pullRequests: 0, tickets: true }),
    merged: async () => ({ count: 0 }),
    telegram: async () => ({ bot: "none", account: false, tested: false, name: null, tickets: false, master: false }),
    leads: async () => ({ on: true, live: 0 }),
    persistentLogin: async () => ({ wanted: false, ready: false, loggedIn: false, waits: [] }),
    ...over,
  };
}

function app(o: { make?: () => Partial<Probes>; now?: () => number; log?: (s: string) => void; newInstall?: boolean; strong?: () => boolean; githubApp?: boolean } = {}) {
  const a = Fastify();
  const make = vi.fn(o.make ?? (() => probes()));
  const steps = registerSetupApi(a, {
    probes: make, now: o.now, log: o.log ?? (() => {}), ...(o.newInstall !== undefined ? { newInstall: o.newInstall } : {}), ...(o.strong ? { strong: o.strong } : {}),
    ...(o.githubApp ? { githubApp: true } : {}),
  });
  return { a, make, steps, get: async () => (await a.inject({ method: "GET", url: "/api/setup/steps" })) };
}

describe("GET /api/setup/steps", () => {
  it("says the protection: strong only when the hardened monitor says so", async () => {
    expect((await app().get()).json().protection).toBe("basic");
    expect((await app({ strong: () => false }).get()).json().protection).toBe("basic");
    expect((await app({ strong: () => true }).get()).json().protection).toBe("strong");
  });

  it("says when the GitHub app switch is on, so the page draws one step; the checks stay two", async () => {
    expect((await app().get()).json().githubApp).toBeUndefined();
    const on = (await app({ githubApp: true }).get()).json();
    expect(on.githubApp).toBe(true);
    expect(on.steps.map((x: { id: string }) => x.id)).toContain("repo");
  });

  it("gives every step in order, with its state and plain text", async () => {
    const { get } = app({ now: () => 1000 });
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.checkedAt).toBe(1000);
    // The second sign-in has no row where no second account is asked for.
    expect(body.steps.map((s: { id: string }) => s.id)).toEqual(STEPS.map((s) => s.id).filter((id) => id !== "persistent"));
    expect(body.steps.map((s: { id: string; state: string }) => `${s.id}:${s.state}`)).toEqual([
      "install:done", "claude:done", "access:done", "pair:done", "github:done", "repo:done",
      "agent:todo", "merge:blocked", "phone:todo", "telegram:todo", "lead:todo",
    ]);
    expect(body.steps[6]).toEqual({
      id: "agent", title: "Start the first agent", why: "An agent does one small task and opens a pull request.",
      optional: false, state: "todo", text: "No agent has started yet.", completes: { kind: "action", name: "first-agent" },
    });
    expect(body.steps[7]).toMatchObject({ blockedBy: "agent", text: "First: Start the first agent.", completes: { kind: "action", name: "merge" } });
  });

  it("has only the fields of a step: no fact of a probe, no part that is not built", async () => {
    const { get } = app();
    const allowed = new Set(["id", "title", "why", "optional", "state", "text", "blockedBy", "error", "completes"]);
    for (const s of (await get()).json().steps) for (const k of Object.keys(s)) expect(allowed.has(k), k).toBe(true);
    expect((await get()).body).not.toMatch(/built|loggedIn|canPush|pairing/);
  });

  it("keeps the answer for a few seconds, then checks again", async () => {
    let t = 0;
    const { get, make } = app({ now: () => t });
    await get();
    t = STEPS_TTL_MS - 1;
    await get();
    expect(make).toHaveBeenCalledTimes(1);
    t = STEPS_TTL_MS + 1;
    await get();
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("a change of a pull request ticket makes the kept answer old; no other event does", () => {
    // The page reads the list right after its own Merge: the answer from before the merge must not come back.
    expect(makesStale({ type: "queue", item: { kind: "pr" } })).toBe(true);
    expect(makesStale({ type: "queue", item: { kind: "choice" } })).toBe(false);
    expect(makesStale({ type: "agent-status" })).toBe(false);
    expect(makesStale({ type: "reminders" })).toBe(false);
  });

  it("checks again at once after an action of the page (forget)", async () => {
    const { get, make, steps } = app({ now: () => 0 });
    await get();
    await get();
    expect(make).toHaveBeenCalledTimes(1);
    steps.forget();
    await get();
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("read() is the read of the route, and last() gives the kept answer with no new run", async () => {
    let t = 0;
    const { get, make, steps } = app({ now: () => t });
    expect(steps.last()).toBeNull();
    const first = await steps.read();
    expect((await get()).json()).toEqual(first);
    t = STEPS_TTL_MS * 10;
    // An old answer is still the kept one: last() starts no check.
    expect(steps.last()).toEqual(first);
    expect(make).toHaveBeenCalledTimes(1);
    steps.forget();
    expect(steps.last()).toBeNull();
  });

  it("does not keep the answer of a run that an action came into", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let login: string | null = null;
    const { get, make, steps } = app({
      now: () => 0,
      make: () => probes({ github: async () => { const seen = login; await gate; return { installed: true, login: seen, commitName: true }; } }),
    });
    const old = get();              // reads "not connected", then waits
    await new Promise((r) => setTimeout(r, 5));
    login = "ada-dev";              // the login ends
    steps.forget();
    release();
    expect((await old).json().steps[4].state).toBe("todo");
    expect((await get()).json().steps[4]).toMatchObject({ state: "done", text: "Connected as ada-dev" });
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("shares one run between callers that come at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { get, make } = app({ make: () => probes({ box: async () => { await gate; return BOX; } }) });
    const both = Promise.all([get(), get()]);
    release();
    const [a, b] = await both;
    expect(make).toHaveBeenCalledTimes(1);
    expect(a.json()).toEqual(b.json());
  });

  it("leaves a step open when its probe throws: the cause goes to the log, not to the answer", async () => {
    const lines: string[] = [];
    const { get } = app({
      make: () => probes({ claude: async () => { throw new Error("EACCES: /home/you/.claude/.credentials.json"); } }),
      log: (s) => lines.push(s),
    });
    const res = await get();
    expect(res.json().steps[1]).toMatchObject({ id: "claude", state: "todo", text: CHECK_FAILED });
    expect(res.body).not.toMatch(/EACCES|credentials|\/home/);
    expect(lines).toEqual(["[setup] the check of step claude did not run: EACCES: /home/you/.claude/.credentials.json"]);
  });

  it("checks again after a run that failed as a whole", async () => {
    let n = 0;
    const { a, make } = app({ make: () => { if (n++ === 0) throw new Error("no probes"); return probes(); } });
    expect((await a.inject({ method: "GET", url: "/api/setup/steps" })).statusCode).toBe(500);
    expect((await a.inject({ method: "GET", url: "/api/setup/steps" })).statusCode).toBe(200);
    expect(make).toHaveBeenCalledTimes(2);
  });
});

describe("the home of the console", () => {
  const home = async (a: ReturnType<typeof app>["a"]) => (await a.inject({ method: "GET", url: "/api/setup/home" })).json();
  const merged = { merged: async () => ({ count: 1 }), agents: async () => ({ started: 1, running: 0, pullRequests: 1, tickets: true }) };

  it("an install with the old names: never the Set-up page, and no check runs for the answer", async () => {
    const { a, make, get } = app();
    expect(await home(a)).toEqual({ home: false });
    expect(make).not.toHaveBeenCalled();
    expect((await get()).json().home).toBe(false); // steps are open, and it is still not the home
    const explicit = app({ newInstall: false });
    expect(await home(explicit.a)).toEqual({ home: false });
    expect(explicit.make).not.toHaveBeenCalled();
  });

  it("a new install: the Set-up page is the home until the first pull request is merged", async () => {
    const open = app({ newInstall: true });
    expect(await home(open.a)).toEqual({ home: true });
    expect((await open.get()).json().home).toBe(true);
    const done = app({ newInstall: true, make: () => probes(merged) });
    expect(await home(done.a)).toEqual({ home: false });
    expect((await done.get()).json().home).toBe(false);
  });

  it("a new install: the answer needs only the check of the last required step", async () => {
    const calls: string[] = [];
    const counted = (): Partial<Probes> => new Proxy(probes(), {
      get: (t, name: string) => () => { calls.push(name); return (t as unknown as Record<string, () => Promise<unknown>>)[name](); },
    });
    const { a } = app({ newInstall: true, make: counted });
    expect(await home(a)).toEqual({ home: true });
    expect(calls).toEqual(["merged"]);
  });

  it("a new install: a merge check that does not run keeps the Set-up page as the home", async () => {
    const { a } = app({ newInstall: true, make: () => probes({ merged: async () => { throw new Error("no queue"); } }) });
    expect(await home(a)).toEqual({ home: true });
  });

  it("uses the list it has when that one is new enough", async () => {
    let t = 1000;
    const { a, make, get } = app({ newInstall: true, now: () => t });
    await get();
    expect(await home(a)).toEqual({ home: true });
    expect(make).toHaveBeenCalledTimes(1);
    t += STEPS_TTL_MS;
    await home(a);
    expect(make).toHaveBeenCalledTimes(2);
  });
});
