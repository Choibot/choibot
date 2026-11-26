// server/chief/brain/store.ts — brain stores (spec §6).
// Decision part: brain/decisions.jsonl, every user input the console sees
// (spec §6.2). Every agent can read the file (one uid), so each line is cut
// to 500 chars and its secret spans are redacted before it is written.
// Rule part: brain/rules.jsonl, append-only rule events, folded in append
// order (spec §6.1); RuleStore is its one writer.
// Classification part: brain/classified.jsonl, the later classifications of
// decision lines by `at` (spec §6.5); ClassifiedLog.
import { randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { appendJsonl, appendJsonlRaw, atomicWrite, onChain, parseJsonl, readJsonl, readText } from "../files.js";
import type { QueueKind } from "../kinds.js";

export type Via = "queue-tab" | "queue-telegram" | "issue-telegram" | "composer" | "master-tab" | "master-telegram";
export type Reason = "differs-from-recommend" | "pr-changes" | "undo" | "undo-own" | "free-text" | "master-chat";
export type DecisionLine = { at: number; via: Via; by: "user" | "master"; text: string; correction: boolean | null;
  itemId?: string; agentId?: string; repo?: string; area?: string; prUrl?: string; value?: string;
  recommend?: { value: string; ruleIds: string[] }; reason?: Reason; refAt?: number };

export const DECISION_TEXT_MAX = 500;
// The master-chat lookup window (spec §6.2 source 3).
const MASTER_CHAT_WINDOW_MS = 30 * 60_000;
// The compaction age (spec §6.2): lines older than this lose their text or go.
const COMPACT_AGE_MS = 90 * 24 * 60 * 60_000;
// Pass 1 reads at most max + this much of the text (the decisions route and a
// Telegram rule edit carry an unbounded string), so the regex cost stays
// bounded.
const REDACT_SLACK = 1024;

const REDACTED = "[redacted]";

// The secret filter of spec §6.2. All patterns run on the same input and
// their spans are merged, so one secret that several patterns match is one
// redaction.
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /[0-9a-f]{32,}/g,
  /[A-Za-z0-9+_-]{40,}/g, // no "/", so an absolute path never matches
  /postgres(ql)?:\/\/\S+/g,
  // URL userinfo. The user part has no ":" (the first ":" ends it), so the
  // match is linear on a long run of ":"; "*" also takes an empty user.
  /https?:\/\/[^\s/@:]*:[^\s/@]+@/g,
  // Telegram bot token. The lookbehind changes no match (the leftmost match
  // always starts at the first digit of a run) but keeps long runs linear.
  /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
// A maximal run of 40+ base64 characters; it counts only when it does not
// start with "/" (an absolute path) and holds an upper, a lower and a digit.
const BASE64_RUN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{40,}/g;
// Exactly 40 lower-case hex is a git SHA: every pattern keeps it.
const GIT_SHA = /^[0-9a-f]{40}$/;

function isBase64Secret(run: string): boolean {
  return !run.startsWith("/") && /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

export type Span = [start: number, end: number];

// The secret spans of text, sorted, overlapping or touching spans merged.
export function secretSpans(text: string): Span[] {
  const spans: Span[] = [];
  const add = (m: RegExpMatchArray) => {
    if (GIT_SHA.test(m[0])) return;
    spans.push([m.index!, m.index! + m[0].length]);
  };
  for (const re of SECRET_PATTERNS) for (const m of text.matchAll(re)) add(m);
  for (const m of text.matchAll(BASE64_RUN)) if (isBase64Secret(m[0])) add(m);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

// Replace each span with REDACTED; `tokens` are the start indexes of the
// inserted tokens in the output.
function applySpans(text: string, spans: Span[]): { text: string; tokens: number[] } {
  let out = "";
  let pos = 0;
  const tokens: number[] = [];
  for (const [s, e] of spans) {
    out += text.slice(pos, s);
    tokens.push(out.length);
    out += REDACTED;
    pos = e;
  }
  return { text: out + text.slice(pos), tokens };
}

export function redactSecrets(text: string): { text: string; count: number } {
  const spans = secretSpans(text);
  return { text: applySpans(text, spans).text, count: spans.length };
}

const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isHighSurrogate = (c: string | undefined) => c !== undefined && /[\uD800-\uDBFF]/.test(c);

// The stored text of a decision line or a rule: redact, cut at max, redact
// again (spec §6.2 rule on the cut text). Pass 1 sees the whole secret even
// when it crosses the cut; pass 2 catches what the cut makes (a SHA cut to
// 32-39 hex). `count` = the inserted tokens that stay visible.
export function capRedacted(text: string, max: number): { text: string; count: number } {
  const window = max + REDACT_SLACK;
  const head = text.slice(0, window);
  const p1 = applySpans(head, secretSpans(head));
  const tokenEnd = (t: number) => t + REDACTED.length;
  let limit = Math.min(max, p1.text.length);
  // When the window splits a token, the unredacted chars at its end may be
  // part of a secret; never store them (they reach the stored text only when
  // pass 1 shrank the window by more than REDACT_SLACK chars).
  if (text.length > window && !isWs(text[window - 1]) && !isWs(text[window])) {
    let i = p1.text.length;
    const floor = p1.tokens.length ? tokenEnd(p1.tokens[p1.tokens.length - 1]) : 0;
    while (i > floor && !isWs(p1.text[i - 1])) i -= 1;
    limit = Math.min(limit, i);
  }
  // Never split a token: a cut inside one moves to its start.
  for (const t of p1.tokens) if (t < limit && limit < tokenEnd(t)) limit = t;
  if (limit < p1.text.length && isHighSurrogate(p1.text[limit - 1])) limit -= 1;

  const cut = p1.text.slice(0, limit);
  const kept = p1.tokens.filter((t) => tokenEnd(t) <= limit);
  const spans2 = secretSpans(cut);
  // A pass-2 span can hold whole pass-1 tokens (no pattern starts or ends
  // inside one); each such token is now part of one visible token.
  const held = kept.filter((t) => spans2.some(([s, e]) => s <= t && tokenEnd(t) <= e)).length;
  return { text: applySpans(cut, spans2).text, count: kept.length - held + spans2.length };
}

export class DecisionLog {
  private readonly now: () => number;
  private readonly usedAts = new Set<number>();
  private loaded: Promise<void> | undefined;
  private redacted = 0;

  constructor(private readonly file: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  // The `at`s already in the file, read once on the decision-log chain, so
  // `at` stays unique across restarts.
  private loadAts(): Promise<void> {
    this.loaded ??= onChain(this.file, async () => {
      for (const l of await this.read()) this.usedAts.add(l.at);
    }).catch((err: unknown) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  // Text: redact, cut at 500 chars, redact again (capRedacted). A
  // colliding `at` is bumped by 1 ms until it is unique.
  async append(input: Omit<DecisionLine, "at"> & { at?: number }): Promise<DecisionLine> {
    await this.loadAts();
    // No await from here to appendJsonl: the `at` is reserved and the write is
    // queued on the chain in call order.
    let at = input.at ?? this.now();
    while (this.usedAts.has(at)) at += 1;
    this.usedAts.add(at);
    const red = capRedacted(input.text, DECISION_TEXT_MAX);
    const line: DecisionLine = { ...input, at, text: red.text };
    await appendJsonl(this.file, line);
    this.redacted += red.count;
    return line;
  }

  // The lines in file order. A torn line, and a parsable line that is not an
  // object with a numeric `at` (e.g. a hand-edited `null`), are skipped.
  async read(): Promise<DecisionLine[]> {
    return (await readJsonl<unknown>(this.file)).filter(isDecisionLine);
  }

  // The [redacted] tokens this log inserted into the stored texts (each
  // visible token once; a literal "[redacted]" the user typed is not counted).
  redactions(): number {
    return this.redacted;
  }

  // The decision-log leaf chain: the same key as appends, so fn never overlaps
  // an append. Not re-entrant: fn must not call append.
  lock<T>(fn: () => Promise<T>): Promise<T> {
    return onChain(this.file, fn);
  }

  // A master-chat `brain add` of kind correction counts once (spec §6.2
  // source 3). The newest `by: "user"` master-tab|master-telegram line of the
  // last 30 min whose normalized text contains the normalized quote gets a
  // master-chat entry in `classified`; without one, a master line of its own,
  // with `refAt` = the newest such user line in the window when one exists.
  // A hit and a refAt may land on the same line, in either order or at once;
  // namedAts keeps both counts. Takes no lock: a raw read, then one public
  // append, which takes its own leaf chain once (so it never deadlocks with
  // compact).
  async countMasterCorrection(o: { quote: string; via: "master-tab" | "master-telegram"; agentId?: string; prUrl?: string },
    classified: ClassifiedLog): Promise<{ marked: number } | { appended: DecisionLine }> {
    const since = this.now() - MASTER_CHAT_WINDOW_MS;
    // The quote as a user line would be stored (redacted), so a quoted secret
    // still matches. A blank key matches nothing ("" is in every text).
    const key = normalizeRuleText(capRedacted(o.quote, DECISION_TEXT_MAX).text);
    let newest: DecisionLine | undefined;
    let hit: DecisionLine | undefined;
    for (const l of await this.read()) {
      if (l.by !== "user" || (l.via !== "master-tab" && l.via !== "master-telegram") || l.at < since) continue;
      if (!newest || l.at > newest.at) newest = l;
      if (key && isStr(l.text) && normalizeRuleText(l.text).includes(key) && (!hit || l.at > hit.at)) hit = l;
    }
    if (hit) {
      await classified.append([{ at: hit.at, correction: true, by: "master-chat" }]);
      return { marked: 1 };
    }
    const line = await this.append({ via: o.via, by: "master", reason: "master-chat", correction: true, text: o.quote,
      ...(o.agentId !== undefined && { agentId: o.agentId }), ...(o.prUrl !== undefined && { prUrl: o.prUrl }),
      ...(newest && { refAt: newest.at }) });
    return { appended: line };
  }

  // The daily compaction (spec §6.2). Lines older than 90 days that are
  // unclassified (raw correction null and no classified entry) are deleted;
  // every other old line keeps all fields but `text: ""`; classified entries
  // whose line is gone go too. Holds the decision-log chain, then the
  // classified chain — the one code that holds both, always in this order —
  // and inside uses only raw reads and atomicWrite. Each file is rewritten
  // (decisions first) only when its content changes; a rewrite drops torn and
  // malformed lines. `cleared` counts the texts cleared by this run.
  compact(classified: ClassifiedLog, now: number): Promise<{ deleted: number; cleared: number }> {
    return this.lock(() => classified.lock(async () => {
      const cutoff = now - COMPACT_AGE_MS;
      const entries = await classified.read();
      const latest = latestEntries(entries);
      const kept: DecisionLine[] = [];
      let deleted = 0;
      let cleared = 0;
      for (const l of await this.read()) {
        if (l.at >= cutoff) kept.push(l);
        else if (isUnclassified(l, latest)) deleted += 1;
        else {
          if (l.text !== "") cleared += 1;
          kept.push({ ...l, text: "" });
        }
      }
      const keptAts = new Set(kept.map((l) => l.at));
      const keptEntries = entries.filter((e) => keptAts.has(e.at));
      if (deleted > 0 || cleared > 0) await atomicWrite(this.file, toJsonl(kept));
      if (keptEntries.length < entries.length) await atomicWrite(classified.file, toJsonl(keptEntries));
      return { deleted, cleared };
    }));
  }
}

const toJsonl = (objs: readonly unknown[]) => objs.map((o) => JSON.stringify(o) + "\n").join("");
const isDecisionLine = (l: unknown): l is DecisionLine => isObj(l) && isNum(l.at);

// ---- Daily compaction timer (spec §6.2) ----

type SetTimer = (fn: () => void, ms: number) => { clear(): void };
const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A slot re-arms for the next `at` later than now + this, so a timer that
// fires a little early never arms the same slot again.
const SLOT_GAP_MS = 60_000;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The time from `now` to the next `at` (HH:MM, host TZ; invalid → 03:30)
// strictly after `now + gap`. Local time, so a DST change keeps the
// wall-clock slot (as DistillRunner's slots).
function msUntilAt(at: string, now: number, gap = 0): number {
  const m = HH_MM.exec(at) ?? HH_MM.exec("03:30")!;
  const from = now + gap;
  const d = new Date(from);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= from) {
    d.setDate(d.getDate() + 1);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  }
  return d.getTime() - now;
}

// DecisionLog.compact at the next `at` (host TZ), then at that time each
// day. Each slot arms the next one before it runs, so a compact that throws
// or rejects is only logged and the timer stays alive. Never throws; the
// returned function stops it.
export function startDailyCompaction(d: {
  decisions: Pick<DecisionLog, "compact">; classified: ClassifiedLog; at: string;
  now?: () => number; setTimer?: SetTimer;
}): () => void {
  const now = d.now ?? Date.now;
  const setTimer = d.setTimer ?? defaultSetTimer;
  const failed = (e: unknown) => console.warn(`[chief] compaction failed: ${errText(e)}`);
  let stopped = false;
  let timer: { clear(): void } | undefined;
  const arm = (gap: number) => {
    try {
      timer = setTimer(slot, msUntilAt(d.at, now(), gap));
    } catch (e) {
      console.warn(`[chief] compaction timer failed: ${errText(e)}`);
    }
  };
  const slot = () => {
    if (stopped) return;
    arm(SLOT_GAP_MS);
    try {
      d.decisions.compact(d.classified, now()).catch(failed);
    } catch (e) {
      failed(e);
    }
  };
  arm(0);
  return () => {
    stopped = true;
    timer?.clear();
  };
}

// ---- Rules (spec §6.1) ----

export type RuleScope = { area: string; repo?: string; kind?: QueueKind; audience?: "all" | "workers" | "master" };
export type RuleOrigin = "user-line" | "master" | "panel" | "memory" | "distill";
export type RuleSource = { origin: RuleOrigin; itemId?: string; agentId?: string; prUrl?: string; via?: string; memoryFile?: string; decisionAt?: number };
export type RuleKind = "correction" | "decision" | "preference";
export type ConfirmVia = "tab" | "cli" | "telegram";
export type RuleEvent =
  | { ev: "add"; id: string; at: number; text: string; scope: RuleScope; kind: RuleKind; source: RuleSource; confidence: number; state: "candidate" | "active" }
  | { ev: "confirm"; id: string; at: number; by: "user"; via: ConfirmVia; confidence: number }
  | { ev: "edit"; id: string; at: number; by: "user"; text?: string; scope?: RuleScope; confidence?: number }
  | { ev: "hit" | "strike"; id: string; at: number; itemId: string }
  | { ev: "retire"; id: string; at: number; by: "user" | "distill"; why: string };
export type Rule = { id: string; text: string; scope: RuleScope; kind: RuleKind; source: RuleSource;
  state: "candidate" | "active" | "retired"; confidence: number; hits: number; strikes: number; createdAt: number;
  latestConfirm?: { seq: number; at: number; via: ConfirmVia }; latestEditSeq?: number };

export const RULE_TEXT_MAX = 200;

// The duplicate key of a rule text: trim, collapse whitespace, lower-case,
// drop trailing "." and "!". A loop, not a regex: /[.!\s]+$/ is quadratic on a
// long run of marks.
export function normalizeRuleText(t: string): string {
  const s = t.trim().replace(/\s+/g, " ").toLowerCase();
  let end = s.length;
  while (end > 0 && ".! ".includes(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

// Runtime checks of the event shapes, so a hand-edited or corrupt line never
// reaches the fold's readers (findDuplicate, readBrain) with a wrong type.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || isStr(v);
const inSet = (set: object, v: unknown) => isStr(v) && Object.hasOwn(set, v);
const QUEUE_KINDS = { pr: 1, choice: 1, preview: 1, question: 1 } satisfies Record<QueueKind, 1>;
const AUDIENCES = { all: 1, workers: 1, master: 1 } satisfies Record<NonNullable<RuleScope["audience"]>, 1>;
const ORIGINS = { "user-line": 1, master: 1, panel: 1, memory: 1, distill: 1 } satisfies Record<RuleOrigin, 1>;
const RULE_KINDS = { correction: 1, decision: 1, preference: 1 } satisfies Record<RuleKind, 1>;
const CONFIRM_VIAS = { tab: 1, cli: 1, telegram: 1 } satisfies Record<ConfirmVia, 1>;

const isScope = (v: unknown): v is RuleScope => isObj(v) && isStr(v.area) && optStr(v.repo)
  && (v.kind === undefined || inSet(QUEUE_KINDS, v.kind)) && (v.audience === undefined || inSet(AUDIENCES, v.audience));
const isSource = (v: unknown): v is RuleSource => isObj(v) && inSet(ORIGINS, v.origin) && optStr(v.itemId)
  && optStr(v.agentId) && optStr(v.prUrl) && optStr(v.via) && optStr(v.memoryFile)
  && (v.decisionAt === undefined || isNum(v.decisionAt));

function isRuleEvent(e: unknown): e is RuleEvent {
  if (!isObj(e) || !isStr(e.id) || !isNum(e.at)) return false;
  switch (e.ev) {
    case "add":
      return isStr(e.text) && isScope(e.scope) && inSet(RULE_KINDS, e.kind) && isSource(e.source)
        && isNum(e.confidence) && (e.state === "candidate" || e.state === "active");
    case "confirm":
      return e.by === "user" && inSet(CONFIRM_VIAS, e.via) && isNum(e.confidence);
    case "edit":
      return e.by === "user" && optStr(e.text) && (e.scope === undefined || isScope(e.scope))
        && (e.confidence === undefined || isNum(e.confidence));
    case "hit":
    case "strike":
      return isStr(e.itemId);
    case "retire":
      return (e.by === "user" || e.by === "distill") && isStr(e.why);
    default:
      return false;
  }
}

// Fold rules.jsonl events in file order. `seq` is the event's index, so
// "newer" (spec §5.6 check 4) is append order, never `at`. Events for an
// unknown id, a second `add` for a known id, events after a `retire` (a
// retired rule never comes back; a new add makes a new rule) and parsable
// lines that are not well-formed events (wrong field types, unknown `ev`) are
// ignored. readJsonl already skips a torn line.
export function foldRules(events: RuleEvent[]): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  events.forEach((e, seq) => {
    if (!isRuleEvent(e)) return;
    const r = rules.get(e.id);
    if (e.ev === "add") {
      if (r) return;
      rules.set(e.id, { id: e.id, text: e.text, scope: e.scope, kind: e.kind, source: e.source,
        state: e.state, confidence: e.confidence, hits: 0, strikes: 0, createdAt: e.at });
      return;
    }
    if (!r || r.state === "retired") return;
    switch (e.ev) {
      case "confirm":
        r.state = "active";
        r.confidence = e.confidence;
        r.latestConfirm = { seq, at: e.at, via: e.via };
        r.strikes = 0;
        break;
      case "edit":
        if (e.text !== undefined) r.text = e.text;
        if (e.scope !== undefined) r.scope = e.scope;
        if (e.confidence !== undefined) r.confidence = e.confidence;
        r.latestEditSeq = seq;
        break;
      case "hit":
        r.hits += 1;
        break;
      case "strike":
        r.strikes += 1;
        break;
      case "retire":
        r.state = "retired";
        break;
    }
  });
  return rules;
}

// A RuleStore refusal; `code` is the HTTP status the brain routes answer
// (same pattern as WidgetError).
export class RuleError extends Error {
  constructor(readonly code: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "RuleError";
  }
}

// A rule id; the distill inputs (distill.ts) keep only ids of this form.
export const RULE_ID = /^r_[0-9a-z]{5}$/;
const CANDIDATE_CONFIDENCE = 0.6;
const CONFIRM_CONFIDENCE = 0.9;

function newRuleId(): string {
  let s = "";
  for (let n = 0; n < 5; n++) s += randomInt(36).toString(36);
  return `r_${s}`;
}

// The stored text of a rule: trim, then redact, cut at RULE_TEXT_MAX, redact
// again (capRedacted reads a bounded window, so an unbounded input costs
// little). Every normalize and dedup runs on this cut text.
// A lone high surrogate left at the end (a torn emoji in the input) is
// dropped: Telegram rejects a text that holds one.
function storedRuleText(text: string): string {
  const t = capRedacted(text.trim(), RULE_TEXT_MAX).text.trimEnd();
  return isHighSurrogate(t[t.length - 1]) ? t.slice(0, -1).trimEnd() : t;
}

// Blank = nothing left for the duplicate key ("", whitespace, only "." "!").
function requireRuleText(text: string): string {
  const t = storedRuleText(text);
  if (!normalizeRuleText(t)) throw new RuleError(400, "blank rule text");
  return t;
}

function checkConfidence(c: number | undefined): void {
  if (c !== undefined && !(isNum(c) && c >= 0 && c <= 1)) throw new RuleError(400, "confidence must be in [0, 1]");
}

// The rule that is not retired and has the same duplicate key as `text` (a
// stored text), or null.
function duplicateIn(rules: Iterable<Rule>, text: string): Rule | null {
  const key = normalizeRuleText(text);
  if (!key) return null;
  for (const r of rules) if (r.state !== "retired" && normalizeRuleText(r.text) === key) return r;
  return null;
}

// The rule `id` when it may change: unknown → 404, retired → 409 (the fold
// ignores every event after a retire).
function liveRule(rules: Map<string, Rule>, id: string): Rule {
  const r = rules.get(id);
  if (!r) throw new RuleError(404, `unknown rule ${id}`);
  if (r.state === "retired") throw new RuleError(409, `rule ${id} is retired`);
  return r;
}

type Plan = { id: string; events: RuleEvent[] };

// brain/rules.jsonl (spec §6.1). Reads need no lock. Every write method takes
// the rule-store lock (onChain(file)) itself, once: it reads and folds the
// file, decides, and appends its lines in one write. The lock is not
// re-entrant and has no public form: a caller that needs ordering queues on its
// own chain (e.g. "chief-tg:rules"), never inside this one. Lock order (spec
// §5.4): item lock → rule-store lock → decision-log leaf.
export class RuleStore {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly file: string, opts: { now?: () => number; newId?: () => string } = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newRuleId;
  }

  private async fold(): Promise<Map<string, Rule>> {
    return foldRules(await readJsonl<RuleEvent>(this.file));
  }

  // Every rule in add order, retired ones too.
  async all(): Promise<Rule[]> {
    return [...(await this.fold()).values()];
  }

  async active(): Promise<Rule[]> {
    return (await this.all()).filter((r) => r.state === "active");
  }

  async get(id: string): Promise<Rule | null> {
    return (await this.fold()).get(id) ?? null;
  }

  // The rule `add(text)` would answer as a duplicate (same stored text rules,
  // so redaction and the cut apply); a blank text has none. Outside the lock:
  // a hint only, `add` checks again under the lock.
  async findDuplicate(text: string): Promise<Rule | null> {
    return duplicateIn((await this.fold()).values(), storedRuleText(text));
  }

  async add(i: { text: string; scope: RuleScope; kind: RuleKind; source: RuleSource; state: "candidate" | "active";
    confidence?: number; via?: "tab" | "cli" }): Promise<{ rule: Rule; duplicate: boolean }> {
    const text = requireRuleText(i.text);
    checkConfidence(i.confidence);
    const { rule, wrote } = await this.commit((rules, at) => {
      const dup = duplicateIn(rules.values(), text);
      if (dup) return { id: dup.id, events: [] };
      const id = this.freshId(rules);
      const add: RuleEvent = { ev: "add", id, at, text, scope: i.scope, kind: i.kind, source: i.source,
        confidence: i.confidence ?? (i.state === "candidate" ? CANDIDATE_CONFIDENCE : CONFIRM_CONFIDENCE), state: i.state };
      if (i.state === "candidate") return { id, events: [add] };
      // USER direct add: the confirm right after the add, so checks 4 and 7 find one.
      return { id, events: [add, { ev: "confirm", id, at, by: "user", via: i.via ?? "tab",
        confidence: i.confidence ?? CONFIRM_CONFIDENCE }] };
    });
    return { rule: rule!, duplicate: !wrote };
  }

  // A USER edit. With `confirm`, the edit line then the confirm line, one `at`
  // (the confirm is newer by append order). No field and no confirm: no write.
  async update(id: string, o: { text?: string; scope?: RuleScope; confidence?: number; confirm?: boolean;
    via?: ConfirmVia }): Promise<Rule> {
    const text = o.text === undefined ? undefined : requireRuleText(o.text);
    checkConfidence(o.confidence);
    const { rule } = await this.commit((rules, at) => {
      liveRule(rules, id);
      const events: RuleEvent[] = [];
      if (text !== undefined || o.scope !== undefined || o.confidence !== undefined) {
        events.push({ ev: "edit", id, at, by: "user",
          ...(text !== undefined && { text }), ...(o.scope !== undefined && { scope: o.scope }),
          ...(o.confidence !== undefined && { confidence: o.confidence }) });
      }
      if (o.confirm) {
        events.push({ ev: "confirm", id, at, by: "user", via: o.via ?? "tab", confidence: o.confidence ?? CONFIRM_CONFIDENCE });
      }
      return { id, events };
    });
    return rule!;
  }

  async confirm(id: string, o: { via: ConfirmVia; confidence?: number }): Promise<Rule> {
    checkConfidence(o.confidence);
    const { rule } = await this.commit((rules, at) => {
      liveRule(rules, id);
      return { id, events: [{ ev: "confirm", id, at, by: "user", via: o.via, confidence: o.confidence ?? CONFIRM_CONFIDENCE }] };
    });
    return rule!;
  }

  // A hit or strike for an unknown or retired rule writes nothing: the fold
  // would ignore it.
  async hit(id: string, itemId: string): Promise<void> {
    await this.count("hit", id, itemId);
  }

  async strike(id: string, itemId: string): Promise<void> {
    await this.count("strike", id, itemId);
  }

  // Unknown → 404. Already retired → the rule, no write.
  async retire(id: string, o: { by: "user" | "distill"; why: string }): Promise<Rule> {
    const { rule } = await this.commit((rules, at) => {
      const r = rules.get(id);
      if (!r) throw new RuleError(404, `unknown rule ${id}`);
      return { id, events: r.state === "retired" ? [] : [{ ev: "retire", id, at, by: o.by, why: o.why }] };
    });
    return rule!;
  }

  // 0 when there is no file yet.
  async mtimeMs(): Promise<number> {
    try {
      return (await stat(this.file)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return 0;
      throw err;
    }
  }

  private async count(ev: "hit" | "strike", id: string, itemId: string): Promise<void> {
    await this.commit((rules, at) => {
      const r = rules.get(id);
      return { id, events: r && r.state !== "retired" ? [{ ev, id, at, itemId }] : [] };
    });
  }

  private freshId(rules: Map<string, Rule>): string {
    for (let n = 0; n < 100; n++) {
      const id = this.newId();
      if (!RULE_ID.test(id)) throw new Error(`bad rule id ${JSON.stringify(id)}`);
      if (!rules.has(id)) return id;
    }
    throw new Error("no free rule id");
  }

  // Under the rule-store lock: fold the file, let `plan` choose the events
  // (none = no write; a throw = no write), append them in one write, and
  // return the plan's rule from the fold after the write.
  private commit(plan: (rules: Map<string, Rule>, at: number) => Plan): Promise<{ rule: Rule | undefined; wrote: boolean }> {
    return onChain(this.file, async () => {
      const text = await readText(this.file);
      const events = parseJsonl<RuleEvent>(text);
      const rules = foldRules(events);
      const { id, events: next } = plan(rules, this.now());
      if (next.length === 0) return { rule: rules.get(id), wrote: false };
      // Never write a line the fold would drop.
      if (!next.every(isRuleEvent)) throw new RuleError(400, "invalid rule event");
      // After a torn last line (crash mid-append) appendJsonlRaw starts a new
      // line, so the torn line stays alone (the fold skips it) and these
      // events survive.
      await appendJsonlRaw(this.file, next);
      return { rule: foldRules([...events, ...next]).get(id), wrote: true };
    });
  }
}

// ---- Classification (spec §6.5) ----

export type ClassifiedEntry = { at: number; correction: boolean; by: "distill" | "master-chat"; runAt?: number };

const isClassifiedEntry = (e: unknown): e is ClassifiedEntry => isObj(e) && isNum(e.at)
  && typeof e.correction === "boolean" && (e.by === "distill" || e.by === "master-chat")
  && (e.runAt === undefined || isNum(e.runAt));

// The last entry per `at` wins (file order).
function latestEntries(entries: readonly ClassifiedEntry[]): Map<number, ClassifiedEntry> {
  const latest = new Map<number, ClassifiedEntry>();
  for (const e of entries) latest.set(e.at, e);
  return latest;
}

// Raw correction null (not a boolean) and no classified entry.
function isUnclassified(l: DecisionLine, latest: Map<number, ClassifiedEntry>): boolean {
  return typeof l.correction !== "boolean" && !latest.has(l.at);
}

// The lines a master line's `refAt` keeps out of both numbers (spec §6.2
// source 3: the master line counts that fuzzy miss once). A refAt hides only
// the line's own value (raw or distill): a line whose latest entry is a
// master-chat hit is another `brain add` and still counts, so two master
// corrections in one window count twice whatever their order. The one notion
// of "named" for metrics (foldMetrics) and distill (unclassifiedAts).
export function namedAts(lines: readonly DecisionLine[], latest: ReadonlyMap<number, ClassifiedEntry>): Set<number> {
  const named = new Set<number>();
  for (const l of lines) if (isNum(l.refAt) && latest.get(l.refAt)?.by !== "master-chat") named.add(l.refAt);
  return named;
}

// The lines the distiller may still classify: unclassified and not named
// (namedAts; a line with an entry is classified already).
export function unclassifiedAts(lines: DecisionLine[], latest: Map<number, ClassifiedEntry>): Set<number> {
  const named = namedAts(lines, latest);
  const out = new Set<number>();
  for (const l of lines) if (isUnclassified(l, latest) && !named.has(l.at)) out.add(l.at);
  return out;
}

// brain/classified.jsonl: {at, correction, by: "distill", runAt} from the
// distiller, {at, correction: true, by: "master-chat"} from the master-chat
// lookup; decisions.jsonl is never edited for them. Append-only except
// DecisionLog.compact, which rewrites `file` under lock().
export class ClassifiedLog {
  constructor(readonly file: string) {}

  // All entries in one write on the classified chain. A malformed entry
  // throws and nothing is written (read would skip it).
  async append(entries: ClassifiedEntry[]): Promise<void> {
    if (!entries.every(isClassifiedEntry)) throw new Error("invalid classified entry");
    await onChain(this.file, () => appendJsonlRaw(this.file, entries));
  }

  // The well-formed entries in file order; torn and malformed lines are skipped.
  async read(): Promise<ClassifiedEntry[]> {
    return (await readJsonl<unknown>(this.file)).filter(isClassifiedEntry);
  }

  async latest(): Promise<Map<number, ClassifiedEntry>> {
    return latestEntries(await this.read());
  }

  // The classified leaf chain: the same key as appends. Not re-entrant: fn
  // must not call append.
  lock<T>(fn: () => Promise<T>): Promise<T> {
    return onChain(this.file, fn);
  }
}
