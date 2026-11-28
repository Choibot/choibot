// server/frontproxy.ts — the console behind a front proxy (a hosted console: a sign-in proxy in
// front of it, on a private network). OFF by default: nothing here runs unless the first start of
// the server wrote the proxy settings (bin/lib/firststart.ts, from the `proxy` key of the
// first-start file).
//
// The walls, in order:
//   1. A second listener, on ONE private address of this server only (the one inside the
//      proxy's network; never all addresses), with TLS (the key made at the first start).
//   2. A connection from any address but the proxy's is closed before the TLS handshake.
//   3. Every request and every WebSocket upgrade on that listener must carry the proxy's token for
//      this console (header x-console-proxy-token). The console keeps only its SHA-256 and compares
//      in constant time. A wrong or missing token: 403 "Forbidden", nothing more.
//   4. The token header is removed from EVERY request (also from the loopback listener) before any
//      handler sees it.
//   5. A request that passed 3 is marked: server/auth.ts lets it pass its outer gate.
//   6. Deny by default without a paired device (registerDeviceGate): a marked request with no
//      device proof reaches only the app shell (GET/HEAD of the page catch-all, /_next/static, the
//      icons: no data in them) and the pairing APIs. Everything else under /api, every WebSocket
//      and the event stream need the proof: x-choibot-user, or for an upgrade the token in its first
//      subprotocol. An upgrade outside /api is refused at 3 already (the editor's and Next's own).
//      With the proof, a request gets what that device gets on loopback, no more: the first-run
//      lock and the USER gate stand as they are.
import { createHash, createHmac, timingSafeEqual, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const PROXY_TOKEN_HEADER = "x-console-proxy-token";
export const PROXY_ENV = {
  from: "CONSOLE_PROXY_FROM",
  network: "CONSOLE_PROXY_NETWORK",
  port: "CONSOLE_PROXY_PORT",
  tokenSha256: "CONSOLE_PROXY_TOKEN_SHA256",
  tlsDir: "CONSOLE_PROXY_TLS_DIR",
} as const;

export type ProxySettings = { from: string; network: string; port: number; tokenSha256: string };

// ------------------------------------------------------------ addresses

// IPv4 in its canonical form only (no leading zero), a range <network address>/<8-30> with no
// host bits, inside the private ranges of RFC 1918; the proxy a host of the range.
const OCTET = "(0|[1-9]\\d{0,2})";
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
export function ipv4ToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
const maskOf = (bits: number): number => (~0 << (32 - bits)) >>> 0;
export function inRange(ip: string, cidr: string): boolean {
  const m = /^([0-9.]{7,15})\/([1-9]\d?)$/.exec(cidr);
  const a = ipv4ToInt(ip);
  const b = m ? ipv4ToInt(m[1]) : null;
  const n = m ? Number(m[2]) : 0;
  if (a === null || b === null || n < 8 || n > 30) return false;
  return ((a & maskOf(n)) >>> 0) === ((b & maskOf(n)) >>> 0);
}
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
export function privateRange(cidr: string): boolean {
  const m = /^([0-9.]{7,15})\/([1-9]\d?)$/.exec(cidr);
  const base = m ? ipv4ToInt(m[1]) : null;
  const n = m ? Number(m[2]) : 0;
  if (!m || base === null || n < 8 || n > 30 || ((base & maskOf(n)) >>> 0) !== base) return false;
  return PRIVATE.some((p) => inRange(m[1], p) && n >= Number(p.split("/")[1]));
}
export function hostInRange(ip: string, cidr: string): boolean {
  if (!inRange(ip, cidr)) return false;
  const n = Number(cidr.split("/")[1]);
  const host = (ipv4ToInt(ip)! & ~maskOf(n)) >>> 0;
  return host !== 0 && host !== 2 ** (32 - n) - 1;
}

// The proxy settings as the first-start file gives them (its `proxy` key) or as the settings
// file keeps them. The reason of a refusal names a field, never a value.
export function parseProxySettings(o: { from?: unknown; network?: unknown; port?: unknown; tokenSha256?: unknown }): ProxySettings | { refused: string } {
  if (typeof o.network !== "string" || !privateRange(o.network)) return { refused: "proxy.network" };
  if (typeof o.from !== "string" || !hostInRange(o.from, o.network)) return { refused: "proxy.from" };
  const port = typeof o.port === "string" && /^[1-9]\d{3,4}$/.test(o.port) ? Number(o.port) : o.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return { refused: "proxy.port" };
  if (typeof o.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.tokenSha256)) return { refused: "proxy.tokenSha256" };
  return { from: o.from, network: o.network, port, tokenSha256: o.tokenSha256 };
}

// From the settings: null when none of them is set (the listener is off, as by default); `off`
// with the reason when some are set or one is wrong (the listener stays off: fail closed).
export function readProxySettings(env: Record<string, string | undefined>): (ProxySettings & { tlsDir: string }) | { off: string } | null {
  const set = Object.values(PROXY_ENV).filter((k) => env[k] !== undefined && env[k] !== "");
  if (set.length === 0) return null;
  if (set.length !== Object.values(PROXY_ENV).length) return { off: "some proxy settings are missing" };
  const s = parseProxySettings({ from: env[PROXY_ENV.from], network: env[PROXY_ENV.network], port: env[PROXY_ENV.port], tokenSha256: env[PROXY_ENV.tokenSha256] });
  if ("refused" in s) return { off: `the setting of ${s.refused} is wrong` };
  const tlsDir = env[PROXY_ENV.tlsDir]!;
  if (!tlsDir.startsWith("/")) return { off: "the TLS folder is not an absolute path" };
  return { ...s, tlsDir };
}

// This server's one IPv4 address inside the proxy's network, or null (none, or more than one).
export function localAddressIn(network: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  const found = Object.values(interfaces).flatMap((l) => l ?? []).filter((a) => a.family === "IPv4" && !a.internal && inRange(a.address, network)).map((a) => a.address);
  const unique = [...new Set(found)];
  return unique.length === 1 ? unique[0] : null;
}

// ------------------------------------------------------------ the gate

const proxySockets = new WeakSet<Socket>();
// A request that came over the proxy listener with the right token, and that token: the headers
// never hold it, it is kept here for doorProofOk only.
const trusted = new WeakMap<IncomingMessage, string>();

// server/auth.ts: a request that came over the proxy listener with the right token.
export const isTrustedProxyRequest = (req: IncomingMessage): boolean => trusted.has(req);

// A proof that only the door's own control path can make (server/chief/firstrun.ts RELINK_ROUTE):
// HMAC-SHA256 of a text of that one call, with the door's token of this console as the key, in
// lower-case hex. The door adds its token to a browser's request after the browser, so a request
// that a browser made cannot carry a right proof, through any door (an old one too).
export const doorProof = (token: string, message: string): string => createHmac("sha256", token).update(message, "utf8").digest("hex");
// The longest key that the proof takes, in bytes: HMAC-SHA256 replaces a key longer than its
// block (64 bytes) with the key's SHA-256, and that is CONSOLE_PROXY_TOKEN_SHA256, which is not a
// secret (the settings and the server's cloud user data hold it; an agent can read it). So with a
// longer token, the hash would make a right proof. The gate takes a token of up to 128
// characters; the door's token has 43.
export const DOOR_PROOF_MAX_KEY_BYTES = 64;
export function doorProofValid(token: string, message: string, proof: unknown): boolean {
  if (Buffer.byteLength(token, "utf8") > DOOR_PROOF_MAX_KEY_BYTES) return false;
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(doorProof(token, message), "hex"));
}
// The proof of a request: false for a request that did not come over the proxy listener.
export function doorProofOk(req: IncomingMessage, message: string, proof: unknown): boolean {
  const token = trusted.get(req);
  return token !== undefined && doorProofValid(token, message, proof);
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

// Removes the token from every view of the request's headers. Node builds `headers` and
// `headersDistinct` from rawHeaders when they are first read, with the count of before: so both
// are read (and so kept) first, and the token goes out of each.
export function stripProxyHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[PROXY_TOKEN_HEADER];
  delete req.headers[PROXY_TOKEN_HEADER];
  // (An injected request, light-my-request, has no headersDistinct.)
  const distinct = req.headersDistinct as Record<string, string[]> | undefined;
  if (distinct) delete distinct[PROXY_TOKEN_HEADER];
  for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
    if (req.rawHeaders[i].toLowerCase() === PROXY_TOKEN_HEADER) req.rawHeaders.splice(i, 2);
  }
  // A repeated header comes joined ("a, b"): it is a wrong token.
  return typeof raw === "string" ? raw : undefined;
}

// The same removal as a first hook, for a request that came another way than the HTTP server's
// events that installProxyGate watches (Fastify's second server when HOST is a name with two
// addresses; an inject).
export function registerProxyHeaderStrip(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest) => { stripProxyHeader(req.raw); });
}

// `next dev` answers its own addresses (/__nextjs_…) through the page route: the private listener
// never runs with it, but in a test instance on its loopback test address (server/testseams.ts).
export const devListenerRefusal = (dev: boolean, testAddress: boolean): string | null =>
  dev && !testAddress ? "a dev server (next dev) never takes the front proxy" : null;

const FORBIDDEN = "Forbidden";

// The events of Node's HTTP server that carry a request. "checkContinue" (Expect: 100-continue),
// "checkExpectation" (another Expect value) and "connect" (the CONNECT method) come IN PLACE OF
// "request" when something listens to them: nothing does today, but a library may one day.
const REQUEST_EVENTS = new Set<string | symbol>(["request", "checkContinue", "checkExpectation"]);
const SOCKET_EVENTS = new Set<string | symbol>(["upgrade", "connect"]);
// The door has no use for these three: on the private listener they are refused, token or not.
const NEVER_FROM_PROXY = new Set<string | symbol>(["checkContinue", "checkExpectation", "connect"]);

// One choke point for every request and every upgrade of the console's HTTP server (both
// listeners): the server's own emit. It runs before Fastify, its hooks, the WebSocket plugin, the
// editor proxy and Next's upgrade handler, which all listen to these events.
export function installProxyGate(server: HttpServer, tokenSha256: string | null): void {
  const want = tokenSha256 !== null && /^[0-9a-f]{64}$/.test(tokenSha256) ? Buffer.from(tokenSha256, "hex") : null;
  const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
  server.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (REQUEST_EVENTS.has(event) || SOCKET_EVENTS.has(event)) {
      const req = args[0] as IncomingMessage;
      const token = stripProxyHeader(req);
      if (proxySockets.has(req.socket)) {
        const upgradeOutsideApi = event === "upgrade" && !(req.url ?? "").startsWith("/api/");
        const ok = !NEVER_FROM_PROXY.has(event) && !upgradeOutsideApi && want !== null && token !== undefined && token.length <= 128 && timingSafeEqual(sha256(token), want);
        if (!ok || token === undefined) {
          if (REQUEST_EVENTS.has(event)) {
            const res = args[1] as ServerResponse;
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "content-length": String(FORBIDDEN.length), connection: "close" });
            res.end(FORBIDDEN);
          } else {
            const socket = args[1] as Socket;
            // A peer that goes away first: no error event with no listener (that would stop the
            // process).
            socket.on("error", () => socket.destroy());
            socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${FORBIDDEN.length}\r\nconnection: close\r\n\r\n${FORBIDDEN}`);
            socket.destroySoon?.();
          }
          return true;
        }
        trusted.set(req, token);
      }
    }
    return emit(event, ...args);
  }) as typeof server.emit;
}

// ------------------------------------------------------------ deny by default

// The pairing APIs: the first device's claim (the /first-run page: GET for its state, POST for
// the claim link or the box code), the code of "Add a device" (the /pair page), the pairing
// link of log or Telegram mode (`#pair=`, src/components/PairCard.tsx), and the door's new claim
// link (server/chief/firstrun.ts RELINK_ROUTE, GET to read if it may, POST to make one: the route
// itself takes this listener only).
export const PAIRING_ROUTES: readonly string[] = [
  "GET /api/chief/pair/first", "POST /api/chief/pair/first", "POST /api/chief/devices/claim", "POST /api/chief/pair/claim",
  "GET /api/chief/pair/relink", "POST /api/chief/pair/relink",
];
const ICONS = new Set(["/favicon.ico", "/icon.svg", "/apple-icon.png"]);

// The API's addresses: /api and all below it (an answer there is JSON).
const isApiPath = (url: string): boolean => { const p = url.split("?")[0]; return p === "/api" || p.startsWith("/api/"); };

// What a marked request may reach with NO device proof. `route` is the route pattern that matched
// (the app shell is the page catch-all only). A path with dot segments, encoded slashes or dots,
// or a backslash is never allowed.
export function allowedWithoutDevice(method: string, url: string, route: string | undefined, pageRoute: string, upgrade: boolean): boolean {
  if (upgrade) return false;
  const path = url.split("?")[0];
  if (/\/\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(path)) return false;
  if (PAIRING_ROUTES.includes(`${method} ${route ?? ""}`)) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (route !== pageRoute) return false;
  if (path.startsWith("/_next/static/") || ICONS.has(path)) return true;
  // /__next…: the addresses of `next dev` (the private listener never runs with it but in a test).
  if (isApiPath(path) || path.startsWith("/_next/") || path.startsWith("/__next") || path === "/editor" || path.startsWith("/editor/")) return false;
  return true;
}

// The device proof: x-choibot-user for a request, the first subprotocol for an upgrade (the same
// checks as server/chief/auth.ts callerOf and server/chief/wsgate.ts wsUserOk).
export type DeviceProof = { request: (req: FastifyRequest) => Promise<boolean>; upgrade: (req: FastifyRequest) => Promise<boolean> };

// Which listener a request came in on: the front proxy's private listener (with its token), a
// loopback peer of the main listener, or another peer of the main listener (the cookie gate of
// server/auth.ts decides that one).
export type ListenerKind = "proxy" | "loopback" | "other";
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function listenerKind(req: FastifyRequest): ListenerKind {
  if (isTrustedProxyRequest(req.raw)) return "proxy";
  return LOOPBACK_PEERS.has(req.ip) ? "loopback" : "other";
}

// The one gate of "a device proof or the allow-list" (allowedWithoutDevice above), for the
// listener kinds in `kinds`. Today only "proxy": a later change may add "loopback" (strong
// protection) here and nowhere else.
export function registerDeviceGate(app: FastifyInstance, o: { proof: DeviceProof | null; pageRoute: string; kinds: ReadonlySet<ListenerKind> }): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!o.kinds.has(listenerKind(req))) return undefined;
    const upgrade = (req.headers.upgrade ?? "").toLowerCase() === "websocket";
    if (allowedWithoutDevice(req.method, req.url, req.routeOptions.url, o.pageRoute, upgrade)) return undefined;
    // No device store (the Queue off): no proof is possible, so nothing more passes.
    const ok = o.proof !== null && (upgrade ? await o.proof.upgrade(req) : await o.proof.request(req));
    if (ok) return undefined;
    // 401 "pair-required": only this gate sends it (the outer gate's 401 is "unauthorized", the
    // USER gate's refusal is 403). The page then opens the pairing screen (src/lib/chief.ts).
    if (isApiPath(req.url)) return reply.code(401).send({ error: "pair-required" });
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  });
}

// ------------------------------------------------------------ the listener

// A file of the TLS folder: a plain file of this user, 0600 or 0400, read on the open file.
function readPrivateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
      throw new Error(`${path} must be a plain file of this user, mode 0600`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

const plainV4 = (a: string | undefined): string => (a ?? "").replace(/^::ffff:/, "");

export type ProxyListener = { server: TlsServer; address: string; port: number; fingerprint256: string };

// The listener: one private address, TLS 1.3, connections from the proxy's address only. Each
// TLS connection goes to the console's HTTP server, where the gate checks each request.
export async function listenProxy(o: { http: HttpServer; address: string; from: string; port: number; tlsDir: string }): Promise<ProxyListener> {
  if (ipv4ToInt(o.address) === null || o.address === "0.0.0.0") throw new Error("the proxy listener binds one IPv4 address, never all");
  const key = readPrivateFile(join(o.tlsDir, "key.pem"));
  const cert = readPrivateFile(join(o.tlsDir, "cert.pem"));
  const fingerprint256 = new X509Certificate(cert).fingerprint256;
  const tls = createTlsServer({ key, cert, minVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] }, (socket) => {
    proxySockets.add(socket as unknown as Socket);
    o.http.emit("connection", socket);
  });
  // Before the TLS handshake: only the proxy's address.
  tls.prependListener("connection", (raw: Socket) => {
    if (plainV4(raw.remoteAddress) !== o.from) raw.destroy();
  });
  tls.on("tlsClientError", (_e, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    tls.once("error", reject);
    tls.listen({ host: o.address, port: o.port, exclusive: true }, () => { tls.off("error", reject); resolve(); });
  });
  const bound = tls.address();
  return { server: tls, address: o.address, port: typeof bound === "object" && bound ? bound.port : o.port, fingerprint256 };
}
