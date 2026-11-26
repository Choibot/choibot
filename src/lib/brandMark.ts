// src/lib/brandMark.ts — the brand mark: the "bot" of the product name, a pixel-art mascot on a
// 12 × 12 grid in the style of the lead avatars (lib/leadAvatar), in one ink. Original art.
// components/BrandMark.tsx draws it in the app. src/app/icon.svg (the browser tab) and
// src/app/apple-icon.png (the phone home screen, 180 px = 15 px per cell) hold the same sprite:
// brandMark.test.ts fails when icon.svg differs from brandMarkSvg().
// The sprite is a 12 × 12 grid: draw it at 12, 24 or 36 px (whole screen pixels per cell).

export const MARK_GRID = 12;

// "#" is ink, "." is the tile. One antenna, two eyes, a smile, two feet; mirrored left to right.
export const BRAND_MARK = [
  "............",
  ".....##.....",
  ".....##.....",
  "..########..",
  ".##..##..##.",
  ".##..##..##.",
  ".##########.",
  ".##.####.##.",
  ".###....###.",
  "..########..",
  "..##....##..",
  "............",
] as const;

// The ink cells as one SVG path (runs of cells along a row), for a 12 × 12 viewBox.
export function markPath(rows: readonly string[] = BRAND_MARK): string {
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      let n = 1;
      while (x + n < row.length && row[x + n] === row[x]) n++;
      if (row[x] === "#") d += `M${x} ${y}h${n}v1h-${n}z`;
      x += n;
    }
  });
  return d;
}

// The mark as a file (the browser tab icon): a dark tile with a light bot, the reverse for a dark
// browser theme, as in the app.
export function brandMarkSvg(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_GRID} ${MARK_GRID}">`,
    "<style>.t{fill:#171717}.m{fill:#fff}@media (prefers-color-scheme:dark){.t{fill:#ededed}.m{fill:#0a0a0a}}</style>",
    `<rect class="t" width="${MARK_GRID}" height="${MARK_GRID}" rx="3"/>`,
    `<path class="m" shape-rendering="crispEdges" d="${markPath()}"/>`,
    "</svg>\n",
  ].join("");
}
