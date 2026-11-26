import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSlug, listRepos } from "./repos.js";

const run = promisify(execFile);

describe("parseSlug", () => {
  it("parses ssh and https github urls", () => {
    expect(parseSlug("git@github.com:example-org/sorrel.git")).toBe("example-org/sorrel");
    expect(parseSlug("https://github.com/example-org/sorrel")).toBe("example-org/sorrel");
    expect(parseSlug("https://github.com/example-org/sorrel.git")).toBe("example-org/sorrel");
  });
  it("returns null for non-github", () => {
    expect(parseSlug("https://gitlab.com/x/y.git")).toBeNull();
  });
});

describe("listRepos", () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "ws-")); });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("lists dirs with a github origin, sorted by name", async () => {
    for (const [name, url] of [["sorrel", "git@github.com:example-org/sorrel.git"], ["app", "https://github.com/example-org/app.git"]]) {
      const p = join(ws, name);
      await mkdir(p);
      await run("git", ["-C", p, "init", "-q"]);
      await run("git", ["-C", p, "remote", "add", "origin", url]);
    }
    await mkdir(join(ws, "not-a-repo"));
    const repos = await listRepos(ws);
    expect(repos.map((r) => r.name)).toEqual(["app", "sorrel"]);
    expect(repos.find((r) => r.name === "sorrel")!.slug).toBe("example-org/sorrel");
  });
});
