// server/codeserver.test.ts — the editor proxy next to the console's own sockets: the proxy gets
// only the sockets of the editor, so a socket that the console refuses throws nothing outside a
// handler (it wrote "uncaughtException … ERR_HTTP_SOCKET_ASSIGNED" to the log before).
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it } from "vitest";
import { registerEditorProxy } from "./codeserver.js";

const open: FastifyInstance[] = [];
afterEach(async () => { for (const a of open.splice(0)) await a.close(); });

// What the editor is for the proxy: a server with one page and one socket that answers.
async function fakeEditor(): Promise<number> {
  const up = Fastify();
  open.push(up);
  await up.register(websocket);
  up.get("/hello", async () => "the editor");
  up.get("/socket", { websocket: true }, (socket) => { socket.on("message", (m: Buffer) => socket.send(`editor: ${m.toString()}`)); });
  await up.listen({ port: 0, host: "127.0.0.1" });
  return (up.server.address() as { port: number }).port;
}

// The console: its own socket plugin, a rule that refuses one address, and the editor proxy.
async function consoleWith(editorPort: number): Promise<number> {
  const app = Fastify();
  open.push(app);
  await app.register(websocket);
  app.addHook("onRequest", async (req, reply) => { if (req.url.startsWith("/locked") || req.url.startsWith("/editor/locked")) return reply.code(403).send({ error: "pair-required" }); });
  app.get("/own", { websocket: true }, (socket) => { socket.on("message", (m: Buffer) => socket.send(`console: ${m.toString()}`)); });
  registerEditorProxy(app, {}, `http://127.0.0.1:${editorPort}`);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return (app.server.address() as { port: number }).port;
}

// "open: <answer>" when the socket opens and answers one message, else "refused".
function talk(port: number, path: string): Promise<string> {
  return new Promise((done) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    s.onopen = () => s.send("hi");
    s.onmessage = (e) => { done(`open: ${String(e.data)}`); s.close(); };
    s.onerror = () => done("refused");
    setTimeout(() => done("no answer"), 4000);
  });
}

describe("the editor proxy and the console's own sockets", () => {
  it("a refused socket, and a socket of an address that no route has, throw nothing outside a handler", async () => {
    const port = await consoleWith(await fakeEditor());
    const thrown: unknown[] = [];
    const onThrow = (e: unknown) => { thrown.push(e); };
    // The test runner has its own listener; this one only counts.
    process.on("uncaughtException", onThrow);
    try {
      expect(await talk(port, "/locked/socket")).toBe("refused");
      expect(await talk(port, "/nothing")).toBe("refused");
      await new Promise((r) => setTimeout(r, 150));
      expect(thrown).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onThrow);
    }
  });

  it("the console's own socket works, and the sockets and pages of the editor go to the editor: nothing is thrown", async () => {
    const port = await consoleWith(await fakeEditor());
    const thrown: unknown[] = [];
    const onThrow = (e: unknown) => { thrown.push(e); };
    process.on("uncaughtException", onThrow);
    try {
      expect(await talk(port, "/own")).toBe("open: console: hi");
      expect(await talk(port, "/editor/socket")).toBe("open: editor: hi");
      expect(await (await fetch(`http://127.0.0.1:${port}/editor/hello`)).text()).toBe("the editor");
      // A rule of the console (the lock, the origin guard) still decides for a socket of the editor.
      expect(await talk(port, "/editor/locked")).toBe("refused");
      await new Promise((r) => setTimeout(r, 150));
      expect(thrown).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onThrow);
    }
  });
});
