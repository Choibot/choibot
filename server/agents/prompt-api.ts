// server/agents/prompt-api.ts — the prompt card's routes.
//   GET  /api/agents/prompts      every agent that shows a prompt now
//   GET  /api/agents/:id/prompt   one agent's prompt (and whether it is live)
//   GET  /api/agents/:id/screen   one agent's screen as text lines
//   POST /api/agents/:id/keys     press keys from the allow-list
// A change reaches the browser as an `agent-prompt` event on /api/events
// (server/events.ts); the card then reads the prompt route.
//
// Keys go through the typing lock and the PTY write path of every other
// writer (issues/reply.ts), one key per write with a short gap, so a lone ESC
// is never read as the start of the next key's escape sequence.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withTypingLock, type ReplyTerminals } from "../issues/reply.js";
import { isAgentId } from "../ids.js";
import { isPromptKey, promptKeySeq, type PromptKey, type PromptKind } from "./prompt.js";
import type { PromptState, PromptSummary } from "./prompt-watch.js";
import type { Screen } from "./screen.js";

export const MAX_KEYS = 16;
export const KEY_GAP_MS = 40;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type PromptApiDeps = {
  terminals: Pick<ReplyTerminals, "has" | "hasSession" | "write" | "reattach">;
  prompts: {
    state(id: string): Promise<PromptState | null>;
    screen(id: string): Promise<Screen | null>;
    list(): PromptSummary[];
  };
  agentExists: (id: string) => Promise<boolean>;
  // The bytes of each accepted key, before the write, as the terminal
  // WebSocket reports web input (index.ts: the masters' inbox trackers, and
  // Enter reopens a closed agent).
  onTyped?: (agentId: string, data: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type PromptResult =
  | { code: 200; body: { live: boolean; prompt: PromptState | null } }
  | { code: 404; body: { reason: "agent-gone" } };

export type ScreenResult =
  | { code: 200; body: ({ live: true } & Screen) | { live: false } }
  | { code: 404; body: { reason: "agent-gone" } };

export type KeysResult =
  | { code: 200; body: { sent: true } }
  | { code: 400; body: { error: string } }
  | { code: 404; body: { reason: "agent-gone" } }
  | { code: 409; body: { reason: "not-live" } }
  // `rev` no longer names the prompt on screen; `prompt` is what shows now.
  | { code: 409; body: { reason: "stale"; prompt: PromptState | null } };

// A session that survived a server restart has no PTY client here until
// something attaches. The reattach replays its history, so its screen is
// there right after. Inside the typing lock: never beside a relaunch or a
// typed message.
async function ensureAttached(t: PromptApiDeps["terminals"], id: string): Promise<boolean> {
  if (t.has(id)) return true;
  return withTypingLock(id, async () => {
    if (!t.has(id) && (await t.hasSession(id))) await t.reattach(id);
    return t.has(id);
  });
}

export async function readPrompt(d: PromptApiDeps, id: string): Promise<PromptResult> {
  if (!isAgentId(id) || !(await d.agentExists(id))) return { code: 404, body: { reason: "agent-gone" } };
  if (!(await ensureAttached(d.terminals, id))) return { code: 200, body: { live: false, prompt: null } };
  return { code: 200, body: { live: true, prompt: await d.prompts.state(id) } };
}

// The kind of dialog on the screen of an agent whose terminal is live here, for a poll (the
// set-up page's first agent, every few seconds): never a reattach. A terminal that is not live
// gives no dialog; the card's own read (readPrompt) attaches it when the user opens it.
export async function livePromptKind(d: Pick<PromptApiDeps, "terminals" | "prompts">, id: string): Promise<PromptKind | null> {
  if (!isAgentId(id) || !d.terminals.has(id)) return null;
  return (await d.prompts.state(id))?.kind ?? null;
}

export async function readScreen(d: PromptApiDeps, id: string): Promise<ScreenResult> {
  if (!isAgentId(id) || !(await d.agentExists(id))) return { code: 404, body: { reason: "agent-gone" } };
  const screen = (await ensureAttached(d.terminals, id)) ? await d.prompts.screen(id) : null;
  return { code: 200, body: screen ? { live: true, ...screen } : { live: false } };
}

function parseKeys(body: unknown): { keys: PromptKey[]; rev?: string } | string {
  const { keys, rev } = (body ?? {}) as { keys?: unknown; rev?: unknown };
  if (!Array.isArray(keys) || keys.length === 0) return "keys must be a non-empty array";
  if (keys.length > MAX_KEYS) return `at most ${MAX_KEYS} keys`;
  const bad = keys.find((k) => !isPromptKey(k));
  if (bad !== undefined) return `key not allowed: ${typeof bad === "string" ? bad.slice(0, 20) : typeof bad}`;
  if (rev !== undefined && (typeof rev !== "string" || !/^[0-9a-f]{1,64}$/.test(rev))) return "bad rev";
  return { keys: keys as PromptKey[], rev: rev as string | undefined };
}

export async function sendKeys(d: PromptApiDeps, id: string, body: unknown): Promise<KeysResult> {
  const parsed = parseKeys(body);
  if (typeof parsed === "string") return { code: 400, body: { error: parsed } };
  if (!isAgentId(id) || !(await d.agentExists(id))) return { code: 404, body: { reason: "agent-gone" } };
  const t = d.terminals;
  const sleep = d.sleep ?? defaultSleep;
  // Liveness, the rev check and the writes are one critical section, shared
  // with every other writer of this PTY.
  return withTypingLock(id, async (): Promise<KeysResult> => {
    if (!t.has(id) && (await t.hasSession(id))) await t.reattach(id);
    if (!t.has(id)) return { code: 409, body: { reason: "not-live" } };
    if (parsed.rev !== undefined) {
      // A card's keys are moves from the selection it showed: they are valid
      // only while that exact prompt is still on screen.
      const now = await d.prompts.state(id);
      if (!now || now.rev !== parsed.rev) return { code: 409, body: { reason: "stale", prompt: now } };
    }
    for (const [i, k] of parsed.keys.entries()) {
      if (i > 0) await sleep(KEY_GAP_MS);
      if (!t.has(id)) return { code: 409, body: { reason: "not-live" } }; // it ended on an earlier key
      const seq = promptKeySeq(k);
      d.onTyped?.(id, seq);
      t.write(id, seq);
    }
    return { code: 200, body: { sent: true } };
  });
}

export function registerPromptApi(app: FastifyInstance, d: PromptApiDeps): void {
  // A static path: it wins over /api/agents/:id.
  app.get("/api/agents/prompts", async () => ({ prompts: d.prompts.list() }));

  app.get("/api/agents/:id/prompt", async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await readPrompt(d, (req.params as { id: string }).id);
    return reply.code(r.code).send(r.body);
  });

  app.get("/api/agents/:id/screen", async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await readScreen(d, (req.params as { id: string }).id);
    return reply.code(r.code).send(r.body);
  });

  app.post("/api/agents/:id/keys", { bodyLimit: 4 * 1024 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await sendKeys(d, (req.params as { id: string }).id, req.body);
    return reply.code(r.code).send(r.body);
  });
}
