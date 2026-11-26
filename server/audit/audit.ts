// server/audit/audit.ts — one clean-up audit at a time, on the user's press only: the scan
// (./scan.ts, code), then the AI step for the words (./ai.ts). The last result is kept with its
// time, also over a restart (a file in the console's own data folder). An audit removes nothing
// and changes nothing. The user can then remove ONE thing of the list with a press and a confirm
// (./remove.ts): the server takes the path from its own table and checks every rule again.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GuideModel } from "../guide/model.js";
import { aiStateOf, AUDIT_SYSTEM, mergeAnswer, tableFor, type AiState } from "./ai.js";
import { removeCandidate, type RemoveDeps } from "./remove.js";
import { scan, type Candidate, type ScanDeps } from "./scan.js";
import { rowOf, type Row } from "./words.js";

// The scan stops after this time and says that it is not complete.
export const SCAN_LIMIT_MS = 8 * 60_000;
// A result older than this is marked old, and nothing of it can be removed.
export const OLD_AFTER_MS = 24 * 60 * 60_000;

export type AuditResult = {
  checkedAt: number;
  rows: Row[];
  // The scan stopped at its time limit: the list is not complete.
  partial: boolean;
  // The AI step: "ok", or why the words are the fixed ones.
  ai: AiState;
};

export type AuditView = {
  state: "none" | "running" | "done";
  startedAt?: number;
  // The id of the row that is removed now.
  removing?: string;
  // Why the last removal did not happen (plain words), with its row.
  refused?: { id: string; text: string };
  // rows: the ones that are still there. freedBytes, freedCount: what the user removed from this result.
  result?: AuditResult & { old: boolean; safeBytes: number; checkBytes: number; freedBytes: number; freedCount: number };
};

type Kept = AuditResult & { candidates: Candidate[] };

export type AuditDeps = Omit<ScanDeps, "now" | "deadline"> & Pick<RemoveDeps, "deleteAgent" | "removeWorktree" | "rm"> & {
  // The places where a disk is mounted, read at each removal.
  mounts: () => string[];
};

export class Audit {
  private running: { startedAt: number } | null = null;
  private removing: string | null = null;
  private refused: { id: string; text: string } | null = null;
  private kept: Kept | null = null;
  private loaded = false;

  constructor(private readonly d: {
    // The inputs of one scan or one removal, read when it starts (the agents change).
    deps: () => Promise<AuditDeps>;
    // The model with no tool. Absent: no AI step.
    model?: GuideModel;
    // Where the last result is kept (with the server's own table of paths).
    file: string;
    now?: () => number;
    log?: (s: string) => void;
  }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  private log(s: string): void { (this.d.log ?? console.warn)(s); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const r = JSON.parse(await readFile(this.d.file, "utf8")) as Kept;
      if (typeof r.checkedAt === "number" && Array.isArray(r.rows) && Array.isArray(r.candidates)) this.kept = r;
    } catch { /* no result yet */ }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.d.file), { recursive: true, mode: 0o700 });
      await writeFile(`${this.d.file}.tmp`, JSON.stringify(this.kept), { mode: 0o600 });
      await rename(`${this.d.file}.tmp`, this.d.file);
    } catch { /* the result is still in memory */ }
  }

  async view(): Promise<AuditView> {
    await this.load();
    const k = this.kept;
    const left = k ? k.rows.filter((r) => !r.removed) : [];
    const gone = k ? k.rows.filter((r) => r.removed) : [];
    const sum = (rows: Row[]) => rows.reduce((n, x) => n + x.bytes, 0);
    return {
      state: this.running ? "running" : k ? "done" : "none",
      ...(this.running ? { startedAt: this.running.startedAt } : {}),
      ...(this.removing ? { removing: this.removing } : {}),
      ...(this.refused ? { refused: this.refused } : {}),
      // The server's table of paths stays on the server. A removed row is not in the list.
      ...(k ? { result: {
        checkedAt: k.checkedAt, rows: left, partial: k.partial, ai: k.ai, old: this.now() - k.checkedAt > OLD_AFTER_MS,
        safeBytes: sum(left.filter((r) => r.group === "safe")), checkBytes: sum(left.filter((r) => r.group === "check")),
        freedBytes: sum(gone), freedCount: gone.length,
      } } : {}),
    };
  }

  /** Starts an audit unless one runs. The promise ends when the audit ends. */
  start(): { started: boolean; done: Promise<void> } {
    if (this.running || this.removing) return { started: false, done: Promise.resolve() };
    this.running = { startedAt: this.now() };
    this.refused = null;
    const done = this.run().catch((e) => {
      this.log(`[audit] the audit did not end: ${e instanceof Error ? e.name : "error"}`);
    }).finally(() => { this.running = null; });
    return { started: true, done };
  }

  private async run(): Promise<void> {
    await this.load();
    const now = this.now();
    const found = await scan({ ...(await this.d.deps()), now, deadline: Date.now() + SCAN_LIMIT_MS });
    const fixed = found.candidates.map(rowOf);
    const { rows, ai } = await this.words(found.candidates, fixed);
    this.kept = { checkedAt: this.now(), rows, partial: found.partial, ai, candidates: found.candidates };
    await this.save();
  }

  private async words(candidates: Candidate[], fixed: Row[]): Promise<{ rows: Row[]; ai: AiState }> {
    if (!this.d.model || candidates.length === 0) return { rows: fixed, ai: this.d.model ? "ok" : "none" };
    const answer = await this.d.model({ system: AUDIT_SYSTEM, input: tableFor(candidates) });
    if (!answer.ok) return { rows: fixed, ai: aiStateOf(answer) };
    const merged = mergeAnswer(fixed, new Map(candidates.map((c) => [c.id, c.floor])), answer.text);
    if (merged.dropped) this.log(`[audit] ${merged.dropped} row(s) of the model were not in the server's table: dropped`);
    // An answer with no usable row counts as no answer.
    return { rows: merged.rows, ai: merged.used > 0 ? "ok" : "down" };
  }

  // One removal: the server's own candidate, every rule checked again (./remove.ts). The answer
  // is null, or why the thing was not removed.
  private async removeOne(row: Row, cand: Candidate): Promise<string | null> {
    this.removing = row.id;
    try {
      const d = await this.d.deps();
      const r = await removeCandidate(cand, {
        wide: d.wide, workDir: d.workDir, checkout: d.checkout, uid: d.uid, agents: d.agents, mounts: d.mounts(), measure: d.measure,
        measureChildren: d.measureChildren, marks: d.marks, inUse: d.inUse, livePid: d.livePid, git: d.git, deleteAgent: d.deleteAgent, removeWorktree: d.removeWorktree, rm: d.rm, minBytes: d.minBytes, now: this.now(),
      });
      if (!r.ok) return r.text;
      row.removed = this.now();
      row.bytes = r.bytes; // the space that really came back
      // One line per removal: the kind, the size, the file system; the path only when it is in
      // the work folder or in a temp folder.
      const named = [d.workDir, ...d.tmpDirs].some((dir) => cand.path === dir || cand.path.startsWith(`${dir}/`));
      this.log(`[audit] removed on the user's press: ${cand.kind}, ${Math.round(r.bytes / (1024 * 1024))} MB, device ${r.dev}${named ? `, ${cand.path}` : ""}`);
      await this.save();
      return null;
    } catch {
      return "It could not be removed.";
    }
  }

  /**
   * Removes the thing of one row of the last result, or (`all`) every row of the "safe" group,
   * one after the other, until one is refused. `id` and `checkedAt` come from the browser: the
   * row must be of the result that the user sees. One removal at a time; none while an audit
   * runs; none from an old result; never a row that the page may not remove. `done` ends when
   * the removal ends.
   */
  async remove(o: { id?: unknown; all?: unknown; checkedAt?: unknown }): Promise<{ started: true; done: Promise<void> } | { started: false; text: string }> {
    await this.load();
    const no = (text: string) => ({ started: false as const, text });
    if (this.running) return no("An audit runs now. Wait for its result.");
    if (this.removing) return no("Another thing is removed now. Wait a moment.");
    const k = this.kept;
    if (!k || o.checkedAt !== k.checkedAt) return no("The list changed. Read it again.");
    if (this.now() - k.checkedAt > OLD_AFTER_MS) return no("This result is old. Run the audit again.");
    const can = (r: Row) => !r.removed && !r.noRemove;
    let rows: Row[];
    if (o.all === "safe") {
      rows = k.rows.filter((r) => r.group === "safe" && can(r));
      if (rows.length === 0) return no("Nothing of the safe group is left.");
    } else {
      const row = typeof o.id === "string" ? k.rows.find((r) => r.id === o.id) : undefined;
      if (!row) return no("This row is not in the list.");
      if (row.removed) return no("It was removed already.");
      if (row.noRemove) return no(row.noRemove);
      rows = [row];
    }
    this.removing = rows[0].id;
    this.refused = null;
    const done = (async () => {
      try {
        for (const row of rows) {
          const cand = k.candidates.find((c) => c.id === row.id);
          const why = cand ? await this.removeOne(row, cand) : "This row is not in the list.";
          // "Remove all" stops at the first thing that is not removed.
          if (why !== null) { this.refused = { id: row.id, text: why }; break; }
        }
      } finally {
        this.removing = null;
      }
    })();
    return { started: true, done };
  }
}
