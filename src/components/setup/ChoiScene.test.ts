// src/components/setup/ChoiScene.test.ts — the scene over the step card: its values come from the
// steps and the first agent; the same state draws the same markup; a change gives the act before
// it and the parts that came.
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StepStatus } from "../../../server/setup/steps";
import { setupRows, type SetupAnswer } from "../../lib/setup";
import { Art, ChoiScene, nextSeen } from "./ChoiScene";

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
(globalThis as { React?: unknown }).React = React;

const ORDER = ["install", "claude", "access", "pair", "github", "repo", "agent", "merge"] as const;
const answer = (cur: (typeof ORDER)[number] | null, checkedAt = 1): SetupAnswer => {
  const c = cur ? ORDER.indexOf(cur) : ORDER.length;
  const states = { ...Object.fromEntries(ORDER.map((id, i) => [id, i < c ? "done" : i === c ? "todo" : "blocked"])), phone: "todo", telegram: "todo", lead: "blocked" };
  return { steps: Object.entries(states).map(([id, state]) => ({ id, title: "t", why: "w", optional: false, state, text: `${id} ${checkedAt}` }) as StepStatus), checkedAt, home: true };
};
const render = (a: SetupAnswer | null, phone = false) => renderToStaticMarkup(createElement(ChoiScene, { rows: setupRows(a), phone }));

describe("ChoiScene", () => {
  it("is decoration: hidden from a screen reader, no words", () => {
    const html = render(answer("pair"));
    expect(html).toMatch(/^<div [^>]*aria-hidden="true"/);
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
  });

  it("draws the values of the steps: the act and the parts that stand", () => {
    expect(render(null)).toContain('data-act="none" data-parts="" data-n="0"');
    expect(render(answer("install"))).toContain('data-act="wait" data-parts="" data-n="0"');
    expect(render(answer("pair"))).toContain('data-act="wait" data-parts="walls roof window" data-n="3"');
    expect(render(answer("merge"))).toContain('data-act="pr" data-parts="walls roof window door server lights" data-n="6"');
    expect(render(answer(null))).toContain('data-act="end"');
    // the first state moves nothing: no act before it, no new part, no cheer
    for (const cur of [...ORDER, null] as const) expect(render(answer(cur))).not.toMatch(/data-(from|new|cheer)/);
  });

  it("a poll with the same state draws the same markup (new time, new words)", () => {
    for (const cur of [...ORDER, null] as const) expect(render(answer(cur, 99))).toBe(render(answer(cur, 1)));
  });

  it("the phone: a smaller band", () => {
    expect(render(answer("pair"), true)).toMatch(/^<div [^>]*data-phone=""/);
    expect(render(answer("pair"))).not.toContain("data-phone");
  });

  it("the art is a memo of strings: a poll that brings the same values draws nothing again", () => {
    expect((Art as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});

describe("nextSeen: what a change of the scene tells its CSS", () => {
  it("the first real state: nothing moves", () => {
    expect(nextSeen("none|", "wait", "walls")).toEqual({ key: "wait|walls", from: null, added: "", cheer: false });
    expect(nextSeen("none|", "end", "walls roof")).toMatchObject({ from: null, cheer: false });
  });
  it("a step done: the act before it and the part that came", () => {
    expect(nextSeen("wait|walls", "wait", "walls roof")).toEqual({ key: "wait|walls roof", from: "wait", added: "roof", cheer: false });
    expect(nextSeen("wait|", "wait", "walls window door")).toMatchObject({ added: "walls window door" });
    expect(nextSeen("wait|walls roof", "work", "walls roof")).toMatchObject({ from: "wait", added: "" });
  });
  it("the end: a cheer only when this page saw the change", () => {
    expect(nextSeen("pr|walls", "end", "walls")).toMatchObject({ from: "pr", cheer: true });
    expect(nextSeen("work|walls", "end", "walls")).toMatchObject({ from: "work", cheer: true });
    expect(nextSeen("end|walls", "end", "walls roof")).toMatchObject({ cheer: false });
    expect(nextSeen("end|walls", "none", "")).toMatchObject({ from: null, cheer: false });
  });
});
