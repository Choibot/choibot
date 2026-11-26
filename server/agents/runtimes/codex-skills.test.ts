import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir, readlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  planSkillLinks,
  discoverSkills,
  discoverPluginSkills,
  linkSkills,
  buildSkillFarm,
} from "./codex-skills.js";

// A ~/.claude stand-in: personal skills plus a plugins/installed_plugins.json
// whose installPaths point at real directories under the same temp root.
async function fakeClaudeHome(spec: {
  personal?: string[];
  // A function receives the temp home, so installPaths can be absolute.
  manifest?: string | Record<string, unknown> | ((home: string) => unknown);
  pluginSkills?: Record<string, string[]>;
}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "claudehome-"));
  for (const name of spec.personal ?? []) {
    await mkdir(join(home, "skills", name), { recursive: true });
    await writeFile(join(home, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  for (const [rel, skills] of Object.entries(spec.pluginSkills ?? {})) {
    for (const s of skills) {
      await mkdir(join(home, rel, "skills", s), { recursive: true });
      await writeFile(join(home, rel, "skills", s, "SKILL.md"), "x");
    }
  }
  if (spec.manifest !== undefined) {
    const m = typeof spec.manifest === "function" ? spec.manifest(home) : spec.manifest;
    await mkdir(join(home, "plugins"), { recursive: true });
    await writeFile(
      join(home, "plugins", "installed_plugins.json"),
      typeof m === "string" ? m : JSON.stringify(m),
    );
  }
  return home;
}

describe("planSkillLinks", () => {
  it("keeps personal skills under their bare name", () => {
    expect(planSkillLinks([{ name: "acme-db", dir: "/c/skills/acme-db" }], []))
      .toEqual([{ name: "acme-db", dir: "/c/skills/acme-db" }]);
  });

  it("namespaces plugin skills with their plugin", () => {
    const out = planSkillLinks([], [
      { plugin: "superpowers", skills: [{ name: "brainstorming", dir: "/p/sp/skills/brainstorming" }] },
    ]);
    expect(out).toEqual([{ name: "superpowers-brainstorming", dir: "/p/sp/skills/brainstorming" }]);
  });

  it("lets a personal skill win a name collision with a plugin", () => {
    const out = planSkillLinks(
      [{ name: "deep-review", dir: "/c/skills/deep-review" }],
      [{ plugin: "deep", skills: [{ name: "review", dir: "/p/deep/skills/review" }] }],
    );
    expect(out.find((s) => s.name === "deep-review")?.dir).toBe("/c/skills/deep-review");
    // The plugin skill is still present, suffixed rather than dropped.
    expect(out).toHaveLength(2);
    expect(out.some((s) => s.dir === "/p/deep/skills/review")).toBe(true);
  });

  it("suffixes two plugins that collide after namespacing", () => {
    const out = planSkillLinks([], [
      { plugin: "a-b", skills: [{ name: "c", dir: "/1" }] },
      { plugin: "a", skills: [{ name: "b-c", dir: "/2" }] },
    ]);
    expect(new Set(out.map((s) => s.name)).size).toBe(2);
  });

  it("is deterministic regardless of input order", () => {
    const p = [{ plugin: "z", skills: [{ name: "s", dir: "/z" }] },
               { plugin: "a", skills: [{ name: "s", dir: "/a" }] }];
    expect(planSkillLinks([], p)).toEqual(planSkillLinks([], [...p].reverse()));
  });

  it("is deterministic when two plugins share a display name", () => {
    // key.split("@")[0] drops the marketplace, so "x@market-a" and "x@market-b"
    // both arrive as "x": input order must not decide who gets the -2 suffix.
    const p = [{ plugin: "x", skills: [{ name: "s", dir: "/market-b/s" }] },
               { plugin: "x", skills: [{ name: "s", dir: "/market-a/s" }] }];
    expect(planSkillLinks([], p)).toEqual(planSkillLinks([], [...p].reverse()));
    expect(planSkillLinks([], p).find((s) => s.name === "x-s")?.dir).toBe("/market-a/s");
  });

  it("flattens path separators out of a crafted plugin name", () => {
    const out = planSkillLinks([], [
      { plugin: "../../evil", skills: [{ name: "pwn", dir: "/p/evil/pwn" }] },
    ]);
    // The invariant that matters: the name is one segment that cannot escape.
    expect(resolve("/farm", out[0].name).startsWith("/farm/")).toBe(true);
    expect(out[0].name).toBe("..-..-evil-pwn");
    expect(out[0].dir).toBe("/p/evil/pwn");
  });

  it("neutralises a name that is nothing but dots", () => {
    const out = planSkillLinks([{ name: "..", dir: "/c/skills/dots" }], []);
    expect(out[0].name).toBe("--");
  });

  it("still suffixes names that collide only after sanitising", () => {
    const out = planSkillLinks([], [
      { plugin: "a/b", skills: [{ name: "c", dir: "/1" }] },
      { plugin: "a-b", skills: [{ name: "c", dir: "/2" }] },
    ]);
    expect(new Set(out.map((s) => s.name)).size).toBe(2);
  });
});

describe("discoverSkills", () => {
  it("finds personal skills and skips dirs without a SKILL.md", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudehome-"));
    await mkdir(join(home, "skills", "real"), { recursive: true });
    await writeFile(join(home, "skills", "real", "SKILL.md"), "---\nname: real\n---\n");
    await mkdir(join(home, "skills", "empty"), { recursive: true });
    const found = await discoverSkills(home);
    expect(found.map((s) => s.name)).toEqual(["real"]);
    await rm(home, { recursive: true, force: true });
  });

  it("returns empty for a missing skills dir instead of throwing", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudehome-none-"));
    await expect(discoverSkills(home)).resolves.toEqual([]);
    await rm(home, { recursive: true, force: true });
  });
});

describe("discoverPluginSkills", () => {
  it("namespaces by the part of the manifest key before the @", async () => {
    const home = await fakeClaudeHome({
      pluginSkills: { "cache/sp/6.3.0": ["brainstorming", "writing-plans"] },
      manifest: (h) => ({
        version: 2,
        plugins: {
          "superpowers@claude-plugins-official": [{ installPath: join(h, "cache/sp/6.3.0") }],
        },
      }),
    });
    const out = await discoverPluginSkills(home);
    expect(out).toHaveLength(1);
    expect(out[0].plugin).toBe("superpowers");
    expect(out[0].skills.map((s) => s.name)).toEqual(["brainstorming", "writing-plans"]);
    await rm(home, { recursive: true, force: true });
  });

  it("reads installs[0], not a superseded cached version", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudehome-vers-"));
    for (const [v, skill] of [["2.0.0", "new-skill"], ["1.0.0", "old-skill"]] as const) {
      await mkdir(join(home, "cache", v, "skills", skill), { recursive: true });
      await writeFile(join(home, "cache", v, "skills", skill, "SKILL.md"), "x");
    }
    await mkdir(join(home, "plugins"), { recursive: true });
    await writeFile(
      join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "p@m": [
            { installPath: join(home, "cache", "2.0.0"), version: "2.0.0" },
            { installPath: join(home, "cache", "1.0.0"), version: "1.0.0" },
          ],
        },
      }),
    );
    const out = await discoverPluginSkills(home);
    expect(out.flatMap((p) => p.skills.map((s) => s.name))).toEqual(["new-skill"]);
    await rm(home, { recursive: true, force: true });
  });

  it("returns empty when the manifest file is missing", async () => {
    const home = await fakeClaudeHome({});
    await expect(discoverPluginSkills(home)).resolves.toEqual([]);
    await rm(home, { recursive: true, force: true });
  });

  it("returns empty for malformed JSON instead of throwing", async () => {
    const home = await fakeClaudeHome({ manifest: "{ not json" });
    await expect(discoverPluginSkills(home)).resolves.toEqual([]);
    await rm(home, { recursive: true, force: true });
  });

  it("returns empty when the manifest has no plugins key", async () => {
    const home = await fakeClaudeHome({ manifest: { version: 2 } });
    await expect(discoverPluginSkills(home)).resolves.toEqual([]);
    await rm(home, { recursive: true, force: true });
  });

  it("skips a plugin entry with no installPath, and one with no skills", async () => {
    const home = await fakeClaudeHome({
      manifest: { plugins: { "nopath@m": [{ version: "1" }], "empty@m": [], "gone@m": [{ installPath: "/nope/missing" }] } },
    });
    await expect(discoverPluginSkills(home)).resolves.toEqual([]);
    await rm(home, { recursive: true, force: true });
  });
});

describe("buildSkillFarm", () => {
  it("links personal and plugin skills together and counts them", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudehome-farm-"));
    await mkdir(join(home, "skills", "mine"), { recursive: true });
    await writeFile(join(home, "skills", "mine", "SKILL.md"), "x");
    await mkdir(join(home, "cache", "p", "skills", "theirs"), { recursive: true });
    await writeFile(join(home, "cache", "p", "skills", "theirs", "SKILL.md"), "x");
    await mkdir(join(home, "plugins"), { recursive: true });
    await writeFile(
      join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "pl@m": [{ installPath: join(home, "cache", "p") }] } }),
    );
    const codexHome = await mkdtemp(join(tmpdir(), "codexhome-farm-"));
    expect(await buildSkillFarm(codexHome, home)).toBe(2);
    expect(await readdir(join(codexHome, "skills"))).toEqual(["mine", "pl-theirs"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  });

  it("returns 0 for a claude home with nothing in it", async () => {
    const home = await mkdtemp(join(tmpdir(), "claudehome-bare-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codexhome-bare-"));
    await expect(buildSkillFarm(codexHome, home)).resolves.toBe(0);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  });
});

describe("linkSkills", () => {
  it("creates one symlink per skill and reports the count", async () => {
    const base = await mkdtemp(join(tmpdir(), "codexhome-"));
    const src = join(base, "src", "alpha");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "x");
    const n = await linkSkills(join(base, "home"), [{ name: "alpha", dir: src }]);
    expect(n).toBe(1);
    expect(await readdir(join(base, "home", "skills"))).toEqual(["alpha"]);
    expect(await readlink(join(base, "home", "skills", "alpha"))).toBe(src);
    await rm(base, { recursive: true, force: true });
  });

  it("replaces a stale farm rather than accumulating", async () => {
    const base = await mkdtemp(join(tmpdir(), "codexhome-stale-"));
    const home = join(base, "home");
    const a = join(base, "a"); const b = join(base, "b");
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    await linkSkills(home, [{ name: "a", dir: a }]);
    await linkSkills(home, [{ name: "b", dir: b }]);
    expect(await readdir(join(home, "skills"))).toEqual(["b"]);
    await rm(base, { recursive: true, force: true });
  });

  it("skips a broken source without failing the whole farm", async () => {
    const base = await mkdtemp(join(tmpdir(), "codexhome-broken-"));
    const good = join(base, "good");
    await mkdir(good, { recursive: true });
    const n = await linkSkills(join(base, "home"), [
      { name: "good", dir: good },
      { name: "gone", dir: join(base, "does-not-exist") },
    ]);
    expect(n).toBe(1);
    await rm(base, { recursive: true, force: true });
  });

  it("refuses to plant a link outside the farm", async () => {
    const base = await mkdtemp(join(tmpdir(), "codexhome-escape-"));
    const src = join(base, "src");
    await mkdir(src, { recursive: true });
    const n = await linkSkills(join(base, "home"), [{ name: "../../escaped-skill", dir: src }]);
    expect(n).toBe(0);
    await expect(access(join(base, "escaped-skill"))).rejects.toThrow();
    expect(await readdir(join(base, "home", "skills"))).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });

  it("resolves a relative source so the link is never dangling", async () => {
    const base = await mkdtemp(join(tmpdir(), "codexhome-rel-"));
    const src = join(base, "src");
    await mkdir(src, { recursive: true });
    const cwd = process.cwd();
    process.chdir(base);
    try {
      const n = await linkSkills(join(base, "home"), [{ name: "rel", dir: "src" }]);
      expect(n).toBe(1);
      expect(await readlink(join(base, "home", "skills", "rel"))).toBe(src);
      await expect(access(join(base, "home", "skills", "rel", "."))).resolves.toBeUndefined();
    } finally {
      process.chdir(cwd);
    }
    await rm(base, { recursive: true, force: true });
  });

  it("returns 0 instead of throwing when the farm dir cannot be created", async () => {
    const base = await mkdtemp(join(tmpdir(), "codexhome-blocked-"));
    // A regular file where the home should be: mkdir fails with ENOTDIR.
    await writeFile(join(base, "blocked"), "not a directory");
    const src = join(base, "src");
    await mkdir(src, { recursive: true });
    await expect(linkSkills(join(base, "blocked"), [{ name: "a", dir: src }])).resolves.toBe(0);
    await rm(base, { recursive: true, force: true });
  });
});
