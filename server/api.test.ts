// server/api.test.ts
import { describe, it, expect } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { registerApi } from "./api.js";
import { EventHub } from "./events.js";

describe("registerApi", () => {
  it("GET /api/events sends the status line and headers at connect, before any event (F5)", async () => {
    const app = Fastify();
    const hub = new EventHub();
    registerApi(app, { hub });
    await app.listen({ host: "127.0.0.1", port: 0 }); // an ephemeral port, never the live console's
    const { port } = app.server.address() as AddressInfo;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/events" });
    try {
      const res = await new Promise<IncomingMessage | "no headers">((resolve, reject) => {
        const t = setTimeout(() => resolve("no headers"), 1500);
        req.on("response", (r) => { clearTimeout(t); resolve(r); });
        req.on("error", reject);
        req.end();
      });
      expect(res).not.toBe("no headers"); // no event was published: only a flush can deliver the headers
      const r = res as IncomingMessage;
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe("text/event-stream");
      expect(r.headers["cache-control"]).toBe("no-cache");
      // no body bytes before the first event; the first event arrives unchanged
      const chunks: string[] = [];
      r.setEncoding("utf8");
      r.on("data", (c: string) => chunks.push(c));
      await new Promise((ok) => setTimeout(ok, 100));
      expect(chunks.join("")).toBe("");
      const ev = { type: "agent-reopened" as const, agentId: "a1" };
      hub.emitEvent(ev);
      await new Promise((ok) => setTimeout(ok, 100));
      expect(chunks.join("")).toBe(`data: ${JSON.stringify(ev)}\n\n`);
    } finally {
      req.destroy();
      await app.close();
    }
  });

  it("sends a comment line on each open stream (the ping), and stops it when the stream closes", async () => {
    const app = Fastify();
    const hub = new EventHub();
    registerApi(app, { hub, pingMs: 50 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/events" });
    try {
      const text = await new Promise<string>((resolve, reject) => {
        req.on("response", (r) => { let t = ""; r.setEncoding("utf8"); r.on("data", (c: string) => { t += c; if (t.length >= 2 * ": ping\n\n".length) resolve(t); }); });
        req.on("error", reject);
        req.end();
      });
      expect(text.startsWith(": ping\n\n: ping\n\n")).toBe(true);
    } finally {
      req.destroy();
      await app.close();
    }
  });

  it("ends every open stream at the close, so the server stops and the page opens its stream on the next one", async () => {
    const app = Fastify();
    registerApi(app, { hub: new EventHub() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const ended = [0, 1].map(() => new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/events" });
      req.on("response", (r) => { r.resume(); r.on("end", () => resolve("end")); r.on("error", () => resolve("error")); });
      req.on("error", reject);
      req.end();
    }));
    await new Promise((ok) => setTimeout(ok, 100));
    const closed = await Promise.race([app.close().then(() => "closed"), new Promise((ok) => setTimeout(() => ok("still open"), 2_000))]);
    expect(closed).toBe("closed");
    expect(await Promise.all(ended)).toEqual(["end", "end"]);
  });

  it("at the close: no subscription stays, none is stopped twice, and no event is written after the end", async () => {
    const app = Fastify();
    const hub = new EventHub();
    // Count the stream's live subscriptions.
    let live = 0;
    const subscribe = hub.subscribe.bind(hub);
    hub.subscribe = (fn) => { live++; const off = subscribe(fn); return () => { live--; off(); }; };
    registerApi(app, { hub });
    // A hook after the stream's own: just after the streams ended, before the requests' close.
    let atEnd = -1;
    app.addHook("preClose", async () => { atEnd = live; hub.emitEvent({ type: "agent-reopened", agentId: "a1" }); });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/events" });
      req.on("response", (r) => { r.resume(); resolve(); });
      req.on("error", reject);
      req.end();
    });
    expect(live).toBe(1);
    await app.close();
    await new Promise((ok) => setTimeout(ok, 50));
    expect([atEnd, live]).toEqual([0, 0]);
  });
});

