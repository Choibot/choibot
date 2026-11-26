// server/chief/queue/types.ts — the queue item model (spec §5.1).
import { randomInt } from "node:crypto";
import type { CheckRollup, PrStatus } from "../../gh/status.js";
import { CONSOLE_AGENT_ID, type DeployInfo } from "../deploy/ticket.js";
import type { ItemKind, QueueKind } from "../kinds.js";

export type { ItemKind, QueueKind } from "../kinds.js";

/** An image of a user's answer (answerImages.ts): `name` is the ticket's copy in its media folder
 *  (a<seq>-<n>.<ext>), `path` the copy that the agent reads (the composer's upload path). */
export type AnswerImage = { name: string; path: string };
export type Answer = {
  value: string; text?: string; by: "user" | "master"; via: "tab" | "telegram" | "cli";
  at: number; ruleIds?: string[]; confidence?: number; images?: AnswerImage[];
};
export type Delivery = {
  msgId: string; state: "held" | "pending" | "delivering" | "delivered" | "failed" | "unknown";
  deliverAfter?: number; attempts: number; lastError?: string; at?: number;
};
export type QueueItem = {
  id: string;
  kind: ItemKind;
  agentId: string;
  createdBy: { agentId: string; kind: "worker" | "issue" | "lead" | "fleet-master" | "coordinator" | "relay" | "console" };
  repo: string; area: string;
  title: string; body: string;
  createdAt: number; updatedAt: number; closedAt?: number;
  status: "open" | "answered" | "auto" | "undone" | "withdrawn" | "snoozed";
  snoozedUntil?: number; blocking: boolean;
  pr?: { url: string; number: number; checks?: CheckRollup; mergeable?: PrStatus["mergeable"] }
     | { local: { repo: string; branch: string; /** Branch had commits not in the base at add time. Absent = unknown (git failed at add); PrWatch auto-closes only when `=== true`. */ aheadAtAdd?: boolean } };
  choice?: { options: { key: string; label: string; detail?: string }[] };
  preview?: { images: string[]; url?: string };
  /** The rich part (rich.ts): the item has a page an agent wrote, copied to the store at add time
   *  (`QueueStore.pagePath`). `height` is the agent's wish for the frame, in px. The body stays
   *  the truth of the ticket: the page only adds to it. */
  html?: { bytes: number; height?: number; /** Only in the answer of GET /api/queue/:id: the path of the stored copy. */ copy?: string };
  /** Shared outside by the user (share.ts): the share tool's page id and its plain link (never the
   *  password or the one-tap link), when, the paired device that pressed, and whether the link
   *  opened (the tool's own check, or the console's look at it). */
  share?: { docId: string; link: string; at: number; device: string; checked: boolean };
  /** A `deploy` item only: what the console's own check found, and the run (spec §5.7). */
  deploy?: DeployInfo;
  /** A rule suggestion only ("Make this a rule?", brain/suggest.ts): the candidate rule it asks about. */
  rule?: { id: string };
  recommend?: { value: string; why: string; ruleIds: string[]; by: string; at: number };
  answer?: Answer; history: Answer[];
  delivery?: Delivery;
  withdrawal?: Delivery & { afterMsgId?: string };
  telegram?: { cardMessageId?: number; mediaMessageIds?: number[]; extraMessageIds?: number[]; awaiting?: "changes" | "other" | "reply"; postFailed?: boolean;
    /** cardRenderHash of what the card shows now (the poster edits only when it differs). */
    renderHash?: string;
    /** The auto one-liner's message id (also in extraMessageIds); autoCleared: its [Undo] keyboard was removed. */
    autoMessageId?: number; autoCleared?: boolean;
    /** Telegram refused the preview images for good (a 4xx other than 429) or they could not be read: the card went without them. */
    mediaFailed?: boolean };
  /** A pr ticket merged from its Merge button another way than gh's merge command (merge.ts): the
   *  note of gh/actions.ts mergePullRequest ("GitHub's GraphQL API failed. The merge went through
   *  GitHub's REST API."), and when. */
  mergeNote?: { text: string; at: number };
  /** Why an item closed without an answer: "merged" | "closed" | "agent-gone". */
  lastError?: string;
  /** 0 at add; +1 at each answer commit (msgId source, decision 50). */
  answerSeq: number;
};

// An item an agent made: not one of the console's own items (the `deploy` ticket and the rule
// suggestions, agentId CONSOLE_AGENT_ID). Recommendations, auto answers, rule scopes, audit
// lines and digest lines exist only for these (spec §5.7).
export type AgentItem = QueueItem & { kind: QueueKind };
export const isAgentItem = (i: QueueItem): i is AgentItem => i.kind !== "deploy" && i.agentId !== CONSOLE_AGENT_ID;
// A "Make this a rule?" item of the console (brain/suggest.ts). Only the user answers it.
export const isRuleSuggestion = (i: QueueItem): boolean => i.agentId === CONSOLE_AGENT_ID && i.kind === "choice" && typeof i.rule?.id === "string";
// True for an item that shows images: a preview item, or a pr item that carries the screenshots
// of its PR (overview decision 65: one ticket for one ask).
export const hasImages = (i: QueueItem): boolean => (i.kind === "preview" || i.kind === "pr") && (i.preview?.images.length ?? 0) > 0;

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
export function newItemId(): string {
  let s = "q";
  for (let i = 0; i < 8; i++) s += B36[randomInt(36)];
  return s;
}
