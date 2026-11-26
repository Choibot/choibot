// Telegram cards for rules and brain proposals, and the cards.json index that
// maps a posted message id back to what the card shows. Texts go out as plain
// text: the 1a client sends no parse_mode, so rule and model text needs no
// escaping.
import { createHash } from "node:crypto";
import { clip, TG_TEXT_MAX, type InlineButton, type InlineKeyboard } from "../issues/telegram";
import type { Proposal } from "./brain/distill";
import type { Rule } from "./brain/store";
import { readJson, updateJson } from "./files";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function ruleCardText(rule: Rule): string {
  const head = rule.state === "candidate" ? "New rule" : "Rule";
  const s = rule.scope;
  const scope = [s.area, s.repo, s.kind].filter((x): x is string => !!x).concat(s.audience ?? "all").join(" · ");
  return clip(`${head}: "${rule.text}"\nScope: ${scope}`);
}

export function ruleCardKeyboard(rule: Rule): InlineKeyboard {
  const row: InlineButton[] = [{ text: "Confirm", callback_data: `q:k:${rule.id}` }];
  if (rule.state === "candidate") row.push({ text: "Discard", callback_data: `q:d:${rule.id}` });
  return { inline_keyboard: [row] };
}

const RETIRE_BUDGET = 1500;
const RETIRE_LINE_MAX = 240;
const CLIPPED_NOTE = "\n(clipped — open Diff in the console for the full text)";

export function proposalCardText(p: Proposal): string {
  const lines: string[] = [];
  let used = 0;
  for (const r of p.retire) {
    const line = clip(`retire ${r.id} "${r.text}" — ${r.why}`, RETIRE_LINE_MAX);
    if (used + line.length + 1 > RETIRE_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = p.retire.length - lines.length;
  if (more > 0) lines.push(`+${more} more to retire`);
  // BRAIN_MAX plus the retire lines can pass TG_TEXT_MAX: a cut card says so.
  const text = ["Brain proposal", ...lines, "", p.text].join("\n");
  return text.length <= TG_TEXT_MAX ? text : clip(text, TG_TEXT_MAX - CLIPPED_NOTE.length) + CLIPPED_NOTE;
}

export function proposalKeyboard(consoleUrl: string): InlineKeyboard {
  const row: InlineButton[] = [
    { text: "Apply", callback_data: "q:p:brain" },
    { text: "Discard", callback_data: "q:q:brain" },
  ];
  try {
    const u = new URL(consoleUrl);
    if (u.protocol === "https:") row.push({ text: "Diff", url: `${u.origin}${u.pathname.replace(/\/+$/, "")}/#brain=diff` });
  } catch { /* not a URL: no Diff button */ }
  return { inline_keyboard: [row] };
}

export type CardEntry = (
  | { kind: "rule"; ruleId: string; textSha256: string }
  | { kind: "brain"; proposalSha256: string }
  | { kind: "item"; itemId: string }
) & { at: number };

type Stored = { ruleId: string; textSha256: string; at: number } | { brain: string; at: number };

function fromStored(v: unknown): CardEntry | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  if (typeof o.ruleId === "string" && typeof o.textSha256 === "string") return { kind: "rule", ruleId: o.ruleId, textSha256: o.textSha256, at: o.at };
  if (typeof o.brain === "string") return { kind: "brain", proposalSha256: o.brain, at: o.at };
  return null;
}

export class CardIndex {
  private entries = new Map<number, CardEntry>();
  constructor(private readonly cardsFile: string) {}

  async load(extra: { messageId: number; itemId: string }[] = []): Promise<void> {
    const next = new Map<number, CardEntry>();
    try {
      const raw = await readJson<unknown>(this.cardsFile);
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          const id = Number(k);
          const e = fromStored(v);
          if (Number.isInteger(id) && e) next.set(id, e);
        }
      }
    } catch (err) {
      console.warn("[chief] cards.json unreadable, starting empty:", err);
    }
    for (const x of extra) next.set(x.messageId, { kind: "item", itemId: x.itemId, at: 0 });
    this.entries = next;
  }

  lookup(messageId: number): CardEntry | undefined {
    return this.entries.get(messageId);
  }

  private async record(messageId: number, stored: Stored, entry: CardEntry): Promise<void> {
    await updateJson<Record<string, Stored>>(this.cardsFile, {}, (cur) => ({ ...cur, [String(messageId)]: stored }));
    this.entries.set(messageId, entry);
  }

  recordRule(messageId: number, rule: Rule): Promise<void> {
    const at = Date.now();
    const textSha256 = sha256Hex(rule.text);
    return this.record(messageId, { ruleId: rule.id, textSha256, at }, { kind: "rule", ruleId: rule.id, textSha256, at });
  }

  recordProposal(messageId: number, p: Proposal): Promise<void> {
    const at = Date.now();
    return this.record(messageId, { brain: p.sha256, at }, { kind: "brain", proposalSha256: p.sha256, at });
  }

  addItem(messageId: number, itemId: string): void {
    this.entries.set(messageId, { kind: "item", itemId, at: Date.now() });
  }
}
