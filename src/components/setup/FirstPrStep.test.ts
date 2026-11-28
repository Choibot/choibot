// src/components/setup/FirstPrStep.test.ts — the "Merge the first PR" step: the card of the pull
// request with ONE Merge (the Queue's own button, so the ticket's route and its gates), the checks
// in one short line, "Open on GitHub" as a quiet second action, and no way to the Queue or to a
// thread. The card draws from the page's memory (lib/setupMemory), as on its first frame.
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../../server/chief/queue/types";
import { USER_TOKEN_KEY } from "../../lib/chief";
import type { FirstView } from "../../lib/setupActions";
import { rememberFirst, ticketMemory } from "../../lib/setupMemory";
import { MergeButton } from "../QueueMerge";
import { FirstPrStep } from "./FirstPrStep";

vi.mock("../../app/fonts", () => ({ geistSans: { style: { fontFamily: "a" }, variable: "" }, geistMono: { style: { fontFamily: "b" }, variable: "" } }));

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
(globalThis as { React?: unknown }).React = React;

const BODY = "WHAT_THE_AGENT_DID: one section in the README.";
const ticket = (id: string, agentId: string, pr: object = {}, o: Partial<QueueItem> = {}): QueueItem => ({
  id, kind: "pr", agentId, createdBy: { agentId, kind: "worker" }, repo: "shop", area: "shop", title: "README: add Run it locally", body: BODY,
  createdAt: 10, updatedAt: 10, status: "open", blocking: false, history: [], answerSeq: 0,
  pr: { url: "https://github.com/acme/shop/pull/128", number: 128, checks: "success", mergeable: "MERGEABLE", ...pr }, ...o,
} as QueueItem);
const view = (o: Partial<FirstView>): FirstView => ({ task: "t", repo: "shop", repos: ["shop"], agent: null, ticket: null, now: 1, ...o } as FirstView);

// Primes the page's memory as the step before it left it, then draws the step as the stage does.
// (`nav` is for the older component, so the same test runs against main.)
function draw(v: FirstView, items: QueueItem[], stage = true): string {
  rememberFirst(v);
  for (const i of items) ticketMemory.set(i.id, i);
  return renderToStaticMarkup(createElement(FirstPrStep, { onDone: async () => {}, stage, nav: {} } as never));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ");
const count = (html: string, re: RegExp) => [...html.matchAll(re)].length;
const mergeButton = (html: string) => html.match(/<button[^>]*aria-label="Merge PR #128"[^>]*>/)?.[0] ?? "";

// A paired browser: the Merge of the Queue is live only with a user token.
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: (k: string) => (k === USER_TOKEN_KEY ? "tok_abcdefghijklmnop" : null) }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("FirstPrStep: merge on the set-up card", () => {
  it("the first agent's pull request: its title, ONE Merge with no method menu, the checks line, Open on GitHub quiet", () => {
    const item = ticket("qfirst001", "a1");
    const html = draw(view({ ticket: { id: "qfirst001", state: "open" } }), [item]);
    expect(html).toContain("acme/shop #128");
    expect(html).toContain("README: add Run it locally");
    expect(html).toContain("Checks pass.");
    // The Queue's own Merge (QueueMerge), drawn as the Queue draws it with no method menu: the same
    // button, so the same press, route (POST /api/queue/:id/merge) and gates.
    expect(count(html, /data-merge=""/g)).toBe(1);
    expect(count(html, /aria-label="Merge PR #128"/g)).toBe(1);
    expect(html).toContain(renderToStaticMarkup(createElement(MergeButton, { item, readOnly: false, userAuth: null, phone: true, methods: false })));
    expect(html).not.toContain("aria-haspopup=\"menu\"");
    expect(html).not.toContain("Merge method");
    expect(mergeButton(html)).not.toContain("disabled");
    // One main action: Merge is the only primary button; GitHub is a quiet link.
    expect(html).toMatch(/<a class="[^"]*quiet[^"]*" href="https:\/\/github.com\/acme\/shop\/pull\/128" target="_blank" rel="noopener noreferrer">Open on GitHub/);
    // No way to the Queue or to an agent's thread.
    expect(text(html)).not.toMatch(/queue|thread/i);
    expect(html).not.toContain("Open the Queue");
  });

  it("the Queue's own ticket keeps its method menu (methods is on unless the card turns it off)", () => {
    const queue = renderToStaticMarkup(createElement(MergeButton, { item: ticket("qfirst001", "a1"), readOnly: false, userAuth: null, phone: false }));
    expect(queue).toContain("aria-haspopup=\"menu\"");
    expect(queue).toContain("aria-label=\"Merge method: Squash and merge\"");
  });

  it("on the stage: what the agent did is in a closed More; off the stage it is in the card", () => {
    const v = view({ ticket: { id: "qfirst001", state: "open" } });
    const html = draw(v, [ticket("qfirst001", "a1")]);
    expect(html).toContain("More: what the agent did");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("ticketBody");
    // Off the stage: the body in the card at once (Md sets its text in the browser), no More.
    const off = draw(v, [ticket("qfirst001", "a1")], false);
    expect(off).toContain("ticketBody");
    expect(off).not.toContain("More: what the agent did");
  });

  it.each([
    ["pending", "Checks still run. Merge asks you first."],
    ["failure", "A check fails. Merge asks you first."],
  ])("checks %s: one short line, and Merge stays live (the Queue asks first, as on the ticket)", (checks, line) => {
    const html = draw(view({ ticket: { id: "qfirst001", state: "open" } }), [ticket("qfirst001", "a1", { checks })]);
    expect(count(html, /data-part="checks"/g)).toBe(1);
    expect(html).toContain(`>${line}</p>`);
    expect(mergeButton(html)).not.toBe("");
    expect(mergeButton(html)).not.toContain("disabled");
    expect(text(html)).not.toMatch(/queue|thread/i);
  });

  it("conflicts: the Queue's line and Merge off, as on the ticket; no checks line", () => {
    const html = draw(view({ ticket: { id: "qfirst001", state: "open" } }), [ticket("qfirst001", "a1", { mergeable: "CONFLICTING", checks: "failure" })]);
    expect(html).toContain("PR #128 has conflicts. Fix them first.");
    expect(mergeButton(html)).toContain("disabled");
    expect(html).not.toContain("data-part=\"checks\"");
    expect(html).toContain("Open on GitHub");
  });

  it("a browser that is not paired: Merge off, as in the Queue", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const html = draw(view({ ticket: { id: "qfirst001", state: "open" } }), [ticket("qfirst001", "a1")]);
    expect(mergeButton(html)).toContain("disabled");
  });

  it("another agent's pull request waits (the first agent has none): the card merges it here, not in the Queue", () => {
    const html = draw(view({ ticket: null, other: { id: "qother002" } }), [ticket("qother002", "u2", { number: 7, url: "https://github.com/acme/shop/pull/7" })]);
    expect(count(html, /aria-label="Merge PR #7"/g)).toBe(1);
    expect(html).toContain("acme/shop #7");
    expect(text(html)).not.toMatch(/queue|thread/i);
  });

  it("the first agent's pull request was closed, another one waits: the card of the other one", () => {
    const closed = ticket("qfirst001", "a1", {}, { status: "withdrawn", lastError: "closed" });
    const html = draw(view({ ticket: { id: "qfirst001", state: "closed" }, other: { id: "qother002" } }), [closed, ticket("qother002", "u2", { number: 7 })]);
    expect(count(html, /aria-label="Merge PR #7"/g)).toBe(1);
    expect(html).not.toContain("was closed and not merged");
  });

  it("merged: the card says Merged, with no Merge; Open on GitHub stays", () => {
    const merged = ticket("qfirst001", "a1", {}, { status: "withdrawn", lastError: "merged" });
    const html = draw(view({ ticket: { id: "qfirst001", state: "merged" } }), [merged]);
    expect(html).toMatch(/role="status"><svg[^]*?<\/svg>Merged<\/span>/);
    expect(html).not.toContain("data-merge=\"\"");
    expect(html).not.toContain("aria-label=\"Merge PR #128\"");
    expect(html).toContain("Open on GitHub");
    expect(text(html)).not.toMatch(/queue|thread/i);
  });

  it("no pull request waits at all: Start the first task again, and no Queue", () => {
    const closed = ticket("qfirst001", "a1", {}, { status: "withdrawn", lastError: "closed" });
    const html = draw(view({ ticket: { id: "qfirst001", state: "closed" }, other: null }), [closed]);
    expect(html).toContain("Start the first task again");
    expect(text(html)).not.toMatch(/queue|thread/i);
  });
});
