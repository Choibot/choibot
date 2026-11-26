// server/widgets/files.test.ts — tests for the atomic and capped file helpers.
import { describe, it, expect } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, mtimeOf, readCapped, readJsonSoft, writeAtomic } from "./files.js";

const tmp = () => mkdtemp(join(tmpdir(), "widget-files-"));

describe("writeAtomic", () => {
  it("writes the file and leaves no temp file behind", async () => {
    const dir = await tmp();
    await writeAtomic(join(dir, "a.json"), '{"a":1}');
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe('{"a":1}');
    expect(await readdir(dir)).toEqual(["a.json"]);
  });
  it("replaces a symlink at the target name instead of writing through it", async () => {
    const dir = await tmp();
    const victim = join(await tmp(), "victim.txt");
    await writeFile(victim, "keep");
    await symlink(victim, join(dir, "state.json"));
    await writeAtomic(join(dir, "state.json"), "{}");
    expect(await readFile(victim, "utf8")).toBe("keep");
    expect((await lstat(join(dir, "state.json"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe("{}");
  });
});

describe("readCapped", () => {
  it("returns null for a missing file and for a folder", async () => {
    const dir = await tmp();
    expect(await readCapped(join(dir, "nope"), 10)).toBeNull();
    await mkdir(join(dir, "sub"));
    expect(await readCapped(join(dir, "sub"), 10)).toBeNull();
  });
  it("reads a file under the cap and throws a 413 WidgetError over it", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "f"), "abcd");
    expect(await readCapped(join(dir, "f"), 4)).toBe("abcd");
    await expect(readCapped(join(dir, "f"), 3)).rejects.toMatchObject({ code: 413 });
  });
});

describe("readJsonSoft, mtimeOf, exists", () => {
  it("parses JSON and returns null for bad JSON, a missing file or one over the cap", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "ok"), '{"x":1}');
    await writeFile(join(dir, "bad"), "{x");
    expect(await readJsonSoft(join(dir, "ok"), 100)).toEqual({ x: 1 });
    expect(await readJsonSoft(join(dir, "bad"), 100)).toBeNull();
    expect(await readJsonSoft(join(dir, "nope"), 100)).toBeNull();
    expect(await readJsonSoft(join(dir, "ok"), 2)).toBeNull();
  });
  it("mtimeOf is a number for a file and null otherwise; exists sees any entry", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "f"), "x");
    expect(typeof (await mtimeOf(join(dir, "f")))).toBe("number");
    expect(await mtimeOf(dir)).toBeNull();
    expect(await mtimeOf(join(dir, "nope"))).toBeNull();
    expect(await exists(join(dir, "f"))).toBe(true);
    expect(await exists(join(dir, "nope"))).toBe(false);
  });
});
