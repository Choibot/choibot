// src/lib/hashRoute.ts — the hash routes the chief links open (spec "Hash routes").
export type HashRoute =
  | { kind: "pair"; code: string }
  | { kind: "brain-diff" }
  | { kind: "reconcile"; agentId: string }
  // A PR's row in the GitHub tab: where the user merges the PR of a queue pr item.
  | { kind: "pr"; slug: string; number: number }
  // A recurring task's page (the link of a run's Telegram message: bin/lib/cron-result.mjs taskPageUrl).
  | { kind: "recurring"; name: string };

const CODE_RE = /^[\w-]{1,200}$/;
const AGENT_RE = /^[\w-]{1,64}$/;
const PR_RE = /^pr=([\w.-]{1,100}\/[\w.-]{1,100})\/([1-9]\d{0,8})$/;
// A task name (NAME_RE of bin/lib/cronspec.ts).
const RECURRING_RE = /^recurring=([a-z0-9][a-z0-9-]{0,40})$/;

// The link to a PR's row in the GitHub tab, or null when the slug or number is not a plain one.
export function prHash(slug: string, number: number): string | null {
  const h = `pr=${slug}/${number}`;
  return PR_RE.test(h) ? `/#${h}` : null;
}

export function parseHashRoute(hash: string): HashRoute | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (h === "brain=diff") return { kind: "brain-diff" };
  const pair = /^pair=(.*)$/.exec(h);
  if (pair) return CODE_RE.test(pair[1]) ? { kind: "pair", code: pair[1] } : null;
  const agent = /^agent=([^&]*)&reconcile$/.exec(h);
  if (agent) return AGENT_RE.test(agent[1]) ? { kind: "reconcile", agentId: agent[1] } : null;
  const pr = PR_RE.exec(h);
  if (pr) return { kind: "pr", slug: pr[1], number: Number(pr[2]) };
  const task = RECURRING_RE.exec(h);
  if (task) return { kind: "recurring", name: task[1] };
  return null;
}
