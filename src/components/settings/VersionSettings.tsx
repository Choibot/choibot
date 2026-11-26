// src/components/settings/VersionSettings.tsx — the Settings section "Version": which version
// this console runs (GET /api/version), how it was installed, and how new code comes. Read only.
"use client";
import { useEffect, useState } from "react";
import { INSTALL_WORDS, NEW_CODE_WORDS, builtWords, fetchUpdateView, fetchVersion, shortCommit, updateWords, versionStatus, type UpdateView, type VersionRead } from "../../lib/version";
import { Block, cx as s, Note, Row, StatusLine, type SectionProps } from "./kit";

export function VersionSettings(_: SectionProps) {
  const [read, setRead] = useState<VersionRead>(null);
  const [update, setUpdate] = useState<UpdateView | null>(null);
  useEffect(() => { void fetchVersion().then(setRead); void fetchUpdateView().then(setUpdate); }, []);
  const v = read && !("error" in read) ? read : null;
  const built = builtWords(v?.builtAt ?? null);
  // Root's updater (a hosted console): one line, in place of "how new code comes".
  const updates = updateWords(update, Date.now());

  return (
    <>
      <StatusLine status={versionStatus(read)} />
      {v && (
        <>
          <Block title="This console">
            {v.version !== null && (
              <Row>
                <span className={s.rowName}>Version</span>
                <span className={s.rowMeta}>{v.version}</span>
              </Row>
            )}
            <Row title={v.commit ?? undefined}>
              <span className={s.rowName}>Commit</span>
              <span className={s.rowMeta}>{v.commit ? shortCommit(v.commit) : "Not known"}</span>
            </Row>
            <Row>
              <span className={s.rowName}>Installed from</span>
              <span className={s.rowMeta}>{INSTALL_WORDS[v.kind]}</span>
            </Row>
            {built && (
              <Row>
                <span className={s.rowName}>Built</span>
                <span className={s.rowMeta}>{built}</span>
              </Row>
            )}
          </Block>
          {updates ? <Note>{updates}</Note> : <Note>{NEW_CODE_WORDS[v.kind]}</Note>}
        </>
      )}
    </>
  );
}
