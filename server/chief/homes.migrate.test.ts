// server/chief/homes.migrate.test.ts — migrateMemory when a file appears in
// the target after its empty check (Task 2c-7 fix round 1, item 7). The race
// is made deterministic by planting the file while the first source file is
// read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plant = vi.hoisted(() => ({ at: "", done: false }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (async (...a: Parameters<typeof real.readFile>) => {
      if (plant.at !== "" && !plant.done) {
        plant.done = true;
        await real.writeFile(plant.at, "agent's own\n");
      }
      return real.readFile(...a);
    }) as typeof real.readFile,
  };
});

const { migrateMemory } = await import("./homes.js");

const tmps: string[] = [];
afterEach(async () => { while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true }); });

describe("migrateMemory, a file planted after the empty check", () => {
  it("skips that file with one log line and copies the rest", async () => {
    const base = await mkdtemp(join(tmpdir(), "migrate-race-"));
    tmps.push(base);
    const from = join(base, "legacy");
    await mkdir(from);
    await writeFile(join(from, "MEMORY.md"), "index\n");
    await writeFile(join(from, "pref.md"), "pref\n");
    const to = join(base, "home", "memory");
    plant.at = join(to, "pref.md");
    const log = vi.fn();
    expect(await migrateMemory(from, to, log)).toBe("copied");
    expect(await readFile(join(to, "MEMORY.md"), "utf8")).toBe("index\n");
    expect(await readFile(join(to, "pref.md"), "utf8")).toBe("agent's own\n");
    expect(log.mock.calls).toEqual([[`[chief] memory pref.md already in ${to}; not copied`]]);
  });
});
