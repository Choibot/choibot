import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import { detailActions, githubUrl, localPrHref, openLinkAttrs, PR_WAIT_TEXT, prFacts, prSlug, prWait, recommendLine, replyValue } from "./queueDetail";

const OPTS = [{ key: "A", label: "a" }, { key: "B", label: "b" }];
const item = (o: Partial<QueueItem>): QueueItem => ({ id: "q1", kind: "choice", agentId: "worker-1", choice: { options: OPTS }, ...o }) as QueueItem;
const rec = { value: "B", why: "w", ruleIds: ["r_ab12c"], by: "fleet-master", at: 1 };
const ids = (i: QueueItem, ro = false) => detailActions(i, ro).map((a) => a.id);

describe("detailActions", () => {
  it("pr: no approve (decision 60): changes, snooze, withdraw", () => {
    expect(ids(item({ kind: "pr" }))).toEqual(["changes", "snooze", "withdraw"]);
    expect(ids(item({ kind: "pr", pr: { local: { repo: "r", branch: "agent/x" } } }))).toEqual(["changes", "snooze", "withdraw"]);
  });
  it("preview: looks good label", () => {
    const a = detailActions(item({ kind: "preview" }), false);
    expect(a[0]).toMatchObject({ id: "approve", label: "Looks good" });
  });
  it("choice: reply, snooze, withdraw (options are the radio list); accept when recommended", () => {
    expect(ids(item({}))).toEqual(["reply", "snooze", "withdraw"]);
    expect(ids(item({ recommend: rec }))).toEqual(["accept", "reply", "snooze", "withdraw"]);
  });
  it("a rule suggestion's reply is labelled Edit", () => {
    expect(detailActions(item({ agentId: "console", rule: { id: "r_aaaaa" } }), false)[0]).toMatchObject({ id: "reply", label: "Edit" });
    expect(detailActions(item({}), false)[0]).toMatchObject({ id: "reply", label: "Reply" });
  });
  it("question: accept only when recommended", () => {
    expect(ids(item({ kind: "question" }))).toEqual(["reply", "snooze", "withdraw"]);
    expect(ids(item({ kind: "question", recommend: rec }))).toEqual(["accept", "reply", "snooze", "withdraw"]);
  });
  it("decision 39: no accept for a persistent agent's item", () => {
    expect(ids(item({ recommend: rec, agentId: "fleet-master" }))).not.toContain("accept");
  });
  it("read-only: no actions", () => {
    expect(ids(item({ kind: "pr" }), true)).toEqual([]);
  });
});

describe("prWait (decision 60: the state of an open pr item in place of Approve)", () => {
  it("a PR url: the hint names the PR; the action is the PR on GitHub, in a new tab", () => {
    expect(PR_WAIT_TEXT).toBe("Not merged yet");
    expect(prWait(item({ kind: "pr", pr: { url: "https://github.com/o/r/pull/3", number: 3 } }))).toEqual({
      what: "PR #3", hint: "This item closes when PR #3 is merged.", open: "Open PR #3", href: "https://github.com/o/r/pull/3", newTab: true,
    });
  });
  it("a url that is not a GitHub one gives the state and no link", () => {
    const w = prWait(item({ kind: "pr", pr: { url: "https://example.com/x/1", number: 1 } }));
    expect(w).toEqual({ what: "PR #1", hint: "This item closes when PR #1 is merged.", open: "Open PR #1" });
    expect(openLinkAttrs(w)).toBeNull();
  });
  it("a local branch: the action is the agent's Reconcile panel", () => {
    expect(prWait(item({ kind: "pr", agentId: "a1", pr: { local: { repo: "r", branch: "agent/x" } } }))).toEqual({
      what: "branch agent/x", hint: "This item closes when the branch is merged.", open: "Open Reconcile", href: "/#agent=a1&reconcile",
    });
  });
  it("none for the other kinds", () => {
    for (const kind of ["choice", "question", "preview"] as const) expect(prWait(item({ kind })), kind).toBeNull();
  });
});

describe("the Open link of a pr item", () => {
  const pr = (url: string) => item({ kind: "pr", agentId: "a1", pr: { url, number: 7 } });
  it("the PR opens on GitHub in a new tab: the url, target and rel", () => {
    expect(openLinkAttrs(prWait(pr("https://github.com/Octo-owner/choibot/pull/7")))).toEqual({
      href: "https://github.com/Octo-owner/choibot/pull/7", target: "_blank", rel: "noopener noreferrer",
    });
  });
  it("never the console's own GitHub tab route", () => {
    expect(openLinkAttrs(prWait(pr("https://github.com/o/r/pull/7")))?.href.startsWith("/#")).toBe(false);
  });
  it("a local branch: Reconcile, inside the console (this tab)", () => {
    const w = prWait(item({ kind: "pr", agentId: "a1", pr: { local: { repo: "r", branch: "agent/x" } } }));
    expect(openLinkAttrs(w)).toEqual({ href: "/#agent=a1&reconcile" });
  });
  it("no link for a url that is not https://github.com/", () => {
    const bad = [
      "http://github.com/o/r/pull/7", "https://example.com/o/r/pull/7", "https://github.com.evil.example/o/r/pull/7",
      "https://evil.example/github.com/o/r/pull/7", "https://github.com@evil.example/o/r/pull/7", "https://user:pw@github.com/o/r/pull/7",
      "https://github.com:8443/o/r/pull/7", "https://gist.github.com/o/1", "javascript:alert(1)", "//github.com/o/r/pull/7", "/#pr=o/r/7", "",
    ];
    for (const url of bad) {
      expect(githubUrl(url), url).toBeNull();
      expect(openLinkAttrs(prWait(pr(url))), url).toBeNull();
    }
  });
  it("githubUrl keeps a GitHub url (the host in any case) and nothing else", () => {
    expect(githubUrl("https://github.com/o/r/pull/7")).toBe("https://github.com/o/r/pull/7");
    expect(githubUrl("https://GitHub.com/o/r/pull/7#issuecomment-1")).toBe("https://github.com/o/r/pull/7#issuecomment-1");
  });
  it("no link without a state", () => expect(openLinkAttrs(null)).toBeNull());
});

describe("replyValue", () => {
  it("changes for pr/preview, reply for choice and question", () => {
    expect(replyValue(item({ kind: "pr" }))).toBe("changes");
    expect(replyValue(item({ kind: "preview" }))).toBe("changes");
    expect(replyValue(item({ kind: "choice" }))).toBe("reply");
    expect(replyValue(item({ kind: "question" }))).toBe("reply");
  });
});

describe("recommendLine", () => {
  it("star line with its rule", () => {
    expect(recommendLine(item({ recommend: rec }))).toBe("Master suggests B — rule r_ab12c");
    expect(recommendLine(item({ recommend: { ...rec, by: "coordinator" } }))).toBe("Coordinator suggests B — rule r_ab12c");
    expect(recommendLine(item({ recommend: { ...rec, ruleIds: ["r_1", "r_2"] } }))).toBe("Master suggests B — rule r_1, r_2");
    expect(recommendLine(item({ recommend: { ...rec, ruleIds: [] } }))).toBe("Master suggests B");
  });
  it("none without a recommendation, and none for a persistent agent (decision 39)", () => {
    expect(recommendLine(item({}))).toBeNull();
    expect(recommendLine(item({ recommend: rec, agentId: "fleet-master" }))).toBeNull();
  });
});

describe("prFacts / localPrHref", () => {
  it("remote pr: checks, mergeable, url", () => {
    expect(prFacts(item({ kind: "pr", pr: { url: "https://github.com/o/r/pull/3", number: 3, checks: "success", mergeable: "MERGEABLE" } })))
      .toEqual({ checks: "success", mergeable: "MERGEABLE", url: "https://github.com/o/r/pull/3", number: 3, slug: "o/r" });
  });
  it("prSlug: owner/name from a GitHub PR url (the diff API matches slugs), else null", () => {
    expect(prSlug("https://github.com/acme/demo/pull/7")).toBe("acme/demo");
    expect(prSlug("https://github.com/acme/demo.js/pull/7/files")).toBe("acme/demo.js");
    expect(prSlug("https://gitlab.com/acme/demo/pull/7")).toBeNull();
    expect(prSlug("https://github.com/acme/pull/7")).toBeNull();
    expect(prSlug("javascript:alert(1)")).toBeNull();
    expect(prFacts(item({ kind: "pr", pr: { url: "https://x/1", number: 1 } }))).toEqual({ url: "https://x/1", number: 1 });
  });
  it("local pr: branch and reconcile link", () => {
    const i = item({ kind: "pr", agentId: "a1", pr: { local: { repo: "demo", branch: "feat/x" } } });
    expect(prFacts(i)).toEqual({ branch: "feat/x" });
    expect(localPrHref(i)).toBe("/#agent=a1&reconcile");
  });
  it("no pr payload", () => {
    expect(prFacts(item({ kind: "question" }))).toBeNull();
    expect(localPrHref(item({ kind: "pr", pr: { url: "https://x/1", number: 1 } }))).toBeNull();
  });
});
