// src/lib/choiScene.ts — the small scene over the step card of the Set-up page: the robot of the
// brand mark (lib/brandMark.ts) builds its server, one part for each required step that is done.
// Pure: the part is components/setup/ChoiScene.tsx (DOM pixels, placed and moved by its CSS).
//
// The scene reads only real states: the step list and the last view of the first agent that the
// step card read (lib/setupMemory). Its two values are strings, so a poll that brings the same
// state gives the same strings, and the scene draws nothing again.
import type { StepId } from "../../server/setup/steps";
import { BRAND_MARK } from "./brandMark";
import { firstTurn, progress, type SetupRow } from "./setup";
import { firstSay, type FirstView } from "./setupActions";

// One part of the building for each step before the first agent, in the order of the list.
export type ScenePart = "walls" | "roof" | "window" | "door" | "server" | "lights";
export const BUILD: readonly { step: StepId; part: ScenePart }[] = [
  { step: "install", part: "walls" },
  { step: "claude", part: "roof" },
  { step: "access", part: "window" },
  { step: "pair", part: "door" },
  { step: "github", part: "server" },
  { step: "repo", part: "lights" },
];

// What the robot does. none: no answer yet (the scene is not shown). wait: the user's step.
// work: the first agent works. stop: it stopped with no pull request (one calm sign). pr: its pull
// request is open (the robot moved in, its face is on the screen). end: every required step is done.
export type SceneAct = "none" | "wait" | "work" | "stop" | "pr" | "end";
export type AgentPhase = "none" | "work" | "stop" | "pr";
// parts: the parts that stand, in BUILD order, one space between them (CSS reads [data-parts~=…]).
export type Scene = { parts: string; act: SceneAct };

// The first agent, from the same words as its card (firstSay): it works, it stopped (the card
// offers "Try again"), it has no session yet (the card offers its terminal) or a dialog of Claude
// waits on its card (both wait for the user, so the same calm sign as a stop), its pull request
// is there, or nothing yet.
export function agentPhase(v: FirstView | null | undefined): AgentPhase {
  if (!v?.agent) return "none";
  const say = firstSay(v);
  if (say.tone === "run") return "work";
  if (say.tone === "ok") return "pr";
  return say.acts.includes("again") || say.acts.includes("terminal") || v.agent.dialog ? "stop" : "none";
}

// The steps that are done. The one row "Connect GitHub" of the GitHub app holds two checks: its
// part "repo" says that GitHub is done and the repo is not; done says both are.
export function doneSteps(rows: SetupRow[]): Set<StepId> {
  const done = new Set<StepId>();
  for (const r of rows) {
    if (r.state === "done") done.add(r.id);
    if (r.app && r.state === "done") done.add("repo");
    if (r.app && r.part === "repo") done.add("github");
  }
  return done;
}

export function sceneOf(rows: SetupRow[], agent: AgentPhase): Scene {
  if (rows.length === 0 || rows.every((r) => r.state === "checking")) return { parts: "", act: "none" };
  const done = doneSteps(rows);
  const parts = BUILD.filter((b) => done.has(b.step)).map((b) => b.part).join(" ");
  const { done: n, total } = progress(rows);
  if (total > 0 && n === total) return { parts, act: "end" };
  const turn = firstTurn(rows)?.id;
  if (turn === "agent") return { parts, act: agent === "none" ? "wait" : agent };
  if (turn === "merge" || done.has("agent")) return { parts, act: "pr" };
  return { parts, act: "wait" };
}

// ---------------------------------------------------------------- sprites
// A sprite is rows of "#" (ink) and "." (none). ChoiScene draws each one as a grid of cells, one
// <i> for each rectangle of rects().
const only = (rows: readonly string[], keep: (y: number) => boolean): string[] =>
  rows.map((r, y) => [...r].map((c) => (c === "#" && keep(y) ? "#" : ".")).join(""));
export const SPRITES = {
  // the brand mark in parts: the antenna and the body (the legs, eyelids and arms are their own
  // elements, so that they can move)
  ant: only(BRAND_MARK, (y) => y <= 2),
  body: only(BRAND_MARK, (y) => y >= 3 && y <= 9),
  // 6 × 5: the robot's face on the server's screen (it moved in)
  face: ["..##..", "######", "#.##.#", "######", ".#..#."],
  // 5 × 7: the calm sign of a stop
  ask: [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."],
} as const satisfies Record<string, readonly string[]>;
export type SpriteName = keyof typeof SPRITES;

export type Rect = [x: number, y: number, w: number, h: number];
// A sprite as few rectangles: horizontal runs, merged down when the next row has the same run.
export function rects(rows: readonly string[]): Rect[] {
  const out: Rect[] = [];
  let open = new Map<string, Rect>();
  rows.forEach((row, y) => {
    const next = new Map<string, Rect>();
    for (let x = 0; x < row.length;) {
      if (row[x] !== "#") { x++; continue; }
      let w = 1;
      while (row[x + w] === "#") w++;
      const k = `${x}:${w}`;
      const r = open.get(k);
      if (r && r[1] + r[3] === y) { r[3]++; next.set(k, r); } else { const n: Rect = [x, y, w, 1]; out.push(n); next.set(k, n); }
      x += w;
    }
    open = next;
  });
  return out;
}
