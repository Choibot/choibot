// src/components/settings/ReposSettings.tsx — the repos in the workspace (GET /api/repos) and "Add
// repo": clone a git URL or make a new empty repo (POST /api/repos; with chief on, the paired user
// only). The flow the New agent dialog had; the dialog keeps a "Manage repos" link to here.
"use client";
import { useCallback, useEffect, useState } from "react";
import { addRepo, fetchRepos, type RepoInfo } from "../../lib/agents";
import { reposStatus, type Read } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { PlusIcon } from "../SideIcons";
import { Block, cx as s, Empty, ErrorLine, Field, Form, Note, Row, StatusLine, type SectionProps } from "./kit";

// The list seen last (lib/viewCache): the page opens on it and reads again.
const reposSeen = viewMemory<Read<RepoInfo>>(1);
let inflight: Promise<Read<RepoInfo>> | null = null;
const readRepos = (): Promise<Read<RepoInfo>> => {
  inflight ??= fetchRepos()
    .then((r): Read<RepoInfo> => ({ rows: r.repos }), (): Read<RepoInfo> => ({ error: "the console did not answer" }))
    .finally(() => { inflight = null; });
  return inflight;
};

// The workspace repos, shared by this section and the Leads section's repo picker. A failed read
// keeps the list seen before.
export function useWorkspaceRepos(): [Read<RepoInfo>, () => Promise<void>] {
  const [read, setRead] = useRemembered(reposSeen, "repos", null);
  const load = useCallback(async () => {
    const next = await readRepos();
    setRead((prev) => (next && "error" in next && prev && "rows" in prev ? prev : next));
  }, [setRead]);
  useEffect(() => { void load(); }, [load]);
  return [read, load];
}

// A value that looks like a clone target (URL, scp style, path): clone; else a new empty repo.
const looksLikeUrl = (v: string): boolean => /:\/\/|@|:|\//.test(v);

export function ReposSettings(_: SectionProps) {
  const [read, reload] = useWorkspaceRepos();
  const rows = read && "rows" in read ? read.rows : [];
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [added, setAdded] = useState("");

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true); setErr(""); setAdded("");
    const r = await addRepo(looksLikeUrl(v) ? { url: v } : { name: v }).catch(() => ({ ok: false as const, error: "The console did not answer", repo: undefined }));
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "failed"); return; }
    setValue(""); setAdding(false);
    await reload();
    setAdded(r.repo?.name ?? v);
  };
  const cancel = () => { setAdding(false); setErr(""); setValue(""); };

  return (
    <>
      <StatusLine status={reposStatus(read)} />
      <Block title="Workspace repos" right={!adding && (
        <button type="button" className={s.btn} onClick={() => { setAdding(true); setAdded(""); }}><PlusIcon size={14} />Add repo</button>
      )}>
        {rows.length === 0 && <Empty>{read === null ? "Reading the workspace…" : "No repos yet."}</Empty>}
        {rows.map((r) => (
          <Row key={r.path} title={r.path}>
            <span className={s.rowName}>{r.name}</span>
            <span className={`${s.rowMeta} ${s.mono}`}>{r.path}</span>
            <span className={s.tag}>{r.branch}</span>
          </Row>
        ))}
        {adding && (
          <Form label="Add repo" onSubmit={() => void submit()}>
            <Field label="Git URL to clone, or a name for a new empty repo">
              <input className={s.input} value={value} autoFocus disabled={busy} placeholder="https://github.com/owner/repo.git"
                onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") cancel(); }} />
            </Field>
            <div className={s.actions}>
              <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || !value.trim()}>
                {busy ? (looksLikeUrl(value.trim()) ? "Cloning…" : "Creating…") : "Add repo"}
              </button>
              <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={cancel}>Cancel</button>
            </div>
          </Form>
        )}
      </Block>
      <ErrorLine text={err} />
      {added && <Note>Added {added}. New agents and leads can use it now.</Note>}
      <Note>A repo is a folder in the workspace. A URL clones it there; a plain name makes a new empty repo.</Note>
    </>
  );
}
