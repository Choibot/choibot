// src/lib/queueDetail.ts — pure helpers for the Queue tab's detail pane (spec §8b right pane):
// which actions the bar shows, the recommendation line, the pr payload facts.
// All item text is untrusted: callers render it as plain text.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { isPersistentAgentId } from "../../server/chief/kinds";

export type DetailAction = { id: "accept" | "approve" | "changes" | "reply" | "snooze" | "withdraw"; label: string; key?: string };

// Decision 39: a persistent agent's item gets no accept and no "Master suggests" line.
export const canAccept = (i: QueueItem): boolean => !!i.recommend && !isPersistentAgentId(i.agentId) && (i.kind === "choice" || i.kind === "question");

// A pr item has no approve (overview decision 60): the user merges, and the merge closes the
// item. Every view that builds its buttons from this list (the Queue tab, a ticket card in an
// agent's thread) so offers none; `prWait` gives what to show in its place.
export function detailActions(i: QueueItem, readOnly: boolean): DetailAction[] {
  if (readOnly) return [];
  const out: DetailAction[] = [];
  // The console's own deploy ticket (chief spec §5.7): no answer. Its Deploy button is its own
  // control (DeployPanel); here it can only be put aside.
  if (i.kind === "deploy") return [{ id: "snooze", label: "Snooze 1 h", key: "s" }, { id: "withdraw", label: "Withdraw" }];
  // The usage-limit ticket: its rows' buttons are its own (LimitPanel); it has no snooze (the
  // agents wait now). Withdraw dismisses it until a new block comes.
  if (i.kind === "limit") return [{ id: "withdraw", label: "Withdraw" }];
  if (i.kind === "pr" || i.kind === "preview") {
    if (i.kind === "preview") out.push({ id: "approve", label: "Looks good", key: "a" });
    out.push({ id: "changes", label: "Request changes", key: "c" });
  } else {
    if (canAccept(i)) out.push({ id: "accept", label: "Accept suggestion", key: "Enter" });
    // A "Make this a rule?" item (the console's own): its reply is the new rule text.
    out.push({ id: "reply", label: i.rule ? "Edit" : "Reply", key: "r" });
  }
  out.push({ id: "snooze", label: "Snooze 1 h", key: "s" });
  out.push({ id: "withdraw", label: "Withdraw" });
  return out;
}

// The answer value the reply box sends, by kind.
export const replyValue = (i: QueueItem): "changes" | "reply" => (i.kind === "pr" || i.kind === "preview" ? "changes" : "reply");

export function recommendLine(i: QueueItem): string | null {
  const r = i.recommend;
  if (!r || isPersistentAgentId(i.agentId)) return null;
  return `${r.by === "coordinator" ? "Coordinator" : "Master"} suggests ${r.value}${r.ruleIds.length ? ` — rule ${r.ruleIds.join(", ")}` : ""}`;
}

export type PrFacts =
  | { checks?: string; mergeable?: string; url: string; number: number; slug?: string }
  | { branch: string };

// `owner/name` from a GitHub PR url: the PR diff API matches a repo by its slug (item.repo is a label).
export function prSlug(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+(?:[/?#]|$)/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function prFacts(i: QueueItem): PrFacts | null {
  const p = i.pr;
  if (!p) return null;
  if ("local" in p) return { branch: p.local.branch };
  const slug = prSlug(p.url);
  return {
    ...(p.checks ? { checks: p.checks } : {}), ...(p.mergeable ? { mergeable: p.mergeable } : {}), url: p.url, number: p.number,
    ...(slug ? { slug } : {}),
  };
}

// A PR's page on GitHub as a link target: an https://github.com/ URL only (no user part, no
// port). Any other value gives null, and the caller shows no link. Item text is untrusted.
export function githubUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  return u.protocol === "https:" && u.hostname === "github.com" && u.port === "" && u.username === "" && u.password === "" ? u.href : null;
}

// The state of an open pr item in place of an Approve button (decision 60), for every view that
// shows one. `what` names the thing to merge. `href` is the one action, the link to where the
// user merges it: the PR on GitHub, in a new browser tab (`newTab`), or for a local item its
// agent's Reconcile panel inside the console. A PR url that is not a GitHub one gives no link.
export const PR_WAIT_TEXT = "Not merged yet";
// The visible form of the `a` key on a pr item (decision 64): the user says that the merge is
// made, and the server reads the PR's state now (lib/useQueueRun `checkPr`). It approves nothing.
export const PR_CHECK_TEXT = "I merged it";
export const PR_CHECKING_TEXT = "Checking…";
export const PR_CHECK_TITLE = "Check now if it is merged. The ticket closes when it is.";
export type PrWait = { what: string; hint: string; open: string; href?: string; newTab?: true };
export function prWait(i: QueueItem): PrWait | null {
  const f = i.kind === "pr" ? prFacts(i) : null;
  if (!f) return null;
  if ("branch" in f) {
    return { what: `branch ${f.branch}`, hint: "This item closes when the branch is merged.", open: "Open Reconcile", href: `/#agent=${i.agentId}&reconcile` };
  }
  const what = `PR #${f.number}`;
  const href = githubUrl(f.url);
  return { what, hint: `This item closes when ${what} is merged.`, open: `Open ${what}`, ...(href ? { href, newTab: true as const } : {}) };
}

// The attributes of the "Open …" link of a pr item, the same in every view. The PR opens on
// GitHub in a new tab, and that page gets no handle on the console (noopener) and no referrer.
// Reconcile stays in this tab. Null: no link.
export type OpenLinkAttrs = { href: string; target?: "_blank"; rel?: "noopener noreferrer" };
export function openLinkAttrs(w: PrWait | null): OpenLinkAttrs | null {
  if (!w?.href) return null;
  return w.newTab ? { href: w.href, target: "_blank", rel: "noopener noreferrer" } : { href: w.href };
}

// The Reconcile panel route for a local pr (hashRoute `#agent=<id>&reconcile`).
export const localPrHref = (i: QueueItem): string | null => (i.pr && "local" in i.pr ? `/#agent=${i.agentId}&reconcile` : null);
