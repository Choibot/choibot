// src/lib/choiScene.test.ts — the scene over the step card: which parts of the server stand for
// the steps that are done, what the robot does, and that a poll with the same state gives the
// same scene.
import { describe, expect, it } from "vitest";
import type { StepStatus } from "../../server/setup/steps";
import { BRAND_MARK } from "./brandMark";
import { agentPhase, BUILD, doneSteps, rects, sceneOf, SPRITES } from "./choiScene";
import { setupRows, type SetupAnswer } from "./setup";
import type { FirstView } from "./setupActions";

const step = (id: string, state: StepStatus["state"], text = `${id} ${state}`): StepStatus =>
  ({ id, title: "t", why: "w", optional: false, state, text } as StepStatus);
const answer = (states: Record<string, StepStatus["state"]>, o: { githubApp?: boolean; checkedAt?: number; text?: string } = {}): SetupAnswer =>
  ({ steps: Object.entries(states).map(([id, s]) => step(id, s, o.text ? `${id} ${o.text}` : undefined)), checkedAt: o.checkedAt ?? 1, home: true, ...(o.githubApp ? { githubApp: true } : {}) });

const ORDER = ["install", "claude", "access", "pair", "github", "repo", "agent", "merge"] as const;
const OPT = { phone: "todo", telegram: "todo", lead: "blocked" } as const;
// The steps before `cur` are done, `cur` is open, the later ones wait. cur null: all done.
const at = (cur: (typeof ORDER)[number] | null): Record<string, StepStatus["state"]> => {
  const c = cur ? ORDER.indexOf(cur) : ORDER.length;
  return { ...Object.fromEntries(ORDER.map((id, i) => [id, i < c ? "done" : i === c ? "todo" : "blocked"])), ...OPT };
};
const rowsAt = (cur: (typeof ORDER)[number] | null, githubApp = false) => setupRows(answer(at(cur), { githubApp }));

const first = (agent: Partial<NonNullable<FirstView["agent"]>> | null, ticket: FirstView["ticket"] = null): FirstView =>
  ({ task: "t", repo: "r", repos: [], now: 60_000, ticket, agent: agent && { id: "a1", name: "agent-1", state: "working", startedAt: 0, pullRequest: false, ...agent } } as FirstView);

describe("sceneOf: the steps build the server", () => {
  it("no answer yet: no scene", () => {
    expect(sceneOf(setupRows(null), "none")).toEqual({ parts: "", act: "none" });
    expect(sceneOf([], "none")).toEqual({ parts: "", act: "none" });
  });

  it("one part more with each step that is done, in the order of the list", () => {
    expect(sceneOf(rowsAt("install"), "none")).toEqual({ parts: "", act: "wait" });
    expect(sceneOf(rowsAt("claude"), "none")).toEqual({ parts: "walls", act: "wait" });
    expect(sceneOf(rowsAt("access"), "none")).toEqual({ parts: "walls roof", act: "wait" });
    expect(sceneOf(rowsAt("pair"), "none")).toEqual({ parts: "walls roof window", act: "wait" });
    expect(sceneOf(rowsAt("github"), "none")).toEqual({ parts: "walls roof window door", act: "wait" });
    expect(sceneOf(rowsAt("repo"), "none")).toEqual({ parts: "walls roof window door server", act: "wait" });
    expect(sceneOf(rowsAt("agent"), "none")).toEqual({ parts: "walls roof window door server lights", act: "wait" });
    expect(BUILD.map((b) => b.step)).toEqual(ORDER.slice(0, 6));
  });

  it("a hosted start: the parts of every step that is done stand at once", () => {
    const rows = setupRows(answer({ install: "done", claude: "todo", access: "done", pair: "done", github: "blocked", repo: "blocked", agent: "blocked", merge: "blocked", ...OPT }));
    expect(sceneOf(rows, "none")).toEqual({ parts: "walls window door", act: "wait" });
  });

  it("the GitHub app (7 steps): the same parts as the 8 steps", () => {
    for (const cur of ORDER) expect(sceneOf(rowsAt(cur, true), "none")).toEqual(sceneOf(rowsAt(cur), "none"));
    expect(sceneOf(rowsAt(null, true), "none")).toEqual(sceneOf(rowsAt(null), "none"));
    // GitHub done, the repo not yet: the one row draws the repo part; the server stands, its lights wait.
    const rows = rowsAt("repo", true);
    expect(rows.find((r) => r.id === "github")).toMatchObject({ app: true, part: "repo", state: "turn" });
    expect([...doneSteps(rows)]).toContain("github");
    expect(sceneOf(rows, "none").parts).toBe("walls roof window door server");
  });

  it("the first agent: it waits for the press, works, stops, or its pull request is there", () => {
    const rows = rowsAt("agent");
    expect(sceneOf(rows, "none").act).toBe("wait");
    expect(sceneOf(rows, "work").act).toBe("work");
    expect(sceneOf(rows, "stop").act).toBe("stop");
    expect(sceneOf(rows, "pr").act).toBe("pr");
  });

  it("the merge step: the robot moved in; every step done: the end", () => {
    expect(sceneOf(rowsAt("merge"), "none")).toEqual({ parts: "walls roof window door server lights", act: "pr" });
    expect(sceneOf(rowsAt("merge"), "stop").act).toBe("pr");
    expect(sceneOf(rowsAt(null), "work")).toEqual({ parts: "walls roof window door server lights", act: "end" });
  });

  it("a poll with the same state gives the same scene (new objects, a new time, new words)", () => {
    for (const cur of [...ORDER, null] as const) {
      const a = sceneOf(setupRows(answer(at(cur), { checkedAt: 1, text: "one" })), "work");
      const b = sceneOf(setupRows(answer(at(cur), { checkedAt: 99, text: "two" })), "work");
      expect(b).toEqual(a);
      expect(`${b.act}|${b.parts}`).toBe(`${a.act}|${a.parts}`);
    }
  });
});

describe("agentPhase: the first agent, in the words of its card", () => {
  it("each state of the agent and its ticket", () => {
    expect(agentPhase(null)).toBe("none");
    expect(agentPhase(first(null))).toBe("none");
    expect(agentPhase(first({}))).toBe("work");
    expect(agentPhase(first({ startedAt: -20 * 60_000 }))).toBe("work");
    expect(agentPhase(first({ state: "error", error: "Usage limit reached" }))).toBe("stop");
    // no session after 90 s ("Open its terminal"): Claude waits for the user, the calm sign
    expect(agentPhase(first({ noSession: true }))).toBe("stop");
    expect(agentPhase(first({ state: "waiting", noSession: true }))).toBe("stop");
    expect(agentPhase(first({ noSession: false }))).toBe("work");
    // a dialog of Claude on its card ("Waiting for you"): the same calm sign
    expect(agentPhase(first({ dialog: "folder-trust" }))).toBe("stop");
    expect(agentPhase(first({ state: "waiting", dialog: "folder-trust" }))).toBe("stop");
    for (const state of ["waiting", "ended", "closed", "gone"] as const) expect(agentPhase(first({ state }))).toBe("stop");
    expect(agentPhase(first({ state: "waiting", pullRequest: true }))).toBe("stop");
    expect(agentPhase(first({ state: "waiting", pullRequest: true }, { id: "q1", state: "open" }))).toBe("pr");
    expect(agentPhase(first({ state: "waiting", pullRequest: true }, { id: "q1", state: "merged" }))).toBe("pr");
    expect(agentPhase(first({ state: "waiting", pullRequest: true }, { id: "q1", state: "closed" }))).toBe("stop");
  });
});

describe("sprites", () => {
  it("the robot is the brand mark: antenna and body give back its rows (legs are their own parts)", () => {
    const join = SPRITES.ant.map((r, y) => [...r].map((c, x) => (c === "#" || SPRITES.body[y]![x] === "#" ? "#" : ".")).join(""));
    expect(join).toEqual(BRAND_MARK.map((r, y) => (y >= 10 ? ".".repeat(12) : r)));
  });

  it("rects covers every ink cell once and no other cell", () => {
    for (const rows of Object.values(SPRITES)) {
      const seen = rows.map((r) => [...r].map(() => 0));
      for (const [x, y, w, h] of rects(rows)) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) seen[j]![i]!++;
      expect(seen.map((r) => r.map((n) => (n === 1 ? "#" : n === 0 ? "." : "!")).join(""))).toEqual([...rows]);
    }
  });
});
