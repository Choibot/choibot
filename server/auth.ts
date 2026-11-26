// server/auth.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import { isTrustedProxyRequest } from "./frontproxy.js";
import { isSessionValueValid } from "./session.js";

const PUBLIC_PREFIXES = ["/_next", "/favicon.ico"];
// A request whose socket peer is localhost. The console binds loopback and sets
// no trustProxy, so req.ip is the real peer: 127.0.0.1 for an SSH-forwarded
// browser or for the gate proxying an already-authenticated request. A remote
// peer can never be loopback and can't spoof it — so this is safe even if :3100
// is ever accidentally bound publicly (the outside world still needs the cookie).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function registerAuth(app: FastifyInstance): void {
  app.register(cookie, { secret: process.env.CONSOLE_COOKIE_SECRET ?? "dev-secret" });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
    // The hook endpoint is called by the local `claude` child with no cookie;
    // it is gated by a per-agent secret token instead (validated in the route).
    if (/^\/api\/agents\/[^/]+\/hook(\?|$)/.test(req.url)) return;
    // Loopback auto-trust: a localhost peer (SSH-forwarded browser, or the gate
    // proxying its already-authenticated traffic) is allowed without a cookie.
    // Remote peers are never loopback, so the public still needs the gate cookie.
    if (LOOPBACK.has(req.ip)) return;
    // A request over the front proxy's private listener that carried the proxy's token for this
    // console (server/frontproxy.ts): the proxy is the gate, as the loopback rule above trusts the
    // gate of a tunnel. Only this outer gate: the paired-device token and the USER gate stand.
    if (isTrustedProxyRequest(req.raw)) return;
    const raw = req.cookies.session;
    const unsigned = raw ? app.unsignCookie(raw) : { valid: false, value: null };
    const ok = unsigned.valid && isSessionValueValid(unsigned.value ?? undefined);
    if (ok) return;
    if (req.url.startsWith("/api/")) return reply.code(401).send({ error: "unauthorized" });
    return reply.code(403).send("Forbidden");
  });
}
