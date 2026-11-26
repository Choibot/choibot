// src/components/settings/SettingsPage.tsx — one place to set up and check every add-on. Desktop: a
// 52 px head, the sections on the left (each with the dot of its status line), the open section on
// the right. Phone: the list of sections, then one section full screen with the back arrow.
//
// Every section body stays mounted (hidden when another is open): each reads its data once when
// the page opens, so the list shows every dot at once and a switch never blinks. The dots and the
// last section are remembered (lib/viewCache) for the next open. The sections: sections.tsx.
"use client";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { hasUserToken } from "../../lib/chief";
import { FIRST_SECTION, LOADING, type SectionStatus } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import type { QueueViewKind } from "../../lib/useQueue";
import { PhoneHeader } from "../PhoneHeader";
import { ChevronIcon, GearIcon } from "../SideIcons";
import { cx as s, Dot, StatusReport } from "./kit";
import { SETTINGS_SECTIONS, sectionById, type SettingsSection } from "./sections";

const statusSeen = viewMemory<Record<string, SectionStatus>>(1);
const lastSeen = viewMemory<string>(1);
const NO_STATUS: Record<string, SectionStatus> = {};

// The rows of the section list, each run of one group under its heading.
function Groups({ render }: { render: (d: SettingsSection) => ReactNode }) {
  return (
    <>
      {SETTINGS_SECTIONS.map((d, i) => (
        <Fragment key={d.id}>
          {(i === 0 || SETTINGS_SECTIONS[i - 1].group !== d.group) && <h3 className={s.navSec}>{d.group}</h3>}
          {render(d)}
        </Fragment>
      ))}
    </>
  );
}

// `section`: the open section (null on the phone = the list). `onSection` opens one. `onBack`: the
// phone's way back to the home list. `chief`: the queue's view kind, for the read-only line.
// `onOpenAgent`: shows an agent's thread (the Coordinator's row in Leads).
export function SettingsPage({ phone = false, section, onSection, onBack, chief, onOpenAgent }: {
  phone?: boolean; section: string | null; onSection: (id: string | null) => void; onBack?: () => void; chief?: QueueViewKind;
  onOpenAgent?: (id: string) => void;
}) {
  const [statuses, setStatuses] = useRemembered(statusSeen, "all", NO_STATUS);
  // Each section's reporter, made once: StatusLine reports through it on every change.
  const reporters = useMemo(() => Object.fromEntries(SETTINGS_SECTIONS.map((d) => [d.id, (st: SectionStatus) => {
    setStatuses((prev) => (prev[d.id]?.tone === st.tone && prev[d.id]?.text === st.text ? prev : { ...prev, [d.id]: st }));
  }])), [setStatuses]);
  const desktopOpen = sectionById(section)?.id ?? sectionById(lastSeen.get("last"))?.id ?? FIRST_SECTION;
  const open = phone ? sectionById(section)?.id ?? null : desktopOpen;
  useEffect(() => { if (open) lastSeen.set("last", open); }, [open]);
  const go = useCallback((id: string) => onSection(id), [onSection]);
  const has = useCallback((id: string) => !!sectionById(id), []);
  // Reading needs no pairing; every action does (the server's USER gate). Said once, up top.
  const [unpaired, setUnpaired] = useState(false);
  useEffect(() => { setUnpaired((chief === "on" || chief === "misconfigured") && !hasUserToken()); }, [chief]);
  const readOnly = unpaired ? "Read only: pair this device to change settings" : "";

  const bodies = SETTINGS_SECTIONS.map(({ id, label, Body }) => (
    <div key={id} className={s.section} hidden={id !== open} aria-labelledby={`settings-${id}`}>
      <h2 className={s.title} id={`settings-${id}`}>{label}</h2>
      <StatusReport.Provider value={reporters[id]}>
        <Body phone={phone} go={go} has={has} openAgent={onOpenAgent} />
      </StatusReport.Provider>
    </div>
  ));
  const statusOf = (id: string): SectionStatus => statuses[id] ?? LOADING;

  if (phone) {
    const d = sectionById(open);
    return (
      <div className={s.phone}>
        {d ? (
          <PhoneHeader onBack={() => onSection(null)} title={d.label} />
        ) : (
          <PhoneHeader onBack={() => onBack?.()} title="Settings" sub={readOnly || undefined} />
        )}
        <div className={s.phoneScroll}>
          {!d && (
            <nav className={s.phoneList} aria-label="Settings sections">
              <Groups render={(x) => (
                <button type="button" className={s.phoneRow} onClick={() => onSection(x.id)}>
                  <span className={s.navIc}>{x.icon}</span>
                  <span className={s.phoneTt}>
                    <span>{x.label}</span>
                    <span className={s.phoneSub}><Dot tone={statusOf(x.id).tone} /><span>{statusOf(x.id).text}</span></span>
                  </span>
                  <span className={s.chev}><ChevronIcon dir="right" size={14} /></span>
                </button>
              )} />
            </nav>
          )}
          <div className={s.phoneBody} hidden={!d}>{bodies}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.head}>
        <h1 className={s.headTitle}>Settings</h1>
        {readOnly && <span className={s.headLine}>{readOnly}</span>}
      </div>
      <div className={s.split}>
        <nav className={s.nav} aria-label="Settings sections">
          <Groups render={(x) => (
            <button type="button" className={s.navRow} aria-current={x.id === open ? "page" : undefined} onClick={() => onSection(x.id)}
              title={statusOf(x.id).text}>
              <span className={s.navIc}>{x.icon}</span>
              <span className={s.navNm}>{x.label}</span>
              <Dot tone={statusOf(x.id).tone} />
            </button>
          )} />
        </nav>
        <div className={s.body}>{bodies}</div>
      </div>
    </div>
  );
}

// The sidebar footer's gear (desktop, next to the theme switch). `open`: Settings is showing.
export function SettingsGear({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className={s.gear} onClick={onClick} aria-pressed={open} title="Settings" aria-label="Settings">
      <GearIcon />
    </button>
  );
}

// The phone home list's last row.
export function SettingsHomeRow({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={s.homeRow} onClick={onClick}>
      <span className={s.navIc}><GearIcon /></span>
      <span className={s.navNm}>Settings</span>
      <span className={s.chev}><ChevronIcon dir="right" size={14} /></span>
    </button>
  );
}
