// server/guide/guide.test.ts — the guide on the Set-up list. One group of tests for each hard
// rule of the design, with a model that is a function of the test.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StepStatus } from "../setup/steps.js";
import type { ActionFacts } from "./actions.js";
import { Guide, LIMIT_RETRY_MS, MESSAGE_MAX, OFF_TEXT } from "./guide.js";
import type { ModelAnswer } from "./model.js";
import { BOX_DONE, FAKE, fakeModel, IDLE, list } from "./testkit.js";
import type { GuideItem } from "./types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "guide-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function make(o: { steps?: StepStatus[]; facts?: ActionFacts; answers?: (ModelAnswer | string)[]; limitUntil?: number | null; githubApp?: boolean } = {}) {
  const w = {
    steps: o.steps ?? list(BOX_DONE),
    facts: o.facts ?? IDLE,
    now: 1_000_000,
    logs: [] as string[],
    fresh: 0,
    model: fakeModel(o.answers),
    guide: null as unknown as Guide,
  };
  w.guide = new Guide({
    dir,
    steps: async (s) => { if (s?.fresh) w.fresh++; return w.steps; },
    facts: async () => w.facts,
    model: w.model,
    limitUntil: async () => o.limitUntil ?? null,
    ...(o.githubApp ? { githubApp: true } : {}),
    now: () => w.now++,
    log: (s) => w.logs.push(s),
  });
  return w;
}

// The turn that runs in the background has ended.
async function settle(g: Guide): Promise<GuideItem[]> {
  for (let n = 0; n < 200; n++) {
    const v = await g.view();
    if (!v.busy) return v.items;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the turn did not end");
}
const kinds = (items: GuideItem[]): string[] => items.map((i) => ("step" in i ? `${i.kind}:${i.step}` : i.kind));
const disk = (): string => readdirSync(dir).map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n");

describe("the fixed lines: the welcome and the next step, with no model", () => {
  it("welcomes one time, says the count, and shows the card of the next step", async () => {
    const w = make();
    const v = await w.guide.sync();
    expect(kinds(v.items)).toEqual(["guide", "guide", "card:github"]);
    expect(v.items[0]).toMatchObject({ fixed: true });
    expect((v.items[0] as { text: string }).text).toMatch(/I am the guide\. 4 of 8 steps are done\. 4 steps are left\.\nYou can also do each step from the list\. It works without me\./);
    expect((v.items[1] as { text: string }).text).toBe("Next: Connect GitHub. Your agents open pull requests with your GitHub account.");
    expect(kinds((await w.guide.sync()).items)).toEqual(["guide", "guide", "card:github"]);
    expect(w.model.calls).toHaveLength(0);
  });

  it("one count with the page: with the ChoiBot app, GitHub and the repo are one step", async () => {
    // Each welcome is the first sync of a new guide (a new folder).
    const welcome = async (o: Parameters<typeof make>[0]) => {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "guide-"));
      return ((await make(o).guide.sync()).items[0] as { text: string }).text;
    };
    expect(await welcome({ githubApp: true })).toMatch(/I am the guide\. 4 of 7 steps are done\. 3 steps are left\./);
    // GitHub approved, no repo yet: the one step is not done (the page says "Step 5 of 7").
    const half = list({ ...BOX_DONE, github: "done" });
    expect(await welcome({ githubApp: true, steps: half })).toMatch(/4 of 7 steps are done\. 3 steps are left\./);
    expect(await welcome({ steps: half })).toMatch(/5 of 8 steps are done\. 3 steps are left\./);
    expect(await welcome({ githubApp: true, steps: list({ ...BOX_DONE, github: "done", repo: "done" }) })).toMatch(/5 of 7 steps are done\. 2 steps are left\./);
  });

  it("says when a step is done, with the note of its check, and goes to the next step", async () => {
    const w = make();
    await w.guide.sync();
    w.steps = list({ ...BOX_DONE, github: { state: "done", text: "Connected as ada-dev" } });
    const items = (await w.guide.sync()).items.slice(3);
    expect(kinds(items)).toEqual(["check:github", "guide", "card:repo"]);
    expect(items[0]).toMatchObject({ state: "done", text: "Connected as ada-dev" });
    expect((items[1] as { text: string }).text).toMatch(/^Next: Pick a repo\./);
    expect(w.model.calls).toHaveLength(0);
  });

  it("says when the set-up is done, one time, and when a done step is open again", async () => {
    const w = make({ steps: list({ ...BOX_DONE, github: "done", repo: "done", agent: "done" }) });
    await w.guide.sync();
    w.steps = list({ ...BOX_DONE, github: "done", repo: "done", agent: "done", merge: "done" });
    let items = (await w.guide.sync()).items;
    expect(kinds(items.slice(-2))).toEqual(["check:merge", "guide"]);
    expect((items[items.length - 1] as { text: string }).text).toMatch(/^The set-up is done\./);
    const n = items.length;
    expect((await w.guide.sync()).items).toHaveLength(n);
    w.steps = list({ ...BOX_DONE, github: { state: "todo", text: "GitHub is not connected." }, repo: "blocked", agent: "blocked", merge: "done" });
    items = (await w.guide.sync()).items.slice(n);
    expect(kinds(items)).toEqual(["check:github", "guide", "card:github"]);
    expect(items[0]).toMatchObject({ state: "todo", text: "GitHub is not connected." });
  });

  it("keeps its thread: a new start of the console reads it and welcomes no second time", async () => {
    const w = make();
    await w.guide.sync();
    const again = make();
    expect(kinds((await again.guide.sync()).items)).toEqual(["guide", "guide", "card:github"]);
  });
});

describe("rule 1: only a check on the server marks a step done", () => {
  it("a reply that says \"done\" changes nothing, and [check] shows the server's result", async () => {
    const w = make({ steps: list({ ...BOX_DONE, github: { state: "todo", text: "GitHub is not connected." } }),
      answers: ["The step Connect GitHub is done now. I marked it done.\n[done github]\n[mark github done]\n[check github]"] });
    await w.guide.sync();
    expect(await w.guide.say("done, I approved it")).toEqual({ ok: true });
    const items = await settle(w.guide);
    const check = items.find((i) => i.kind === "check");
    expect(check).toMatchObject({ step: "github", state: "todo", text: "GitHub is not connected." });
    // The list is what the server said, before and after: the guide has no way to write to it.
    expect(w.steps.find((s) => s.id === "github")?.state).toBe("todo");
    expect(kinds((await w.guide.sync()).items).filter((k) => k === "check:github")).toHaveLength(1);
    expect(disk()).not.toMatch(/\[done github\]|mark github done\]/);
  });

  it("the checks run again for each turn: the guide answers on the state of now", async () => {
    const w = make({ answers: ["[check github]"] });
    await w.guide.sync();
    await w.guide.say("is GitHub connected?");
    await settle(w.guide);
    expect(w.fresh).toBe(1);
    expect(w.model.calls[0].input).toContain("github | Connect GitHub | open: Connect GitHub is open.");
  });
});

describe("rule 2: the guide acts only through its typed actions", () => {
  it("a reply becomes text, the server's check, the server's error and a card: nothing else", async () => {
    const steps = list({ ...BOX_DONE, github: { state: "todo", text: "GitHub is not connected.", error: "GitHub answered: not logged in." } });
    const w = make({ steps,
      answers: ["GitHub shows no login yet, so this step stays open. I cannot mark it done for you.\n[check github]\n[error github]\nThe code ran out before GitHub saw the approval. Press New code on the card.\n[card github]\n[run gh auth login]\n[shell cat ~/.config/gh/hosts.yml]"] });
    await w.guide.sync();
    const before = (await settle(w.guide)).length;
    // The code ran out while the user was away. Then the user says "done".
    w.facts = { ...IDLE, login: { state: "failed", reason: "expired" } };
    await w.guide.say("done, I approved it");
    const items = (await settle(w.guide)).slice(before);
    expect(kinds(items)).toEqual(["user", "guide", "check:github", "error:github", "guide", "card:github"]);
    expect(items[3]).toMatchObject({ text: expect.stringMatching(/one-time code ran out after 15 minutes/) });
    expect(disk()).not.toMatch(/gh auth login|hosts\.yml/);
  });

  it("an [error] for a step with no error says so in the server's words", async () => {
    const w = make({ answers: ["[error repo]"] });
    await w.guide.sync();
    await w.guide.say("why?");
    const items = await settle(w.guide);
    expect(items[items.length - 1]).toMatchObject({ kind: "error", step: "repo", text: "No error is on record for this step." });
  });

  it("no shipped file of the guide starts a program, an action of a step, or talks to an agent", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const shipped = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testkit.ts");
    expect(shipped.sort()).toEqual(["actions.ts", "api.ts", "guide.ts", "model.ts", "prompt.ts", "secret.ts", "types.ts"]);
    for (const f of shipped) {
      const code = readFileSync(join(here, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      // The one program the guide starts is its own model, through the runner of the distiller (model.ts).
      expect(code, f).not.toMatch(/child_process|execFile|spawn\(|\.start\(\{|\.clone\(|setCommitName|spawnAgent|sendToAgent|pushConsole/);
      expect(code, f).not.toMatch(/from "\.\.\/(master|agents|gh)\//);
      // Its only imports of the set-up actions are types and the one "needs pairing" answer.
      for (const m of code.matchAll(/^import (type )?\{([^}]*)\} from "\.\.\/setup\/(ghlogin|firstagent|repopick|commitname|actions)\.js";$/gm)) {
        expect(m[1] === "type " || m[2].trim() === "NEEDS_PAIRING", `${f}: ${m[0]}`).toBe(true);
      }
    }
  });
});

describe("rule 3: a secret typed into the chat goes nowhere", () => {
  it("stops it before the model, the thread file and the log, and says where it belongs", async () => {
    const w = make();
    await w.guide.sync();
    for (const secret of Object.values(FAKE)) {
      const r = await w.guide.say(`ok I have it: ${secret} do I paste it here?`);
      expect(r, secret.slice(0, 6)).toMatchObject({ ok: false, why: "secret" });
    }
    const items = await settle(w.guide);
    expect(w.model.calls).toHaveLength(0);
    const all = disk() + w.logs.join("\n") + JSON.stringify(items);
    for (const secret of Object.values(FAKE)) {
      expect(all).not.toContain(secret);
      expect(all).not.toContain(secret.slice(0, 14));
    }
    expect(all).not.toContain("do I paste it here");
    const stopped = items.filter((i) => i.kind === "stopped");
    expect(stopped).toHaveLength(Object.keys(FAKE).length);
    expect(stopped[0]).toMatchObject({ secret: "telegram", text: expect.stringMatching(/was not sent.*a Telegram bot token.*not stored.*form of the step “Telegram”/) });
    // The one secret the set-up takes has a form: its card comes with the line.
    expect(kinds(items).filter((k) => k === "card:telegram")).toHaveLength(1);
    expect(w.logs.some((l) => /a message was stopped: it looked like a Telegram bot token/.test(l))).toBe(true);
  });

  it("the next turn of the model gets no part of a stopped message", async () => {
    const w = make({ answers: ["Use the form of the step Telegram.\n[card telegram]"] });
    await w.guide.sync();
    await w.guide.say(FAKE.telegram);
    await w.guide.say("where does the token go?");
    await settle(w.guide);
    expect(w.model.calls).toHaveLength(1);
    expect(w.model.calls[0].input).not.toContain(FAKE.telegram.slice(0, 14));
    expect(w.model.calls[0].input).toContain("the console stopped a message of the user");
  });

  it("the guard runs first: also when the guide is busy or not available", async () => {
    const w = make({ steps: list({ install: "done", claude: { state: "todo", text: "Claude is not logged in on your server." } }) });
    await w.guide.sync();
    expect(await w.guide.say(FAKE.githubClassic)).toMatchObject({ ok: false, why: "secret" });
    expect(disk()).not.toContain(FAKE.githubClassic.slice(0, 14));
  });
});

describe("rule 4: everything works when the guide is not there", () => {
  it("no Claude login: the guide says so, takes no message, and the fixed lines still come", async () => {
    const w = make({ steps: list({ install: "done", claude: { state: "todo", text: "Claude is not logged in on your server." }, access: "done", pair: "done" }) });
    const v = await w.guide.sync();
    expect(v.off).toEqual({ why: "login", text: OFF_TEXT.login });
    expect(kinds(v.items)).toEqual(["guide", "guide", "card:claude"]);
    expect(await w.guide.say("help")).toMatchObject({ ok: false, why: "off", off: { why: "login" } });
    expect(w.model.calls).toHaveLength(0);
    expect(kinds((await w.guide.view()).items)).not.toContain("user");
  });

  it("a check that did not run is not \"logged out\"", async () => {
    const w = make({ steps: list({ claude: { state: "todo", text: "The check did not run." } }) });
    expect((await w.guide.sync()).off).toBeUndefined();
  });

  it("the plan at its limit: one plain line, with the time when the console knows it", async () => {
    const w = make({ answers: [{ ok: false, why: "limit" }], limitUntil: 2_000_000 });
    await w.guide.sync();
    await w.guide.say("help");
    const items = await settle(w.guide);
    expect(items[items.length - 1]).toMatchObject({ kind: "note", text: OFF_TEXT.limit });
    expect((await w.guide.view()).off).toEqual({ why: "limit", text: OFF_TEXT.limit, until: 2_000_000 });
    expect(await w.guide.say("again")).toMatchObject({ ok: false, why: "off" });
    expect(w.model.calls).toHaveLength(1);
    // The list goes on with no guide: a step that is done is said, the next card comes.
    w.steps = list({ ...BOX_DONE, github: "done" });
    expect(kinds((await w.guide.sync()).items).slice(-3)).toEqual(["check:github", "guide", "card:repo"]);
    w.now = 2_000_001;
    expect((await w.guide.view()).off).toBeUndefined();
    expect(await w.guide.say("again")).toEqual({ ok: true });
    await settle(w.guide);
  });

  it("a limit with no known time ends by itself", async () => {
    const w = make({ answers: [{ ok: false, why: "limit" }] });
    await w.guide.sync();
    await w.guide.say("help");
    await settle(w.guide);
    expect((await w.guide.view()).off).toEqual({ why: "limit", text: OFF_TEXT.limit });
    w.now += LIMIT_RETRY_MS;
    expect((await w.guide.view()).off).toBeUndefined();
  });

  it("the model is down: the user gets a line, and the next message is a new try", async () => {
    const w = make({ answers: [{ ok: false, why: "down" }, "I am back."] });
    await w.guide.sync();
    await w.guide.say("help");
    let items = await settle(w.guide);
    expect(items[items.length - 1]).toMatchObject({ kind: "note", text: OFF_TEXT.down });
    expect((await w.guide.view()).off).toEqual({ why: "down", text: OFF_TEXT.down });
    expect(await w.guide.say("help again")).toEqual({ ok: true });
    items = await settle(w.guide);
    expect(items[items.length - 1]).toMatchObject({ kind: "guide", text: "I am back." });
    expect((await w.guide.view()).off).toBeUndefined();
  });

  it("a reply with nothing in it is a plain line, not an empty bubble", async () => {
    const w = make({ answers: ["[done github]"] });
    await w.guide.sync();
    await w.guide.say("help");
    const items = await settle(w.guide);
    expect(items[items.length - 1]).toMatchObject({ kind: "note", text: expect.stringMatching(/gave no answer/) });
  });
});

describe("an action that failed: the guide reads the error", () => {
  const steps = list({ ...BOX_DONE, github: { state: "todo", text: "GitHub is not connected." } });
  const expired: ActionFacts = { ...IDLE, login: { state: "failed", reason: "expired" } };

  it("one turn of the model for one failure, with the error in its input", async () => {
    const w = make({ steps, answers: ["The code ran out. Press New code on the card.\n[card github]"] });
    await w.guide.sync();
    expect(w.model.calls).toHaveLength(0);
    w.facts = expired;
    await w.guide.sync();
    const items = await settle(w.guide);
    expect(w.model.calls).toHaveLength(1);
    expect(w.model.calls[0].input).toMatch(/Now: the step "github" \(Connect GitHub\) failed\. Its last error: The one-time code ran out after 15 minutes\./);
    expect(kinds(items.slice(-2))).toEqual(["guide", "card:github"]);
    await w.guide.sync();
    await settle(w.guide);
    expect(w.model.calls).toHaveLength(1);
    // A new login that fails in another way is a new failure.
    w.facts = { ...IDLE, login: { state: "failed", reason: "denied" } };
    await w.guide.sync();
    await settle(w.guide);
    expect(w.model.calls).toHaveLength(2);
  });

  it("with no guide: the error and the card come as fixed lines", async () => {
    const w = make({ steps, answers: [{ ok: false, why: "down" }] });
    await w.guide.sync();
    w.facts = expired;
    await w.guide.sync();
    let items = await settle(w.guide);
    expect(kinds(items.slice(-2))).toEqual(["error:github", "card:github"]);
    expect(items[items.length - 2]).toMatchObject({ text: expect.stringMatching(/ran out after 15 minutes/) });
    // The guide is known to be down now: the next failure does not ask the model.
    w.facts = { ...IDLE, login: { state: "failed", reason: "no-answer" } };
    await w.guide.sync();
    items = await settle(w.guide);
    expect(w.model.calls).toHaveLength(1);
    expect(kinds(items.slice(-2))).toEqual(["error:github", "card:github"]);
  });

  it("a failure that a turn of the user saw is not said a second time", async () => {
    const w = make({ steps, facts: expired, answers: ["[error github]\n[card github]"] });
    // The thread exists already: the welcome is there, the failure comes with the user's message.
    w.facts = IDLE;
    await w.guide.sync();
    w.facts = expired;
    await w.guide.say("done, I approved it");
    await settle(w.guide);
    await w.guide.sync();
    await settle(w.guide);
    expect(w.model.calls).toHaveLength(1);
  });
});

describe("messages", () => {
  it("one turn at a time, and the limits of a message", async () => {
    const w = make({ answers: ["One.", "Two."] });
    await w.guide.sync();
    let free = () => {};
    w.model.hold = new Promise<void>((r) => { free = r; });
    expect(await w.guide.say("first")).toEqual({ ok: true });
    expect((await w.guide.view()).busy).toBe(true);
    expect(await w.guide.say("second")).toEqual({ ok: false, why: "busy" });
    free();
    await settle(w.guide);
    expect(await w.guide.say("   ")).toEqual({ ok: false, why: "empty" });
    expect(await w.guide.say(undefined)).toEqual({ ok: false, why: "empty" });
    expect(await w.guide.say("x".repeat(MESSAGE_MAX + 1))).toEqual({ ok: false, why: "long" });
    expect(kinds((await w.guide.view()).items).filter((k) => k === "user")).toHaveLength(1);
  });

  it("the input of a turn has the message one time, and the thread before it", async () => {
    const w = make({ answers: ["Ok."] });
    await w.guide.sync();
    await w.guide.say("what is a ticket?");
    await settle(w.guide);
    const input = w.model.calls[0].input;
    expect(input.match(/what is a ticket\?/g)).toHaveLength(1);
    expect(input).toContain("guide: Next: Connect GitHub.");
    expect(w.model.calls[0].system).toMatch(/^You are the guide of a new/);
  });
});
