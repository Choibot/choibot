import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_MARK, brandMarkSvg, MARK_GRID, markPath } from "./brandMark";

const app = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

describe("brand mark", () => {
  it("is a 12 × 12 sprite with an empty border, mirrored left to right", () => {
    expect(BRAND_MARK).toHaveLength(MARK_GRID);
    for (const row of BRAND_MARK) {
      expect(row).toMatch(/^\.[.#]{10}\.$/);
      expect([...row].reverse().join("")).toBe(row);
    }
    expect(BRAND_MARK[0]).toBe("............");
    expect(BRAND_MARK[MARK_GRID - 1]).toBe("............");
  });

  it("makes one path that covers each ink cell once", () => {
    const cells = new Set<string>();
    for (const m of markPath().matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(m[3]); i++) cells.add(`${Number(m[1]) + i},${m[2]}`);
    }
    const ink = BRAND_MARK.flatMap((row, y) => [...row].flatMap((c, x) => (c === "#" ? [`${x},${y}`] : [])));
    expect([...cells].sort()).toEqual(ink.sort());
  });

  it("is the sprite of the browser tab icon (src/app/icon.svg)", () => {
    expect(readFileSync(join(app, "icon.svg"), "utf8")).toBe(brandMarkSvg());
  });
});
