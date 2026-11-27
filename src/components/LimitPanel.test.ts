// src/components/LimitPanel.test.ts — the usage-limit ticket's block shows each row's state and
// only the buttons that fit it: no Continue while a menu of Claude is on the screen, "Move all" and
// "Continue all" only for 2 rows or more, no button on a closed ticket or on a device that is not
// paired.
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LimitInfo, LimitRow } from "../../server/chief/limit/ticket";
import type { QueueItem } from "../../server/chief/queue/types";
import { LimitPanel } from "./LimitPanel";

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
// The test runner compiles JSX to React.createElement (the app's bundler does not need the name).
(globalThis as { React?: unknown }).React = React;

let n = 0;
const row = (over: Partial<LimitRow>): LimitRow => {
  n += 1;
  return { agentId: `w${n}`, key: `w${n}@1`, tag: `0000000${n}`.slice(-8), name: `Worker ${n}`, login: "main", loginName: "Main",
    until: null, room: false, state: "blocked", ...over };
};
const item = (limit: LimitInfo, status: QueueItem["status"] = "open"): QueueItem => ({
  id: "q00000001", kind: "limit", status, agentId: "console", createdBy: { agentId: "console", kind: "console" },
  repo: "", area: "", title: "Usage limit", body: "", createdAt: 1, updatedAt: 1, blocking: false, history: [], answerSeq: 0, limit,
}) as QueueItem;
const SPARE = { id: "spare", name: "Spare" };

function show(it: QueueItem, readOnly = false): { text: string; buttons: string[]; html: string } {
  const html = renderToStaticMarkup(createElement(LimitPanel, { item: it, readOnly, userAuth: "log" }));
  const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  return { text, buttons, html };
}

describe("LimitPanel", () => {
  it("a row with a menu of Claude on its screen has no Continue, also when its login has room", () => {
    const v = show(item({ rows: [row({ state: "answer-menu", room: true, name: "Lead · console" })], to: SPARE }));
    expect(v.text).toContain("Lead · console Main · Answer its menu first");
    expect(v.buttons).toEqual(["Move to Spare"]);
  });

  it("'Move all' only for 2 rows or more that can move; 'Continue all' only for 2 rows or more that can go on", () => {
    // Two rows can move, one can go on: "Move all" and no "Continue all".
    const two = show(item({ rows: [row({}), row({ room: true })], to: SPARE }));
    expect(two.buttons).toEqual(["Move to Spare", "Move to Spare", "Continue", "Move all to Spare"]);
    // One row: no "all" button at all.
    const one = show(item({ rows: [row({ room: true })], to: SPARE }));
    expect(one.buttons).toEqual(["Move to Spare", "Continue"]);
    // Two rows that can go on and no login to move to: "Continue all" alone.
    const go = show(item({ rows: [row({ room: true }), row({ room: true }), row({ state: "answer-menu", room: true })] }));
    expect(go.buttons).toEqual(["Continue", "Continue", "Continue all"]);
    expect(go.text).toContain("Answer its menu first");
  });

  it("a row that goes on, or moves when quiet, has no button and says so", () => {
    const v = show(item({ rows: [row({ state: "going-on", room: true }), row({ state: "moves-when-quiet" })], to: SPARE }));
    expect(v.buttons).toEqual([]);
    expect(v.text).toContain("Going on");
    expect(v.text).toContain("Moves when quiet");
  });

  it("a long login name: the button's label can end in an ellipsis, its title holds the whole name", () => {
    const long = { id: "spare", name: "A login with a very long name that does not fit a phone" };
    const v = show(item({ rows: [row({}), row({})], to: long }));
    expect(v.html).toContain(`title="Move all to ${long.name}"`);
    expect(v.html).toMatch(/<button[^>]*><span[^>]*>Move all to A login with a very long name/);
  });

  it("no button on a closed ticket or on a device that is not paired (that one says how to pair)", () => {
    const info = { rows: [row({ room: true }), row({ room: true })], to: SPARE };
    expect(show(item(info, "withdrawn")).buttons).toEqual([]);
    const ro = show(item(info), true);
    expect(ro.buttons).toEqual([]);
    expect(ro.text).toContain("A move needs a paired device");
  });

  it("no login with room and nothing to go on: one plain line says so", () => {
    const v = show(item({ rows: [row({ until: null })] }));
    expect(v.buttons).toEqual([]);
    expect(v.text).toContain("Blocked");
    expect(v.text).toContain("No login has room now.");
  });
});
