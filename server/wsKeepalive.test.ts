import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { keepAlive } from "./wsKeepalive.js";

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  pings = 0;
  terminated = false;
  ping() { this.pings++; }
  terminate() { this.terminated = true; this.readyState = 3; this.emit("close"); }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("keepAlive", () => {
  it("pings while pongs come back", async () => {
    const s = new FakeSocket();
    s.ping = () => { s.pings++; setImmediate(() => s.emit("pong")); };
    keepAlive(s as any, 10);
    await tick(55);
    expect(s.pings).toBeGreaterThanOrEqual(3);
    expect(s.terminated).toBe(false);
    s.emit("close");
  });

  it("terminates a socket that misses a pong", async () => {
    const s = new FakeSocket();
    keepAlive(s as any, 10);
    await tick(35);
    expect(s.pings).toBe(1);
    expect(s.terminated).toBe(true);
  });

  it("stops pinging after close", async () => {
    const s = new FakeSocket();
    keepAlive(s as any, 10);
    s.readyState = 3;
    s.emit("close");
    await tick(35);
    expect(s.pings).toBe(0);
  });
});
