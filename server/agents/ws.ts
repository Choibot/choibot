import "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { ResumePoint, TerminalManager } from "./terminal.js";
import { keepAlive, WS_CLOSE_FINAL } from "../wsKeepalive.js";
import { isAgentId } from "../ids.js";
import type { TerminalWsGate } from "../chief/wsgate.js";

// ?epoch=<id>&since=<offset>: where the browser's copy of the stream ends.
export function parseResume(query: unknown): ResumePoint | undefined {
  const { epoch, since } = (query ?? {}) as { epoch?: unknown; since?: unknown };
  if (typeof epoch !== "string" || !epoch || typeof since !== "string" || !/^\d+$/.test(since)) return undefined;
  return { epoch, offset: Number(since) };
}

// Registered AFTER auth so the cookie preHandler gate runs on the upgrade
// request too (the route lives under /api/, which is not a public prefix).
export function registerTerminalWs(
  app: FastifyInstance,
  terminals: TerminalManager,
  // gate: only in a hardened deployment (server/chief/wsgate.ts).
  // whyNone: the words for an agent that has no terminal for a known reason (it waits for a
  // Claude login with room); null: the usual words.
  opts: { onInput?: (id: string, data: string) => void; gate?: Pick<TerminalWsGate, "agent">; whyNone?: (id: string) => Promise<string | null> } = {},
): void {
  app.get("/api/agents/:id/terminal", { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    // The user token first, for any id but a worker agent's; a refusal has
    // already closed the socket.
    if (opts.gate && !(await opts.gate.agent(socket, req, id))) return;
    // reattach() builds the dtach socket path from the id; a non-agent id (a
    // decoded `x%2F..%2Fy`, a service's `svc:<id>`) never gets that far.
    if (!isAgentId(id)) {
      socket.send("\r\n[no live terminal for this agent — resume it]\r\n");
      socket.close(WS_CLOSE_FINAL);
      return;
    }
    // attach() is the fast path (already live in-process). If nothing is live,
    // try to reattach a persisted session that survived a server restart before
    // giving up — that's what keeps a running agent's terminal across restarts.
    const att = terminals.attach(id, parseResume(req.query)) ?? (await terminals.reattach(id));
    if (!att) {
      const why = (await opts.whyNone?.(id).catch(() => null)) ?? "no live terminal for this agent — resume it";
      socket.send(`\r\n[${why}]\r\n`);
      socket.close(WS_CLOSE_FINAL);
      return;
    }
    keepAlive(socket);
    // Tell the client where the stream stands, in a binary frame (terminal output
    // is always text), then replay what it misses and stream live output.
    socket.send(Buffer.from(JSON.stringify({ t: "sync", epoch: att.epoch, offset: att.offset, resumed: att.resumed })));
    if (att.snapshot) socket.send(att.snapshot);
    const unsub = att.subscribe((chunk) => {
      if (socket.readyState === socket.OPEN) socket.send(chunk);
    });
    // A browser keeps this socket for as long as the agent's tab is in its pool.
    // Close when the terminal ends: a resumed agent is a new stream, and the
    // client reconnects to it when it next shows the terminal.
    const unend = att.onEnd(() => socket.close(WS_CLOSE_FINAL));
    socket.on("message", (raw: Buffer) => {
      let msg: { t?: string; data?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === "input" && typeof msg.data === "string") {
        // The fleet master's inbox watches its tab for drafts (server/master/draft.ts).
        opts.onInput?.(id, msg.data);
        terminals.write(id, msg.data);
      } else if (msg.t === "resize" && msg.cols && msg.rows) {
        terminals.resize(id, msg.cols, msg.rows);
      }
    });
    socket.on("close", () => { unsub(); unend(); });
  });
}
