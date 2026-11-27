// server/guide/guide.ts — the guide of a new console: a small agent of its own that works on
// the Set-up list with the user. It is not the fleet master and it is not an agent of the
// console: it has no record, no terminal, no session, no token and no tool.
//
// What it does:
//   sync()   the page is open: bring the thread up to date with the list. The welcome, "this
//            step is done now" and "next: …" with the card of the next step are fixed lines the
//            console writes from the list, with no model: they are there at once, and they cost
//            nothing of the user's plan. An action of a step that failed (a login code that ran
//            out, a copy that failed) starts one turn of the model, which reads the error and
//            says what to do.
//   say()    the user wrote: the secret guard, then one turn of the model.
//   view()   the thread and the state of the guide.
//
// The rules it holds:
//   1. Only a check on the server marks a step done. This file reads the list (the same data as
//      GET /api/setup/steps) and never writes to it; nothing does. A [check] in a reply shows
//      the server's result, whatever the guide says.
//   2. The model has no tool (model.ts). Its reply is cut into text and three typed actions
//      (actions.ts); all else is dropped.
//   3. A text of the user that looks like a secret is stopped before the model, the thread file
//      and the log (secret.ts). The thread keeps the kind, never the text.
//   4. With no guide (no login, the plan at its limit, no answer) the fixed lines still come,
//      and every step works from the list: nothing of the list waits for this file.
//   5. This file can start nothing. Its dependencies are readers. A card is a line of data;
//      the form or the button on it calls the routes of setup/actions.ts as the paired user.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DISPLAY_NAME } from "../brand.js";
import { CHECK_FAILED, NOT_CHECKED, type StepId, type StepStatus } from "../setup/steps.js";
import { actionError, lastError, parseReply, type ActionFacts } from "./actions.js";
import type { GuideModel, ModelFailure } from "./model.js";
import { guideSystemPrompt, turnInput, type TurnCause } from "./prompt.js";
import { findSecret, secretOfKind, stoppedLine, type SecretHit } from "./secret.js";
import type { GuideItem, GuideOff, GuideView } from "./types.js";

export const MESSAGE_MAX = 2_000;
// The view gives this many items of the thread (the newest).
export const VIEW_ITEMS = 200;
// A plan at its limit with no known time: the guide tries again after this.
export const LIMIT_RETRY_MS = 10 * 60_000;

const WORKS_WITHOUT = "All steps work from the list.";
export const OFF_TEXT: Record<GuideOff["why"], string> = {
  login: `Claude is not logged in on your server. ${WORKS_WITHOUT}`,
  limit: `Your Claude plan is at its limit. ${WORKS_WITHOUT}`,
  down: `The guide did not answer. ${WORKS_WITHOUT}`,
};

export type GuideDeps = {
  // The folder of the guide: its thread and what it has said about the list.
  dir: string;
  // The steps with their states: the same run as GET /api/setup/steps. `fresh`: check again now.
  steps: (o?: { fresh?: boolean }) => Promise<StepStatus[]>;
  // What the actions of the Set-up page say about themselves. Read only.
  facts: () => Promise<ActionFacts>;
  model: GuideModel;
  // When the Claude plan comes back, if the console knows.
  limitUntil?: () => Promise<number | null>;
  // The ChoiBot GitHub app is on: "Connect GitHub" and "Pick a repo" are one step on the page
  // (src/lib/setup.ts oneGithubStep), so the count of the welcome counts them as one.
  githubApp?: boolean;
  now?: () => number;
  log?: (s: string) => void;
};

// The steps that the count of the welcome counts: the same number as the page (one count). With
// the ChoiBot app, "Connect GitHub" and "Pick a repo" are one step, done when both are done.
export function countedSteps(main: StepStatus[], githubApp: boolean): StepStatus[] {
  const repo = main.find((s) => s.id === "repo");
  if (!githubApp || !repo || !main.some((s) => s.id === "github")) return main;
  return main.filter((s) => s.id !== "repo").map((s) => (s.id === "github" && s.state === "done" && repo.state !== "done" ? { ...s, state: repo.state } : s));
}

export type SayResult =
  | { ok: true }
  | { ok: false; why: "secret"; hit: SecretHit }
  | { ok: false; why: "empty" | "long" | "busy" }
  | { ok: false; why: "off"; off: GuideOff };

// What the guide has said about the list: so it says each thing one time.
type Told = {
  started: boolean;
  done: StepId[];
  // The step of the last "Next: …" line. Null: none, or the set-up is done.
  next: StepId | null;
  over: boolean;
  // The failure of an action that the thread holds already, per step.
  errors: Partial<Record<StepId, string>>;
};

const FRESH: Told = { started: false, done: [], next: null, over: false, errors: {} };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Guide {
  private items: GuideItem[] | null = null;
  private told: Told = { ...FRESH };
  private busy = false;
  private loggedOut = false;
  private failure: (ModelFailure & { at: number }) | null = null;
  private seq = 0;
  // Every change of the thread runs alone, in the order it came.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private d: GuideDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  private log(what: string): void { (this.d.log ?? ((s: string) => console.warn(s)))(`[guide] ${what}`); }
  private get threadFile(): string { return join(this.d.dir, "thread.jsonl"); }
  private get toldFile(): string { return join(this.d.dir, "told.json"); }

  private alone<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // The thread and the notes, read from the folder one time.
  private async load(): Promise<GuideItem[]> {
    if (this.items) return this.items;
    const items: GuideItem[] = [];
    try {
      for (const line of (await readFile(this.threadFile, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          const i: unknown = JSON.parse(line);
          if (isObj(i) && typeof i.kind === "string" && typeof i.id === "string" && typeof i.ts === "number") items.push(i as GuideItem);
        } catch { /* a line that is cut: left out */ }
      }
    } catch { /* no file: an empty thread */ }
    try {
      const t: unknown = JSON.parse(await readFile(this.toldFile, "utf8"));
      if (isObj(t)) {
        this.told = {
          started: t.started === true, over: t.over === true,
          done: Array.isArray(t.done) ? (t.done as StepId[]) : [],
          next: typeof t.next === "string" ? (t.next as StepId) : null,
          errors: isObj(t.errors) ? (t.errors as Told["errors"]) : {},
        };
      }
    } catch { /* no notes yet */ }
    // A thread with lines and no notes (the notes file was lost): never a second welcome.
    if (items.length > 0) this.told.started = true;
    this.items = items;
    return items;
  }

  private async add(item: Record<string, unknown> & { kind: GuideItem["kind"] }): Promise<void> {
    const items = await this.load();
    const ts = this.now();
    const full = { ...item, id: `${ts.toString(36)}-${(this.seq++).toString(36)}`, ts } as GuideItem;
    items.push(full);
    await mkdir(this.d.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.threadFile, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  }

  private async keep(): Promise<void> {
    await mkdir(this.d.dir, { recursive: true, mode: 0o700 });
    await writeFile(`${this.toldFile}.tmp`, JSON.stringify(this.told), { mode: 0o600 });
    await rename(`${this.toldFile}.tmp`, this.toldFile);
  }

  // Why the guide cannot answer now, or null.
  private off(): GuideOff | null {
    if (this.loggedOut) return { why: "login", text: OFF_TEXT.login };
    const f = this.failure;
    if (!f) return null;
    if (f.why === "limit") {
      const until = f.until ?? f.at + LIMIT_RETRY_MS;
      if (until <= this.now()) return null;
      return { why: "limit", text: OFF_TEXT.limit, ...(f.until ? { until: f.until } : {}) };
    }
    return { why: f.why, text: OFF_TEXT[f.why] };
  }

  async view(): Promise<GuideView> {
    const items = await this.load();
    const off = this.off();
    return { items: items.slice(-VIEW_ITEMS), busy: this.busy, ...(off ? { off } : {}) };
  }

  private note(steps: StepStatus[]): void {
    const claude = steps.find((s) => s.id === "claude");
    // A check that did not run is not "logged out".
    this.loggedOut = claude !== undefined && claude.state !== "done" && claude.text !== NOT_CHECKED && claude.text !== CHECK_FAILED;
  }

  // The page is open, or the list changed: say what is new. Never a turn of the model for a
  // step that only went on; one turn for an action that failed.
  sync(): Promise<GuideView> {
    return this.alone(async () => {
      await this.load();
      const steps = await this.d.steps();
      const facts = await this.d.facts();
      this.note(steps);
      const main = steps.filter((s) => !s.optional);
      const doneNow = steps.filter((s) => s.state === "done").map((s) => s.id);
      const over = main.length > 0 && main.every((s) => s.state === "done");
      const next = over ? null : steps.find((s) => s.state === "todo" && !s.optional)?.id ?? null;
      const told = this.told;

      if (!told.started) {
        const counted = countedSteps(main, this.d.githubApp === true);
        const left = counted.length - counted.filter((s) => s.state === "done").length;
        const count = `${counted.length - left} of ${counted.length} steps ${counted.length - left === 1 ? "is" : "are"} done.`;
        await this.add({ kind: "guide", fixed: true, text: over
          ? `Welcome. This is your ${DISPLAY_NAME}, and I am the guide. The set-up is done. Ask me how something works, or what to set up next.`
          : `Welcome. This is your ${DISPLAY_NAME}, and I am the guide. ${count} ${left === 1 ? "1 step is" : `${left} steps are`} left.\nYou can also do each step from the list. It works without me.` });
        told.started = true;
        told.over = over;
      } else {
        for (const s of steps) {
          const was = told.done.includes(s.id);
          if (s.state === "done" && !was) await this.add({ kind: "check", step: s.id, state: "done", text: s.text });
          // A step that was done and is open again (a login that ended): the list says so, and the thread too.
          if (s.state === "todo" && was) await this.add({ kind: "check", step: s.id, state: "todo", text: s.text });
        }
        if (over && !told.over) {
          await this.add({ kind: "guide", fixed: true, text: "The set-up is done. Your first agent opened a pull request, and you merged it.\nI stay here. Ask me how something works, or what to set up next." });
        }
        told.over = over;
      }
      told.done = doneNow;
      if (next !== told.next) {
        const step = next && steps.find((s) => s.id === next);
        if (step) {
          await this.add({ kind: "guide", fixed: true, text: `Next: ${step.title}. ${step.why}` });
          await this.add({ kind: "card", step: step.id });
        }
        told.next = next;
      }

      // The action of a step failed, and the thread does not say so yet.
      let failed: { step: StepId; error: string } | null = null;
      for (const s of steps) {
        const error = actionError(s, facts);
        if (!error) { delete told.errors[s.id]; continue; }
        if (told.errors[s.id] !== error && !failed && !this.busy) failed = { step: s.id, error };
      }
      if (failed) {
        told.errors[failed.step] = failed.error;
        if (this.off()) await this.plainFailure(failed.step, failed.error);
        else this.begin({ failed: failed.step, error: failed.error });
      }
      await this.keep();
      return this.view();
    });
  }

  // The error and the card of a step, with no words of the model.
  private async plainFailure(step: StepId, error: string): Promise<void> {
    await this.add({ kind: "error", step, text: error });
    await this.add({ kind: "card", step });
  }

  // A message was stopped: the thread keeps the kind of the secret and where it belongs. The
  // text is not here. The chat box of the page stops a secret before it leaves the browser and
  // then calls this with the kind only; say() calls it for a text that came through.
  async stopped(kind: unknown): Promise<boolean> {
    const hit = typeof kind === "string" ? secretOfKind(kind) : null;
    if (!hit) return false;
    await this.alone(async () => {
      await this.add({ kind: "stopped", secret: hit.kind, text: stoppedLine(hit) });
      // The one secret the set-up takes has a form: it comes with the line.
      if (hit.step === "telegram") await this.add({ kind: "card", step: "telegram" });
    });
    this.log(`a message was stopped: it looked like ${hit.what}`);
    return true;
  }

  // The user wrote. The guard runs first: a text that looks like a secret goes nowhere.
  async say(raw: unknown): Promise<SayResult> {
    if (typeof raw !== "string") return { ok: false, why: "empty" };
    const hit = findSecret(raw);
    if (hit) {
      await this.stopped(hit.kind);
      return { ok: false, why: "secret", hit };
    }
    const text = raw.trim();
    if (!text) return { ok: false, why: "empty" };
    if (text.length > MESSAGE_MAX) return { ok: false, why: "long" };
    return this.alone(async (): Promise<SayResult> => {
      await this.load();
      if (this.busy) return { ok: false, why: "busy" };
      const off = this.off();
      // No login, or the plan at its limit: the message would go nowhere. After "no answer",
      // a new message is a new try.
      if (off && (this.loggedOut || off.why === "limit")) return { ok: false, why: "off", off };
      await this.add({ kind: "user", text });
      this.begin({ user: text });
      return { ok: true };
    });
  }

  // One turn of the model, in the background. The page reads the thread until `busy` ends.
  private begin(cause: TurnCause): void {
    this.busy = true;
    void this.turn(cause)
      .catch(() => this.log("a turn ended with an error"))
      .finally(() => { this.busy = false; });
  }

  private async turn(cause: TurnCause): Promise<void> {
    // The checks run now: the guide answers on the state of this moment.
    const steps = await this.d.steps({ fresh: true });
    const facts = await this.d.facts();
    const byId = new Map(steps.map((s) => [s.id, s]));
    const errors: Partial<Record<StepId, string>> = {};
    for (const s of steps) { const e = lastError(s, facts); if (e) errors[s.id] = e; }
    const all = await this.load();
    // The message that started the turn is the last line of the thread: the input gives it once.
    const history = "user" in cause ? all.slice(0, -1) : all;
    const answer = await this.d.model({ system: guideSystemPrompt(), input: turnInput({ steps, errors, history, cause }) });

    await this.alone(async () => {
      this.note(steps);
      if (!answer.ok) {
        let until = answer.until;
        if (answer.why === "limit" && until === undefined) until = (await this.d.limitUntil?.().catch(() => null)) ?? undefined;
        this.failure = { why: answer.why, at: this.now(), ...(until ? { until } : {}) };
        // The user is not left with a message and no answer. A failed action still gets its card.
        if ("failed" in cause) await this.plainFailure(cause.failed, cause.error);
        else await this.add({ kind: "note", text: OFF_TEXT[answer.why] });
        return;
      }
      this.failure = null;
      const blocks = parseReply(answer.text);
      if (blocks.length === 0) { await this.add({ kind: "note", text: "The guide gave no answer. Ask again, or use the list." }); return; }
      for (const b of blocks) {
        if ("say" in b) { await this.add({ kind: "guide", text: b.say }); continue; }
        const s = byId.get(b.step);
        if (!s) continue;
        // The state and the words are the server's. The guide chose only which step to show.
        if (b.do === "check") await this.add({ kind: "check", step: s.id, state: s.state, text: s.text });
        if (b.do === "error") await this.add({ kind: "error", step: s.id, text: errors[s.id] ?? "No error is on record for this step." });
        if (b.do === "card") await this.add({ kind: "card", step: s.id });
      }
      // The failure of an action that this turn saw is in the thread now: sync() says it no second time.
      for (const s of steps) { const e = actionError(s, facts); if (e) this.told.errors[s.id] = e; }
      await this.keep();
    });
  }
}
