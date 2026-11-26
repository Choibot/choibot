// src/components/StatusDot.tsx — a sidebar row's status as a dot in the token colours
// (lib/agentGroups statusDot). The word is its title and aria-label, so the state stays
// readable without the colour.
import type { Dot } from "../lib/agentGroups";
import s from "./AgentSidebar.module.css";

export function StatusDot({ status }: { status: { dot: Dot; word: string } }) {
  return (
    <span className={s.dotw} role="img" title={status.word} aria-label={status.word}>
      <i className={`${s.dot} ${s[`d_${status.dot}`]}`} />
    </span>
  );
}
