// src/components/settings/ModelSettings.tsx — Settings > Model (server/settings/model.ts): the
// model of a new agent. A task can ask for another one (`agents spawn` "model"). A save applies
// at the next start or resume of an agent, with no restart.
"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchModelSetting, saveModel, type ModelSetting } from "../../lib/model";
import { LOADING, type SectionStatus } from "../../lib/settings";
import { cx as s, ErrorLine, Field, Form, StatusLine, type SectionProps } from "./kit";

type Read = ModelSetting | { error: string } | null;
const NAMES: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const nameOf = (m: string): string => NAMES[m] ?? m;

export function modelStatus(r: Read): SectionStatus {
  if (!r) return LOADING;
  if ("error" in r) return { tone: "err", text: `Cannot read the setting: ${r.error}` };
  if (r.wrong) return { tone: "warn", text: `"${r.wrong}" is not a model: new agents use ${nameOf(r.model)}` };
  return { tone: "ok", text: `New agents use ${nameOf(r.model)}` };
}

export function ModelSettings(_: SectionProps) {
  const [read, setRead] = useState<Read>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetchModelSetting();
      setRead(r);
      setValue(r.model);
    } catch {
      setRead((p) => (p && !("error" in p) ? p : { error: "the console did not answer" }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const st = read && !("error" in read) ? read : null;

  const save = async () => {
    setBusy(true); setError(""); setDone("");
    const r = await saveModel(value);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setDone("Saved.");
    await load();
  };

  return (
    <>
      <StatusLine status={modelStatus(read)} />
      <Form label="Model" onSubmit={() => void save()}>
        <Field label="Model">
          <select className={s.input} value={value} disabled={busy || !st?.canSave} onChange={(e) => setValue(e.target.value)}>
            {(st?.choices ?? []).map((m) => <option key={m} value={m}>{nameOf(m)}</option>)}
          </select>
          <span className={s.help}>The model of a new agent. A task can ask for another one.</span>
        </Field>
        <div className={s.actions}>
          <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || !st?.canSave || !value || (value === st?.model && !st?.wrong)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <ErrorLine text={error || (st && !st.canSave && st.why ? st.why : "")} />
        {done && <p className={s.note} role="status">{done}</p>}
      </Form>
    </>
  );
}
