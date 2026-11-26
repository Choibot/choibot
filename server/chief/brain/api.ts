// server/chief/brain/api.ts — brain routes (spec §7). Phase 1a: paired devices
// and the master's merge-order log. Phase 1b: the brain, its rules, distill,
// apply / discard / rollback and the corrections metric, registered only when
// the 1b deps are given. Registered only when CHIEF_ENABLED=1; every route
// answers 503 while misconfigured.
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { EventHub } from "../../events.js";
import { isAgentId } from "../../ids.js";
import { PR_URL_RE } from "../../master/events.js";
import { DEVICE_LABEL_RE, type Caller, type DeviceStore } from "../auth.js";
import { readText } from "../files.js";
import { gateRoute, gateUser, pairRequired, type ChiefGate } from "../gate.js";
import type { ChiefPaths } from "../paths.js";
import type { ChiefTelegram } from "../telegram.js";
import { applyProposal, discardProposal, rollbackBrain } from "./apply.js";
import { readProposal, type DistillRunner, type DistillStatus } from "./distill.js";
import { foldMetrics } from "./metrics.js";
import { AREA_RE } from "./prompt.js";
import { oneTimeReason } from "./standing.js";
import {
  capRedacted, RULE_ID, RULE_TEXT_MAX, RuleError,
  type ClassifiedLog, type DecisionLog, type Rule, type RuleSource, type RuleStore,
} from "./store.js";

export type BrainApiDeps = {
  gate: ChiefGate;
  devices: Pick<DeviceStore, "list" | "revoke">;
  decisions: Pick<DecisionLog, "append" | "read" | "countMasterCorrection">;
  surface: () => "tab" | "telegram";
  // Phase 1b. The routes below the decisions route exist only when rules,
  // classified, paths and hub are all given. Without distill the distill
  // route answers 503; without hardened the mode is weak.
  rules?: RuleStore;
  classified?: ClassifiedLog;
  paths?: ChiefPaths;
  hub?: Pick<EventHub, "emitEvent">;
  distill?: Pick<DistillRunner, "runOnce" | "status">;
  hardened?(): boolean;
  // True in a hardened deployment (overview decision 45): the UI hides the
  // editor buttons. Absent: false.
  editorOff?: boolean;
  telegram?: Pick<ChiefTelegram, "postRuleCard" | "postProposalCard">;
  // A new candidate was made (index.ts: the rule suggester's sync). Never awaited.
  onCandidate?: () => void;
  now?: () => number;
  log?: (s: string) => void;
};

const decisionBody = z.object({
  value: z.string().min(1).max(100),
  text: z.string(),
  agent: z.string().refine(isAgentId).optional(),
  pr: z.string().regex(PR_URL_RE).optional(),
  via: z.enum(["master-tab", "master-telegram"]).optional(),
});

export function registerBrainApi(app: FastifyInstance, d: BrainApiDeps): void {
  app.get("/api/brain/devices", async (req, reply) => {
    if (!(await gateUser(d.gate, req, reply))) return reply;
    return (await d.devices.list()).map(({ label, createdAt, lastUsedAt }) => ({ label, createdAt, lastUsedAt }));
  });

  app.post<{ Params: { label: string } }>("/api/brain/devices/:label/revoke", async (req, reply) => {
    if (!(await gateUser(d.gate, req, reply))) return reply;
    const { label } = req.params;
    if (!DEVICE_LABEL_RE.test(label) || !(await d.devices.revoke(label))) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // The fleet master logs a merge order (§6.2 source 3).
  app.post("/api/brain/decisions", async (req, reply) => {
    if (!gateRoute(d.gate, reply)) return reply;
    const caller = await d.gate.caller(req);
    if (caller.level !== "master") return reply.code(403).send({ error: "master only" });
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const b = body.data;
    await d.decisions.append({
      by: "master", reason: "master-chat", correction: null, value: b.value, text: b.text,
      agentId: b.agent, prUrl: b.pr,
      via: b.via ?? (d.surface() === "telegram" ? "master-telegram" : "master-tab"),
    });
    return { ok: true };
  });

  const { rules, classified, paths, hub } = d;
  if (rules && classified && paths && hub) registerBrainRoutes(app, { ...d, rules, classified, paths, hub });
}

// ---- Phase 1b routes (spec §7, §6.1, §6.2 source 3, §3) ----

type Deps = BrainApiDeps & Required<Pick<BrainApiDeps, "rules" | "classified" | "paths" | "hub">>;
type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

// Every string field is bounded. A repo or memory file may come as a path;
// only its basename is stored, and the server never reads either.
const NAME_RE = /^[\w.-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d{1,20}$/;
const RETIRE_WHY_MAX = 200;
const baseName = (inMax: number, outMax: number) => z.string().min(1).max(inMax)
  .transform((s) => basename(s))
  .refine((s) => s.length <= outMax && NAME_RE.test(s) && s !== "." && s !== "..");
const nonBlank = (s: string) => s.trim().length > 0;

const ruleText = z.string().min(1).max(RULE_TEXT_MAX).refine(nonBlank);
const scopeBody = z.object({
  area: z.string().regex(AREA_RE),
  repo: baseName(256, 100).optional(),
  kind: z.enum(["pr", "choice", "preview", "question"]).optional(),
  audience: z.enum(["all", "workers", "master"]).optional(),
});
// `via` over HTTP is the confirm line's tab | cli, never telegram (§6.1).
const httpVia = z.enum(["tab", "cli"]);

// zod strips unknown keys: a body cannot set `origin` or any other source field.
const addBody = z.object({
  text: ruleText,
  scope: scopeBody,
  kind: z.enum(["correction", "decision", "preference"]),
  agent: z.string().refine(isAgentId).optional(),
  pr: z.string().max(256).regex(PR_URL_RE).optional(),
  state: z.literal("candidate").optional(),
  source: z.object({ memoryFile: baseName(256, 128).optional() }).optional(),
  via: httpVia.optional(),
});

const editBody = z.object({
  text: ruleText.optional(),
  scope: scopeBody.optional(),
  confidence: z.number().min(0).max(1).optional(),
  confirm: z.boolean().optional(),
  retire: z.object({ why: z.string().min(1).max(RETIRE_WHY_MAX).refine(nonBlank) }).optional(),
  via: httpVia.optional(),
}).refine((b) => !b.retire || (b.text === undefined && b.scope === undefined && b.confidence === undefined && !b.confirm));

const stateQuery = z.object({ state: z.enum(["active", "candidate", "all"]).default("all") });
const weeksQuery = z.object({
  weeks: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(52)).default("8"),
});
const distillBody = z.object({ dryRun: z.boolean().optional() });
const shaBody = z.object({ sha256: z.string().regex(SHA256_RE).optional() });
const rollbackBody = z.object({ version: z.string().regex(VERSION_RE).optional() });

const ERR = {
  invalid: "invalid body", internal: "internal error", logMode: "no Telegram in log mode",
  noTelegram: "telegram unavailable", noDistill: "distill unavailable", unknownRule: "unknown rule",
  weakApply: "apply from Telegram", userOrMaster: "user or master only",
} as const;

// The errors apply.ts rejects with, by message.
const BRAIN_ERRORS: Record<string, 404 | 409> = { "no proposal": 404, changed: 409, "unknown version": 404 };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type RuleView = Pick<Rule, "id" | "text" | "scope" | "kind" | "state" | "confidence" | "hits" | "strikes" | "source" | "createdAt">;
const ruleView = (r: Rule): RuleView => ({ id: r.id, text: r.text, scope: r.scope, kind: r.kind, state: r.state,
  confidence: r.confidence, hits: r.hits, strikes: r.strikes, source: r.source, createdAt: r.createdAt });

// The body of a request that may have none (no payload, no content type).
const bodyOf = (req: FastifyRequest): unknown => req.body ?? {};

// 0 when there is no file yet.
async function mtimeMs(path: string): Promise<number> {
  try {
    return Math.floor((await stat(path)).mtimeMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return 0;
    throw err;
  }
}

function registerBrainRoutes(app: FastifyInstance, d: Deps): void {
  const { gate, rules, classified, paths, hub } = d;
  const log = d.log ?? ((s: string) => console.warn(s));
  const hardened = () => d.hardened?.() ?? false;
  const now = d.now;

  // RuleError → its code and message; an apply.ts rejection → its code; any
  // other error is logged and answers a fixed 500 (no message, no stack).
  const guard = (fn: Handler): Handler => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof RuleError) return reply.code(e.code).send({ error: e.message });
      if (e instanceof Error && Object.hasOwn(BRAIN_ERRORS, e.message)) {
        return reply.code(BRAIN_ERRORS[e.message]!).send({ error: e.message });
      }
      log(`[chief] brain ${req.method} ${req.routeOptions.url} failed: ${errText(e)}`);
      return reply.code(500).send({ error: ERR.internal });
    }
  };

  // A Telegram card post is started, never awaited: the poster may hang (the
  // 1a client has no timeout) or reject (cards off). Either is logged.
  const startCard = (what: string, post: () => Promise<void>): void => {
    const failed = (e: unknown) => log(`[chief] brain ${what} failed: ${errText(e)}`);
    try {
      post().catch(failed);
    } catch (e) {
      failed(e);
    }
  };

  const candidateMade = (): void => {
    try {
      d.onCandidate?.();
    } catch (e) {
      log(`[chief] brain candidate follow-up failed: ${errText(e)}`);
    }
  };

  // Telegram-card routes: log mode has no Telegram (409); a telegram-mode
  // console without the poster is a wiring gap (503).
  const telegramFor = (reply: FastifyReply): BrainApiDeps["telegram"] | null => {
    if (gate.userAuth === "log") {
      reply.code(409).send({ error: ERR.logMode });
      return null;
    }
    if (!d.telegram) {
      reply.code(503).send({ error: ERR.noTelegram });
      return null;
    }
    return d.telegram;
  };

  // USER or the fleet master. Agent headers of any other kind (or a token that
  // does not match) → 403; no headers and no valid user token → pair-required.
  const userOrMaster = async (req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> => {
    if (!gateRoute(gate, reply)) return null;
    const caller = await gate.caller(req);
    if (caller.level === "user" || caller.level === "master") return caller;
    if (caller.agentHeaders) reply.code(403).send({ error: ERR.userOrMaster });
    else pairRequired(gate, reply);
    return null;
  };

  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: ERR.invalid });

  // Any session.
  app.get("/api/brain", guard(async (_req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const [text, updatedAt, proposal] = await Promise.all([readText(paths.brain), mtimeMs(paths.brain), readProposal(paths)]);
    const distill: DistillStatus = d.distill?.status() ?? { enabled: false, reason: ERR.noDistill };
    return {
      text, updatedAt, size: text.length,
      ...(proposal && { proposed: { text: proposal.text, sha256: proposal.sha256, retire: proposal.retire } }),
      hardened: hardened(), editorOff: d.editorOff ?? false, userAuth: gate.userAuth, distill,
    };
  }));

  // Any session.
  app.get("/api/brain/rules", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const q = stateQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid state" });
    const all = await rules.all();
    const state = q.data.state;
    return (state === "all" ? all : all.filter((r) => r.state === state)).map(ruleView);
  }));

  // MASTER → a candidate (origin master), never for a question or a
  // one- or two-word answer (standing.ts; 400); it reaches the user as one
  // "Make this a rule?" queue item (suggest.ts), not a Telegram card. USER →
  // active with a confirm line, or a candidate with state "candidate" (origin
  // memory with source.memoryFile, else panel). The server sets `origin` (§6.1).
  app.post("/api/brain/rules", guard(async (req, reply) => {
    const caller = await userOrMaster(req, reply);
    if (!caller) return reply;
    const body = addBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    const b = body.data;
    const ids = { ...(b.agent !== undefined && { agentId: b.agent }), ...(b.pr !== undefined && { prUrl: b.pr }) };

    if (caller.level === "master") {
      const why = oneTimeReason(b.text);
      if (why !== null) return reply.code(400).send({ error: `not a standing rule: ${why}` });
      // state, source and via are USER-only: a master add is always a candidate.
      const { rule, duplicate } = await rules.add({ text: b.text, scope: b.scope, kind: b.kind,
        source: { origin: "master", ...ids }, state: "candidate" });
      if (!duplicate) candidateMade();
      // A repeated correction still counts (§6.2 source 3, §6.5). The rule is
      // written: a failed count is logged, never a 500 (a master retry would
      // count the correction twice).
      if (b.kind === "correction") {
        try {
          await d.decisions.countMasterCorrection({ quote: b.text,
            via: d.surface() === "telegram" ? "master-telegram" : "master-tab", ...ids }, classified);
        } catch (e) {
          log(`[chief] brain correction count for ${rule.id} failed: ${errText(e)}`);
        }
      }
      return duplicate ? { id: rule.id, state: rule.state, duplicate: true } : { id: rule.id, state: rule.state };
    }

    const memoryFile = b.source?.memoryFile;
    const source: RuleSource = memoryFile !== undefined ? { origin: "memory", memoryFile, ...ids } : { origin: "panel", ...ids };
    const { rule, duplicate } = await rules.add({ text: b.text, scope: b.scope, kind: b.kind, source,
      state: b.state ?? "active", via: b.via ?? "tab" });
    if (duplicate) return reply.code(409).send({ error: "duplicate", id: rule.id });
    return { id: rule.id, state: rule.state };
  }));

  // USER: edit, confirm, or retire (alone). A confirm without an edit writes
  // only the confirm line (a confidence goes on it).
  app.post("/api/brain/rules/:id", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const { id } = req.params as { id: string };
    if (!RULE_ID.test(id)) return reply.code(404).send({ error: ERR.unknownRule });
    const body = editBody.safeParse(bodyOf(req));
    if (!body.success) return invalid(reply);
    const b = body.data;
    const via = b.via ?? "tab";
    let rule: Rule;
    if (b.retire) {
      rule = await rules.retire(id, { by: "user", why: capRedacted(b.retire.why.trim(), RETIRE_WHY_MAX).text });
    } else if (b.confirm && b.text === undefined && b.scope === undefined) {
      rule = await rules.confirm(id, { via, confidence: b.confidence });
    } else {
      rule = await rules.update(id, { text: b.text, scope: b.scope, confidence: b.confidence, confirm: b.confirm, via });
    }
    return ruleView(rule);
  }));

  // USER: "Confirm on Telegram" (§6.1) posts the q:k: card of a candidate or
  // active rule.
  app.post("/api/brain/rules/:id/telegram-card", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const tg = telegramFor(reply);
    if (!tg) return reply;
    const { id } = req.params as { id: string };
    const rule = RULE_ID.test(id) ? await rules.get(id) : null;
    if (!rule) return reply.code(404).send({ error: ERR.unknownRule });
    if (rule.state === "retired") return reply.code(409).send({ error: `rule ${id} is retired` });
    startCard(`rule card ${id}`, () => tg.postRuleCard(rule));
    return reply.code(202).send({ ok: true });
  }));

  // USER. Awaited: the CLI waits for the report. runOnce never rejects, and a
  // run may take up to 10 min per claude call (longer behind a timer run).
  // Fastify 5's defaults (connectionTimeout, requestTimeout and handlerTimeout
  // 0; keepAliveTimeout only between requests) never cut it.
  app.post("/api/brain/distill", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const body = distillBody.safeParse(bodyOf(req));
    if (!body.success) return invalid(reply);
    if (!d.distill) return reply.code(503).send({ error: ERR.noDistill });
    return await d.distill.runOnce({ dryRun: body.data.dryRun === true });
  }));

  // USER. Weak mode with Telegram (§3): only the [Apply] card applies; log
  // and hardened modes accept the user token.
  app.post("/api/brain/apply", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    if (gate.userAuth === "telegram" && !hardened()) return reply.code(403).send({ error: ERR.weakApply });
    const body = shaBody.safeParse(bodyOf(req));
    if (!body.success) return invalid(reply);
    const expectSha256 = body.data.sha256;
    return await applyProposal({ paths, rules, hub, now, ...(expectSha256 !== undefined && { expectSha256 }) });
  }));

  // USER: the Brain panel's "Apply on Telegram" re-posts the proposal card.
  app.post("/api/brain/proposal/telegram-card", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const tg = telegramFor(reply);
    if (!tg) return reply;
    const p = await readProposal(paths);
    if (!p) return reply.code(404).send({ error: "no proposal" });
    startCard("proposal card", () => tg.postProposalCard(p));
    return reply.code(202).send({ ok: true });
  }));

  app.post("/api/brain/discard-proposal", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const body = shaBody.safeParse(bodyOf(req));
    if (!body.success) return invalid(reply);
    if (!(await readProposal(paths))) return reply.code(404).send({ error: "no proposal" });
    const expectSha256 = body.data.sha256;
    await discardProposal({ paths, hub, now, ...(expectSha256 !== undefined && { expectSha256 }) });
    return { ok: true };
  }));

  app.post("/api/brain/rollback", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const body = rollbackBody.safeParse(bodyOf(req));
    if (!body.success) return invalid(reply);
    return await rollbackBrain({ paths, hub, now }, body.data.version);
  }));

  // Any session.
  app.get("/api/brain/metrics", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const q = weeksQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid weeks" });
    const [lines, entries] = await Promise.all([d.decisions.read(), classified.read()]);
    return foldMetrics(lines, entries, { weeks: q.data.weeks, now: (now ?? Date.now)() });
  }));
}
