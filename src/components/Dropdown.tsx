// src/components/Dropdown.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import s from "./AgentSidebar.module.css";
import { groupOptions } from "../lib/group-options";

export type Option = { value: string; label: string; group?: string };

export function Dropdown({
  value, options, placeholder, onChange, disabled, title,
}: {
  value: string;
  options: Option[];
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div className={s.dd} ref={ref} data-dropdown-open={open ? "" : undefined}>
      <button type="button" className={s.ddBtn} onClick={() => setOpen((o) => !o)} disabled={disabled} title={title}>
        <span className={selected ? s.ddValue : s.ddPlaceholder}>
          {selected ? selected.label : placeholder}
        </span>
        <span className={s.ddCaret}>
          <svg
            className={`${s.ddCaretIcon} ${open ? s.ddCaretOpen : ""}`}
            width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className={s.ddMenu} role="listbox">
          {options.length === 0 && <div className={s.ddEmpty}>none available</div>}
          {groupOptions(options).map((grp) => (
            <div key={grp.group ?? "_"}>
              {grp.group && <div className={s.ddGroup}>{grp.group}</div>}
              {grp.items.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  className={`${s.ddItem} ${o.value === value ? s.ddItemActive : ""}`}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
