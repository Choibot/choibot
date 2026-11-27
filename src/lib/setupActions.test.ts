// src/lib/setupActions.test.ts — the words of the GitHub and repo rows, and the calls.
import { describe, expect, it } from "vitest";
import {
  accessWord, ago, appApproveLine, appReachLine, deviceLink, oneStepCard, repoChoice, canPick, cloneLine, cloneProblem, fetchLogin, fetchRepoPage, firstSay, loginProblem, mergeHint, minutesLeft, needsCommitName,
  repoLine, since, sizeText, SLOW_MS, startClone, startFirst, type FirstView, type PickRow,
} from "./setupActions";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const repo = (o: Partial<PickRow> = {}): PickRow => ({
  slug: "acme/shop", private: false, push: true, archived: false, language: "TypeScript", pushedAt: "2026-11-19T10:00:00Z", sizeKb: 1200, here: false, ...o,
});
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as never;

describe("the words", () => {
  it("says when a repo was pushed to last", () => {
    expect(ago("2026-11-19T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-11-19T11:40:00Z", NOW)).toBe("20 minutes ago");
    expect(ago("2026-11-19T10:00:00Z", NOW)).toBe("2 hours ago");
    expect(ago("2026-11-18T10:00:00Z", NOW)).toBe("yesterday");
    expect(ago("2026-11-14T10:00:00Z", NOW)).toBe("5 days ago");
    expect(ago("2026-10-29T10:00:00Z", NOW)).toBe("3 weeks ago");
    expect(ago("2026-05-19T10:00:00Z", NOW)).toBe("6 months ago");
    expect(ago("2023-11-19T10:00:00Z", NOW)).toBe("3 years ago");
  });

  it("describes a repo row, or says why it is off", () => {
    expect(repoLine(repo(), NOW)).toBe("TypeScript · pushed 2 hours ago");
    expect(repoLine(repo({ private: true, language: null, here: true }), NOW)).toBe("Private · pushed 2 hours ago · on your server");
    expect(repoLine(repo({ push: false }), NOW)).toBe("Agents cannot open pull requests here. Ask the owner for push access.");
    expect(repoLine(repo({ archived: true }), NOW)).toMatch(/archived/);
    expect([accessWord(repo()), accessWord(repo({ push: false })), accessWord(repo({ archived: true }))]).toEqual(["Read and push", "Read only", "Archived"]);
    expect([canPick(repo()), canPick(repo({ push: false })), canPick(repo({ archived: true }))]).toEqual([true, false, false]);
  });

  it("says how long a code is valid, and how big a repo is", () => {
    expect([minutesLeft(15 * 60_000), minutesLeft(119_000), minutesLeft(30_000)]).toEqual(["15 minutes", "1 minute", "less than 1 minute"]);
    expect([sizeText(900), sizeText(340_000), sizeText(1_240_000)]).toEqual(["1 MB", "340 MB", "1.2 GB"]);
  });

  it("says where the ChoiBot app's repos are chosen: the next step of Set-up, or GitHub from Settings", () => {
    expect(appReachLine("setup")).toBe("ChoiBot then works only in the repos that you choose in the next step. There it can read and change the code, pull requests and issues, and read the checks.");
    expect(appReachLine("settings")).toBe("ChoiBot then works only in the repos that you choose on GitHub. There it can read and change the code, pull requests and issues, and read the checks.");
  });

  it("says in step 2 of the code card what the approval gives, in one short line", () => {
    expect(appApproveLine("setup")).toBe("Type the code, then approve. ChoiBot gets access only to the repos that you pick next.");
    expect(appApproveLine("settings")).toBe("Type the code, then approve. ChoiBot gets access only to the repos that you pick on GitHub.");
  });

  it("puts the code into GitHub's device link only in GitHub's form", () => {
    const page = "https://github.com/login/device";
    expect(deviceLink(page, "WDJB-MJHT")).toBe("https://github.com/login/device?user_code=WDJB-MJHT");
    for (const bad of ["wdjb-mjht", "WDJBMJHT", "WDJB-MJH", "WDJB-MJHT&x=1", "WDJB-MJHT ", "", "../x-yyyy"]) expect(deviceLink(page, bad)).toBe(page);
    expect(deviceLink("https://github.com/login/device?a=1", "WDJB-MJHT")).toBe("https://github.com/login/device?a=1");
    expect(deviceLink("not a url", "WDJB-MJHT")).toBe("not a url");
  });

  it("gives the one card its state and one short line at each press", () => {
    const waiting = { state: "waiting" as const, code: "WDJB-MJHT", url: "https://github.com/login/device", leftMs: 60_000, app: { appUrl: null } };
    expect(oneStepCard(null, false)).toEqual({ kind: "starting", line: "Asking GitHub for a code…" });
    expect(oneStepCard({ state: "idle" }, false).kind).toBe("starting");
    expect(oneStepCard(waiting, false)).toEqual({
      kind: "connect", code: "WDJB-MJHT", href: "https://github.com/login/device?user_code=WDJB-MJHT",
      line: "ChoiBot gets access only to the repos that you pick next.", button: "Connect GitHub",
    });
    expect(oneStepCard(waiting, true)).toMatchObject({ kind: "approve", line: "Approve ChoiBot on GitHub. If it asks for the code, paste it.", button: "Open GitHub again" });
    expect(oneStepCard({ state: "done" }, true)).toEqual({ kind: "approved", line: "Approved on GitHub. One moment…" });
    // A refusal and a code that ran out: the plain line with what to press.
    expect(oneStepCard({ state: "failed", reason: "denied" }, true)).toEqual({ kind: "failed", line: loginProblem("denied") });
    expect(oneStepCard({ state: "failed", reason: "expired" }, true)).toEqual({ kind: "failed", line: "The code ran out. Press New code." });
  });

  it("knows the repo part's state: reading, no repo reached yet, a list", () => {
    const page = (listed: number, app: boolean) => ({ repos: [], total: listed, listed, more: false, capped: false, ...(app ? { app: { manage: [], appUrl: null } } : {}) });
    expect(repoChoice(null)).toBe("reading");
    expect(repoChoice(page(0, true))).toBe("choose");
    expect(repoChoice(page(3, true))).toBe("list");
    expect(repoChoice(page(0, false))).toBe("list");
  });

  it("has a plain line with what to press for each failure", () => {
    for (const r of ["expired", "denied", "no-gh", "no-answer", "env-token", "failed"] as const) {
      expect(loginProblem(r)).toMatch(/Press|press/);
      expect(loginProblem(r)).not.toMatch(/[A-Z]{2,}_[A-Z]|\/home|~\//);
    }
    // The ChoiBot app's own two: the person cannot fix them on the page, so no button is named.
    for (const r of ["disabled", "bad-client"] as const) {
      expect(loginProblem(r)).toMatch(/ChoiBot app/);
      expect(loginProblem(r)).not.toMatch(/[A-Z]{2,}_[A-Z]|\/home|~\/|Press/);
    }
    for (const r of ["auth", "disk", "network", "empty", "exists", "timeout", "failed"] as const) {
      expect(cloneProblem(r)).toMatch(/[Pp]ick|[Pp]ress|[Tt]ry/);
      expect(cloneProblem(r)).not.toMatch(/[A-Z]{2,}_[A-Z]|\/home|~\//);
    }
  });

  it("says how far a copy is", () => {
    expect(cloneLine({ state: "copying", repo: "acme/shop", percent: null, big: false })).toBe("Copying acme/shop to your server…");
    expect(cloneLine({ state: "copying", repo: "acme/shop", percent: 41, big: true })).toBe("Copying acme/shop to your server… 41% This repo is big. The copy can take some minutes.");
  });

  it("knows when the GitHub step waits only for the commit name", () => {
    expect(needsCommitName({ text: "GitHub is connected as ada-dev. Your server has no name and e-mail for commits yet." })).toBe(true);
    expect(needsCommitName({ text: "GitHub is not connected." })).toBe(false);
  });
});

describe("the calls", () => {
  it("gives the answer of the server", async () => {
    expect(await fetchLogin(answer(200, { state: "idle" }))).toEqual({ state: "idle" });
  });
  it("sends the search and the page", async () => {
    let url = "";
    await fetchRepoPage({ q: "a b/c", page: 2, fresh: true }, (async (u: string) => { url = u; return new Response("{}"); }) as never);
    expect(url).toBe("/api/setup/repos?q=a%20b%2Fc&page=2&fresh=1");
  });
  it("sends only the repo name for a copy", async () => {
    let sent: unknown;
    await startClone("acme/shop", (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response("{}"); }) as never);
    expect(sent).toEqual({ repo: "acme/shop" });
  });
  it("turns a refusal into a plain line", async () => {
    await expect(fetchLogin(answer(403, { error: "pair-required", userAuth: "log" }))).rejects.toThrow("Only a paired device can do this. Pair this device first.");
    await expect(startClone("x", answer(400, { error: "Pick a repo of the list." }))).rejects.toThrow("Pick a repo of the list.");
    await expect(fetchLogin(answer(500, { error: "boom" }))).rejects.toThrow("The console did not answer. Try again.");
    await expect(fetchLogin((async () => { throw new Error("net"); }) as never)).rejects.toThrow("The console did not answer. Try again.");
  });
  it("shows the console's own sentence of a failed start; the edge's page of a 502 (not JSON) gets the plain line", async () => {
    await expect(startFirst({}, answer(500, { error: "The agent did not start. Press the button again." }))).rejects.toThrow("The agent did not start. Press the button again.");
    const edge = (async () => new Response("<!DOCTYPE html><title>Bad gateway | Cloudflare</title>", { status: 502, headers: { "content-type": "text/html" } })) as never;
    await expect(startFirst({}, edge)).rejects.toThrow("The console did not answer. Try again.");
  });
});

describe("the first agent, in plain words", () => {
  const view = (o: Partial<FirstView> = {}): FirstView => ({ task: "t", repo: "shop", repos: ["shop"], agent: null, ticket: null, now: 1_000_000, ...o });
  const agent = (state: NonNullable<FirstView["agent"]>["state"], o: Partial<NonNullable<FirstView["agent"]>> = {}) =>
    ({ id: "a1", name: "First task", state, startedAt: 1_000_000 - 130_000, pullRequest: false, noSession: false, ...o });

  it("offers the start, with the repo", () => {
    expect(firstSay(view())).toMatchObject({ acts: ["start"], line: "The agent works in its own copy of shop. Your main branch is not touched." });
    expect(firstSay(view({ repo: null }))).toMatchObject({ acts: [], tone: "warn" });
  });

  it("says that the agent works, and for how long", () => {
    expect(firstSay(view({ agent: agent("working") }))).toMatchObject({ tone: "run", line: "Working · started 2 minutes ago", acts: [] });
    const slow = firstSay(view({ agent: agent("working", { startedAt: 1_000_000 - SLOW_MS - 60_000 }) }));
    expect(slow.line).toBe("Working for 9 minutes. This takes longer than usual.");
    expect(slow).toMatchObject({ hint: "You can close this page: the agent keeps working.", acts: [] });
  });

  // The live fault (hosted console, release 861): the thread stayed empty and the row said
  // "Working". Now: a short line and the way to the screen where Claude waits.
  it("says that no session started when Claude did not take the task in, and offers its terminal", () => {
    const stuck = { tone: "warn", line: "No session started yet.", hint: "Its terminal shows what Claude waits for.", acts: ["terminal"] };
    expect(firstSay(view({ agent: agent("working", { noSession: true }) }))).toEqual(stuck);
    // A move or a restart before the first turn leaves the record idle: the same words.
    expect(firstSay(view({ agent: agent("waiting", { noSession: true }) }))).toEqual(stuck);
    expect(firstSay(view({ agent: agent("working") })).line).toBe("Working · started 2 minutes ago");
    // A pull request ticket, an error, an end: their own words.
    expect(firstSay(view({ agent: agent("waiting", { noSession: true }), ticket: { id: "q1", state: "open" } })).acts).toEqual([]);
    expect(firstSay(view({ agent: agent("error", { noSession: true }) })).line).toBe("The agent stopped with an error.");
  });

  it("says what happened and what to press when the agent stops with no pull request", () => {
    expect(firstSay(view({ agent: agent("waiting") }))).toMatchObject({ tone: "warn", line: "The agent stopped and opened no pull request.", acts: ["again"] });
    expect(firstSay(view({ agent: agent("waiting", { pullRequest: true }) }))).toMatchObject({ line: "The agent opened a pull request, but its ticket did not come.", acts: ["again"] });
    expect(firstSay(view({ agent: agent("ended") })).acts).toEqual(["again"]);
    expect(firstSay(view({ agent: agent("closed") })).acts).toEqual(["again"]);
    expect(firstSay(view({ agent: agent("gone") }))).toMatchObject({ line: "The agent is not there any more.", acts: ["again"] });
    for (const s of ["waiting", "ended", "closed", "gone"] as const) expect(firstSay(view({ agent: agent(s) })).hint).toMatch(/again/);
  });

  it("an error: its line, the error's own sentence when the console has one, and Try again only", () => {
    const err = firstSay(view({ agent: agent("error", { error: "Usage limit reached" }) }));
    expect(err).toEqual({ tone: "warn", line: "The agent stopped with an error.", hint: "Usage limit reached", acts: ["again"] });
    expect(firstSay(view({ agent: agent("error") }))).toEqual({ tone: "warn", line: "The agent stopped with an error.", acts: ["again"] });
  });

  it("sends the user to no thread of the agent, in no state", () => {
    const states = ["working", "waiting", "error", "ended", "closed", "gone"] as const;
    const views = [
      ...states.map((s) => view({ agent: agent(s) })),
      // no session: its terminal is the way (the word "terminal" is allowed, a thread is not)
      ...states.map((s) => view({ agent: agent(s, { noSession: true }) })),
      view({ agent: agent("working", { startedAt: 1_000_000 - SLOW_MS - 60_000 }) }),
      view({ agent: agent("waiting", { pullRequest: true }) }),
      ...(["open", "closed", "merged"] as const).map((t) => view({ agent: agent("waiting"), ticket: { id: "q1", state: t } })),
    ];
    for (const v of views) expect(JSON.stringify(firstSay(v))).not.toMatch(/thread/i);
  });

  it("points to the next step when the pull request is open, and offers a new start when it was closed", () => {
    expect(firstSay(view({ agent: agent("waiting"), ticket: { id: "q1", state: "open" } }))).toMatchObject({ tone: "ok", acts: [] });
    expect(firstSay(view({ agent: agent("waiting"), ticket: { id: "q1", state: "closed" } })).acts).toEqual(["again"]);
    expect(firstSay(view({ agent: agent("gone"), ticket: { id: "q1", state: "merged" } })).acts).toEqual([]);
  });

  it("counts the time in words", () => {
    expect([since(20_000), since(60_000), since(125_000), since(3_900_000), since(7_200_000)]).toEqual(["less than 1 minute", "1 minute", "2 minutes", "1 hour 5 minutes", "2 hours"]);
  });

  it("says what stands in the way of a merge", () => {
    const pr = (o: object) => ({ pr: { url: "https://github.com/acme/shop/pull/1", number: 1, ...o } }) as never;
    expect(mergeHint(pr({ mergeable: "CONFLICTING" }))).toMatch(/conflicts.*Open it on GitHub/);
    expect(mergeHint(pr({ checks: "failure" }))).toMatch(/check of the pull request fails/);
    for (const o of [{ mergeable: "CONFLICTING" }, { checks: "failure" }, { checks: "pending" }] as const) expect(mergeHint(pr(o))).not.toMatch(/thread/i);
    expect(mergeHint(pr({ checks: "pending" }))).toMatch(/still run/);
    expect(mergeHint(pr({ checks: "success", mergeable: "MERGEABLE" }))).toBeNull();
    expect(mergeHint({ pr: { local: { repo: "shop", branch: "b" } } } as never)).toBeNull();
  });

  it("asks for a new agent only with `again`", async () => {
    const sent: unknown[] = [];
    const f = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}"); }) as never;
    await startFirst({}, f); await startFirst({ again: true }, f); await startFirst({ repo: "api" }, f);
    expect(sent).toEqual([{}, { again: true }, { repo: "api" }]);
  });
});
