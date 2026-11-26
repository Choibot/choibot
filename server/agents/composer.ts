// server/agents/composer.ts — the composer under each agent terminal
// (spec 2026-11-05-agent-composer). The browser queues what the user writes
// and POSTs one message at a time; this route types it into the agent's PTY
// the same way Telegram replies do (one bracketed paste, then Enter), but only
// once the agent's TUI can take it, and never twice for the same msgId.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pasteOf, typeIntoAgentWhy, withTypingLock, type ReplyTerminals } from "../issues/reply.js";
import type { CaptureLine } from "../chief/brain/capture.js";

export const MAX_TEXT = 32_000;
export const DEDUP_KEEP = 200;
const MSG_ID_RE = /^[\w-]{8,64}$/;

export type GateTerminals = ReplyTerminals;

export type ComposerDeps = {
  terminals: GateTerminals;
  agentExists: (id: string) => Promise<boolean>;
  // The agent works on a turn now: a line typed into it goes into its wait
  // line. The answer then has `busy`, and the thread says "Waits" at once,
  // before the session file does.
  isBusy?: (id: string) => Promise<boolean>;
  // A closed agent whose session is stopped: resume it with `text` as its
  // first turn, as a Telegram reply does (agents/closed.ts). True when it did.
  resumeClosed?: (agentId: string, text: string) => Promise<boolean>;
  // The fleet master's inbox tracker (server/master/draft.ts): fed with the
  // bytes we type, before the paste, as web input is.
  onTyped?: (agentId: string, data: string) => void;
  // A line of the composer route (`input`) was typed, or resumed a closed
  // agent: the user wrote to this agent (the master's quiet policy,
  // server/master/quiet.ts). Never for `inputInternal` (a queue answer, a
  // reminder): the console typed those.
  onUserLine?: (agentId: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type InputResult =
  | { code: 200; body: { delivered: true; duplicate?: true; busy?: true } }
  | { code: 400; body: { error: string } }
  | { code: 404; body: { reason: "agent-gone" } }
  // `dialog`: the line waits because Claude asks a question on the agent's screen (the reason
  // stays "starting" for the callers that try again on it; the page says the true cause).
  | { code: 409; body: { reason: "not-live" | "starting" | "busy"; dialog?: true } };

// The reminder deliverer's options (the queue Deliverer passes none):
// noResume — a stopped closed agent is not-live (the reminder deliverer
// resumes a closed agent itself, with the line as its first turn); hold —
// asked inside the typing lock, on a live and ready PTY, just before the
// paste: true answers 409 busy and types nothing.
export type InternalOpts = { noResume?: boolean; hold?: () => Promise<boolean> };

export class ComposerGate {
  // Delivered msgIds per agent, oldest first, at most DEDUP_KEEP.
  private delivered = new Map<string, string[]>();

  constructor(private d: ComposerDeps) {}

  private seen(id: string, msgId: string): boolean {
    return this.delivered.get(id)?.includes(msgId) ?? false;
  }

  private remember(id: string, msgId: string): void {
    const list = this.delivered.get(id) ?? [];
    list.push(msgId);
    if (list.length > DEDUP_KEEP) list.splice(0, list.length - DEDUP_KEEP);
    this.delivered.set(id, list);
  }

  async input(id: string, body: unknown): Promise<InputResult> {
    return this.deliver(id, body, {}, true);
  }

  // The queue Deliverer's door (spec §5.4 step 3): the same gate as `input`.
  // The user-line capture lives in the route, which never calls this.
  async inputInternal(id: string, o: { msgId: string; text: string }, opts: InternalOpts = {}): Promise<InputResult> {
    return this.deliver(id, o, opts);
  }

  private async deliver(id: string, body: unknown, opts: InternalOpts = {}, fromUser = false): Promise<InputResult> {
    const { msgId, text } = (body ?? {}) as { msgId?: unknown; text?: unknown };
    if (typeof msgId !== "string" || !MSG_ID_RE.test(msgId)) return { code: 400, body: { error: "bad msgId" } };
    if (typeof text !== "string" || !text.trim()) return { code: 400, body: { error: "empty text" } };
    if (text.length > MAX_TEXT) return { code: 400, body: { error: `text over ${MAX_TEXT} chars` } };
    if (!(await this.d.agentExists(id))) return { code: 404, body: { reason: "agent-gone" } };
    // Dedup, liveness, readiness and typing are one critical section, shared
    // with every other writer of this PTY. A second request with the same
    // msgId waits here and then sees the first one's result.
    return withTypingLock(id, async (): Promise<InputResult> => {
      if (this.seen(id, msgId)) return { code: 200, body: { delivered: true, duplicate: true } };
      const t = this.d.terminals;
      const attached = t.has(id);
      if (!attached && !(await t.hasSession(id))) {
        if (!opts.noResume && (await this.d.resumeClosed?.(id, text))) {
          if (fromUser) this.d.onUserLine?.(id);
          this.remember(id, msgId);
          return { code: 200, body: { delivered: true } };
        }
        return { code: 409, body: { reason: "not-live" } };
      }
      // A session not attached here survived a server restart: its TUI is up
      // (typeIntoAgent reattaches it). One spawned here must have turned on
      // bracketed paste first, or a multi-line prompt would arrive as keys.
      // Not ready because Claude asks a question at its start (the folder trust dialog comes
      // before the input box): the page then says the true cause.
      if (attached && !t.inputReady(id)) {
        const dialog = t.dialogOn ? await t.dialogOn(id).catch(() => false) : false;
        return { code: 409, body: { reason: "starting", ...(dialog ? { dialog: true as const } : {}) } };
      }
      if (opts.hold && (await opts.hold())) return { code: 409, body: { reason: "busy" } };
      // Asked before the paste: the line itself starts a turn of an idle agent.
      const busy = fromUser && (await this.d.isBusy?.(id).catch(() => false)) === true;
      this.d.onTyped?.(id, pasteOf(text) + "\r");
      const typed = await typeIntoAgentWhy(t, id, text, this.d.sleep);
      // A dialog of Claude is on its screen: the line would answer it. As a TUI that is not ready.
      if (typed === "dialog") return { code: 409, body: { reason: "starting", dialog: true } };
      if (typed !== "sent") return { code: 409, body: { reason: "not-live" } };
      if (fromUser) this.d.onUserLine?.(id);
      this.remember(id, msgId);
      return { code: 200, body: { delivered: true, ...(busy ? { busy: true as const } : {}) } };
    });
  }
}

// The chief's capture of composer lines (spec §6.2 source 2). index.ts passes
// it only while the chief is active.
export type ComposerCapture = {
  isUser(req: FastifyRequest): Promise<boolean>;
  // From the agent record: kind (fleet master → master-tab), prUrl, repo.
  lineFor(agentId: string): Promise<{ via: "composer" | "master-tab"; prUrl?: string; repo?: string }>;
  capture(line: CaptureLine): Promise<{ hint?: string }>;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A delivered line of a USER caller, after its PTY write and outside the
// typing lock. Best effort: any error is logged and the line keeps its 200.
// The capture is awaited (a decision line and, for `rule:`, the rule add) so a
// duplicate rule's hint can go in the body; it never waits on Telegram.
async function captureLine(c: ComposerCapture, req: FastifyRequest, agentId: string, text: string): Promise<string | undefined> {
  try {
    if (!(await c.isUser(req))) return undefined;
    const line = await c.lineFor(agentId);
    return (await c.capture({ text, agentId, ...line })).hint;
  } catch (e) {
    console.warn(`[composer] capture for ${agentId} failed:`, errText(e));
    return undefined;
  }
}

export function registerComposerApi(app: FastifyInstance, gate: ComposerGate, capture?: ComposerCapture): void {
  app.post("/api/agents/:id/input", { bodyLimit: 256 * 1024 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const r = await gate.input(id, req.body);
    // Only a delivered, non-duplicate line is captured (plan ambiguity 14).
    if (!capture || r.code !== 200 || r.body.duplicate) return reply.code(r.code).send(r.body);
    const hint = await captureLine(capture, req, id, (req.body as { text: string }).text);
    return reply.code(r.code).send(hint ? { ...r.body, hint } : r.body);
  });
}
