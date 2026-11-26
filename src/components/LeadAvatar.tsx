// src/components/LeadAvatar.tsx — a lead's avatar: the pixel-art creature of its area name
// (lib/leadAvatar), on a neutral tile. The same lead has the same avatar in every place and on
// every device. The sprite is a 12 × 12 grid, so the sizes are 12, 24 and 36 px only: one sprite
// pixel is 1, 2 or 3 whole screen pixels and never blurs. Do not scale it with CSS.
// Beside the lead's name it is decorative (hidden from screen readers); alone, give it `label`.
// `status` puts the lead's status dot on its corner (the dot keeps its word as title and label).
// No motion.
"use client";
import { useMemo } from "react";
import type { Dot } from "../lib/agentGroups";
import { avatarPaths, AVATAR_GRID, leadAvatar } from "../lib/leadAvatar";
import { useLeadLooks } from "../lib/leads";
import s from "./LeadAvatar.module.css";

export type AvatarSize = 12 | 24 | 36;

export function LeadAvatar({ area, size = 24, variant, label, status }: {
  area: string; size?: AvatarSize; variant?: number; label?: string; status?: { dot: Dot; word: string };
}) {
  // The user's pick for this area (Settings, Leads), unless the caller gives one.
  const picked = useLeadLooks().get(area);
  const v = variant ?? picked ?? 0;
  const paths = useMemo(() => avatarPaths(leadAvatar(area, v)), [area, v]);
  return (
    <span className={s.av} data-size={size} data-lead-avatar={area}>
      <svg
        className={s.tile} width={size} height={size} viewBox={`0 0 ${AVATAR_GRID} ${AVATAR_GRID}`} shapeRendering="crispEdges" focusable="false"
        {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      >
        {paths.map((p) => <path key={p.fill} fill={p.fill} d={p.d} />)}
      </svg>
      {status && <i className={`${s.st} ${s[`d_${status.dot}`]}`} role="img" title={status.word} aria-label={status.word} />}
    </span>
  );
}
