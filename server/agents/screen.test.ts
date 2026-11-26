import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ScreenMirror, MAX_PENDING } from "./screen.js";
import { detectPrompt } from "./prompt.js";

const file = (name: string): string => readFileSync(fileURLToPath(new URL(`./testdata/screens/${name}`, import.meta.url)), "utf8");

describe("ScreenMirror", () => {
  it("turns the real PTY bytes of the trust dialog into the screen the user saw", async () => {
    const m = new ScreenMirror(120, 30);
    m.write(file("trust-2.1.322.raw"));
    const s = await m.read();
    expect(s.cols).toBe(120);
    expect(s.rows).toBe(30);
    expect(s.lines).toHaveLength(30);
    expect(s.lines.join("\n") + "\n").toBe(file("trust-2.1.322.txt"));
    expect(detectPrompt(s)?.kind).toBe("folder-trust");
    m.dispose();
  });

  it("gives the same screen when the bytes arrive in small chunks", async () => {
    const raw = file("trust-2.1.322.raw");
    const m = new ScreenMirror(120, 30);
    for (let i = 0; i < raw.length; i += 7) m.write(raw.slice(i, i + 7));
    expect((await m.read()).lines.join("\n") + "\n").toBe(file("trust-2.1.322.txt"));
    m.dispose();
  });

  it("applies cursor moves and erases: a repaint replaces the old text", async () => {
    const m = new ScreenMirror(40, 5);
    m.write("first\r\nsecond\r\n");
    m.write("\x1b[2A\x1b[2Knew\x1b[1B\r\x1b[2K");
    const s = await m.read();
    expect(s.lines).toEqual(["new", "", "", "", ""]);
    expect(s.cursor).toEqual({ x: 0, y: 1 });
    m.dispose();
  });

  it("keeps no scrollback: only the viewport, whatever was written", async () => {
    const m = new ScreenMirror(20, 4);
    for (let i = 0; i < 500; i++) m.write(`line ${i}\r\n`);
    const s = await m.read();
    expect(s.lines).toEqual(["line 497", "line 498", "line 499", ""]);
    m.dispose();
  });

  it("follows a resize and clamps a size out of range", async () => {
    const m = new ScreenMirror(20, 4);
    m.write("hello");
    m.resize(50, 10);
    let s = await m.read();
    expect([s.cols, s.rows, s.lines.length]).toEqual([50, 10, 10]);
    expect(s.lines[0]).toBe("hello");
    m.resize(100_000, 0);
    s = await m.read();
    expect([s.cols, s.rows]).toEqual([500, 1]);
    m.dispose();
  });

  it("drops output over the pending cap and counts it, and still parses later output", async () => {
    const m = new ScreenMirror(20, 4);
    m.write("x".repeat(MAX_PENDING + 1));
    expect(m.droppedChars).toBe(MAX_PENDING + 1);
    m.write("ok");
    expect((await m.read()).lines[0]).toBe("ok");
    expect(m.droppedChars).toBe(MAX_PENDING + 1);
    m.dispose();
  });

  it("after dispose: writes are ignored and a read answers with an empty screen", async () => {
    const m = new ScreenMirror(20, 4);
    m.write("hello");
    const pending = m.read();
    m.dispose();
    m.dispose();
    m.write("more");
    m.resize(30, 6);
    expect((await pending).lines).toEqual([]);
    expect((await m.read()).lines).toEqual([]);
  });
});
