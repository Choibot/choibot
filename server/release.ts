// server/release.ts — which version this console runs, and how it was installed. Read once at
// boot from the console's own folder (the unit's WorkingDirectory):
//   - release.json: the release builder (scripts/release/build.sh) writes it into the app folder
//     of a release (release format v1, section 6);
//   - .next/BUILD_ID: the commit that the build recorded (server/buildid.mjs), or Next's random id;
//   - .git: a git checkout (`choibot update` and the Deploy ticket work only there).
// GET /api/version gives it to the Settings page, and to the updater's check after a start.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listenerKind } from "./frontproxy.js";

export const RELEASE_FILE = "release.json";
// Open also while a new install waits for its first device (chief/firstrun.ts): the updater's check
// after a start reads it on a server that nobody claimed yet. It holds no secret.
export const VERSION_ROUTE = "/api/version";
const SHA = /^[0-9a-f]{40}$/;
const PLAIN_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;

// Strict: a field that the format does not name is a release.json of another format.
export const releaseShape = z.object({
  v: z.literal(1),
  version: z.number().int().min(1).max(1_000_000_000),
  commit: z.string().regex(SHA),
  channel: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
  builtAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  node: z.string().regex(PLAIN_VERSION),
  pnpm: z.string().regex(PLAIN_VERSION),
  gh: z.string().regex(PLAIN_VERSION),
}).strict();
export type Release = z.infer<typeof releaseShape>;

// checkout: a git checkout (.git is a folder, or a file in a worktree). release: the app folder of a
// release (release.json is there, also one that does not parse). archive: neither (the install
// line from an archive file, as the image of hosted ChoiBot does it).
export type InstallKind = "checkout" | "release" | "archive";

export function installKind(dir: string): InstallKind {
  if (existsSync(join(dir, RELEASE_FILE))) return "release";
  if (existsSync(join(dir, ".git"))) return "checkout";
  return "archive";
}

export type ReleaseRead = { release: Release | null; problem?: string };

export function readRelease(dir: string): ReleaseRead {
  let text: string;
  try {
    text = readFileSync(join(dir, RELEASE_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { release: null };
    return { release: null, problem: `${RELEASE_FILE} cannot be read` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { release: null, problem: `${RELEASE_FILE} is not JSON` }; }
  const r = releaseShape.safeParse(raw);
  return r.success ? { release: r.data } : { release: null, problem: `${RELEASE_FILE} is not of format 1` };
}

export type VersionInfo = {
  kind: InstallKind;
  // The release's number (a release only), and the commit of the running build.
  version: number | null;
  commit: string | null;
  // The text of .next/BUILD_ID (a commit, or Next's random id), null when there is no build.
  buildId: string | null;
  // A release only.
  channel: string | null;
  builtAt: string | null;
  // Set when the facts do not agree (a release.json that does not parse, or another build).
  problem?: string;
};

export function versionInfo(dir: string): VersionInfo {
  const kind = installKind(dir);
  let buildId: string | null = null;
  try {
    buildId = readFileSync(join(dir, ".next", "BUILD_ID"), "utf8").trim() || null;
  } catch { /* no build */ }
  const built = buildId && SHA.test(buildId) ? buildId : null;
  if (kind !== "release") return { kind, version: null, commit: built, buildId, channel: null, builtAt: null };
  const { release, problem } = readRelease(dir);
  if (!release) return { kind, version: null, commit: built, buildId, channel: null, builtAt: null, problem: problem ?? `${RELEASE_FILE} is missing` };
  const other = built !== release.commit
    ? { problem: `the build is not the release's (the build records ${built ? built.slice(0, 7) : "no commit"}, the release ${release.commit.slice(0, 7)})` }
    : {};
  return { kind, version: release.version, commit: release.commit, buildId, channel: release.channel, builtAt: release.builtAt, ...other };
}

// GET /api/version: any session (a loopback peer too: server/auth.ts), also before the first
// pairing (chief/firstrun.ts). Read once, at boot: the
// build and the release of a running server do not change on disk while it runs.
export function registerVersionApi(app: FastifyInstance, info: VersionInfo): void {
  app.get(VERSION_ROUTE, async () => info);
}

// The version for the door (the front proxy, server/frontproxy.ts): on EVERY answer of the private
// listener, also a refusal, so the door's health check (HEAD / with its token) reads it. Never on
// loopback or another peer: the door is its only reader, and it must not pass it on to a browser.
// "<version> <commit>": 0 for an install that is not a release, "-" for no recorded commit.
export const VERSION_HEADER = "x-choibot-version";
export const versionHeaderValue = (info: Pick<VersionInfo, "version" | "commit">): string => `${info.version ?? 0} ${info.commit ?? "-"}`;

export function registerVersionHeader(app: FastifyInstance, info: Pick<VersionInfo, "version" | "commit">): void {
  const value = versionHeaderValue(info);
  app.addHook("onSend", async (req, reply, payload) => {
    if (listenerKind(req) === "proxy") reply.header(VERSION_HEADER, value);
    return payload;
  });
}
