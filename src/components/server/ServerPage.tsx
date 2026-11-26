// src/components/server/ServerPage.tsx — the Server page: is your server healthy, and what uses
// it. The state now (processor, memory, each disk, uptime), one hour and one day of history, the
// agents and the programs that use the most, and what fills the disk. A second tab, Files, shows
// every folder and file of the server (FilesTab.tsx). A third tab, Clean-up, lists what could be
// removed (CleanUpTab.tsx). Read only: the page stops nothing and
// removes nothing. Desktop: a 52 px head and one column. Phone: one screen with the
// back arrow to the home list.
"use client";
import { useState, type ReactNode } from "react";
import { ago, checkPlaces, fullTone, placeWords, seriesOf, type HealthView, type PlaceSize, type Range, type Use } from "../../lib/server";
import { useHealth } from "../../lib/useServer";
import { useRemembered, useScrollMemory, viewMemory } from "../../lib/viewCache";
import { DISPLAY_NAME } from "../../../server/brand";
import { diskName, percent, size, span } from "../../../server/health/words";
import { PhoneHeader } from "../PhoneHeader";
import { ChevronIcon } from "../SideIcons";
import { Block, cx as k, Dot, Empty } from "../settings/kit";
import { CleanUpTab } from "./CleanUpTab";
import { FilesTab } from "./FilesTab";
import { LineChart } from "./LineChart";
import s from "./Server.module.css";

// The limits of the server's own warnings (server/health/warn.ts), for the colour of a bar.
const DISK_WARN = 85;
const DISK_ERROR = 95;
const MEMORY_WARN = 90;

function headline(view: HealthView | null): string {
  if (!view) return "";
  const n = view.warnings.length;
  return n === 0 ? "Healthy" : `${n} ${n === 1 ? "thing needs" : "things need"} you`;
}

function Bar({ value, tone = "ok", label }: { value: number; tone?: "ok" | "warn" | "err"; label: string }) {
  return (
    <span className={s.bar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={label}>
      <i data-tone={tone} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </span>
  );
}

function Tile({ label, value, of, bar, sub }: { label: string; value: string; of?: string; bar?: ReactNode; sub: ReactNode }) {
  return (
    <div className={s.tile}>
      <span className={s.tileLabel}>{label}</span>
      <span className={s.tileValue}>{value}{of && <small> {of}</small>}</span>
      {bar}
      <span className={s.tileSub}>{sub}</span>
    </div>
  );
}

function Now({ view }: { view: HealthView }) {
  const m = view.memory;
  const memPct = m ? (m.used / m.total) * 100 : 0;
  return (
    <div className={s.tiles}>
      <Tile
        label="Processor" value={view.cpu === null ? "…" : percent(view.cpu)}
        bar={<Bar value={view.cpu ?? 0} label="Processor in use" />}
        sub={view.load ? `Load ${view.load[0].toFixed(2)} · ${view.cores} ${view.cores === 1 ? "core" : "cores"}` : `${view.cores} cores`}
      />
      {m && (
        <Tile
          label="Memory" value={size(m.used)} of={`of ${size(m.total)}`}
          bar={<Bar value={memPct} tone={fullTone(memPct, MEMORY_WARN)} label="Memory in use" />}
          sub={m.swapTotal > 0 ? `Swap ${size(m.swapUsed)} of ${size(m.swapTotal)}` : "No swap"}
        />
      )}
      {view.disks.map((d) => (
        <Tile
          key={d.path} label={d.path === "/" ? "Main disk" : `Disk ${d.path}`} value={size(d.used)} of={`of ${size(d.total)}`}
          bar={<Bar value={d.percent} tone={fullTone(d.percent, DISK_WARN, DISK_ERROR)} label={`${diskName(d.path)}: space in use`} />}
          sub={`${size(d.free)} free${d.holdsWork && view.disks.length > 1 ? " · your agents work here" : ""}`}
        />
      ))}
      <Tile
        label="Running for" value={view.uptimeSec === null ? "…" : span(view.uptimeSec)}
        sub={<>{view.facts.system ?? "Linux"} · {view.facts.name}</>}
      />
    </div>
  );
}

function Warnings({ view }: { view: HealthView }) {
  if (!view.warnings.length) return null;
  return (
    <section className={s.warns} aria-label="What needs you">
      {view.warnings.map((w) => (
        <div key={w.id} className={s.warn} role="status">
          <Dot tone={w.level === "error" ? "err" : "warn"} />
          <div className={k.stack}>
            <b className={s.warnTitle}>{w.title}</b>
            <span className={s.warnText}>{w.text}</span>
            <span className={s.warnTodo}>{w.todo}</span>
          </div>
        </div>
      ))}
    </section>
  );
}

function OverTime({ view }: { view: HealthView }) {
  const [range, setRange] = useState<Range>("hour");
  const h = view.history;
  const gap = range === "hour" ? h.fineStepMs * 3 : h.coarseStepMs * 2.5;
  const m = view.memory;
  const pick = (
    <div className={s.switch} role="group" aria-label="Time shown">
      <button type="button" aria-pressed={range === "hour"} onClick={() => setRange("hour")}>1 hour</button>
      <button type="button" aria-pressed={range === "day"} onClick={() => setRange("day")}>24 hours</button>
    </div>
  );
  return (
    <section className={k.block}>
      <div className={k.blockHead}><h3 className={k.blockTitle}>Over time</h3>{pick}</div>
      <div className={s.charts}>
        <LineChart title="Processor" now={view.cpu === null ? "…" : percent(view.cpu)} series={seriesOf(h, range, 1, view.at)} gapMs={gap} />
        <LineChart title="Memory" now={m ? percent((m.used / m.total) * 100) : "…"} series={seriesOf(h, range, 2, view.at)} gapMs={gap} />
      </div>
      <p className={k.note}>The history is kept in memory only: it starts again when {DISPLAY_NAME} restarts. It began {ago(view.since, view.at)}.</p>
    </section>
  );
}

// name: the row's own name for the user (the Agents list leaves out the word "agent").
function UseRow({ u, by, name = u.name }: { u: Use; by: "cpu" | "mem" | "both"; name?: string }) {
  return (
    <>
      <span className={k.rowName}>{name}</span>
      <span className={k.rowMeta}>{u.procs > 1 ? `${u.procs} processes` : ""}</span>
      {by !== "mem" && <span className={s.num}>{percent(u.cpu)}</span>}
      {by !== "cpu" && <span className={s.num}>{size(u.mem)}</span>}
    </>
  );
}

function Agents({ view, onOpenAgent }: { view: HealthView; onOpenAgent: (id: string) => void }) {
  return (
    <Block title="Agents" right={view.agents.length ? <span className={s.cols}><span>Processor</span><span>Memory</span></span> : undefined}>
      {view.agents.length === 0 && <Empty>No agent runs now.</Empty>}
      {view.agents.map((u) => (
        <button key={u.agentId} type="button" className={`${k.row} ${s.agentRow}`} onClick={() => onOpenAgent(u.agentId as string)} title="Open its thread">
          <UseRow u={u} by="both" name={u.name.replace(/^agent /, "")} />
          <span className={s.chev}><ChevronIcon dir="right" /></span>
        </button>
      ))}
    </Block>
  );
}

function Top({ view }: { view: HealthView }) {
  const list = (title: string, rows: Use[], by: "cpu" | "mem") => (
    <Block title={title}>
      {rows.length === 0 && <Empty>Nothing to show yet.</Empty>}
      {rows.map((u, i) => <div key={`${u.kind}:${u.agentId ?? u.name}:${i}`} className={k.row}><UseRow u={u} by={by} /></div>)}
    </Block>
  );
  return <div className={s.pair}>{list("Most processor", view.topCpu, "cpu")}{list("Most memory", view.topMemory, "mem")}</div>;
}

function PlaceRow({ p, max }: { p: Pick<PlaceSize, "bytes"> & { name: string; note: string }; max: number }) {
  return (
    <div className={`${k.row} ${k.rowTall} ${s.place}`}>
      <div className={k.stack}>
        <div className={k.line}><span className={s.placeName}>{p.name}</span></div>
        {p.note && <span className={k.help}>{p.note}</span>}
        {p.bytes !== null && max > 0 && <span className={s.share}><i style={{ width: `${Math.max(1, (p.bytes / max) * 100)}%` }} /></span>}
      </div>
      <span className={s.num}>{p.bytes === null ? "Not measured" : size(p.bytes)}</span>
    </div>
  );
}

function Places({ view, refresh }: { view: HealthView; refresh: () => Promise<void> }) {
  const { rows, checkedAt, checking } = view.places;
  const [asked, setAsked] = useState(false);
  const busy = checking || asked;
  const again = async () => {
    setAsked(true);
    await checkPlaces();
    await refresh();
    setAsked(false);
  };
  const work = view.disks.find((d) => d.holdsWork);
  const known = rows.reduce((sum, r) => sum + (r.workDisk ? r.bytes ?? 0 : 0), 0);
  const rest = work && checkedAt !== null ? work.used - known : 0;
  const max = Math.max(rest, ...rows.map((r) => r.bytes ?? 0));
  const restBiggest = rest > 0 && rows.every((r) => (r.bytes ?? 0) < rest);
  const right = (
    <>
      <span className={s.checked}>{busy ? "Measuring…" : checkedAt === null ? "" : `Checked ${ago(checkedAt, view.at)}`}</span>
      <button type="button" className={k.btn} onClick={() => void again()} disabled={busy}>Check again</button>
    </>
  );
  return (
    <section className={k.block}>
      <div className={k.blockHead}><h3 className={k.blockTitle}>What fills the disk</h3>{right}</div>
      <div className={k.list}>
        {checkedAt === null && <Empty>The sizes are being measured. This takes a minute or two.</Empty>}
        {rows.map((r) => <PlaceRow key={r.id} p={{ ...placeWords(r), bytes: r.bytes }} max={max} />)}
        {rest > 0 && <PlaceRow p={{ name: "Everything else on this disk", note: restBiggest ? "Most of the space is here. The Files tab shows where: open a folder and press \"Measure the folders\"." : "The system, other programs and files that this page does not know", bytes: rest }} max={max} />}
      </div>
      <p className={k.note}>This page is read only: it stops nothing and removes nothing.</p>
    </section>
  );
}

type Tab = "health" | "files" | "clean-up";
// The tab that was open: the page opens on it again.
const tabSeen = viewMemory<Tab>(1);

function Tabs({ tab, set }: { tab: Tab; set: (t: Tab) => void }) {
  return (
    <div className={`${s.switch} ${s.tabs}`} role="group" aria-label="Part of the Server page">
      <button type="button" aria-pressed={tab === "health"} onClick={() => set("health")}>Health</button>
      <button type="button" aria-pressed={tab === "files"} onClick={() => set("files")}>Files</button>
      <button type="button" aria-pressed={tab === "clean-up"} onClick={() => set("clean-up")}>Clean-up</button>
    </div>
  );
}

export function ServerPage({ onBack, onOpenAgent, onOpenExplorer }: {
  onBack?: () => void; onOpenAgent: (id: string) => void;
  // "Open in the code explorer" on a file of the work folder: the folder to open, and the file.
  onOpenExplorer: (folder: string, file?: string) => void;
}) {
  const [tab, setTab] = useRemembered<Tab>(tabSeen, "tab", "health");
  const health = useHealth();
  const scroll = useScrollMemory<HTMLDivElement>("server");
  const { view, why } = health;
  const body = view ? (
    <>
      <Warnings view={view} />
      <Now view={view} />
      <OverTime view={view} />
      <Agents view={view} onOpenAgent={onOpenAgent} />
      <Top view={view} />
      <Places view={view} refresh={health.refresh} />
    </>
  ) : why === "needs-pairing" ? (
    <p className={s.lone} role="status">This page is for a paired device. Add this device in Settings, under Devices.</p>
  ) : why === "failed" ? (
    <p className={s.lone} role="status">Your server did not answer. The page tries again.</p>
  ) : null;

  if (onBack) {
    return (
      <div className={s.phonePage}>
        <PhoneHeader onBack={onBack} title="Server" sub={headline(view)} right={<Tabs tab={tab} set={setTab} />} />
        {tab === "files" ? <FilesTab phone onOpenExplorer={onOpenExplorer} />
          : tab === "clean-up" ? <CleanUpTab phone />
          : <div className={s.phoneScroll} ref={scroll.ref} onScroll={scroll.onScroll}><div className={`${k.phoneBody} ${s.phoneBody}`}>{body}</div></div>}
      </div>
    );
  }
  return (
    <div className={s.page}>
      <div className={s.head}>
        <h1 className={s.title}>Server</h1>
        {view && <Dot tone={view.level === "error" ? "err" : view.level === "warn" ? "warn" : "ok"} />}
        <span className={s.headLine}>{headline(view)}</span>
        <Tabs tab={tab} set={setTab} />
      </div>
      {tab === "files" ? <FilesTab phone={false} onOpenExplorer={onOpenExplorer} />
        : tab === "clean-up" ? <CleanUpTab phone={false} />
        : <div className={s.scroll} ref={scroll.ref} onScroll={scroll.onScroll}><div className={s.inner}>{body}</div></div>}
    </div>
  );
}
