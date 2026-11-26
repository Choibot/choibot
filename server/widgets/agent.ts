// server/widgets/agent.ts — the agent fallback (spec "Agent fallback"): a
// widget with no refresh script asks its agent by typing into the agent's
// terminal through sendToAgent (one bracketed paste, controls stripped). The
// routes call type() only for text the user confirmed; the `[widget <id>]`
// prefix shows the user and the agent where the text came from.
import type { AgentRecord } from "../agents/store.js";
import { sendToAgent, type ReplyTerminals } from "../issues/reply.js";
import { oneLine } from "../text.js";
import { WidgetError } from "./errors.js";
import { LIMITS } from "./paths.js";

export const TYPE_INTERVAL_MS = 10_000;

// The confirm bar must show all that will be typed: oneLine drops controls
// (sendToAgent would drop them anyway) and folds every whitespace run.
export function refreshMessage(wid: string, dir: string, args?: unknown): string {
  const base = `[widget ${wid}] Refresh: get fresh data and write it as JSON to ${dir}/data.json.`;
  const text = oneLine(args === undefined ? base : `${base} Args: ${JSON.stringify(args)}`);
  if (text.length > LIMITS.askText) throw new WidgetError(400, "args too long");
  return text;
}

export function askMessage(wid: string, text: string): string {
  return `[widget ${wid}] ${oneLine(text)}`.slice(0, LIMITS.askText);
}

export type TyperDeps = {
  terminals: ReplyTerminals;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // sendToAgent's readiness check (index.ts sets it from chiefActive).
  checkReady?: boolean;
};

type TypedRec = Pick<AgentRecord, "id" | "kind" | "status">;

export class AgentTyper {
  private last = new Map<string, number>();

  constructor(private d: TyperDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // Everything that can refuse a message, before any confirm bar opens.
  // Issue agents: each typed turn would go to Telegram through the issue relay.
  check(rec: TypedRec, wid: string): void {
    if (rec.kind === "issue") throw new WidgetError(409, "not for issue agents");
    if (rec.status !== "running" && rec.status !== "idle") throw new WidgetError(409, "agent not running");
    const prev = this.last.get(`${rec.id}/${wid}`);
    if (prev !== undefined && this.now() - prev < TYPE_INTERVAL_MS) {
      throw new WidgetError(429, "one message per widget every 10 s");
    }
  }

  async type(rec: TypedRec, wid: string, text: string): Promise<void> {
    this.check(rec, wid);
    const key = `${rec.id}/${wid}`;
    this.last.set(key, this.now()); // taken before the await: a parallel call gets 429
    let ok = false;
    try {
      // "not-live" and "starting" both answer the 409 below.
      ok = (await sendToAgent(this.d.terminals, rec.id, text, this.d.sleep, { checkReady: this.d.checkReady })) === "sent";
    } finally {
      if (!ok) this.last.delete(key);
    }
    if (!ok) throw new WidgetError(409, "agent not running");
  }
}
