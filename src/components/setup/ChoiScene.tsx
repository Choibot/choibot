// src/components/setup/ChoiScene.tsx — the small scene over the step card of the Set-up page:
// the robot of the brand mark builds its server, one part for each required step that is done
// (lib/choiScene.ts sceneOf: the mapping). Decorative (aria-hidden): the words stay in the card.
//
// DOM pixels only (span, i, b), placed and moved by ChoiScene.module.css. The scene changes only
// by its data-* values, which come from real states (the step list, the first agent's last view).
// The default of every rule is the END state of its value, so with reduced motion each state shows
// still and whole. A change of value is a transition in place; the same value (a poll that changed
// nothing) changes no node: the art is a memo of four strings.
"use client";
import { memo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { agentPhase, rects, sceneOf, SPRITES, type AgentPhase, type SceneAct, type SpriteName } from "../../lib/choiScene";
import type { SetupRow } from "../../lib/setup";
import { lastFirst, watchFirst } from "../../lib/setupMemory";
import s from "./ChoiScene.module.css";

const k = (...names: (string | undefined)[]): string => names.filter(Boolean).join(" ");

// One sprite: a grid of cells, one <i> for each rectangle of its rows.
function Px({ name, cls, x2 }: { name: SpriteName; cls?: string; x2?: boolean }) {
  const rows = SPRITES[name];
  const cols = rows[0]!.length;
  const box: CSSProperties = { gridTemplateColumns: `repeat(${cols}, var(--u))`, width: `calc(var(--u) * ${cols})`, height: `calc(var(--u) * ${rows.length})` };
  return (
    <b className={k(s.px, x2 ? s.x2 : undefined, cls)} style={box}>
      {rects(rows).map(([x, y, w, h], i) => <i key={i} style={{ gridArea: `${y + 1} / ${x + 1} / span ${h} / span ${w}` }} />)}
    </b>
  );
}

// The robot: 12 × 12 cells, 2 scene pixels for each cell. Its eyelids blink, its legs step, its
// right arm has two poses (down, up).
function Robot() {
  return (
    <span className={k(s.rb, s.x2, s.me)}>
      <Px name="ant" /><Px name="body" />
      <i className={k(s.lid, s.l)} /><i className={k(s.lid, s.r)} />
      <i className={k(s.leg, s.l)} /><i className={k(s.leg, s.r)} />
      <i className={k(s.arm, s.l)} /><i className={k(s.arm, s.r)} /><i className={k(s.arm, s.up)} />
    </span>
  );
}

type ArtProps = { act: SceneAct; parts: string; from: SceneAct | null; added: string; cheer: boolean };

// A side view of the building site: the ground, a tree, the road to the door, the building, and
// the robot. added: the parts that this change brought (they come in; the robot hops once).
// n: the count of parts (it gives the hop a new name for each new part).
export const Art = memo(function Art({ act, parts, from, added, cheer }: ArtProps) {
  const n = parts ? parts.split(" ").length : 0;
  return (
    <div className={s.sc} data-act={act} data-parts={parts} data-n={n} data-from={from ?? undefined}
      data-new={added || undefined} data-cheer={cheer ? "" : undefined}>
      <span className={s.world}>
        <span className={s.earth} /><span className={s.gnd} /><span className={s.road} />
        <span className={k(s.cloud, s.c1)} /><span className={k(s.cloud, s.c2)} /><span className={k(s.cloud, s.c3)} />
        <span className={s.tree}><i /><i /></span>
        <span className={s.plot} />
        <span className={s.dc}>
          <span className={s.walls} />
          <span className={s.roof} /><span className={s.lamp} />
          <span className={s.win}>
            <span className={s.slot} />
            <span className={s.srv}>
              <i className={k(s.led, s.la)} /><i className={k(s.led, s.lb)} /><i className={k(s.led, s.lc)} /><i className={s.grill} />
              <span className={s.scr}><i className={s.type} /><i className={s.cur} /><span className={s.fw}><Px name="face" x2 /></span></span>
            </span>
          </span>
          <span className={s.door}><span className={s.glow} /></span>
          <span className={s.panel}><i className={s.knob} /></span>
        </span>
        <span className={s.walker}><Robot /><span className={s.qw}><Px name="ask" x2 /></span></span>
      </span>
    </div>
  );
});

// The first agent from the view its card read last (no read of its own). A string: the same
// state gives the same value, and React draws nothing again.
const useAgentPhase = (): AgentPhase => useSyncExternalStore(watchFirst, () => agentPhase(lastFirst()), () => "none");

export type Seen = { key: string; from: SceneAct | null; added: string; cheer: boolean };

export function nextSeen(beforeKey: string, act: SceneAct, parts: string): Seen {
  const [before, had = ""] = beforeKey.split("|") as [SceneAct, string?];
  const real = before !== "none" && act !== "none";
  if (!real) return { key: `${act}|${parts}`, from: null, added: "", cheer: false };
  const old = new Set(had.split(" "));
  const added = parts.split(" ").filter((p) => p && !old.has(p)).join(" ");
  return { key: `${act}|${parts}`, from: before, added, cheer: act === "end" && before !== "end" };
}

export function ChoiScene({ rows, phone = false }: { rows: SetupRow[]; phone?: boolean }) {
  const { act, parts } = sceneOf(rows, useAgentPhase());
  const key = `${act}|${parts}`;
  // A change from one real state to another: data-from is the act before it, data-new the parts
  // that it brought, data-cheer says that this page saw the set-up end. The first real state
  // fades in and moves nothing; the same state (a poll) changes nothing here.
  const [seen, setSeen] = useState<Seen>({ key, from: null, added: "", cheer: false });
  if (seen.key !== key) setSeen(nextSeen(seen.key, act, parts));
  return (
    <div className={s.band} data-phone={phone ? "" : undefined} aria-hidden="true">
      <Art act={act} parts={parts} from={seen.from} added={seen.added} cheer={seen.cheer} />
    </div>
  );
}
