// src/components/setup/RepoStep.test.ts — the card of the repo part while the ChoiBot app reaches
// no repo yet: before the trip moved (the link to GitHub is the action) and after it (the person
// picks in the GitHub tab; the link is only a way back).
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChooseCard } from "./RepoStep";

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
(globalThis as { React?: unknown }).React = React;

const APP = "https://github.com/apps/choibot";
const card = (o: Partial<React.ComponentProps<typeof ChooseCard>> = {}) =>
  renderToStaticMarkup(createElement(ChooseCard, { appUrl: APP, moved: false, emptyReads: 0, reading: false, listErr: "", onRead: () => {}, ...o }));

describe("the choice of repos on GitHub", () => {
  it("links straight to the app's install page, with no Referer and no way back to this page", () => {
    const html = card();
    expect(html).toContain(`href="${APP}/installations/new"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Choose repos on GitHub");
    expect(html).toContain("Read the list again");
    expect(html).not.toContain("still reaches no repo");
  });

  it("after the trip moved: one line at the place of the action, and a quiet link back", () => {
    const html = card({ moved: true });
    expect(html).toContain("In the GitHub tab, pick “Only select repositories”, your repos, then Install.");
    expect(html).toContain("Open GitHub again");
    expect(html).not.toContain("Choose repos on GitHub");
  });

  it("says so after a read that still gave no repo, and has no link without the app's address", () => {
    expect(card({ emptyReads: 1 })).toContain("ChoiBot still reaches no repo.");
    const none = card({ appUrl: null });
    expect(none).not.toContain("<a ");
    expect(none).toContain("no link to the ChoiBot app");
  });
});
