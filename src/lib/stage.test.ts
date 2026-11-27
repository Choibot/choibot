// src/lib/stage.test.ts — the stage of the Set-up page: which step is on it, the rail, the end
// card, and the signs of life of the first agent.
import { describe, expect, it } from "vitest";
import type { StepStatus } from "../../server/setup/steps";
import { headline, progress, setupRows, type SetupAnswer } from "./setup";
import type { FirstView } from "./setupActions";
import type { ThreadRes } from "./thread";
import { bandAt, BAND_ZONE, endOptions, milestones, nowLine, railParts, rowNote, stageKey, stageStep, threadNow } from "./stage";

const step = (id: string, state: StepStatus["state"], text = `${id} ${state}`): StepStatus =>
  ({ id, title: "t", why: "w", optional: false, state, text } as StepStatus);
const answer = (states: Record<string, StepStatus["state"]>, githubApp = false): SetupAnswer =>
  ({ steps: Object.entries(states).map(([id, s]) => step(id, s)), checkedAt: 1, home: true, ...(githubApp ? { githubApp: true } : {}) });

const BOX = { install: "done", claude: "done", access: "done", pair: "done" } as const;
const OPT = { phone: "todo", telegram: "todo", lead: "blocked" } as const;

describe("stageStep", () => {
  it("waits for the first answer; then shows the step to do now", () => {
    expect(stageStep(setupRows(null), null)).toEqual({ kind: "checking" });
    const rows = setupRows(answer({ ...BOX, github: "todo", repo: "blocked", agent: "blocked", merge: "blocked", ...OPT }));
    const s = stageStep(rows, null);
    expect(s).toMatchObject({ kind: "step", picked: false, row: { id: "github" } });
    expect(stageKey(s)).toBe("github");
  });

  it("a hosted start: the steps that are done get no stage, the first stage is the first open step", () => {
    const rows = setupRows(answer({ install: "done", claude: "todo", access: "done", pair: "done", github: "blocked", repo: "blocked", agent: "blocked", merge: "blocked", ...OPT }));
    expect(stageStep(rows, null)).toMatchObject({ kind: "step", row: { id: "claude" } });
    expect(railParts(rows).map((p) => p.state)).toEqual(["done", "cur", "done", "done", "todo", "todo", "todo", "todo"]);
  });

  it("a done step or an optional step that the user picks is on the stage; a step that waits is not", () => {
    const rows = setupRows(answer({ ...BOX, github: "done", repo: "done", agent: "todo", merge: "blocked", ...OPT }));
    expect(stageStep(rows, "repo")).toMatchObject({ kind: "step", picked: true, row: { id: "repo" } });
    expect(stageStep(rows, "phone")).toMatchObject({ kind: "step", picked: true, row: { id: "phone" } });
    // The pick of the step to do now is no pick.
    expect(stageStep(rows, "agent")).toMatchObject({ kind: "step", picked: false, row: { id: "agent" } });
    // A step that waits for a step before it, or a step that is gone, gives the step to do now.
    expect(stageStep(rows, "merge")).toMatchObject({ row: { id: "agent" } });
    expect(stageStep(rows, "lead")).toMatchObject({ row: { id: "agent" } });
  });

  it("every required step done: the end card, and an optional pick puts that step on the stage", () => {
    const rows = setupRows(answer({ ...BOX, github: "done", repo: "done", agent: "done", merge: "done", ...OPT }));
    expect(stageStep(rows, null)).toEqual({ kind: "end" });
    expect(stageKey(stageStep(rows, null))).toBe("end");
    expect(stageStep(rows, "telegram")).toMatchObject({ kind: "step", picked: true, row: { id: "telegram" } });
    expect(headline(rows)).toBe("Set-up is done");
  });

  it("a required step with no answer keeps the stage at \"checking\": never the end too early", () => {
    const rows = setupRows(answer({ ...BOX, github: "done", repo: "done", agent: "done" }));
    expect(stageStep(rows, null)).toEqual({ kind: "checking" });
  });
});

describe("one count", () => {
  it("the ChoiBot app: GitHub and the repo are one step and one part of the rail (7)", () => {
    const states = { ...BOX, github: "done", repo: "todo", agent: "blocked", merge: "blocked", ...OPT } as const;
    const app = setupRows(answer(states, true));
    expect(railParts(app)).toHaveLength(7);
    expect(railParts(app).find((p) => p.id === "github")?.state).toBe("cur");
    expect(progress(app)).toEqual({ done: 4, total: 7 });
    expect(headline(app)).toBe("Step 5 of 7 · Connect GitHub");
    // With no app: 8 parts, and "Pick a repo" is its own step.
    const two = setupRows(answer(states));
    expect(railParts(two)).toHaveLength(8);
    expect(progress(two)).toEqual({ done: 5, total: 8 });
  });
});

describe("the note of a row", () => {
  it("done: its line; optional: the minutes of its why; the step to do now: none", () => {
    const rows = setupRows(answer({ ...BOX, github: "todo", repo: "blocked", agent: "blocked", merge: "blocked", ...OPT }));
    const note = (id: string) => rowNote(rows.find((r) => r.id === id)!);
    expect(note("claude")).toBe("claude done");
    expect(note("github")).toBeNull();
    expect(note("agent")).toBe("Waits");
    expect(note("phone")).toBe("1 minute");
    expect(note("telegram")).toBe("3 minutes");
    expect(note("lead")).toBe("Waits");
  });
});

describe("endOptions", () => {
  it("shows 3 optional steps at most, then how many more", () => {
    const rows = setupRows(answer({ ...BOX, github: "done", repo: "done", agent: "done", merge: "done", ...OPT }));
    const three = endOptions(rows);
    expect(three.shown.map((r) => r.id)).toEqual(["phone", "telegram", "lead"]);
    expect(three.more).toBe(0);
    expect(endOptions(rows, 2)).toMatchObject({ more: 1 });
  });
});

describe("the signs of life of the first agent", () => {
  const view = (o: Omit<Partial<FirstView>, "agent"> & { agent?: Partial<NonNullable<FirstView["agent"]>> | null } = {}): FirstView => ({
    task: "t", repo: "r", repos: [], now: 0, ticket: null, ...o,
    agent: o.agent === null ? null : { id: "a1", name: "agent-1", state: "working", startedAt: 0, pullRequest: false, ...o.agent },
  } as FirstView);

  it("the band is a time on an axis of 8 minutes, with the usual zone at 3 to 6 minutes", () => {
    expect(BAND_ZONE).toEqual({ from: 0.375, width: 0.375 });
    expect(bandAt(view({ now: 0 }))).toBe(0);
    expect(bandAt(view({ now: 2 * 60_000 }))).toBe(0.25);
    expect(bandAt(view({ now: 30 * 60_000 }))).toBe(1);
    // Only while the agent works and no ticket is there.
    expect(bandAt(view({ agent: { state: "error" } }))).toBeNull();
    // no session yet: the task did not start, so no time of the task
    expect(bandAt(view({ now: 2 * 60_000, agent: { noSession: true } }))).toBeNull();
    expect(bandAt(view({ ticket: { id: "q1", state: "open" } as FirstView["ticket"] }))).toBeNull();
    expect(bandAt(view({ agent: null }))).toBeNull();
    expect(bandAt(null)).toBeNull();
  });

  it("the marks: started, the pull request, the ticket in the Queue", () => {
    const marks = (v: FirstView | null) => milestones(v).map((m) => `${m.done ? "✓" : "○"} ${m.label}`);
    expect(marks(view({ agent: null }))).toEqual(["○ Started", "○ Pull request", "○ Ticket in the Queue"]);
    expect(marks(view())).toEqual(["✓ Started", "○ Pull request", "○ Ticket in the Queue"]);
    expect(marks(view({ agent: { pullRequest: true } }))).toEqual(["✓ Started", "✓ Pull request", "○ Ticket in the Queue"]);
    expect(marks(view({ ticket: { id: "q1", state: "open" } as FirstView["ticket"] }))).toEqual(["✓ Started", "✓ Pull request", "✓ Ticket in the Queue"]);
  });

  it("reads the open step from the last page of the agent's thread", () => {
    const page = (items: unknown[], status = "running") => ({ ok: true, sessionId: "s", status, now: 9, items, start: null, end: 9 }) as unknown as ThreadRes;
    const step = { kind: "step", id: "t1", ts: 5, tool: "Edit", label: "Edit …/README.md" };
    expect(threadNow(page([{ kind: "user", id: "u", ts: 1, text: "go" }, step]))).toBe("Edit …/README.md");
    expect(threadNow(page([step], "idle"))).toBeNull();
    expect(threadNow(page([{ ...step, end: 6 }]))).toBeNull();
    expect(threadNow({ ok: false, reason: "no-file", status: "running", now: 1 })).toBeNull();
    expect(threadNow(null)).toBeNull();
  });

  it("says what the agent does now, or nothing", () => {
    expect(nowLine("Edit …/README.md")).toBe("Now: Edit …/README.md");
    expect(nowLine("  ")).toBeNull();
    expect(nowLine(null)).toBeNull();
  });
});
