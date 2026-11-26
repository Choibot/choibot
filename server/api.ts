// server/api.ts — the event stream (SSE) of the console.
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EventHub } from "./events.js";

// A comment line on each open stream this often: a proxy in front (a hosted console's door) may
// cut a stream that is silent, and the console's reader (src/lib/sse.ts) opens again a stream that
// is silent for 60 s. A browser's EventSource ignores comment lines.
export const PING_MS = 20_000;

export function registerApi(app: FastifyInstance, deps: { hub: EventHub; pingMs?: number }): void {
  const { hub } = deps;
  // A stream holds its connection open: Fastify's close() waits for it, so a stopped server
  // kept running with every open tab, and the tabs never opened their stream again. At the
  // close the streams end: each tab then opens its stream again on the new server.
  // Each open stream and what stops it (its hub subscription and its ping): stopped BEFORE the
  // end, so no event is written after it.
  const open = new Map<ServerResponse, () => void>();
  app.addHook("preClose", async () => {
    for (const [res, stop] of open) { stop(); res.end(); }
    open.clear();
  });

  app.get("/api/events", (req: FastifyRequest, reply: FastifyReply) => {
    // hijack() hands the socket to us so Fastify stops managing the response —
    // required for a long-lived SSE stream, or Fastify hangs waiting for a reply.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Send the status line and headers now, not with the first event: the browser's EventSource
    // `open` (and the client's refetch on stream open) then fires at connect. No body bytes.
    reply.raw.flushHeaders();
    const off = hub.subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), deps.pingMs ?? PING_MS);
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; off(); clearInterval(ping); };
    open.set(reply.raw, stop);
    req.raw.on("close", () => { stop(); open.delete(reply.raw); });
  });
}
