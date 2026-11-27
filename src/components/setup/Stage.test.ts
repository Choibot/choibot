// src/components/setup/Stage.test.ts — the stage of the Set-up page draws one step, the rail and
// the fold "All steps"; the wait for the first answer; the end card.
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STEPS, type StepStatus } from "../../../server/setup/steps";
import type { SetupAnswer } from "../../lib/setup";
import type { SetupView } from "../../lib/useSetup";
import type { FirstView } from "../../lib/setupActions";
import { AgentState } from "./FirstAgentStep";
import { SetupStage } from "./Stage";

// The ticket of the merge step draws with the console's fonts (next/font, which runs only in the
// app's build). The stage needs no font file.
vi.mock("../../app/fonts", () => ({ geistSans: { style: { fontFamily: "a" }, variable: "" }, geistMono: { style: { fontFamily: "b" }, variable: "" } }));

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
// The test runner compiles JSX to React.createElement (the app's bundler does not need the name).
(globalThis as { React?: unknown }).React = React;

const step = (id: string, state: StepStatus["state"]): StepStatus => {
  const s = STEPS.find((x) => x.id === id)!;
  return { id, title: s.title, why: s.why, optional: s.optional, state, text: `${id} ${state}` } as StepStatus;
};
const answer = (states: Record<string, StepStatus["state"]>): SetupAnswer =>
  ({ steps: Object.entries(states).map(([id, s]) => step(id, s)), checkedAt: 1, home: true });
const view = (a: SetupAnswer | null, o: Partial<SetupView> = {}): SetupView => ({ answer: a, checking: false, failed: false, refresh: async () => {}, ...o });
const render = (v: SetupView, onLeave?: () => void) => renderToStaticMarkup(createElement(SetupStage, { setup: v, nav: { onLeave } }));
const count = (html: string, re: RegExp) => [...html.matchAll(re)].length;

const OPT = { phone: "todo", telegram: "todo", lead: "blocked" } as const;

describe("SetupStage", () => {
  it("before the first answer: the wait, an empty rail, and the fold with no count", () => {
    const html = render(view(null));
    expect(html).toContain("Checking the steps…");
    expect(html).toContain(">All steps<");
    expect(html).not.toContain("data-state=\"done\"><b>");
    expect(html).toContain("data-still");
  });

  it("no answer from the console: the sentence and Check again", () => {
    const html = render(view(null, { failed: true }));
    expect(html).toContain("The console did not answer. Press Check again.");
    expect(html).toContain("Check again");
  });

  it("one step on the stage: its card, its part on the rail, the count in the fold", () => {
    const html = render(view(answer({ install: "done", claude: "done", access: "todo", pair: "blocked", github: "blocked", repo: "blocked", agent: "blocked", merge: "blocked", ...OPT })));
    const access = STEPS.find((s) => s.id === "access")!;
    // One card, the step to do now, with no state word (the line over it says "Step 3 of 8").
    expect(count(html, /<section /g)).toBe(1);
    expect(html).toContain(`data-step="access" data-state="turn"`);
    expect(html).toContain(`>${access.title}</h2>`);
    expect(html).toContain(`Step 3 of 8 · ${access.title}`);
    // 8 rail parts: 2 done, the step to do now, 5 later.
    expect(count(html, /<i data-state="done"><b><\/b><\/i>/g)).toBe(2);
    expect(count(html, /<i data-state="cur"><b><\/b><\/i>/g)).toBe(1);
    expect(count(html, /<i data-state="todo"><b><\/b><\/i>/g)).toBe(5);
    expect(html).toContain("aria-valuenow=\"2\"");
    expect(html).toContain("All steps · 2 of 8 done");
    // The fold is closed: no row of the list is in the page.
    expect(html).not.toContain("Optional, after the end");
  });

  it("every required step done: the end card with 3 optional steps and the way to the console", () => {
    const done = { install: "done", claude: "done", access: "done", pair: "done", github: "done", repo: "done", agent: "done", merge: "done" } as const;
    const html = render(view(answer({ ...done, ...OPT })), () => {});
    expect(html).toContain("Set-up is done");
    expect(html).toContain("What next. Each one is optional.");
    expect(count(html, /<li data-step="/g)).toBe(3);
    // The phone and Telegram can go on the stage; the lead waits for its step before it.
    expect(count(html, /<button type="button" class="[^"]*option/g)).toBe(2);
    expect(html).toContain("Open the console");
    expect(html).not.toContain("+");
  });
});

describe("the first agent on the stage", () => {
  const first = (agent: Partial<NonNullable<FirstView["agent"]>>, o: Partial<FirstView> = {}): FirstView =>
    ({ task: "t", repo: "r", repos: [], now: 3 * 60_000, ticket: null, ...o, agent: { id: "a1", name: "agent-1", state: "working", startedAt: 0, pullRequest: false, ...agent } } as FirstView);
  const draw = (v: FirstView, now: string | null) =>
    renderToStaticMarkup(createElement(AgentState, { view: v, set: () => {}, onChange: () => {}, stage: { now }, more: { label: "the task", body: "TASK" } }));

  it("while it works: what it does now, the band of time, the marks, and the task in a closed More", () => {
    const html = draw(first({}), "Edit …/README.md");
    expect(html).toContain("Now: Edit …/README.md");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("translateX(37.50%)");
    expect(count(html, /<li data-done="">/g)).toBe(1);
    expect(html).toContain("Ticket in the Queue");
    expect(html).toContain("More: the task");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("TASK");
  });

  it("an error: the words of the stop only, no band and no marks", () => {
    const html = draw(first({ state: "error" }), null);
    expect(html).toContain("The agent stopped with an error.");
    expect(html).not.toContain("role=\"img\"");
    expect(html).not.toContain("Ticket in the Queue");
    expect(html).not.toContain("Now:");
    // Try again only: the set-up sends the user to no thread of the agent.
    expect(html).toContain(">Try again</button>");
    expect(count(html, /<button /g)).toBe(2);
    expect(html).not.toMatch(/thread/i);
  });

  it("an error with the error's own sentence: that sentence under the line", () => {
    const html = draw(first({ state: "error", error: "Usage limit reached" }), null);
    expect(html).toMatch(/The agent stopped with an error\.<\/span><\/div><p class="[^"]*">Usage limit reached<\/p>/);
    expect(html).not.toMatch(/thread/i);
  });

  it("no session after 90 s: its line, Open its terminal in the place of the actions, no band, no marks, no thread", () => {
    const v = first({ noSession: true });
    const html = renderToStaticMarkup(createElement(AgentState, { view: v, set: () => {}, onChange: () => {}, onOpenTerminal: () => {}, stage: { now: null }, more: { label: "the task", body: "TASK" } }));
    expect(html).toContain("No session started yet.");
    expect(html).toContain("Its terminal shows what Claude waits for.");
    expect(html).toMatch(/<div class="[^"]*acts[^"]*"><button type="button" class="[^"]*primary[^"]*">Open its terminal<\/button>/);
    expect(html).not.toContain("role=\"img\"");
    expect(html).not.toContain("Ticket in the Queue");
    expect(html).not.toMatch(/thread/i);
    // with no terminal handler (no place to open it), no button
    expect(draw(v, null)).not.toContain("Open its terminal");
  });

  it("while it works, and when its pull request is open: no way to the thread of the agent", () => {
    for (const v of [first({}), first({ startedAt: -20 * 60_000 }), first({ state: "waiting", pullRequest: true }), first({ state: "waiting" }, { ticket: { id: "q1", state: "open" } })]) {
      expect(draw(v, "Edit …/README.md")).not.toMatch(/thread/i);
    }
    expect(draw(first({}), null)).toContain("You can close this page: the agent keeps working.");
  });
});
