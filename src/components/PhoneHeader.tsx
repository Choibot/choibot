// src/components/PhoneHeader.tsx — the one header of a phone screen (A · Inset): the back
// arrow, the title and its status line, then the screen's own buttons on the right. `icon` sits
// before the title (a lead's avatar). It pads
// itself below the notch. `extra` is a full-width second line (the fleet master's lead switch).
"use client";
import type { ReactNode } from "react";
import { BackIcon } from "./SideIcons";
import s from "./PhoneHeader.module.css";

export function PhoneHeader({ onBack, backLabel = "Back", icon, title, sub, right, extra }: {
  onBack: () => void; backLabel?: string; icon?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; extra?: ReactNode;
}) {
  return (
    <header className={s.head}>
      <div className={s.line}>
        <button type="button" className={s.back} onClick={onBack} aria-label={backLabel} title={backLabel}><BackIcon /></button>
        {icon && <span className={s.lead}>{icon}</span>}
        <div className={s.tt}>
          <b className={s.title}>{title}</b>
          {sub && <small className={s.sub}>{sub}</small>}
        </div>
        {right}
      </div>
      {extra && <div className={s.extra}>{extra}</div>}
    </header>
  );
}

// The round "files" button of a header (the mockup's .fbtn): an icon and a count.
export function PhonePillButton({ onClick, pressed, label, children }: {
  onClick: () => void; pressed?: boolean; label: string; children: ReactNode;
}) {
  return (
    <button type="button" className={s.pill} onClick={onClick} aria-pressed={pressed} aria-label={label} title={label}>
      {children}
    </button>
  );
}

// A plain 44 px icon button of a header (the pane's "more" menu).
export function PhoneIconButton({ onClick, label, expanded, children }: {
  onClick: () => void; label: string; expanded?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" className={s.icon} onClick={onClick} aria-label={label} title={label}
      {...(expanded !== undefined ? { "aria-expanded": expanded, "aria-haspopup": "menu" as const } : {})}>
      {children}
    </button>
  );
}
