// server/chief/leads/areas.ts — areas.json: which repos belong to which lead's area
// (spec §13). A leaf lock: set uses updateJson and takes no other lock. A missing or
// torn file reads as {}, so every item's area is its repo and all routes to the master.
import { avatarVariant } from "../../../src/lib/leadAvatar.js";
import { readJson, updateJson } from "../files.js";

// `avatar`: the user's "Change avatar" pick for the area's lead (lib/leadAvatar; absent = 0, the
// name's own creature).
export type Areas = Record<string, { repos: string[]; leadId?: string; avatar?: number }>;
export const AREA_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The lead record id of an area (spec §13). AREA_RE keeps it inside the dtach
// helper's socket charset [A-Za-z0-9._-] after agentSessionName.
export function leadId(area: string): string {
  return `lead-${area}`;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// The entry's avatar pick as a field to spread: nothing for 0 or a bad value.
const avatarOf = (e: unknown): { avatar?: number } => {
  const v = avatarVariant((e as { avatar?: unknown } | null | undefined)?.avatar);
  return v ? { avatar: v } : {};
};

export class AreaStore {
  constructor(private readonly file: string, private readonly deps: { exists: (agentId: string) => Promise<boolean> }) {}

  // Only well-formed entries: an area name, a string array of repos and, when
  // present, the area's own lead id. Anything else is dropped (its repos map to
  // themselves, its lead is not a lead). A bad avatar pick reads as none.
  async read(): Promise<Areas> {
    const v = await readJson<unknown>(this.file);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Areas = Object.create(null) as Areas;
    for (const [area, e] of Object.entries(v as Record<string, unknown>)) {
      if (!AREA_RE.test(area) || !e || typeof e !== "object") continue;
      const { repos, leadId: lead } = e as { repos?: unknown; leadId?: unknown };
      if (!isStringArray(repos)) continue;
      if (lead !== undefined && lead !== leadId(area)) continue;
      out[area] = { repos, ...(lead === undefined ? {} : { leadId: lead }), ...avatarOf(e) };
    }
    return out;
  }

  // Keeps the area's avatar pick.
  async set(area: string, v: { repos: string[]; leadId?: string }): Promise<void> {
    if (!AREA_RE.test(area)) throw new Error(`bad area name: ${area}`);
    await updateJson<Areas>(this.file, {}, (cur) => ({ ...cur, [area]: { ...v, ...avatarOf(cur[area]) } }));
  }

  // Sets the repos in one updateJson call and keeps the area's lead id (a start
  // of a running area must not drop it) and its avatar pick.
  async setRepos(area: string, repos: string[]): Promise<void> {
    if (!AREA_RE.test(area)) throw new Error(`bad area name: ${area}`);
    await updateJson<Areas>(this.file, {}, (cur) => {
      const lead = cur[area]?.leadId;
      return { ...cur, [area]: { repos, ...(lead === undefined ? {} : { leadId: lead }), ...avatarOf(cur[area]) } };
    });
  }

  // The user's avatar pick for an area that exists (false: no such area). 0 removes the pick.
  async setAvatar(area: string, variant: number): Promise<boolean> {
    if (!AREA_RE.test(area)) return false;
    let found = false;
    await updateJson<Areas>(this.file, {}, (cur) => {
      const e = Object.hasOwn(cur, area) ? cur[area] : undefined;
      if (!e || !isStringArray(e.repos)) return cur;
      found = true;
      const { avatar: _old, ...rest } = e;
      return { ...cur, [area]: { ...rest, ...avatarOf({ avatar: variant }) } };
    });
    return found;
  }

  async areaOf(repo: string): Promise<string> {
    const areas = await this.read();
    for (const [name, a] of Object.entries(areas)) if (a.repos.includes(repo)) return name;
    return repo;
  }

  async leadFor(area: string): Promise<string | undefined> {
    return (await this.read())[area]?.leadId;
  }

  async isLiveLead(agentId: string): Promise<boolean> {
    const areas = await this.read();
    return Object.values(areas).some((a) => a.leadId === agentId) && this.deps.exists(agentId);
  }
}

// The queue add path's areaOf: an areas.json that cannot be read (EACCES, EIO)
// maps the item to its repo, with one log line, so it never blocks an add.
export function areaOfOrRepo(
  areas: Pick<AreaStore, "areaOf">, log: (s: string) => void = (s) => console.warn(s),
): (repo: string) => Promise<string> {
  return async (repo) => {
    try {
      return await areas.areaOf(repo);
    } catch (e) {
      log(`[chief] areas.json not read (${e instanceof Error ? e.message : String(e)}); item area = its repo ${repo}`);
      return repo;
    }
  };
}
