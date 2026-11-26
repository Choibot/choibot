// server/chief/queue/api.ts — the /api/queue routes (spec §7, §5.2, §4.4,
// §3.1). Registered only when CHIEF_ENABLED=1 (Task 2a-21); every route
// answers 503 while misconfigured. Levels:
//   GET  /api/queue, /api/queue/:id         any session
//   GET  /api/queue/:id/media/:name         any session (a preview's image)
//   GET  /api/queue/:id/page                any session (the checked rich part, as JSON)
//   POST /api/queue                         AGENT | LEAD | MASTER | COORDINATOR
//   POST /api/queue/:id/answer              USER (by: "user"); the master's
//                                           `auto` answer goes to AutoAnswer
//   POST /api/queue/:id/answer-image        USER only: one image for the user's answer (answerImages.ts)
//   POST /api/queue/:id/recommend           MASTER or COORDINATOR, or LEAD on its workers' items (QueueActions decides)
//   POST /api/queue/:id/undo                USER, or MASTER on its own auto answer
//   POST /api/queue/:id/snooze|delivery     USER
//   POST /api/queue/:id/withdraw            the item's own agent, or USER
//   GET|POST /api/queue/:id/merge           USER only, never the master (merge.ts): the Merge
//                                           button of a pr ticket; no other route merges
//   GET|POST /api/queue/:id/share, POST /api/queue/:id/share/stop, GET /api/queue/:id/share/file
//                                           USER only (share.ts): "Share outside" on a ticket
// A non-USER caller of a USER route gets 403 pair-required (decision 12). A
// request with agent headers is never USER (callerOf), so no agent request
// can produce an answer with by: "user".
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../../agents/store.js";
import type { EventQueue } from "../../master/events.js";
import type { CallerLevel } from "../auth.js";
import type { Counts } from "../brain/metrics.js";
import { gateRoute, gateUser, pairRequired, USER_ALONE_ERR, type ChiefGate } from "../gate.js";
import { hardenedDeployment } from "../hardened.js";
import type { ActionResult, QueueActions } from "./actions.js";
import type { AutoAnswer } from "./auto.js";
import type { QueueMerge } from "./merge.js";
import type { QueueShare } from "./share.js";
import { createdByOf, QueueAddError, type CreatedBy } from "./add.js";
import { MEDIA_NAME_RE } from "./media.js";
import { ANSWER_IMAGE_RE, answerKeeps } from "./answerImages.js";
import { MAX_UPLOAD_BYTES } from "../../agents/upload.js";
import { checkRich } from "./rich.js";
import { sortOpen } from "./priority.js";
import type { PrWatch } from "./prwatch.js";
import { isRecentAuto, isUndelivered } from "./sections.js";
import { parseAddInput, type AddInputValue } from "./schema.js";
import type { QueueStore } from "./store.js";
import { isAgentItem, type QueueItem } from "./types.js";

export type QueueApiDeps = {
  gate: ChiefGate; undoMs: number; store: QueueStore; actions: QueueActions;
  add: (agentId: string, input: AddInputValue, createdBy: CreatedBy) => Promise<{ id: string; created: boolean }>;
  events: Pick<EventQueue, "addQueue">; agents: Pick<SessionStore, "load">;
  weekMetrics: () => Promise<Counts>; hardened(): boolean;
  prWatch: Pick<PrWatch, "refreshSoon">; previewEnabled: boolean;
  // Absent: a master `auto` body is refused with 400 (Task 2b-13 wires it).
  autoAnswer?: Pick<AutoAnswer, "apply">;
  // The Merge button of a pr ticket (merge.ts). Absent: the merge routes do not exist.
  merge?: Pick<QueueMerge, "view" | "merge">;
  // "Share outside" (share.ts). Absent: the share routes do not exist.
  share?: Pick<QueueShare, "view" | "publish" | "stop" | "file">;
  now?: () => number; log?: (s: string) => void;
};

export type QueueCounts = { open: number; auto: number; undelivered: number };

const ERR = {
  agentsOnly: "agents only", notFound: "not found", invalidQuery: "invalid query", internal: "internal error",
  pageRefused: "the stored page did not pass the check", autoUser: '"auto" is a master-only verb', autoPhase: "auto answers arrive in Phase 2b",
} as const;

// The Queue tab's Auto section: auto answers of the last 10 min (spec §8b).
const ADD_LEVELS: ReadonlySet<CallerLevel> = new Set(["agent", "lead", "master", "coordinator"]);

const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const listQuery = z.object({
  status: z.enum(["open", "all"]).default("open"),
  area: z.string().max(100).optional(),
});

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// The body of a request that may have none (no payload, no content type).
const bodyOf = (req: FastifyRequest): unknown => req.body ?? {};
const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;
const isLive = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";

// The header counts, as the Queue tab's sections define them (spec §8b):
// open = the Open section (snoozed items once snoozedUntil passed);
// undelivered = an answer or withdrawal slot in failed or unknown on an item
// that is not withdrawn.
export function queueCounts(items: QueueItem[], now: number): QueueCounts {
  return {
    open: sortOpen(items, now).length,
    auto: items.filter((i) => isRecentAuto(i, now)).length,
    undelivered: items.filter(isUndelivered).length,
  };
}

export function registerQueueApi(app: FastifyInstance, d: QueueApiDeps): void {
  const { gate } = d;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((s: string) => console.warn(s));

  // QueueAddError → its status and message; any other error is logged and
  // answers a fixed 500 (no message, no stack).
  const guard = (fn: Handler): Handler => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof QueueAddError) return reply.code(e.status).send({ error: e.message });
      log(`[chief] queue ${req.method} ${req.routeOptions.url} failed: ${errText(e)}`);
      return reply.code(500).send({ error: ERR.internal });
    }
  };

  // 200 → the item itself; a refusal → its body (a 409 carries the current item).
  const send = (reply: FastifyReply, r: ActionResult) => (r.code === 200 ? r.item : reply.code(r.code).send(r.body));

  // The item is committed: a failed digest line is logged, never a 500 (an
  // agent's retry would add a second item).
  const digest = async (id: string): Promise<void> => {
    const failed = (e: unknown) => log(`[chief] queue digest line for ${id} failed: ${errText(e)}`);
    try {
      const item = await d.store.get(id);
      if (item && isAgentItem(item)) d.events.addQueue(item.id, item.kind, item.repo, item.agentId).catch(failed);
    } catch (e) {
      failed(e);
    }
  };

  // The list never fails on the metrics line (agents' `queue list` reads this
  // route too): a failure is logged and counts as zeros.
  const weekMetrics = async (): Promise<Counts> => {
    try {
      return await d.weekMetrics();
    } catch (e) {
      log(`[chief] queue week metrics failed: ${errText(e)}`);
      return { decisions: 0, corrections: 0 };
    }
  };

  // Any session. Counts cover the area, whatever the status filter.
  app.get("/api/queue", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: ERR.invalidQuery });
    d.prWatch.refreshSoon();
    const { status, area } = q.data;
    const [all, week] = await Promise.all([d.store.list(), weekMetrics()]);
    const t = now();
    // Strong protection: a worker sees only its own items (chief/access.ts lets it list).
    const caller = hardenedDeployment() ? await gate.caller(req) : null;
    const mine = caller?.level === "agent" ? all.filter((i) => i.agentId === caller.agentId) : all;
    const inArea = area ? mine.filter((i) => i.area === area) : mine;
    return {
      items: status === "all" ? inArea : inArea.filter(isLive),
      counts: queueCounts(inArea, t), metrics: { week },
      serverNow: t, undoMs: d.undoMs, hardened: d.hardened(), userAuth: gate.userAuth,
    };
  }));

  // Any session.
  app.get("/api/queue/:id", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const item = await d.store.get(idOf(req));
    if (!item) return reply.code(404).send({ error: ERR.notFound });
    // `queue show` says where the copy of a page is: the queue's own file, not the agent's.
    return item.html ? { ...item, html: { ...item.html, copy: d.store.pagePath(item.id) } } : item;
  }));

  // Any session (a plain <img src> in the tab sends no device header). The
  // name must match the pattern AND be one of the item's own images before it
  // is joined into a path.
  app.get("/api/queue/:id/media/:name", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const name = (req.params as { name: string }).name;
    // A preview's image, or one that an answer of the item keeps (never a draft).
    const item = MEDIA_NAME_RE.test(name) || ANSWER_IMAGE_RE.test(name) ? await d.store.get(idOf(req)) : null;
    if (!item || !(item.preview?.images.includes(name) || answerKeeps(item, name))) return reply.code(404).send({ error: ERR.notFound });
    let data: Buffer;
    try {
      data = await readFile(join(d.store.mediaDir, item.id, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: ERR.notFound });
      throw e;
    }
    return reply.header("content-type", MEDIA_TYPES[name.split(".")[1]!]!)
      .header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=3600").send(data);
  }));

  // The rich part of an item (rich.ts): who can read the item can read its page. The stored copy
  // is checked again on every read, and goes out as JSON (never as text/html: a visit of this
  // address shows no page). The Queue puts it in a sandboxed frame (src/lib/richTicket.ts).
  app.get("/api/queue/:id/page", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const item = await d.store.get(idOf(req));
    if (!item?.html) return reply.code(404).send({ error: ERR.notFound });
    let source: string;
    try {
      source = await readFile(d.store.pagePath(item.id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: ERR.notFound });
      throw e;
    }
    const c = checkRich(source);
    if (!c.ok) return reply.code(422).send({ error: ERR.pageRefused });
    return reply.header("x-content-type-options", "nosniff").header("cache-control", "private, no-store")
      .send({ css: c.page.css, html: c.page.html, ...(item.html.height !== undefined ? { height: item.html.height } : {}) });
  }));

  app.post("/api/queue", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const caller = await gate.caller(req);
    const agentId = caller.agentId;
    if (!ADD_LEVELS.has(caller.level) || agentId === undefined) return reply.code(403).send({ error: ERR.agentsOnly });
    const v = parseAddInput(req.body, { previewEnabled: d.previewEnabled });
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const rec = await d.agents.load(agentId);
    const { id, created } = await d.add(agentId, v.value, createdByOf(caller, rec));
    if (created) await digest(id);
    return { id };
  }));

  // USER → by: "user". The `auto` check runs before any item lookup.
  app.post("/api/queue/:id/answer", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const caller = await gate.caller(req);
    const body = bodyOf(req);
    const auto = isObj(body) && "auto" in body;
    if (caller.level === "user") {
      if (auto) return reply.code(400).send({ error: ERR.autoUser });
      return send(reply, await d.actions.answerUser(idOf(req), body, "tab"));
    }
    if (caller.level === "master" && auto) {
      // With strong protection the user alone answers (gate.ts USER_ALONE_ERR).
      if (gate.strong) return reply.code(403).send({ error: USER_ALONE_ERR.auto });
      if (!d.autoAnswer) return reply.code(400).send({ error: ERR.autoPhase });
      const r = await d.autoAnswer.apply(idOf(req), body, caller);
      // A downgrade is a 200 that keeps the item shape and adds the reason.
      return r.code === 200 && r.downgraded !== undefined ? { ...r.item, downgraded: r.downgraded } : send(reply, r);
    }
    return pairRequired(gate, reply);
  }));

  // The bytes of one image (the client sends application/octet-stream: the server reads the type
  // from the bytes). The paired user only: an agent header is never the user (gateUser).
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
  }
  app.post("/api/queue/:id/answer-image", { bodyLimit: MAX_UPLOAD_BYTES }, guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "send the image as application/octet-stream" });
    const r = await d.actions.answerImage(idOf(req), req.body);
    return r.code === 200 ? { name: r.name } : reply.code(r.code).send({ error: r.error });
  }));

  app.post("/api/queue/:id/recommend", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    return send(reply, await d.actions.recommend(idOf(req), bodyOf(req), await gate.caller(req)));
  }));

  // USER, or the MASTER (QueueActions allows it only on its own auto answer).
  // Agents and leads, with or without a user token, must pair as before.
  app.post("/api/queue/:id/undo", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const caller = await gate.caller(req);
    if (caller.level !== "user" && caller.level !== "master") return pairRequired(gate, reply);
    return send(reply, await d.actions.undo(idOf(req), caller));
  }));

  app.post("/api/queue/:id/snooze", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const body = bodyOf(req);
    return send(reply, await d.actions.snooze(idOf(req), isObj(body) ? body.minutes : undefined));
  }));

  // The item's own agent or USER (QueueActions decides); a caller that is
  // neither user nor an authenticated agent must pair.
  app.post("/api/queue/:id/withdraw", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const caller = await gate.caller(req);
    if (caller.level === "none") return pairRequired(gate, reply);
    return send(reply, await d.actions.withdraw(idOf(req), caller));
  }));

  // The Merge button (merge.ts): gateUser, the gate of the Deploy button. Only a request with a
  // paired device's token passes; the master, a lead, an agent (with or without a user token),
  // the cookie session and a loopback request all get 403 pair-required.
  const merge = d.merge;
  if (merge) {
    app.get("/api/queue/:id/merge", guard(async (req, reply) => {
      if (!(await gateUser(gate, req, reply))) return reply;
      const r = await merge.view(idOf(req));
      return reply.code(r.code).send(r.body);
    }));
    app.post("/api/queue/:id/merge", guard(async (req, reply) => {
      const caller = await gateUser(gate, req, reply);
      if (!caller) return reply;
      const r = await merge.merge(idOf(req), bodyOf(req), caller.device ?? "?");
      return reply.code(r.code).send(r.body);
    }));
  }

  // "Share outside" (share.ts): gateUser, as Merge. Only a paired device's press sends a page out:
  // an agent, a lead, the master, the Coordinator and a device with no pairing get 403. The body
  // carries the hits the user said yes to, never HTML or a path.
  const share = d.share;
  if (share) {
    app.get("/api/queue/:id/share", guard(async (req, reply) => {
      if (!(await gateUser(gate, req, reply))) return reply;
      const r = await share.view(idOf(req));
      return reply.code(r.code).send(r.body);
    }));
    app.post("/api/queue/:id/share", guard(async (req, reply) => {
      const caller = await gateUser(gate, req, reply);
      if (!caller) return reply;
      const r = await share.publish(idOf(req), bodyOf(req), caller.device ?? "?");
      return reply.code(r.code).header("cache-control", "no-store").send(r.body);
    }));
    app.post("/api/queue/:id/share/stop", guard(async (req, reply) => {
      const caller = await gateUser(gate, req, reply);
      if (!caller) return reply;
      const r = await share.stop(idOf(req), caller.device ?? "?");
      return reply.code(r.code).send(r.body);
    }));
    // A download, never a page of the console: attachment, no sniffing, and a policy with no script.
    app.get("/api/queue/:id/share/file", guard(async (req, reply) => {
      if (!(await gateUser(gate, req, reply))) return reply;
      const r = await share.file(idOf(req));
      if (!("html" in r)) return reply.code(r.code).send(r.body);
      return reply.header("content-type", "text/html; charset=utf-8")
        .header("content-disposition", `attachment; filename="${r.name.replace(/"/g, "")}"`)
        .header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox; default-src 'none'")
        .header("cache-control", "private, no-store").send(r.html);
    }));
  }

  app.post("/api/queue/:id/delivery", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const body = bodyOf(req);
    const b = isObj(body) ? body : {};
    return send(reply, await d.actions.deliveryAction(idOf(req), b.action, b.slot));
  }));
}
