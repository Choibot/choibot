// src/components/settings/RulesSettings.tsx — the Settings section "Rules" (pick A "Quiet rules",
// 2026-11-19): the active rules, which every agent gets in its prompt when it starts, each one
// sentence with Edit and Remove (a second press confirms), and one "Add a rule" field. No
// candidates here: a new rule comes to the Queue first, as one "Make this a rule?" item. Rule
// text is untrusted (agent output can reach it): plain text only.
"use client";
import { useCallback, useEffect, useState } from "react";
import { addRule, editRule, readActiveRules, removeRule, rulesStatus, scopeLabel, type ActionResult, type RuleRow } from "../../lib/brain";
import type { Read } from "../../lib/settings";
import { useRemembered, viewMemory } from "../../lib/viewCache";
import { PlusIcon } from "../SideIcons";
import { Block, cx as s, Empty, ErrorLine, Form, Note, Row, StatusLine, type SectionProps } from "./kit";
import b from "./Brain.module.css";

const seen = viewMemory<Read<RuleRow>>(1);
const RULE_MAX = 200; // = server/chief/brain/store.ts RULE_TEXT_MAX

export function RulesSettings({ phone }: SectionProps) {
  const [read, setRead] = useRemembered<Read<RuleRow>>(seen, "rules", null);
  // A failed read keeps the rows the section showed.
  const load = useCallback(async () => {
    const next = await readActiveRules();
    setRead((p) => (next && "error" in next && p && "rows" in p ? p : next));
  }, [setRead]);
  useEffect(() => { void load(); }, [load]);

  const rows = read && "rows" in read ? read.rows : [];
  const off = read !== null && "off" in read;
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const act = async (p: Promise<ActionResult>, done: () => void) => {
    setBusy(true); setErr("");
    const r = await p;
    setBusy(false);
    if (r.ok) done(); else setErr(r.error);
    await load();
  };
  const save = () => { if (editing?.text.trim()) void act(editRule(editing.id, editing.text.trim()), () => setEditing(null)); };
  const add = () => { if (draft.trim()) void act(addRule(draft.trim()), () => setDraft("")); };

  return (
    <>
      <StatusLine status={rulesStatus(read)} />
      {!off && (
        <Block title="Active rules">
          {rows.length === 0 && <Empty>{read === null ? "Reading the rules…" : "No rules yet. Add one below."}</Empty>}
          {rows.map((x) => {
            const who = scopeLabel(x.scope);
            if (editing?.id === x.id) {
              return (
                <Row key={x.id}>
                  <form className={b.edit} aria-label="Edit the rule" onSubmit={(e) => { e.preventDefault(); save(); }}>
                    <input className={`${s.input} ${b.grow}`} value={editing.text} maxLength={RULE_MAX} autoFocus disabled={busy} aria-label="Rule text"
                      onChange={(e) => setEditing({ id: x.id, text: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
                    <button type="submit" className={`${s.btn} ${s.primary} ${b.small}`} disabled={busy || !editing.text.trim()}>Save</button>
                    <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                </Row>
              );
            }
            const tail = (
              <>
                {who && <span className={s.tag}>{who}</span>}
                {removing === x.id ? (
                  <span className={b.act}>
                    <span className={b.ask}>Remove?</span>
                    <button type="button" className={`${s.btn} ${b.small}`} disabled={busy}
                      onClick={() => void act(removeRule(x.id), () => setRemoving(null))}>Yes</button>
                    <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy} onClick={() => setRemoving(null)}>No</button>
                  </span>
                ) : (
                  <span className={b.act} data-idle>
                    <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy}
                      onClick={() => { setRemoving(null); setEditing({ id: x.id, text: x.text }); }}>Edit</button>
                    <button type="button" className={`${s.btn} ${s.quiet} ${b.small}`} disabled={busy}
                      onClick={() => { setEditing(null); setRemoving(x.id); }}>Remove</button>
                  </span>
                )}
              </>
            );
            // A phone row puts the tag and the buttons under the sentence, so the sentence keeps its width.
            return (
              <Row key={x.id}>
                {phone
                  ? <div className={b.stack}><span className={b.text}>{x.text}</span><div className={b.under}>{tail}</div></div>
                  : <><span className={b.text}>{x.text}</span>{tail}</>}
              </Row>
            );
          })}
          <Form label="Add a rule" onSubmit={add}>
            <div className={b.add}>
              <input className={`${s.input} ${b.grow}`} value={draft} maxLength={RULE_MAX} disabled={busy} aria-label="New rule"
                placeholder={phone ? "Add a rule" : "Add a rule: one short sentence, e.g. Always run the tests before a PR"} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className={`${s.btn} ${s.primary}`} disabled={busy || !draft.trim()}><PlusIcon size={14} />Add</button>
            </div>
          </Form>
        </Block>
      )}
      <ErrorLine text={err} />
      <Note>
        A rule you tell the fleet master, or a line that starts with <code>rule:</code>, comes to the Queue first as
        &quot;Make this a rule?&quot;. One answer alone never becomes a rule.
      </Note>
    </>
  );
}
