// src/components/settings/LeadsSettings.tsx — the areas and their lead (GET /api/leads): the lead's
// avatar and state, its repos, "Edit repos", and "New lead" (an area name and its repos). Both go
// to POST /api/leads (USER only): it writes the area's repos, then starts its lead if it is not
// live. A press on a lead's avatar changes it (the next of lib/leadAvatar's variants; POST
// /api/leads/:area/avatar, USER only). There is no route that stops or removes a lead, so this
// section has neither.
"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchLeadsState, type LeadRow } from "../../lib/leads";
import { COORDINATOR_ID, coordinatorLine, coordinatorTone, fetchCoordinator, type CoordinatorView } from "../../lib/coordinator";
import { statusDot } from "../../lib/agentGroups";
import { AVATAR_VARIANTS, avatarVariant } from "../../lib/leadAvatar";
import { areaNameError, areaNameFrom, newLeadStart, leadsStatus, leadWord, sameRepos, saveLead, saveLeadAvatar, toggleRepo, type Read } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { LeadAvatar } from "../LeadAvatar";
import { PlusIcon } from "../SideIcons";
import { Block, cx as s, Dot, Empty, ErrorLine, Field, FieldGroup, Form, HowTo, Note, Row, StatusLine, type SectionProps } from "./kit";
import { useWorkspaceRepos } from "./ReposSettings";
import { USER_CLI } from "../../../server/brand";

const leadsSeen = viewMemory<Read<LeadRow>>(1);
const coordinatorSeen = viewMemory<CoordinatorView | null>(1);

// The Coordinator: the console's background agent. One quiet row: its state, its last activity
// and a look at its thread. It has no settings and no row in the sidebar.
function CoordinatorRow({ openAgent }: { openAgent?: (id: string) => void }) {
  const [view, setView] = useRemembered(coordinatorSeen, "coordinator", null);
  useEffect(() => {
    let live = true;
    const load = () => { void fetchCoordinator().then((v) => { if (live) setView(v); }).catch(() => {}); };
    load();
    const t = setInterval(load, 15_000);
    return () => { live = false; clearInterval(t); };
  }, [setView]);
  if (!view) return null;
  return (
    <div className={s.afterNotes}>
      <Block title="Coordinator">
        {/* Its own row class: on the phone the state goes under the name, in full. */}
        <div className={`${s.row} ${s.coordRow}`} title="The background agent of the console. It reads the events, the runs of the recurring tasks and the lead reports. It writes to you only through the Queue.">
          <Dot tone={coordinatorTone(view.state)} />
          <span className={s.rowName}>Coordinator</span>
          <span className={s.rowMeta}>{coordinatorLine(view)}</span>
          {openAgent && view.state !== "not-started" && (
            <button type="button" className={`${s.btn} ${s.quiet}`} onClick={() => openAgent(COORDINATOR_ID)}>Open its thread</button>
          )}
        </div>
      </Block>
    </div>
  );
}


// The repo chips of a form: every workspace repo, plus any the area lists that the workspace has not.
function RepoPicker({ all, picked, onChange, disabled }: { all: string[]; picked: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const shown = [...all, ...picked.filter((r) => !all.includes(r))];
  if (shown.length === 0) return <p className={s.note}>No repos in the workspace yet: add one in Repos first.</p>;
  return (
    <div className={s.chips}>
      {shown.map((r) => (
        <button key={r} type="button" className={s.chip} aria-pressed={picked.includes(r)} disabled={disabled}
          onClick={() => onChange(toggleRepo(picked, r, all))}>{r}</button>
      ))}
    </div>
  );
}

export function LeadsSettings({ go, openAgent }: SectionProps) {
  const [read, setRead] = useRemembered(leadsSeen, "leads", null);
  const [repoRead] = useWorkspaceRepos();
  const allRepos = repoRead && "rows" in repoRead ? repoRead.rows.map((r) => r.name) : [];
  const load = useCallback(async () => {
    try {
      const { rows, missing } = await fetchLeadsState();
      setRead(missing ? { off: true } : { rows });
    } catch (e) {
      const text = e instanceof Error && /503/.test(e.message) ? `the chief is misconfigured (see \`${USER_CLI} doctor\`)` : "the console did not answer";
      setRead((p) => (p && "rows" in p ? p : { error: text }));
    }
  }, [setRead]);
  useEffect(() => { void load(); }, [load]);

  const rows = read && "rows" in read ? read.rows : [];
  const off = !!read && "off" in read;
  // One form at a time: the new lead, or the repos of one area.
  const [form, setForm] = useState<{ kind: "new" } | { kind: "edit"; area: string } | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  // The name of a new lead follows its first repo until the user types a name.
  const [typed, setTyped] = useState(false);
  const open = (next: typeof form, repos: string[] = []) => { setForm(next); setPicked(repos); setName(""); setTyped(false); setErr(""); setDone(""); };
  // "New lead": the form is filled in (the first repo with no lead, and the name from it).
  const openNew = () => {
    const start = newLeadStart(allRepos, rows);
    open({ kind: "new" }, start.repos);
    setName(start.name);
  };
  // The form opened before the repo list came: fill it in when the list is there.
  useEffect(() => {
    if (form?.kind !== "new" || typed || name !== "" || picked.length > 0 || allRepos.length === 0) return;
    const start = newLeadStart(allRepos, rows);
    setPicked(start.repos);
    setName(start.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, allRepos.length]);
  const pickRepos = (next: string[]) => {
    setPicked(next);
    if (form?.kind === "new" && !typed) setName(next.length ? areaNameFrom(next[0], rows.map((l) => l.area)) : "");
  };
  const close = () => { setForm(null); setErr(""); };

  const submit = async () => {
    if (!form || busy) return;
    const area = form.kind === "new" ? name.trim() : form.area;
    if (form.kind === "new") {
      const bad = areaNameError(area, rows.map((l) => l.area));
      if (bad) { setErr(bad); return; }
      if (picked.length === 0) { setErr("Pick at least one repo: a lead spawns workers only in its repos"); return; }
    }
    setBusy(true); setErr("");
    const r = await saveLead(area, picked);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setForm(null);
    await load();
    setDone(form.kind === "new" ? `Lead ${area} is starting. Its row in the sidebar opens it.` : `Saved the repos of ${area}.`);
  };

  // A press on an avatar: the next variant, shown at once, then saved. A refusal puts the old one back.
  const nextAvatar = async (l: LeadRow) => {
    const next = (avatarVariant(l.avatar) + 1) % AVATAR_VARIANTS;
    const put = (v: number) => setRead((p) => (p && "rows" in p ? { rows: p.rows.map((r) => (r.area === l.area ? { ...r, avatar: v } : r)) } : p));
    put(next); setErr(""); setDone("");
    const r = await saveLeadAvatar(l.area, next);
    if (!r.ok) { put(avatarVariant(l.avatar)); setErr(r.error); return; }
    await load();
  };

  const editRow = (l: LeadRow) => form?.kind === "edit" && form.area === l.area;

  return (
    <>
      <StatusLine status={leadsStatus(read)} />
      {off ? (
        <>
          <Note>A lead runs one area of your work: its repos and their workers. Leads are part of the chief of staff, which is off on this console.</Note>
          <HowTo title="How to turn leads on">
            <p>In the console&apos;s <code>.env</code> file set <code>CHIEF_ENABLED=1</code> and <code>CHIEF_CONSOLE_URL</code> (the address you open the console at), then restart the console. <code>{USER_CLI} doctor</code> checks the set-up.</p>
          </HowTo>
        </>
      ) : (
        <>
          <Block title="Areas" right={form?.kind !== "new" && (
            <button type="button" className={s.btn} disabled={read === null || (!!read && "error" in read)} onClick={openNew}>
              <PlusIcon size={14} />New lead
            </button>
          )}>
            {rows.length === 0 && form?.kind !== "new" && <Empty>{read === null ? "Reading the leads…" : "No areas yet. A lead runs one area: its repos and their workers."}</Empty>}
            {rows.map((l) => (
              <Fragment key={l.area}>
                <Row title={l.leadId ?? undefined}>
                  <button type="button" className={s.avatarBtn} onClick={() => void nextAvatar(l)}
                    title="Change avatar" aria-label={`Change the avatar of ${l.area}`}>
                    <LeadAvatar area={l.area} variant={avatarVariant(l.avatar)} size={24} status={{ ...statusDot(l.waits ? "" : l.status ?? ""), word: leadWord(l.status, l.waits) }} />
                  </button>
                  <span className={s.rowName}>{l.area}</span>
                  <span className={s.rowMeta}>{l.repos.length ? l.repos.join(", ") : "no repos"}</span>
                  <span className={s.tag}>{leadWord(l.status, l.waits)}</span>
                  {!editRow(l) && (
                    <button type="button" className={`${s.btn} ${s.quiet}`} onClick={() => open({ kind: "edit", area: l.area }, l.repos)}
                      aria-label={`Edit the repos of ${l.area}`}>Edit repos</button>
                  )}
                </Row>
                {editRow(l) && (
                  <Form label={`Repos of ${l.area}`} onSubmit={() => void submit()}>
                    <FieldGroup label={`Repos of ${l.area}`}>
                      <RepoPicker all={allRepos} picked={picked} onChange={setPicked} disabled={busy} />
                    </FieldGroup>
                    {l.waits ? <Note>This lead starts after &ldquo;Sign in for your assistant&rdquo; on the Set-up page.</Note>
                      : l.status !== "running" && l.status !== "idle" && <Note>Save also starts this lead: it is not live now.</Note>}
                    <div className={s.actions}>
                      <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || sameRepos(picked, l.repos)}>{busy ? "Saving…" : "Save"}</button>
                      <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={close}>Cancel</button>
                    </div>
                  </Form>
                )}
              </Fragment>
            ))}
            {form?.kind === "new" && (
              <Form label="New lead" onSubmit={() => void submit()}>
                <Field label="Area name">
                  <input className={s.input} value={name} autoFocus disabled={busy} placeholder="app"
                    onChange={(e) => { setName(e.target.value); setTyped(true); }} onKeyDown={(e) => { if (e.key === "Escape") close(); }} />
                </Field>
                <FieldGroup label="Repos">
                  <RepoPicker all={allRepos} picked={picked} onChange={pickRepos} disabled={busy} />
                </FieldGroup>
                <Note>The lead starts at once in its own terminal. It spawns workers only in these repos.</Note>
                <div className={s.actions}>
                  <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || !name.trim() || picked.length === 0}>{busy ? "Starting…" : "Start lead"}</button>
                  <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={close}>Cancel</button>
                </div>
              </Form>
            )}
          </Block>
          <ErrorLine text={err} />
          {done && <Note>{done}</Note>}
          {rows.length > 0 && <Note>Each lead has its own avatar, made from its area name. Press an avatar to change it.</Note>}
          <Note>You cannot stop or remove a lead here yet. Missing a repo? <button type="button" className={`${s.btn} ${s.link}`} onClick={() => go("repos")}>Add it in Repos</button>.</Note>
          <CoordinatorRow openAgent={openAgent} />
        </>
      )}
    </>
  );
}
