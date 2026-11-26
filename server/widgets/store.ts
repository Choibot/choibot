// server/widgets/store.ts — every widget operation behind the HTTP routes:
// list (with the ingest of agent-written data.json), read, state and ui
// writes, delete, and (Task 6) the script refresh and actions. All writes for
// one widget go through one KeyedLock key, so two viewers, or a scan during a
// refresh, never append the same history entry twice. Ids are checked here
// too, so no caller can turn an id into a path outside the root.
import { join } from "node:path";
import type { AgentExec } from "../agents/terminal.js";
import { hardenedDeployment } from "../chief/hardened.js";
import { WidgetError } from "./errors.js";
import { exists, listNames, mtimeOf, readCapped, readJsonSoft, removeTree, writeAtomic } from "./files.js";
import {
  appendHistory, ingestAgentData, readData, readHistory, readStatus, writeData, writeStatus,
  type HistoryEntry, type WidgetStatus,
} from "./history.js";
import { KeyedLock } from "./lock.js";
import { parseMeta, parseUi, resolveLayout, sortWidgets, uiFromObject, type WidgetLayout, type WidgetUi, type WidgetWidth } from "./meta.js";
import { LIMITS, agentWidgetsDir, isAgentId, isWidgetId, widgetDir } from "./paths.js";
import { resolveRunnable, runScript, scriptEnv } from "./runner.js";

export type WidgetInfo = {
  id: string; title: string; width: WidgetWidth; height: number; chrome: boolean;
  autoRefresh: number | null; order: number; hasRefresh: boolean;
  htmlMtime: number; dataMtime: number | null; status: WidgetStatus | null;
};
export type WidgetPayload = { html?: string; data: unknown; history: HistoryEntry[]; state: unknown };
// agentExec: set only in a hardened deployment after the helper probe passed
// (the TerminalManager's); scripts then run as the agent uid (runner.ts).
export type StoreOpts = { timeoutMs?: number; drainMs?: number; agentExec?: AgentExec };
export type ScriptRefresh = { data: unknown; status: WidgetStatus };
// Spec "Script contract": at most 2 actions run at once per widget.
export const MAX_ACTIONS = 2;

const HTML = "widget.html";
export const NEEDS_HELPER = "widget scripts need the agent helper";

export class WidgetStore {
  private locks = new KeyedLock();

  constructor(readonly root: string, private opts: StoreOpts = {}) {}

  dir(agentId: string, wid: string): string {
    return widgetDir(this.root, agentId, wid);
  }

  private key(agentId: string, wid: string): string {
    return `${agentId}/${wid}`;
  }

  // Ruling F3: in a hardened deployment a script runs only as the agent uid,
  // through the helper. Without agentExec (its probe failed) it is refused:
  // never agent-written code as the console uid. Not hardened: nothing.
  private requireHelper(): void {
    if (!this.opts.agentExec && hardenedDeployment()) throw new WidgetError(503, NEEDS_HELPER);
  }

  // meta.json + ui.json → layout. A file over 64 KB counts as missing.
  private async layout(dir: string, wid: string): Promise<WidgetLayout> {
    const soft = (name: string) => readCapped(join(dir, name), LIMITS.small).catch(() => null);
    const [meta, ui] = await Promise.all([soft("meta.json"), soft("ui.json")]);
    return resolveLayout(wid, parseMeta(meta), parseUi(ui));
  }

  async list(agentId: string): Promise<WidgetInfo[]> {
    if (!isAgentId(agentId)) return [];
    const names = await listNames(agentWidgetsDir(this.root, agentId));
    const infos = await Promise.all(names.filter(isWidgetId).map((w) => this.info(agentId, w)));
    return sortWidgets(infos.filter((i): i is WidgetInfo => i !== null));
  }

  // One widget's list entry. A folder without widget.html is not a widget.
  async info(agentId: string, wid: string): Promise<WidgetInfo | null> {
    if (!isAgentId(agentId) || !isWidgetId(wid)) return null;
    const dir = this.dir(agentId, wid);
    const htmlMtime = await mtimeOf(join(dir, HTML));
    if (htmlMtime === null) return null;
    const layout = await this.layout(dir, wid);
    // Agent-written data.json → history (spec "History"). Never fails the list.
    await this.locks.run(this.key(agentId, wid), () => ingestAgentData(dir, layout.historyMax)).catch(() => null);
    const [hasRefresh, dataMtime, status] = await Promise.all([
      exists(join(dir, "refresh")), mtimeOf(join(dir, "data.json")), readStatus(dir),
    ]);
    return {
      id: wid, title: layout.title, width: layout.width, height: layout.height, chrome: layout.chrome,
      autoRefresh: layout.autoRefresh, order: layout.order, hasRefresh, htmlMtime, dataMtime, status: status.last,
    };
  }

  // `since` given: only history entries with at > since, and no html (the
  // client asks this way on each dataMtime change).
  async get(agentId: string, wid: string, since?: number): Promise<WidgetPayload | null> {
    if (!isAgentId(agentId) || !isWidgetId(wid)) return null;
    const dir = this.dir(agentId, wid);
    if ((await mtimeOf(join(dir, HTML))) === null) return null;
    const [data, history, state] = await Promise.all([
      readData(dir), readHistory(dir, since), readJsonSoft(join(dir, "state.json"), LIMITS.state),
    ]);
    const payload: WidgetPayload = { data, history, state: state ?? {} };
    if (since === undefined) payload.html = (await readCapped(join(dir, HTML), LIMITS.html)) ?? "";
    return payload;
  }

  async setState(agentId: string, wid: string, state: unknown): Promise<boolean> {
    const text = JSON.stringify(state ?? {});
    if (Buffer.byteLength(text) > LIMITS.state) throw new WidgetError(413, "state is over 64 KB");
    return this.write(agentId, wid, (dir) => writeAtomic(join(dir, "state.json"), text));
  }

  async setUi(agentId: string, wid: string, patch: WidgetUi): Promise<boolean> {
    return this.write(agentId, wid, async (dir) => {
      const cur = uiFromObject(await readJsonSoft(join(dir, "ui.json"), LIMITS.small));
      await writeAtomic(join(dir, "ui.json"), JSON.stringify({ ...cur, ...patch }));
    });
  }

  async remove(agentId: string, wid: string): Promise<boolean> {
    return this.write(agentId, wid, (dir) => removeTree(dir));
  }

  // Agent deleted → its whole widget folder goes (best effort, by the caller).
  async removeAgent(agentId: string): Promise<void> {
    if (!isAgentId(agentId)) return;
    const agentDir = agentWidgetsDir(this.root, agentId);
    // Take each widget's lock first, so a running refresh or ingest ends before its folder goes.
    const names = await listNames(agentDir);
    for (const wid of names.filter(isWidgetId)) {
      await this.locks.run(this.key(agentId, wid), () => removeTree(this.dir(agentId, wid)));
    }
    await removeTree(agentDir);
  }

  private flights = new Map<string, Promise<ScriptRefresh>>();
  private running = new Map<string, number>();

  // Script mode. One refresh per widget at a time: a second call joins the
  // running one (its args are ignored). The script runs outside the lock; the
  // writes (data.json, history, status) happen under it.
  async refreshScript(agentId: string, wid: string, cwd: string, args: unknown): Promise<ScriptRefresh> {
    const key = this.key(agentId, wid);
    const running = this.flights.get(key);
    if (running) return running;
    const p = this.runRefresh(agentId, wid, cwd, args).finally(() => this.flights.delete(key));
    this.flights.set(key, p);
    return p;
  }

  private async runRefresh(agentId: string, wid: string, cwd: string, args: unknown): Promise<ScriptRefresh> {
    if (!isAgentId(agentId) || !isWidgetId(wid)) throw new WidgetError(404, "not found");
    const dir = this.dir(agentId, wid);
    const file = await resolveRunnable(dir, "refresh");
    if (!file) throw new WidgetError(400, "not runnable");
    this.requireHelper();
    const res = await runScript({
      file, cwd, args: args ?? {}, env: scriptEnv(dir, agentId), maxOut: LIMITS.refreshOut,
      timeoutMs: this.opts.timeoutMs, drainMs: this.opts.drainMs, agentExec: this.opts.agentExec,
    });
    const layout = await this.layout(dir, wid);
    return this.locks.run(this.key(agentId, wid), async () => {
      // Deleted while the script ran: write nothing, so no folder comes back.
      if ((await mtimeOf(join(dir, HTML))) === null) throw new WidgetError(404, "not found");
      const prev = await readStatus(dir);
      const at = Date.now();
      if (!res.ok) {
        const status: WidgetStatus = { at, ok: false, mode: "script", error: res.error };
        await writeStatus(dir, { ...prev, last: status });
        return { data: await readData(dir).catch(() => null), status };
      }
      // data.json first, then its mtime as ingestedMtime: the list scan will
      // see this file as already in history.
      const mtime = await writeData(dir, res.value);
      await appendHistory(dir, { at, data: res.value }, layout.historyMax);
      const status: WidgetStatus = { at, ok: true, mode: "script" };
      await writeStatus(dir, { last: status, ingestedMtime: mtime });
      return { data: res.value, status };
    });
  }

  // actions/<name>: the JSON result goes back to the calling widget only; no
  // data.json, no history. Callers validate `name` with isWidgetId.
  async action(agentId: string, wid: string, name: string, cwd: string, args: unknown): Promise<unknown> {
    if (!isAgentId(agentId) || !isWidgetId(wid) || !isWidgetId(name)) throw new WidgetError(400, "not runnable");
    const dir = this.dir(agentId, wid);
    const file = await resolveRunnable(dir, join("actions", name));
    if (!file) throw new WidgetError(400, "not runnable");
    this.requireHelper();
    const key = this.key(agentId, wid);
    const n = this.running.get(key) ?? 0;
    if (n >= MAX_ACTIONS) throw new WidgetError(429, "too many actions running");
    this.running.set(key, n + 1);
    try {
      const res = await runScript({
        file, cwd, args: args ?? {}, env: scriptEnv(dir, agentId), maxOut: LIMITS.actionOut,
        timeoutMs: this.opts.timeoutMs, drainMs: this.opts.drainMs, agentExec: this.opts.agentExec,
      });
      if (!res.ok) throw new WidgetError(500, res.error);
      return res.value;
    } finally {
      const left = (this.running.get(key) ?? 1) - 1;
      if (left > 0) this.running.set(key, left);
      else this.running.delete(key);
    }
  }

  // Run `fn` under the widget's lock when the widget exists; false otherwise.
  private async write(agentId: string, wid: string, fn: (dir: string) => Promise<void>): Promise<boolean> {
    if (!isAgentId(agentId) || !isWidgetId(wid)) return false;
    const dir = this.dir(agentId, wid);
    return this.locks.run(this.key(agentId, wid), async () => {
      if ((await mtimeOf(join(dir, HTML))) === null) return false;
      await fn(dir);
      return true;
    });
  }
}
