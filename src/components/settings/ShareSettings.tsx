// src/components/settings/ShareSettings.tsx — Settings, "Share outside" (server/settings/share.ts):
// the share tool that "Share outside" on a ticket runs. Off until the user sets one: then a ticket
// can only be downloaded. A save checks the program first (one check of a test page; nothing is
// shared) and applies at once. The contract is in the fold for the person who writes a tool.
"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchShareSetting, saveShareTool, type ShareSetting } from "../../lib/share";
import { LOADING, type SectionStatus } from "../../lib/settings";
import { Block, cx as s, ErrorLine, Field, Form, HowTo, Note, Row, StatusLine, type SectionProps } from "./kit";

type Read = ShareSetting | { error: string } | null;

export function shareStatus(r: Read): SectionStatus {
  if (!r) return LOADING;
  if ("error" in r) return { tone: "err", text: `Cannot read the setting: ${r.error}` };
  if (!r.tool) return { tone: "off", text: "Off: a ticket can only be downloaded" };
  if (r.problem) return { tone: "warn", text: `The share tool cannot run: ${r.problem}` };
  return { tone: "ok", text: "On: a ticket can be shared with a link and a password" };
}

export function ShareSettings(_: SectionProps) {
  const [read, setRead] = useState<Read>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetchShareSetting();
      setRead(r);
      setValue(r.tool ?? "");
    } catch {
      setRead((p) => (p && !("error" in p) ? p : { error: "the console did not answer" }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const st = read && !("error" in read) ? read : null;

  const save = async (tool: string | null) => {
    setBusy(true); setError(""); setDone("");
    const r = await saveShareTool(tool);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setDone(tool ? "Saved. The program answered as a share tool." : "Turned off.");
    await load();
  };

  return (
    <>
      <StatusLine status={shareStatus(read)} />
      <Block title="Share tool">
        <Row>
          <span className={s.rowName}>Program</span>
          <span className={s.rowMeta}>{st?.tool ?? "Not set"}</span>
        </Row>
      </Block>
      <Form label="Share tool" onSubmit={() => void save(value.trim() || null)}>
        <Field label="The full path of the program on your server">
          <input
            className={s.input} value={value} disabled={busy || !st?.canSave} type="text" autoComplete="off" spellCheck={false}
            placeholder="/home/you/bin/share-tool" onChange={(e) => setValue(e.target.value)}
          />
          <span className={s.help}>A save runs the program once on a small test page, to check it. Nothing is shared then.</span>
        </Field>
        <div className={s.actions}>
          <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || !st?.canSave || !value.trim() || value.trim() === st?.tool}>
            {busy ? "Checking…" : "Save"}
          </button>
          {st?.tool && <button type="button" className={`${s.btn} ${s.quiet}`} disabled={busy} onClick={() => void save(null)}>Turn off</button>}
        </div>
        <ErrorLine text={error || (st && !st.canSave && st.why ? st.why : "")} />
        {done && <p className={s.note} role="status">{done}</p>}
      </Form>
      <Note>
        Nothing goes out by itself. A page goes out only when you press Share outside on a ticket and confirm. Each page gets a
        password, and you get one link with the password in it. Agents cannot share a page.
      </Note>
      <HowTo title="What a share tool must do">
        <p>The console runs the program with these arguments, never through a shell, with a time limit and only the basic settings of your server (no keys):</p>
        <ul>
          <li><code>scan FILE.html</code>: print one line <code>BLOCKED text</code> or <code>warning text</code> for each thing that can be private. Exit 0, or 1 when it found something.</li>
          <li><code>add FILE.html</code> (and <code>--allow-sensitive</code> when you said yes to each hit): put the page online behind a password. Print <code>link: https://…</code>, and if it can, <code>one-tap: https://…#…</code> (the same address with the password after #) and <code>password: …</code>.</li>
          <li><code>remove ID</code>: take the page down. ID is the last part of the link. Exit 0 when it is gone.</li>
        </ul>
        <p>The console keeps the link and the ID, never the password. Other lines of the program are not shown.</p>
      </HowTo>
    </>
  );
}
