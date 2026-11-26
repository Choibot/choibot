import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { originAllowed, registerOriginGuard } from "./origin.js";

describe("originAllowed", () => {
  it("passes requests with no Origin header (curl, agent hooks, the CLI)", () => {
    expect(originAllowed("POST", { host: "localhost:3100" })).toBe(true);
    expect(originAllowed("GET", { host: "localhost:3100", upgrade: "websocket" })).toBe(true);
  });
  it("passes GET and HEAD from any origin", () => {
    expect(originAllowed("GET", { host: "localhost:3100", origin: "null" })).toBe(true);
    expect(originAllowed("HEAD", { host: "localhost:3100", origin: "https://evil.example" })).toBe(true);
  });
  it("refuses a write with Origin null or a foreign host", () => {
    expect(originAllowed("POST", { host: "localhost:3100", origin: "null" })).toBe(false);
    expect(originAllowed("PUT", { host: "localhost:3100", origin: "https://evil.example" })).toBe(false);
    expect(originAllowed("DELETE", { host: "localhost:3100", origin: "http://localhost:3000" })).toBe(false);
  });
  it("accepts a same-host write (host plus port)", () => {
    expect(originAllowed("POST", { host: "localhost:3100", origin: "http://localhost:3100" })).toBe(true);
  });
  it("uses X-Forwarded-Host when present, and only it", () => {
    const pub = "console.tail5678cd.ts.net";
    expect(originAllowed("POST", { host: "127.0.0.1:3100", "x-forwarded-host": pub, origin: `https://${pub}` })).toBe(true);
    expect(originAllowed("POST", { host: "127.0.0.1:3100", "x-forwarded-host": "other.example", origin: "http://127.0.0.1:3100" })).toBe(false);
  });
  it("treats a WebSocket upgrade like a write, whatever the method", () => {
    expect(originAllowed("GET", { host: "localhost:3100", upgrade: "websocket", origin: "null" })).toBe(false);
    expect(originAllowed("GET", { host: "localhost:3100", upgrade: "WebSocket", origin: "http://localhost:3100" })).toBe(true);
  });
  it("refuses an unparsable Origin and a request with no Host to compare", () => {
    expect(originAllowed("POST", { host: "localhost:3100", origin: "::nope" })).toBe(false);
    expect(originAllowed("POST", { origin: "http://localhost:3100" })).toBe(false);
  });
});

describe("registerOriginGuard", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  async function build(): Promise<void> {
    app = Fastify();
    await app.register(websocket);
    registerOriginGuard(app);
    app.post("/api/x", async () => ({ ok: true }));
    app.get("/api/sock", { websocket: true }, (socket) => { socket.send("hi"); });
    await app.ready();
  }
  const postX = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/api/x", headers: { "content-type": "text/plain", ...headers }, payload: "{}" });

  it("403s a POST with Origin null and one from a foreign host", async () => {
    await build();
    expect((await postX({ host: "localhost:3100", origin: "null" })).statusCode).toBe(403);
    expect((await postX({ host: "localhost:3100", origin: "https://evil.example" })).statusCode).toBe(403);
  });
  it("lets same-host, forwarded same-host and Origin-less POSTs through", async () => {
    await build();
    expect((await postX({ host: "localhost:3100", origin: "http://localhost:3100" })).statusCode).toBe(200);
    expect((await postX({
      host: "127.0.0.1:3100", "x-forwarded-host": "console.example.ts.net", origin: "https://console.example.ts.net",
    })).statusCode).toBe(200);
    expect((await postX({ host: "localhost:3100" })).statusCode).toBe(200);
  });
  it("refuses a WebSocket upgrade with Origin null, accepts a same-host one", async () => {
    await build();
    await expect(app.injectWS("/api/sock", { headers: { host: "localhost:3100", origin: "null" } }))
      .rejects.toThrow(/403/);
    const ws = await app.injectWS("/api/sock", { headers: { host: "localhost:3100", origin: "http://localhost:3100" } });
    ws.terminate();
  });
});
