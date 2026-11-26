// src/components/SideIcons.tsx — the line icons of the console (16 px grid, 1.5 stroke,
// currentColor). Decorative: the text or the aria-label of the control names the thing.
// Use these, never a text glyph (▸ ▾ ↗ ✓ ✗ ● ★ ⟳ …) as an icon.
import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flex: "none", verticalAlign: "-0.125em" }}>
      {children}
    </svg>
  );
}

export const InboxIcon = () => <Icon><path d="M2 9.5V13h12V9.5M2 9.5 3.8 3h8.4L14 9.5M2 9.5h3.5l1 1.5h3l1-1.5H14" /></Icon>;
export const DiamondIcon = ({ size = 16 }: { size?: number }) => <Icon size={size}><path d="M8 2.5 13.5 8 8 13.5 2.5 8z" /></Icon>;
export const GitHubIcon = () => (
  <Icon><circle cx="4.5" cy="4" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="6" r="1.5" /><path d="M4.5 5.5v5M11.5 7.5c0 2-2 2.5-5 3.5" /></Icon>
);
export const ServerIcon = () => <Icon><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /><path d="M5 4.75h.5M5 11.25h.5" /></Icon>;
export const LockIcon = () => <Icon><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></Icon>;
export const LinkIcon = () => <Icon><path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" /></Icon>;
export const RepeatIcon = () => <Icon><path d="M3 7.5v-1a2 2 0 0 1 2-2h7.5M10.5 2.5l2 2-2 2M13 8.5v1a2 2 0 0 1-2 2H3.5M5.5 13.5l-2-2 2-2" /></Icon>;
export const ClockIcon = () => <Icon><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></Icon>;
export const PlusIcon = ({ size = 16 }: { size?: number }) => <Icon size={size}><path d="M8 3v10M3 8h10" /></Icon>;
export const CloseIcon = ({ size = 14 }: { size?: number }) => <Icon size={size}><path d="m4 4 8 8M12 4l-8 8" /></Icon>;
// A fold caret: right when closed, down when open (`open`), or a fixed direction (`dir`).
const CHEVRON = { right: "m6 4 4 4-4 4", down: "m4 6 4 4 4-4", up: "m4 10 4-4 4 4", left: "m10 4-4 4 4 4" } as const;
export const ChevronIcon = ({ open, dir, size = 12 }: { open?: boolean; dir?: keyof typeof CHEVRON; size?: number }) => (
  <Icon size={size}><path d={CHEVRON[dir ?? (open ? "down" : "right")]} /></Icon>
);
export const SunIcon = () => (
  <Icon><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></Icon>
);
export const MoonIcon = () => <Icon><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" /></Icon>;
// The phone shell: the back arrow of every screen header, the files button,
// the pane's "more" menu, and the reminder badge's alarm.
export const BackIcon = ({ size = 22 }: { size?: number }) => <Icon size={size}><path d="M10 3 5 8l5 5" /></Icon>;
export const FileIcon = () => <Icon><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></Icon>;
export const MoreIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}><circle cx="3.5" cy="8" r="0.6" /><circle cx="8" cy="8" r="0.6" /><circle cx="12.5" cy="8" r="0.6" /></Icon>
);
export const AlarmIcon = ({ size = 12 }: { size?: number }) => (
  <Icon size={size}><circle cx="8" cy="9" r="5" /><path d="M8 6.5V9l1.5 1M2.5 3.5 4 2M13.5 3.5 12 2" /></Icon>
);
export const CheckIcon = ({ size = 14 }: { size?: number }) => <Icon size={size}><path d="m3.5 8.5 3 3 6-7" /></Icon>;
// Settings: Rules (a list with marks) and Devices (a phone).
export const RulesIcon = () => <Icon><path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.5 4l.75.75L4.5 3.25M2.5 8l.75.75L4.5 7.25M2.5 12l.75.75 1.25-1.5" /></Icon>;
export const DeviceIcon = () => <Icon><rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" /><path d="M7.25 11.75h1.5" /></Icon>;
// A link that opens a new tab (GitHub, a preview, a CI run).
export const ExternalIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M6 3h7v7M13 3 5 11" /></Icon>;
export const RefreshIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></Icon>
);
export const ArrowUpIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M8 13V3M4 7l4-4 4 4" /></Icon>;
export const ArrowDownIcon = ({ size = 12 }: { size?: number }) => <Icon size={size}><path d="M8 3v10M4 9l4 4 4-4" /></Icon>;
export const ExpandIcon = ({ size = 14 }: { size?: number }) => <Icon size={size}><path d="M3 6.5V3h3.5M9.5 3H13v3.5M13 9.5V13H9.5M6.5 13H3V9.5" /></Icon>;
export const CodeIcon = ({ size = 14 }: { size?: number }) => <Icon size={size}><path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5" /></Icon>;
// The drag handle of a sidebar row: two columns of three dots.
export const GripIcon = ({ size = 12 }: { size?: number }) => (
  <Icon size={size}>{[5, 8, 11].map((y) => <g key={y}><circle cx="6" cy={y} r="0.6" /><circle cx="10" cy={y} r="0.6" /></g>)}</Icon>
);
// The state of one row in a list of steps (a CI run, a deploy step, a task, a cron run): a
// tick (ok), a cross (fail), a filled dot (running now), a ring (to do) or a dash (skipped).
// currentColor: the caller's class gives the tone.
export type MarkKind = "ok" | "fail" | "run" | "todo" | "skip";
export const Mark = ({ kind, size = 12 }: { kind: MarkKind; size?: number }) => (
  <Icon size={size}>
    {kind === "ok" ? <path d="m3.5 8.5 3 3 6-7" />
      : kind === "fail" ? <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
      : kind === "run" ? <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
      : kind === "todo" ? <circle cx="8" cy="8" r="3.25" />
      : <path d="M5 8h6" />}
  </Icon>
);
// Settings: the gear of the sidebar footer, and the icons of its sections.
export const GearIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12.78 6.54 14.48 6.74 14.48 9.26 12.78 9.46 12.41 10.35 13.47 11.69 11.69 13.47 10.35 12.41 9.46 12.78 9.26 14.48 6.74 14.48 6.54 12.78 5.65 12.41 4.31 13.47 2.53 11.69 3.59 10.35 3.22 9.46 1.52 9.26 1.52 6.74 3.22 6.54 3.59 5.65 2.53 4.31 4.31 2.53 5.65 3.59 6.54 3.22 6.74 1.52 9.26 1.52 9.46 3.22 10.35 3.59 11.69 2.53 13.47 4.31 12.41 5.65z" />
    <circle cx="8" cy="8" r="2" />
  </Icon>
);
export const FlagIcon = () => <Icon><path d="M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5" /></Icon>;
export const PersonIcon = () => <Icon><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.6 2.8-4 5-4s4.2 1.4 5 4" /></Icon>;
export const FolderIcon = () => <Icon><path d="M2 3.5h4l1.5 1.5H14v8H2z" /></Icon>;
export const SendIcon = () => <Icon><path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z" /></Icon>;
