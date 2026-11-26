// server/widgets/api.ts — HTTP routes for agent widgets (spec "HTTP API").
// Unknown agents, malformed ids and master agents are 404. POST/PUT accept
// JSON only (415 otherwise): together with the global origin guard
// (server/origin.ts) no frame or foreign page can reach them. Agent-mode
// text is typed only with `confirmed: true`, which only the console's own
// buttons and confirm bar send.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPersistentKind, type AgentRecord, type SessionStore } from "../agents/store.js";
import { askMessage, refreshMessage, type AgentTyper } from "./agent.js";
import { WidgetError } from "./errors.js";
import { uiFromObject } from "./meta.js";
import { isAgentId, isWidgetId } from "./paths.js";
import type { WidgetInfo, WidgetStore } from "./store.js";

export type WidgetsApiDeps = {
  agents: Pick<SessionStore, "load">;
  widgets: WidgetStore;
  typer: AgentTyper;
  workspaceDir: string;
};

const NOT_FOUND = { error: "not found" };
type Params = { id: string; wid?: string };
type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

async function requireJson(req: FastifyRequest, reply: FastifyReply) {
  const ct = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return reply.code(415).send({ error: "content type must be application/json" });
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// WidgetError → its status and message; anything else stays a 500.
const guard = (fn: Handler): Handler => async (req, reply) => {
  try {
    return await fn(req, reply);
  } catch (e) {
    if (e instanceof WidgetError) return reply.code(e.code).send({ error: e.message });
    throw e;
  }
};

export function registerWidgetsApi(app: FastifyInstance, deps: WidgetsApiDeps): void {
  const { agents, widgets, typer } = deps;
  const json = { preHandler: requireJson };
  // Same rule as recovery.ts: the record's spawn dir, else worktree/workspace.
  const cwdOf = (rec: AgentRecord): string => rec.cwd ?? (rec.repo ? rec.worktree : deps.workspaceDir);

  async function agentOf(req: FastifyRequest): Promise<AgentRecord | null> {
    const { id } = req.params as Params;
    if (!isAgentId(id)) return null;
    const rec = await agents.load(id);
    return rec && !isPersistentKind(rec.kind) ? rec : null;
  }

  async function widgetOf(req: FastifyRequest): Promise<{ rec: AgentRecord; wid: string; info: WidgetInfo } | null> {
    const rec = await agentOf(req);
    const { wid } = req.params as Params;
    if (!rec || !isWidgetId(wid)) return null;
    const info = await widgets.info(rec.id, wid);
    return info ? { rec, wid, info } : null;
  }

  app.get("/api/agents/:id/widgets", guard(async (req, reply) => {
    const rec = await agentOf(req);
    if (!rec) return reply.code(404).send(NOT_FOUND);
    return { widgets: await widgets.list(rec.id) };
  }));

  app.get("/api/agents/:id/widgets/:wid", guard(async (req, reply) => {
    const rec = await agentOf(req);
    const { wid } = req.params as Params;
    if (!rec || !isWidgetId(wid)) return reply.code(404).send(NOT_FOUND);
    const raw = (req.query as { since?: string }).since;
    const since = raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    const payload = await widgets.get(rec.id, wid, since);
    if (!payload) return reply.code(404).send(NOT_FOUND);
    return payload;
  }));

  app.post("/api/agents/:id/widgets/:wid/refresh", json, guard(async (req, reply) => {
    const w = await widgetOf(req);
    if (!w) return reply.code(404).send(NOT_FOUND);
    const body = asObj(req.body);
    if (w.info.hasRefresh) {
      const r = await widgets.refreshScript(w.rec.id, w.wid, cwdOf(w.rec), body.args);
      return { mode: "script", data: r.data, status: r.status };
    }
    const text = refreshMessage(w.wid, widgets.dir(w.rec.id, w.wid), body.args);
    typer.check(w.rec, w.wid);
    if (body.confirmed !== true) return reply.code(428).send({ needsConfirm: true, text });
    await typer.type(w.rec, w.wid, text);
    return { mode: "agent" };
  }));

  app.post("/api/agents/:id/widgets/:wid/action", json, guard(async (req, reply) => {
    const w = await widgetOf(req);
    if (!w) return reply.code(404).send(NOT_FOUND);
    const body = asObj(req.body);
    if (!isWidgetId(body.name)) return reply.code(400).send({ error: "bad action name" });
    return { result: await widgets.action(w.rec.id, w.wid, body.name, cwdOf(w.rec), body.args) };
  }));

  app.post("/api/agents/:id/widgets/:wid/ask", json, guard(async (req, reply) => {
    const w = await widgetOf(req);
    if (!w) return reply.code(404).send(NOT_FOUND);
    const body = asObj(req.body);
    if (typeof body.text !== "string" || !body.text.trim()) return reply.code(400).send({ error: "text required" });
    const text = askMessage(w.wid, body.text);
    typer.check(w.rec, w.wid);
    if (body.confirmed !== true) return reply.code(428).send({ needsConfirm: true, text });
    await typer.type(w.rec, w.wid, text);
    return { ok: true };
  }));

  app.put("/api/agents/:id/widgets/:wid/state", json, guard(async (req, reply) => {
    const rec = await agentOf(req);
    const { wid } = req.params as Params;
    if (!rec || !isWidgetId(wid)) return reply.code(404).send(NOT_FOUND);
    const body = asObj(req.body);
    if (!("state" in body)) return reply.code(400).send({ error: "state required" });
    if (!(await widgets.setState(rec.id, wid, body.state))) return reply.code(404).send(NOT_FOUND);
    return { ok: true };
  }));

  app.put("/api/agents/:id/widgets/:wid/ui", json, guard(async (req, reply) => {
    const rec = await agentOf(req);
    const { wid } = req.params as Params;
    if (!rec || !isWidgetId(wid)) return reply.code(404).send(NOT_FOUND);
    if (!(await widgets.setUi(rec.id, wid, uiFromObject(req.body)))) return reply.code(404).send(NOT_FOUND);
    return { ok: true };
  }));

  app.delete("/api/agents/:id/widgets/:wid", guard(async (req, reply) => {
    const rec = await agentOf(req);
    const { wid } = req.params as Params;
    if (!rec || !isWidgetId(wid)) return reply.code(404).send(NOT_FOUND);
    if (!(await widgets.remove(rec.id, wid))) return reply.code(404).send(NOT_FOUND);
    return { ok: true };
  }));
}
