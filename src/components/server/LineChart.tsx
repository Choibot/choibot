// src/components/server/LineChart.tsx — one small line chart of one value over time, 0 to 100 %:
// plain SVG, one series (its title names it), a quiet grid, and a line with the value under the
// pointer or the finger. The line is not drawn over a time with no data.
"use client";
import { useRef, useState, type PointerEvent } from "react";
import { clock, linePath, nearest, type Series } from "../../lib/server";
import { percent } from "../../../server/health/words";
import s from "./Server.module.css";

const W = 600;
const H = 120;

export function LineChart({ title, now, series, gapMs }: { title: string; now: string; series: Series; gapMs: number }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<[number, number] | null>(null);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const t = series.from + ((e.clientX - r.left) / r.width) * (series.to - series.from);
    setAt(nearest(series, t));
  };
  const span = series.to - series.from;
  const left = at ? ((at[0] - series.from) / span) * 100 : 0;
  const d = linePath(series, W, H, gapMs);
  const peak = series.points.reduce((m, p) => Math.max(m, p[1]), 0);
  return (
    <figure className={s.chart}>
      <figcaption className={s.chartHead}>
        <span className={s.chartTitle}>{title}</span>
        <span className={s.chartNow}>{at ? `${percent(at[1])} at ${clock(at[0])}` : now}</span>
      </figcaption>
      <div
        className={s.plot} ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setAt(null)}
        role="img" aria-label={series.points.length ? `${title}: now ${now}, highest ${percent(peak)} in this time` : `${title}: no history yet`}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0, 0.5, 1].map((f) => <line key={f} className={s.grid} x1="0" x2={W} y1={H * f} y2={H * f} />)}
          {d && <path className={s.line} d={d} />}
        </svg>
        {at && <i className={s.cross} style={{ left: `${left}%` }} />}
        {at && <i className={s.mark} style={{ left: `${left}%`, top: `${100 - Math.min(100, at[1])}%` }} />}
        {!series.points.length && <span className={s.plotEmpty}>The history starts now</span>}
        <span className={s.yTop}>100%</span>
        <span className={s.yMid}>50%</span>
      </div>
      <div className={s.xAxis}><span>{clock(series.from)}</span><span>{clock(series.from + span / 2)}</span><span>now</span></div>
    </figure>
  );
}
