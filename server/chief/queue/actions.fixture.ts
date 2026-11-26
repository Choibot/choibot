// server/chief/queue/actions.fixture.ts — the instrumented harness the
// QueueActions tests share (actions*.test.ts, auto*.test.ts). vitest only
// collects *.test.ts, so this file never runs on its own. A real QueueStore,
// RuleStore, DecisionLog and AuditLog under `root`, wrapped so a test can see
// what runs inside an item lock (`steps`, with the lock depth `held`), which
// items the store wrote (`changes`, its onChange) and which ids were kicked
// (`kicks`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DecisionLog, RuleStore, type DecisionLine, type RuleEvent } from "../brain/store.js";
import { readJsonl } from "../files.js";
import type { ActionResult } from "./actions.js";
import { AuditLog, type AuditEntry } from "./auto.js";
import { QueueStore } from "./store.js";
import type { QueueItem } from "./types.js";

export type Step = { what: string; held: number };

export function harness(root: string, now: () => number, o: { failDecision?: boolean } = {}) {
  const changes: QueueItem[] = [];
  const store = new QueueStore(join(root, "queue"), { now, log: () => {}, onChange: (i) => changes.push(i) });
  // `held` = item locks held right now; `queued` = withItem calls still
  // waiting for their lock (their fn has not started).
  let held = 0;
  let queued = 0;
  const steps: Step[] = [];
  const step = (what: string) => { steps.push({ what, held }); };
  const withItem = store.withItem.bind(store);
  store.withItem = (id, fn) => {
    queued++;
    return withItem(id, async () => {
      queued--;
      held++;
      try { return await fn(); } finally { held--; }
    });
  };
  const write = store.write.bind(store);
  store.write = async (item) => { step("write"); await write(item); };
  const rulesFile = join(root, "brain", "rules.jsonl");
  const decisionsFile = join(root, "brain", "decisions.jsonl");
  const rules = new RuleStore(rulesFile, { now });
  const decisions = new DecisionLog(decisionsFile, { now });
  const add = rules.add.bind(rules), hit = rules.hit.bind(rules), strike = rules.strike.bind(rules);
  rules.add = async (i) => {
    step("rule add");
    return add(i);
  };
  rules.hit = async (id, itemId) => { step(`hit ${id}`); await hit(id, itemId); };
  rules.strike = async (id, itemId) => { step(`strike ${id}`); await strike(id, itemId); };
  const append = decisions.append.bind(decisions);
  decisions.append = async (i) => {
    step("decision");
    if (o.failDecision) throw new Error("decisions disk full");
    return append(i);
  };
  const auditFile = join(root, "audit", "auto.jsonl");
  const audit = new AuditLog(auditFile);
  const auditAppend = audit.append.bind(audit);
  audit.append = async (e) => { step(`audit ${e.event}`); await auditAppend(e); };
  const kicks: string[] = [];
  const logs: string[] = [];
  return {
    root, store, rules, decisions, audit, rulesFile, decisionsFile, auditFile, changes, steps, kicks, logs,
    queued: () => queued,
    // The QueueActions deps `deliverer` and `log`.
    kicker: { kick: (id: string) => { step(`kick ${id}`); kicks.push(id); } },
    log: (s: string) => { logs.push(s); },
  };
}
export type Harness = ReturnType<typeof harness>;

// The item file as stored, to show that a refused action wrote nothing.
export const raw = (h: Pick<Harness, "root">, id: string): string => readFileSync(join(h.root, "queue", `${id}.json`), "utf8");
export const get = async (h: Pick<Harness, "store">, id: string): Promise<QueueItem> => (await h.store.get(id))!;
export const lines = (h: Pick<Harness, "decisionsFile">) => readJsonl<DecisionLine>(h.decisionsFile);
export const ruleEvents = (h: Pick<Harness, "rulesFile">) => readJsonl<RuleEvent>(h.rulesFile);
export const auditLines = (h: Pick<Harness, "auditFile">) => readJsonl<AuditEntry>(h.auditFile);

export const ok = (r: ActionResult): QueueItem => {
  if (r.code !== 200) throw new Error(`expected 200, got ${r.code} ${JSON.stringify(r.body)}`);
  return r.item;
};

// A direct write under the item lock (test setup); then steps and changes are reset.
export async function patch(h: Harness, id: string, fn: (it: QueueItem) => QueueItem): Promise<void> {
  await h.store.withItem(id, async () => { await h.store.write(fn((await h.store.get(id))!)); });
  h.steps.length = 0;
  h.changes.length = 0;
}

// Forget steps, changes and kicks so far.
export const reset = (h: Harness): void => { h.steps.length = 0; h.changes.length = 0; h.kicks.length = 0; };

// A promise the test settles.
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// The state of `p` once every microtask already due has run (one macrotask
// turn): "pending" means it waits on something outside (a lock, a deferred).
export async function settledState(p: Promise<unknown>): Promise<"settled" | "pending"> {
  let state: "settled" | "pending" = "pending";
  p.then(() => { state = "settled"; }, () => { state = "settled"; });
  await new Promise((r) => setImmediate(r));
  return state;
}
