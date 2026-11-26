// server/services/store.ts
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isServiceId } from "../ids.js";

export type ServiceRecord = {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  requiresConfirm: boolean;
  confirmMessage: string;
  autoRestart: boolean;
  createdAt: number;
};

// One JSON file per service definition. Mirrors server/agents/store.ts,
// id guard included: the id is the file name, Fastify decodes %2F in a route
// param, and the default services dir is a sibling of the agents dir. So an
// id that is not a service id never reaches the file system: load gives null,
// save throws, delete and patch do nothing. list() reads the names readdir
// gives, unchanged.
export class ServiceStore {
  constructor(private dir: string) {}
  private file(id: string) { return join(this.dir, `${id}.json`); }
  private async ensure() { await mkdir(this.dir, { recursive: true }); }

  async save(rec: ServiceRecord): Promise<void> {
    if (!isServiceId(rec.id)) throw new Error(`invalid service id: ${String(rec.id).slice(0, 64)}`);
    await this.ensure();
    await writeFile(this.file(rec.id), JSON.stringify(rec, null, 2));
  }
  async load(id: string): Promise<ServiceRecord | null> {
    if (!isServiceId(id)) return null;
    return this.read(this.file(id));
  }
  private async read(path: string): Promise<ServiceRecord | null> {
    try { return JSON.parse(await readFile(path, "utf8")) as ServiceRecord; }
    catch { return null; }
  }
  async list(): Promise<ServiceRecord[]> {
    await this.ensure();
    const names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const recs = await Promise.all(names.map((n) => this.read(join(this.dir, n))));
    return recs.filter((r): r is ServiceRecord => r !== null).sort((a, b) => a.createdAt - b.createdAt);
  }
  async patch(id: string, fields: Partial<ServiceRecord>): Promise<void> {
    const rec = await this.load(id);
    if (!rec) return;
    await this.save({ ...rec, ...fields });
  }
  async delete(id: string): Promise<void> {
    if (!isServiceId(id)) return;
    try { await unlink(this.file(id)); } catch { /* already gone */ }
  }
}
