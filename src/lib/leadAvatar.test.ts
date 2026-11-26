import { describe, expect, it } from "vitest";
import { AVATAR_COLOURS, AVATAR_GRID, AVATAR_VARIANTS, avatarInks, avatarPaths, avatarPixels, avatarVariant, leadAvatar } from "./leadAvatar";

// One real set of area names: the six must be easy to tell apart.
const AREAS = ["app-shop", "indexer", "console", "sorrel", "report-app", "protocol"];
const NAMES = [...AREAS, "web", "api", "infra", "docs", "billing", "design", "mobile", "data", "a", "x-1", "0", "a-very-long-area-name-of-32-chars"];
const colour = (area: string, v = 0) => AVATAR_COLOURS[leadAvatar(area, v).colour].name;
const sprite = (area: string, v = 0) => avatarPixels(leadAvatar(area, v)).join("\n");

describe("leadAvatar", () => {
  it("is stable: the same name gives the same creature, on every device", () => {
    expect(leadAvatar("console")).toEqual(leadAvatar("console"));
    // Pinned: a change of the hash, the seed or the lists changes every lead's avatar.
    expect(leadAvatar("console")).toEqual({ colour: 3, body: 1, top: "tuft", eyes: "big", mouth: "wide", feet: "none", cheeks: false, belly: false, arms: false });
    expect(AREAS.map((a) => colour(a))).toEqual(["stone", "teal", "lime", "magenta", "blue", "orange"]);
  });

  it("the six areas differ clearly: six colours, none next to another on the colour ring, six kinds of ears", () => {
    const specs = AREAS.map((a) => leadAvatar(a));
    const colours = specs.map((s) => s.colour);
    expect(new Set(colours).size).toBe(6);
    // The first 11 colours are a ring (red … pink); stone is off it.
    const RING = AVATAR_COLOURS.length - 1;
    for (const a of colours) for (const b of colours) {
      if (a === b || a >= RING || b >= RING) continue;
      const d = Math.abs(a - b);
      expect([a, b, Math.min(d, RING - d) > 1]).toEqual([a, b, true]);
    }
    expect(new Set(specs.map((s) => s.top)).size).toBe(6);
    expect(new Set(specs.map((s) => s.eyes)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(AREAS.map((a) => sprite(a))).size).toBe(6);
  });

  it("one sprite, as drawn (b body, d dark row, l highlight, k and w the eyes and the mouth)", () => {
    expect(avatarPixels(leadAvatar("console"))).toEqual([
      "............",
      ".....b......",
      ".....bb.....",
      "...bbbbbb...",
      "..blbbbbbb..",
      ".bbwkbbwkbb.",
      ".bbkkbbkkbb.",
      ".bbbkkkkbbb.",
      ".bbbbbbbbbb.",
      "..dddddddd..",
      "............",
      "............",
    ]);
  });

  it("a variant is another colour each time: 12 variants show 12 colours, and variant 0 is the name's own", () => {
    for (const area of AREAS) {
      expect(new Set(Array.from({ length: AVATAR_VARIANTS }, (_, v) => colour(area, v))).size).toBe(AVATAR_VARIANTS);
      expect(leadAvatar(area, 0)).toEqual(leadAvatar(area));
      expect(sprite(area, 1)).not.toBe(sprite(area));
    }
  });

  it("a bad variant is variant 0", () => {
    for (const v of [-1, AVATAR_VARIANTS, 1.5, NaN, "2", null, undefined]) expect(avatarVariant(v)).toBe(0);
    expect(avatarVariant(AVATAR_VARIANTS - 1)).toBe(AVATAR_VARIANTS - 1);
    expect(leadAvatar("console", 99)).toEqual(leadAvatar("console"));
  });
});

describe("avatarPixels", () => {
  it("every creature is a 12 × 12 grid with an empty edge, two eyes or one, and a body", () => {
    for (const area of NAMES) for (let v = 0; v < AVATAR_VARIANTS; v++) {
      const spec = leadAvatar(area, v);
      const rows = avatarPixels(spec);
      expect(rows).toHaveLength(AVATAR_GRID);
      expect(rows.every((r) => r.length === AVATAR_GRID && /^[.dblkwptgs]+$/.test(r))).toBe(true);
      expect(rows[0] + rows[AVATAR_GRID - 1]).toMatch(/^\.+$/);
      expect(rows.every((r) => r[0] === "." && r[AVATAR_GRID - 1] === ".")).toBe(true);
      const all = rows.join("");
      expect(all.split("b").length - 1).toBeGreaterThan(20);
      expect(all).toContain("k");
      // Mirrored left to right, but for the highlight, the eye glints and a one-sided tuft or sprout.
      const sym = (r: string) => r.replace(/[lwk]/g, "b");
      if (spec.top !== "tuft" && spec.top !== "sprout") expect(rows.every((r) => sym(r) === [...sym(r)].reverse().join(""))).toBe(true);
    }
  });

  it("avatarPaths covers each filled cell once, in the sprite's own colours, one path per colour", () => {
    for (const area of NAMES) for (let v = 0; v < AVATAR_VARIANTS; v++) {
      const spec = leadAvatar(area, v);
      const cells = avatarPixels(spec).join("").replace(/\./g, "").length;
      const paths = avatarPaths(spec);
      const drawn = paths.reduce((n, p) => n + [...p.d.matchAll(/h(\d+)v1/g)].reduce((m, x) => m + Number(x[1]), 0), 0);
      expect(drawn).toBe(cells);
      const inks = Object.values(avatarInks(spec));
      expect(paths.every((p) => inks.includes(p.fill))).toBe(true);
      // The component keys each path by its colour.
      expect(new Set(paths.map((p) => p.fill)).size).toBe(paths.length);
    }
  });
});
