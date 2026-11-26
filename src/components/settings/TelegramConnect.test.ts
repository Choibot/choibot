// src/components/settings/TelegramConnect.test.ts — every state of the connect steps says what
// it is in plain words for an end user: no id, no settings key, no file path, "your server".
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LinkView, TelegramView } from "../../lib/settings";
import { TelegramConnect } from "./TelegramConnect";

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
// The test runner compiles JSX to React.createElement (the app's bundler does not need the name).
(globalThis as { React?: unknown }).React = React;

const NONE: LinkView = {
  account: { connected: false, name: null, tested: false }, chat: { connected: false, title: null },
  pending: null, last: null, waitsRestart: false,
};
const view = (link: Partial<LinkView>, over: Partial<TelegramView> = {}): TelegramView => ({
  token: true, userId: link.account?.connected ? "5550001" : null, targets: [], bot: { ok: true, username: "acme_choibot", name: "Acme" },
  chief: "on", chiefProblem: null, userAuth: "log", devices: 1, canTest: true,
  setup: { values: { account: "", masterGroup: "", masterTopic: "", cronGroup: "", cronTopic: "" }, tokenSet: true, canSave: true, why: null, restart: { ok: true }, restarting: false },
  bootAt: 1, link: { ...NONE, ...link }, ...over,
});
const text = (v: TelegramView): string =>
  renderToStaticMarkup(createElement(TelegramConnect, { v, reload: async () => {} })).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const ADA = { connected: true, name: "@ada", tested: true };
// The ticket cards go to the user's chat with the bot (no fleet master chat).
const PRIVATE_QUEUE = { id: "queue", label: "Queue cards", what: "", keys: [], missing: [], chatId: "1", threadId: null, testable: false } as TelegramView["targets"][number];
const STATES: Array<[string, TelegramView, RegExp]> = [
  ["no account yet", view({}), /Connect your chat .*one-time code and send it to @acme_choibot.*No id to type.*Connect your chat.*Fleet master chat Optional A topic of a Telegram group where you write to the fleet master\. Your tickets then come there, not to your own chat\. Connect your chat first/],
  ["a code waits (asked on another device)", view({ pending: { kind: "account", expiresAt: 9e12, problem: null } }), /A code waits for its message\..*shows one time.*New code/],
  ["the code ran out", view({ last: { kind: "account", end: "expired", who: null, test: false, restart: null } }), /No message came in 10 minutes.*New code/],
  ["too many wrong codes", view({ last: { kind: "account", end: "spent", who: null, test: false, restart: null } }), /Too many wrong codes came in.*New code/],
  ["not saved", view({ last: { kind: "account", end: "not-saved", who: null, test: false, restart: null } }), /Your server could not save it\. Nothing changed/],
  ["connected, the console restarts", view({ waitsRestart: true, last: { kind: "account", end: "ok", who: "@ada", test: true, restart: { ok: true } } }), /Connected as @ada \. The test message went out\. Look at your phone\. The console restarts now to use it\. Agents keep running\./],
  ["connected, no restart from the page", view({ waitsRestart: true, last: { kind: "account", end: "ok", who: "@ada", test: false, restart: { ok: false, why: "this console cannot restart itself" } } }), /The test message did not go out\. Start the console again to use it \(this console cannot restart itself\)/],
  ["connected: the tickets come to the user's own chat", view({ account: ADA }, { targets: [PRIVATE_QUEUE] }), /Connected as @ada \. The bot answers only this account\. Your tickets come to this chat with answer buttons\. The test message went out\. Send a test message Connect another account Disconnect .*A topic of a Telegram group where you write to the fleet master\. Your tickets then come there, not to your own chat\..*Connect a topic/],
  ["connected, but the Queue does not run: no promise of tickets", view({ account: ADA }), /Connected as @ada \. The bot answers only this account\. The test message went out\./],
  ["connected by hand (the ids in the settings)", view({ account: { connected: true, name: null, tested: false }, chat: { connected: true, title: null } }), /Connected\. The bot answers only this account\. Send a test message.*Fleet master chat Optional Connected\. Your tickets come to this chat.*Use another topic Disconnect/],
  ["a topic code waits, with a problem", view({ account: ADA, pending: { kind: "chat", expiresAt: 9e12, problem: "This is the General topic. Make a topic of its own for the fleet master, and send the message again there." } }), /A code waits for its message in the topic\. This is the General topic\..*New code/],
  ["both connected", view({ account: ADA, chat: { connected: true, title: "Ada's fleet" } }), /Connected to Ada's fleet \. Your tickets come to this chat.*Send a test message Use another topic Disconnect/],
  ["the page cannot save", view({ account: ADA }, { setup: { values: { account: "", masterGroup: "", masterTopic: "", cronGroup: "", cronTopic: "" }, tokenSet: true, canSave: false, why: "Saving is off: the settings file is a symlink", restart: { ok: true }, restarting: false } }), /Saving is off: the settings file is a symlink\./],
];

describe("TelegramConnect", () => {
  it.each(STATES)("%s", (_name, v, want) => {
    const t = text(v);
    expect(t).toMatch(want);
    // Plain words: no settings key, no id, no file path, and "your server" (never "the box").
    expect(t).not.toMatch(/TELEGRAM_|CHIEF_|\.env|5550001|-100\d|\/home\/|the box/);
  });

  it("draws nothing on a console with no link state", () => {
    expect(renderToStaticMarkup(createElement(TelegramConnect, { v: view({}, { link: null }), reload: async () => {} }))).toBe("");
  });

  it("a console that cannot save from the page has no live button", () => {
    const html = renderToStaticMarkup(createElement(TelegramConnect, { v: view({}, { setup: { values: { account: "", masterGroup: "", masterTopic: "", cronGroup: "", cronTopic: "" }, tokenSet: true, canSave: false, why: "x", restart: { ok: true }, restarting: false } }), reload: async () => {} }));
    expect(html.match(/<button[^>]*>/g)!.every((b) => b.includes("disabled"))).toBe(true);
  });
});
