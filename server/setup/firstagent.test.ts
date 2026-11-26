// server/setup/firstagent.test.ts — the first agent: one start, a fixed task, and its state
// from the record of the agent and the tickets of the Queue.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import { FIRST_AGENT_LABEL, FIRST_TASK_PROMPT, FIRST_TASK_TITLE, FirstAgent, ticketOf, ticketState } from "./firstagent.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "setup-first-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: FIRST_AGENT_LABEL, repo: "/ws/shop", worktree: `/wt/${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: "t", status: "running", createdAt: 1, ...o,
});
const pr = (id: string, agentId: string, o: Partial<QueueItem> = {}): QueueItem => ({
  id, kind: "pr", agentId, createdBy: { agentId, kind: "worker" }, repo: "shop", area: "shop", title: "README: add Run it locally", body: "b",
  createdAt: 10, updatedAt: 10, status: "open", blocking: false, history: [], answerSeq: 0,
  pr: { url: "https://github.com/acme/shop/pull/128", number: 128 }, ...o,
} as QueueItem);

function make(o: { repo?: { name: string; path: string } | null; repos?: { name: string; path: string }[]; spawnFails?: string } = {}) {
  const records = new Map<string, AgentRecord>();
  const items: QueueItem[] = [];
  const spawned: { prompt: string; repo: string; label: string }[] = [];
  const logs: string[] = [];
  let t = 1000, changed = 0;
  const first = new FirstAgent({
    file: join(dir, "setup", "first-agent.json"),
    agents: { load: async (id) => records.get(id) ?? null },
    repos: async () => o.repos ?? (o.repo === null ? [] : [o.repo ?? { name: "shop", path: "/ws/shop" }]),
    spawn: async (req) => {
      if (o.spawnFails) return { ok: false, error: o.spawnFails };
      spawned.push(req);
      const id = `a${spawned.length}`;
      records.set(id, rec(id));
      return { ok: true, id };
    },
    tickets: async () => items,
    changed: () => { changed++; },
    now: () => t,
    log: (s) => logs.push(s),
  });
  return { first, records, items, spawned, logs, tick: (ms: number) => { t += ms; }, changed: () => changed };
}

describe("the task", () => {
  it("is fixed, small, and changes only the README", () => {
    expect(FIRST_TASK_TITLE).toBe("Add a “Run it locally” section to the README");
    expect(FIRST_TASK_PROMPT).toMatch(/Change only the README/);
    expect(FIRST_TASK_PROMPT).toMatch(/Do not invent a command/);
    expect(FIRST_TASK_PROMPT).toMatch(/open a pull request/);
    expect(FIRST_TASK_PROMPT).toMatch(/ticket of the pull request to the Queue/);
  });
});

describe("view", () => {
  it("before the start: the task and the repo the button will use, no agent", async () => {
    const { first, spawned } = make();
    expect(await first.view()).toEqual({ task: FIRST_TASK_TITLE, repo: "shop", repos: ["shop"], agent: null, ticket: null, now: 1000 });
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, "setup"))).toBe(false);
  });

  it("asks GitHub for the repo one time a minute, however often the page asks", async () => {
    let asked = 0, t = 0;
    const first = new FirstAgent({
      file: join(dir, "first.json"), agents: { load: async () => null }, tickets: async () => [], now: () => t,
      repos: async () => { asked++; return [{ name: "shop", path: "/ws/shop" }]; }, spawn: async () => ({ ok: false, error: "x" }),
    });
    await first.view(); t = 30_000; await first.view(); t = 59_000; await first.view();
    expect(asked).toBe(1);
    t = 61_000;
    expect((await first.view()).repo).toBe("shop");
    expect(asked).toBe(2);
  });

  it("says that no repo with push access is there", async () => {
    expect((await make({ repo: null }).first.view()).repo).toBeNull();
  });

  it("follows the agent: working, waiting, ended, error, closed, gone", async () => {
    const { first, records } = make();
    await first.start();
    const state = async () => (await first.view()).agent?.state;
    expect(await state()).toBe("working");
    records.set("a1", rec("a1", { status: "idle" })); expect(await state()).toBe("waiting");
    records.set("a1", rec("a1", { status: "done" })); expect(await state()).toBe("ended");
    records.set("a1", rec("a1", { status: "error" })); expect(await state()).toBe("error");
    records.set("a1", rec("a1", { status: "idle", closedAt: 5 })); expect(await state()).toBe("closed");
    records.delete("a1"); expect(await state()).toBe("gone");
  });

  it("shows the pull request ticket of the first agent, and of no other agent", async () => {
    const { first, items } = make();
    await first.start();
    items.push(pr("qother000", "someone-else"));
    expect((await first.view()).ticket).toBeNull();
    items.push(pr("qfirst001", "a1"));
    expect(await first.view()).toMatchObject({ ticket: { id: "qfirst001", state: "open" }, agent: { pullRequest: true } });
    items[1] = pr("qfirst001", "a1", { status: "withdrawn", lastError: "merged" });
    expect((await first.view()).ticket).toEqual({ id: "qfirst001", state: "merged" });
  });

  it("knows a pull request that has no ticket yet", async () => {
    const { first, records } = make();
    await first.start();
    expect((await first.view()).agent?.pullRequest).toBe(false);
    records.set("a1", rec("a1", { status: "idle", prUrl: "https://github.com/acme/shop/pull/128", prNumber: 128 }));
    expect(await first.view()).toMatchObject({ agent: { state: "waiting", pullRequest: true }, ticket: null });
  });

  it("is there again after a restart of the console (the file)", async () => {
    const a = make();
    await a.first.start();
    const kept = JSON.parse(readFileSync(join(dir, "setup", "first-agent.json"), "utf8"));
    expect(kept).toEqual({ agentId: "a1", repo: "shop", startedAt: 1000 });
    const b = make();
    b.records.set("a1", rec("a1", { status: "idle" }));
    expect(await b.first.view()).toMatchObject({ repo: "shop", agent: { id: "a1", state: "waiting", startedAt: 1000 } });
  });

  it("reads a broken file as no first agent", async () => {
    const { first } = make();
    await first.start();
    writeFileSync(join(dir, "setup", "first-agent.json"), "{ not json");
    expect((await first.view()).agent).toBeNull();
  });
});

describe("the repo of the first task", () => {
  const API = { name: "api", path: "/ws/api" }, SHOP = { name: "shop", path: "/ws/shop" }, NOTES = { name: "notes", path: "/ws/notes" };

  it("is the first repo with push access when the user picked none", async () => {
    const { first, spawned } = make({ repos: [API, SHOP] });
    expect(await first.view()).toMatchObject({ repo: "api", repos: ["api", "shop"] });
    await first.start();
    expect(spawned[0].repo).toBe("/ws/api");
  });

  it("is the repo the user picked in “Pick a repo”", async () => {
    const { first, spawned } = make({ repos: [API, SHOP, NOTES] });
    await first.picked("shop");
    expect(await first.view()).toMatchObject({ repo: "shop", repos: ["api", "shop", "notes"] });
    await first.start();
    expect(spawned).toEqual([{ prompt: FIRST_TASK_PROMPT, repo: "/ws/shop", label: FIRST_AGENT_LABEL }]);
    expect(JSON.parse(readFileSync(join(dir, "setup", "picked-repo.json"), "utf8"))).toEqual({ repo: "shop" });
  });

  it("takes the last pick, also after a restart of the console", async () => {
    const a = make({ repos: [API, SHOP, NOTES] });
    await a.first.picked("shop");
    await a.first.picked("notes");
    expect((await make({ repos: [API, SHOP, NOTES] }).first.view()).repo).toBe("notes");
  });

  it("falls back when the picked repo is gone, or has no push access any more", async () => {
    const { first, spawned } = make({ repos: [API, NOTES] });
    await first.picked("shop");
    expect((await first.view()).repo).toBe("api");
    await first.start();
    expect(spawned[0].repo).toBe("/ws/api");
  });

  it("uses the repo of the “Change” control when its name is in the list of the server", async () => {
    const { first, spawned } = make({ repos: [API, SHOP, NOTES] });
    await first.picked("shop");
    expect(await first.start({ repo: "notes" })).toMatchObject({ ok: true, view: { repo: "notes", repos: [] } });
    expect(spawned[0].repo).toBe("/ws/notes");
  });

  it("refuses a name that the list does not hold, and a path: nothing starts", async () => {
    const { first, spawned } = make({ repos: [API, SHOP] });
    for (const bad of ["other", "/ws/shop", "../shop", "shop/", "ws/shop", "", "/etc", "SHOP"]) {
      expect(await first.start({ repo: bad }), bad).toEqual({ ok: false, why: "unknown-repo" });
    }
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, "setup", "first-agent.json"))).toBe(false);
  });

  it("starts a new try in the repo of the first try", async () => {
    const { first, spawned, records } = make({ repos: [API, SHOP, NOTES] });
    await first.start({ repo: "notes" });
    records.set("a1", rec("a1", { status: "idle" }));
    await first.start({ again: true });
    expect(spawned.map((x) => x.repo)).toEqual(["/ws/notes", "/ws/notes"]);
  });

  it("shows no list once an agent started", async () => {
    const { first } = make({ repos: [API, SHOP] });
    await first.start();
    expect(await first.view()).toMatchObject({ repo: "api", repos: [] });
  });

  it("writes no pick for an empty name", async () => {
    const { first } = make();
    await first.picked("");
    expect(existsSync(join(dir, "setup", "picked-repo.json"))).toBe(false);
  });
});

describe("ticketOf", () => {
  it("prefers a ticket that waits, then a merged one, then the newest", () => {
    const closed = pr("q1", "a1", { status: "answered", createdAt: 1 });
    const merged = pr("q2", "a1", { status: "withdrawn", lastError: "merged", createdAt: 2 });
    const open = pr("q3", "a1", { createdAt: 3 });
    const late = pr("q4", "a1", { status: "withdrawn", lastError: "closed", createdAt: 4 });
    expect(ticketOf([closed, merged, open, late], "a1")?.id).toBe("q3");
    expect(ticketOf([closed, merged, late], "a1")?.id).toBe("q2");
    expect(ticketOf([closed, late], "a1")?.id).toBe("q4");
    expect(ticketOf([pr("q5", "a1", { kind: "question" } as never)], "a1")).toBeNull();
    expect([ticketState(open), ticketState(merged), ticketState(late), ticketState(pr("q6", "a1", { status: "snoozed" }))]).toEqual(["open", "merged", "closed", "open"]);
  });
});

describe("start", () => {
  it("starts one agent in the repo, with the fixed task and its label", async () => {
    const { first, spawned, changed, logs } = make();
    const r = await first.start();
    expect(r).toMatchObject({ ok: true, view: { repo: "shop", agent: { id: "a1", name: FIRST_AGENT_LABEL, state: "working", startedAt: 1000 } } });
    expect(spawned).toEqual([{ prompt: FIRST_TASK_PROMPT, repo: "/ws/shop", label: FIRST_AGENT_LABEL }]);
    expect(changed()).toBe(1);
    expect(logs).toEqual(["[setup] the first agent started in shop"]);
  });

  it("starts no second agent on a second press", async () => {
    const { first, spawned, records } = make();
    await first.start();
    expect(await first.start()).toMatchObject({ ok: true, view: { agent: { id: "a1" } } });
    records.set("a1", rec("a1", { status: "idle" }));
    await first.start();
    expect(spawned).toHaveLength(1);
  });

  it("starts one agent when two presses come at the same time", async () => {
    const { first, spawned } = make();
    const [a, b] = await Promise.all([first.start(), first.start()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(spawned).toHaveLength(1);
  });

  it("`again` starts a new agent after the first one stopped, but never while it works", async () => {
    const { first, spawned, records } = make();
    await first.start();
    expect(await first.start({ again: true })).toEqual({ ok: false, why: "working" });
    records.set("a1", rec("a1", { status: "idle" }));
    expect(await first.start({ again: true })).toMatchObject({ ok: true, view: { agent: { id: "a2", state: "working" } } });
    expect(spawned).toHaveLength(2);
  });

  it("starts a new agent with a plain press when the first one is gone or ended", async () => {
    const { first, spawned, records } = make();
    await first.start();
    records.delete("a1");
    expect(await first.start()).toMatchObject({ ok: true, view: { agent: { id: "a2" } } });
    records.set("a2", rec("a2", { status: "error" }));
    expect(await first.start()).toMatchObject({ ok: true, view: { agent: { id: "a3" } } });
    expect(spawned).toHaveLength(3);
  });

  it("starts no new agent while a pull request waits for the user", async () => {
    const { first, spawned, items, records } = make();
    await first.start();
    records.set("a1", rec("a1", { status: "idle" }));
    items.push(pr("qfirst001", "a1"));
    expect(await first.start({ again: true })).toMatchObject({ ok: true, view: { agent: { id: "a1" }, ticket: { state: "open" } } });
    expect(spawned).toHaveLength(1);
  });

  it("refuses with no repo, and keeps nothing", async () => {
    const { first, spawned } = make({ repo: null });
    expect(await first.start()).toEqual({ ok: false, why: "no-repo" });
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, "setup"))).toBe(false);
  });

  it("says that the start failed, with the cause only in the log", async () => {
    const { first, logs } = make({ spawnFails: "fatal: '/home/x/ws/shop' is not a git repository" });
    expect(await first.start()).toEqual({ ok: false, why: "failed" });
    expect(logs.join("\n")).toMatch(/did not start/);
    expect((await first.view()).agent).toBeNull();
  });
});
