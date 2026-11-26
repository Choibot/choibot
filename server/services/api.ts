// server/services/api.ts
import "@fastify/websocket";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TerminalManager } from "../agents/terminal.js";
import type { ServiceStore, ServiceRecord } from "./store.js";
import { type ServiceManager, svcTermId } from "./manager.js";
import { keepAlive, WS_CLOSE_FINAL } from "../wsKeepalive.js";
import { isServiceId } from "../ids.js";
import type { TerminalWsGate } from "../chief/wsgate.js";

type Body = Partial<Omit<ServiceRecord, "id" | "createdAt">>;

// Validate + normalize a create/edit body. Returns the cleaned fields or an
// error string. Keeps the "run arbitrary command" surface shaped (non-empty
// command/name, well-typed args/env) — see the design's security posture.
function clean(body: Body): { fields: Omit<ServiceRecord, "id" | "createdAt"> } | { error: string } {
  const name = (body.name ?? "").trim();
  const command = (body.command ?? "").trim();
  const cwd = (body.cwd ?? "").trim();
  if (!name) return { error: "name is required" };
  if (!command) return { error: "command is required" };
  if (!cwd) return { error: "cwd is required" };
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  const env: Record<string, string> = {};
  if (body.env && typeof body.env === "object") {
    for (const [k, v] of Object.entries(body.env)) env[String(k)] = String(v);
  }
  return {
    fields: {
      name, description: (body.description ?? "").trim(), command, args, cwd, env,
      requiresConfirm: Boolean(body.requiresConfirm),
      confirmMessage: (body.confirmMessage ?? "").trim(),
      autoRestart: Boolean(body.autoRestart),
    },
  };
}

export function registerServiceApi(
  app: FastifyInstance,
  // wsGate: only in a hardened deployment (server/chief/wsgate.ts).
  deps: { services: ServiceManager; store: ServiceStore; terminals: TerminalManager; wsGate?: Pick<TerminalWsGate, "user"> },
): void {
  const { services, store, terminals } = deps;

  app.get("/api/services", async () => {
    const recs = await store.list();
    return { services: recs.map((r) => ({ ...r, ...services.snapshot(r.id) })) };
  });

  app.post("/api/services", async (req, reply) => {
    const res = clean((req.body ?? {}) as Body);
    if ("error" in res) { reply.code(400); return { error: res.error }; }
    const rec: ServiceRecord = { id: "svc-" + randomUUID(), createdAt: Date.now(), ...res.fields };
    await store.save(rec);
    reply.code(201);
    return { service: rec };
  });

  app.patch("/api/services/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await store.load(id);
    if (!existing) { reply.code(404); return { error: "no such service" }; }
    // PATCH is a partial update: merge the incoming fields onto the current
    // record, then validate the result so the stored definition stays well-formed.
    const res = clean({ ...existing, ...((req.body ?? {}) as Body) });
    if ("error" in res) { reply.code(400); return { error: res.error }; }
    await store.patch(id, res.fields);
    return { service: await store.load(id) };
  });

  app.delete("/api/services/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await store.load(id))) { reply.code(404); return { error: "no such service" }; }
    if (services.snapshot(id).status === "running" || terminals.has(svcTermId(id))) {
      reply.code(409); return { error: "stop the service before deleting it" };
    }
    await store.delete(id);
    return { ok: true };
  });

  app.post("/api/services/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const confirm = Boolean((req.body as { confirm?: boolean } | undefined)?.confirm);
    const r = await services.start(id, confirm);
    if (!r.ok) { reply.code(r.needsConfirm ? 409 : 400); return r; }
    return r;
  });

  app.post("/api/services/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Stop never loads the record: the kill builds the dtach socket path and
    // pkill pattern from the id. Not a service id -> 404, nothing killed.
    if (!isServiceId(id)) { reply.code(404); return { error: "no such service" }; }
    services.stop(id);
    return { ok: true };
  });

  // Read-only log stream: replay scrollback, stream live output, accept resize
  // ONLY. Input is never written to the PTY (logs are read-only in v1).
  app.get("/api/services/:id/terminal", { websocket: true }, async (socket, req) => {
    // The user token first; a refusal has already closed the socket.
    if (deps.wsGate && !(await deps.wsGate.user(socket, req))) return;
    const { id } = req.params as { id: string };
    if (!(await store.load(id))) { socket.send("\r\n[no such service]\r\n"); socket.close(WS_CLOSE_FINAL); return; }
    const termId = svcTermId(id);
    const att = terminals.attach(termId) ?? (await terminals.reattach(termId));
    if (!att) {
      // No live process. Show the retained tail of the last run (e.g. the crash
      // error) plus the exit code, so a fast crash isn't an opaque "not running".
      const tail = services.lastOutput(id);
      if (tail) {
        socket.send(tail);
        const snap = services.snapshot(id);
        const code = snap.lastExitCode != null ? `, exit ${snap.lastExitCode}` : "";
        socket.send(`\r\n\x1b[2m[service ${snap.status}${code} — output above is from the last run]\x1b[0m\r\n`);
      } else {
        socket.send("\r\n[service not running — start it]\r\n");
      }
      socket.close(WS_CLOSE_FINAL);
      return;
    }
    keepAlive(socket);
    socket.send(att.snapshot);
    const unsub = att.subscribe((chunk) => { if (socket.readyState === socket.OPEN) socket.send(chunk); });
    socket.on("message", (raw: Buffer) => {
      let msg: { t?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === "resize" && msg.cols && msg.rows) terminals.resize(termId, msg.cols, msg.rows);
      // intentionally NO input handling — read-only.
    });
    socket.on("close", unsub);
  });
}
