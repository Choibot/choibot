// src/components/settings/kit.tsx — the parts every Settings section is made of. A section's body
// starts with <StatusLine> (its dot also shows in the section list), then <Block>s of <Row>s, and a
// <Form> for its action. Use these and the classes of Settings.module.css (`cx`), so every section
// has the same look.
"use client";
import { createContext, useContext, useEffect, type FormEvent, type ReactNode } from "react";
import type { SectionStatus } from "../../lib/settings";
import { ChevronIcon } from "../SideIcons";
import s from "./Settings.module.css";

export { s as cx };

// What the page gives each section's body.
export type SectionProps = {
  // The phone's full-screen view (touch sizes).
  phone: boolean;
  // Open another section (a "see Devices" link).
  go: (id: string) => void;
  // Whether a section exists (a link to it shows only then).
  has: (id: string) => boolean;
  // Open an agent's thread (the Coordinator's "Open its thread"). Absent: no such button.
  openAgent?: (id: string) => void;
};

// The page's side of the status line: the section list shows each section's last status.
export const StatusReport = createContext<(status: SectionStatus) => void>(() => {});

// The first line of a section: a dot and a few words ("Connected", "Not set up", or what is wrong).
export function StatusLine({ status }: { status: SectionStatus }) {
  const report = useContext(StatusReport);
  useEffect(() => { report(status); }, [report, status.tone, status.text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <p className={s.status} role="status">
      <Dot tone={status.tone} />
      <span>{status.text}</span>
    </p>
  );
}

// A 7 px status dot. The tones of lib/settings, plus a lead's or agent's run/turn.
export function Dot({ tone, title }: { tone: string; title?: string }) {
  return <i className={s.dot} data-tone={tone} title={title} aria-label={title} role={title ? "img" : undefined} />;
}

// A titled group: the title line (with its buttons on the right) and a hairline list of rows.
export function Block({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.block}>
      <div className={s.blockHead}>
        <h3 className={s.blockTitle}>{title}</h3>
        {right}
      </div>
      <div className={s.list}>{children}</div>
    </section>
  );
}

// `className`: a variant of a row for one section (its own layout on the phone).
export function Row({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return <div className={className ? `${s.row} ${className}` : s.row} title={title}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={s.empty}>{children}</div>;
}

// A form inside a Block (after its rows). Enter in a field submits it.
export function Form({ onSubmit, children, label }: { onSubmit: () => void; children: ReactNode; label: string }) {
  return (
    <form className={s.form} aria-label={label} onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
      {children}
    </form>
  );
}

// One labelled input (the label wraps it, so a click on the words focuses it).
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      {children}
    </label>
  );
}

// A labelled set of controls (chips, buttons): never a <label>, which would hand its words and
// its clicks to the first button.
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field} role="group" aria-label={label}>
      <span className={s.label} aria-hidden>{label}</span>
      {children}
    </div>
  );
}

// A closed fold for the details a person who edits the box needs (key names, ids, commands).
export function HowTo({ title = "How to set this up", children }: { title?: string; children: ReactNode }) {
  return (
    <details className={s.howto}>
      <summary className={s.howtoHead}><span className={s.howtoCaret}><ChevronIcon size={12} /></span>{title}</summary>
      <div className={s.howtoBody}>{children}</div>
    </details>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className={s.note}>{children}</p>;
}

export function ErrorLine({ text }: { text: string }) {
  return text ? <p className={s.err} role="alert">{text}</p> : null;
}
