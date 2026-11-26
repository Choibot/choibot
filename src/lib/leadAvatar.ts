// src/lib/leadAvatar.ts — a lead's avatar, from its area name alone: a small pixel-art creature
// on a 12 × 12 grid. A hash of the name picks the colour, the body, the ears, the eyes and the
// rest, so the same lead looks the same on every device with no stored data. Pure:
// components/LeadAvatar.tsx draws the result. `variant` (0 = the name's own creature) is the
// user's "Change avatar" pick: each step is another colour and another creature.
// The creatures are original: a round or chunky body, mirrored left to right, clear eyes, a dark
// bottom row and one highlight pixel.

export const AVATAR_GRID = 12;

// The palette: 12 colours, each as dark / base / light, plus the fixed inks below.
export const AVATAR_COLOURS = [
  { name: "red", d: "#a8324a", b: "#e8605a", l: "#ffb199" },
  { name: "orange", d: "#b3562a", b: "#f2913d", l: "#ffcf8a" },
  { name: "yellow", d: "#b58a1e", b: "#f5cd45", l: "#fff0a8" },
  { name: "lime", d: "#5d8c2b", b: "#a3d14e", l: "#dcf59a" },
  { name: "green", d: "#2b7d54", b: "#4fc27a", l: "#aaf0b6" },
  { name: "teal", d: "#1f7377", b: "#3fbfb5", l: "#a5efdc" },
  { name: "sky", d: "#2d6da8", b: "#56b4ec", l: "#b5e5ff" },
  { name: "blue", d: "#3a3f9c", b: "#6474ea", l: "#b9c2ff" },
  { name: "purple", d: "#643f9e", b: "#a078e8", l: "#d9c4ff" },
  { name: "magenta", d: "#8f357f", b: "#d968c4", l: "#f7bdec" },
  { name: "pink", d: "#b0486e", b: "#f58cab", l: "#ffd0dc" },
  { name: "stone", d: "#5f6680", b: "#a3abc2", l: "#dde2ee" },
] as const;
const INK = "#1c1b29";
const WHITE = "#fdfcf5";
const PINK = "#ff8fa8";
const GOLD = "#ffd65c";
const AQUA = "#6fe3e0";
const LEAF = "#5fcf6a";
const STEM = "#2f8a4c";

// One variant per colour: a full turn of "Change avatar" shows every colour once.
export const AVATAR_VARIANTS = AVATAR_COLOURS.length;

// The bodies: the half-width of each row (cells from the middle outward), from row `top` down;
// `eye` is the row of the eyes.
const BODIES = [
  { name: "blob", top: 4, eye: 6, rows: [4, 5, 5, 5, 5, 4] },
  { name: "round", top: 3, eye: 5, rows: [3, 4, 5, 5, 5, 5, 4] },
  { name: "box", top: 4, eye: 6, rows: [4, 4, 4, 4, 4, 4] },
  { name: "pear", top: 3, eye: 5, rows: [2, 3, 4, 5, 5, 5, 4] },
  { name: "tall", top: 3, eye: 5, rows: [3, 4, 4, 4, 4, 4, 3] },
  { name: "bean", top: 5, eye: 6, rows: [4, 5, 5, 5, 4] },
] as const;
export const AVATAR_TOPS = ["none", "cat", "bear", "mouse", "bunny", "antenna", "horns", "tuft", "sprout"] as const;
export const AVATAR_EYES = ["dot", "tall", "big", "white", "sleepy", "one"] as const;
export const AVATAR_MOUTHS = ["none", "small", "wide", "beak"] as const;
export const AVATAR_FEET = ["none", "feet", "wide"] as const;

// What the hash picked.
export type AvatarSpec = {
  colour: number; body: number; top: (typeof AVATAR_TOPS)[number]; eyes: (typeof AVATAR_EYES)[number];
  mouth: (typeof AVATAR_MOUTHS)[number]; feet: (typeof AVATAR_FEET)[number]; cheeks: boolean; belly: boolean; arms: boolean;
};

// Picked so that small sets of plain area names get clearly different creatures (the test holds
// one such set). A change here changes every avatar.
const SEED = 253736;

function fnv1a(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// murmur3's finalizer: every input bit reaches every output bit.
function mix(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// A whole number 0 ≤ variant < AVATAR_VARIANTS; anything else is 0 (the name's own creature).
export function avatarVariant(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < AVATAR_VARIANTS ? v : 0;
}

export function leadAvatar(area: string, variant = 0, seed = SEED): AvatarSpec {
  const v = avatarVariant(variant);
  const base = fnv1a(area, seed);
  const pick = (k: number, n: number): number => mix((base + Math.imul(k + 1 + v * 16, 0x9e3779b9)) >>> 0) % n;
  return {
    // The colour steps by 5 per variant (5 and 12 share no factor: 12 steps visit every colour).
    colour: (mix(base) % AVATAR_COLOURS.length + v * 5) % AVATAR_COLOURS.length,
    body: pick(1, BODIES.length),
    top: AVATAR_TOPS[pick(2, AVATAR_TOPS.length)],
    eyes: AVATAR_EYES[pick(3, AVATAR_EYES.length)],
    mouth: AVATAR_MOUTHS[pick(4, AVATAR_MOUTHS.length)],
    feet: AVATAR_FEET[pick(5, AVATAR_FEET.length)],
    cheeks: pick(6, 2) === 0,
    belly: pick(7, 3) === 0,
    arms: pick(8, 3) === 0,
  };
}

// The sprite: 12 rows of 12 cells. "." is empty; a letter is a colour of `avatarInks`.
export type AvatarInk = "d" | "b" | "l" | "k" | "w" | "p" | "t" | "g" | "s";

export function avatarInks(spec: AvatarSpec): Record<AvatarInk, string> {
  const c = AVATAR_COLOURS[spec.colour];
  const warm = c.name === "red" || c.name === "magenta" || c.name === "pink";
  const sunny = c.name === "yellow" || c.name === "orange";
  const leafy = c.name === "green" || c.name === "lime";
  return {
    d: c.d, b: c.b, l: c.l, k: INK, w: WHITE,
    p: warm ? c.d : PINK, // cheeks
    t: sunny ? AQUA : GOLD, // antenna tips, horns and the beak
    g: leafy ? GOLD : LEAF, s: leafy ? c.d : STEM, // the sprout: a leaf and its stem
  };
}

export function avatarPixels(spec: AvatarSpec): string[] {
  const N = AVATAR_GRID;
  const g: string[][] = Array.from({ length: N }, () => Array<string>(N).fill("."));
  const set = (x: number, y: number, ink: AvatarInk): void => { if (x >= 1 && x <= N - 2 && y >= 1 && y <= N - 2) g[y][x] = ink; };
  // c = cells from the middle (0 = the two middle columns), drawn on both sides.
  const both = (c: number, y: number, ink: AvatarInk): void => { set(5 - c, y, ink); set(6 + c, y, ink); };
  const body = BODIES[spec.body];
  const bottom = body.top + body.rows.length - 1;
  const half = (y: number): number => body.rows[y - body.top] ?? 0;

  // The body; its bottom row is the dark tone.
  body.rows.forEach((w, i) => { for (let c = 0; c < w; c++) both(c, body.top + i, i === body.rows.length - 1 ? "d" : "b"); });
  // One highlight pixel, top left.
  set(5 - (half(body.top + 1) - 2), body.top + 1, "l");

  // The top of the head.
  const w0 = body.rows[0];
  const y1 = body.top - 1;
  switch (spec.top) {
    case "cat": both(w0 - 1, y1, "b"); both(w0 - 2, y1, "b"); both(w0 - 1, y1 - 1, "b"); break;
    case "bear": both(w0 - 1, y1, "b"); both(w0 - 2, y1, "b"); break;
    case "mouse": for (const y of [y1, y1 - 1]) { both(w0 - 1, y, "b"); both(w0, y, "b"); } both(w0 - 1, y1, "l"); break;
    case "bunny": for (let y = y1; y >= Math.max(1, y1 - 2); y--) both(1, y, "b"); break;
    case "antenna": both(2, y1, "d"); both(2, y1 - 1, "t"); break;
    case "horns": both(w0 - 1, y1, "t"); break;
    case "tuft": both(0, y1, "b"); set(5, y1 - 1, "b"); break;
    case "sprout": set(5, y1, "s"); set(5, y1 - 1, "s"); set(6, y1 - 1, "g"); set(7, y1 - 2, "g"); set(6, y1 - 2, "g"); break;
    default: break;
  }

  // The feet, under the body; the arms, at its sides.
  if (spec.feet === "feet") { both(1, bottom + 1, "d"); both(2, bottom + 1, "d"); }
  else if (spec.feet === "wide") { both(2, bottom + 1, "d"); both(3, bottom + 1, "d"); }
  if (spec.arms && half(body.eye + 2) <= 4) both(half(body.eye + 2), body.eye + 2, "d");

  // The eyes.
  const ey = body.eye;
  let eyeRows = 1;
  switch (spec.eyes) {
    case "tall": both(2, ey, "k"); both(2, ey + 1, "k"); eyeRows = 2; break;
    case "big":
      for (const y of [ey, ey + 1]) { both(1, y, "k"); both(2, y, "k"); }
      set(3, ey, "w"); set(7, ey, "w"); eyeRows = 2; break;
    case "white":
      for (const y of [ey, ey + 1]) { both(1, y, "w"); both(2, y, "w"); }
      set(4, ey + 1, "k"); set(8, ey + 1, "k"); eyeRows = 2; break;
    case "sleepy": both(1, ey, "k"); both(2, ey, "k"); break;
    case "one":
      for (const y of [ey, ey + 1]) { both(0, y, "w"); both(1, y, "w"); }
      set(5, ey, "k"); set(6, ey, "k"); set(5, ey + 1, "k"); set(6, ey + 1, "k"); eyeRows = 2; break;
    default: both(2, ey, "k"); break;
  }

  // The mouth, one row under the eyes, and the cheeks beside it.
  const my = ey + eyeRows;
  if (my < bottom) {
    if (spec.mouth === "small") both(0, my, "k");
    else if (spec.mouth === "wide") { both(0, my, "k"); both(1, my, "k"); }
    else if (spec.mouth === "beak") both(0, my, "t");
    if (spec.cheeks && half(my) >= 4) both(3, my, "p");
  }
  // A light belly, where the mouth leaves room.
  if (spec.belly && my + 2 < bottom) { both(0, bottom - 1, "l"); both(1, bottom - 1, "l"); }

  return g.map((row) => row.join(""));
}

// The sprite as one SVG path per colour (runs of cells along a row), for a 12 × 12 viewBox.
export function avatarPaths(spec: AvatarSpec): { fill: string; d: string }[] {
  const inks = avatarInks(spec);
  const by = new Map<string, string>();
  avatarPixels(spec).forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ink = row[x];
      let n = 1;
      while (x + n < row.length && row[x + n] === ink) n++;
      // By colour, not by ink: two inks can share one (the cheeks of a red creature are its dark tone).
      const fill = ink === "." ? "" : inks[ink as AvatarInk];
      if (fill) by.set(fill, `${by.get(fill) ?? ""}M${x} ${y}h${n}v1h-${n}z`);
      x += n;
    }
  });
  return [...by].map(([fill, d]) => ({ fill, d }));
}
