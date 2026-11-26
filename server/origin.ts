// server/origin.ts — refuse cross-origin writes and WebSocket upgrades.
// Why: auth.ts trusts loopback peers with no cookie, and remote access reaches
// the console as 127.0.0.1 through `tailscale serve`. So a sandboxed widget
// frame or Docs artifact (opaque origin, `Origin: null`) or any other page
// could POST to the API with a simple text/plain request (no CORS preflight),
// or open an agent/shell terminal WebSocket. Browsers send Origin on those
// requests; curl, agent hooks and the CLI send none and pass as before.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type Headers = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Exact rule (spec "Origin guard"): new URL(origin).host must equal
// X-Forwarded-Host when that header is present, else Host.
export function originAllowed(method: string, headers: Headers): boolean {
  const origin = first(headers.origin);
  if (origin === undefined) return true;
  const isWs = (first(headers.upgrade) ?? "").toLowerCase() === "websocket";
  const m = method.toUpperCase();
  if (!isWs && (m === "GET" || m === "HEAD")) return true;
  if (origin === "null") return false;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  const fwd = first(headers["x-forwarded-host"]);
  const want = (fwd !== undefined ? fwd : first(headers.host))?.trim().toLowerCase();
  return !!want && host === want;
}

// Registered before auth and before every route, so it covers the API, the
// terminal WebSockets, the editor proxy and Next's catch-all alike.
export function registerOriginGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (originAllowed(req.method, req.headers)) return;
    return reply.code(403).send({ error: "cross-origin request refused" });
  });
}
