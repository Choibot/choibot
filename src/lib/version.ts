// src/lib/version.ts — Settings, "Version": which version this console runs (GET /api/version,
// server/release.ts), in plain words. The status line and the rows are pure, for the tests.
import type { VersionInfo } from "../../server/release"; // type-only: release.ts imports node:fs
import type { UpdateService } from "../../server/update/service"; // type-only
import { chiefFetch } from "./chief";
import { ageText } from "./queueInbox";
import type { SectionStatus } from "./settings";

export type { VersionInfo };
export type VersionRead = VersionInfo | { error: string } | null;

export async function fetchVersion(deps: { fetch?: typeof fetch } = {}): Promise<VersionRead> {
  try {
    const res = await chiefFetch("/api/version", undefined, deps);
    if (!res.ok) return { error: `the console answered HTTP ${res.status}` };
    const b = (await res.json().catch(() => null)) as VersionInfo | null;
    return b && typeof b.kind === "string" ? b : { error: "the answer is not a version" };
  } catch {
    return { error: "the console did not answer" };
  }
}

export const shortCommit = (c: string | null): string => (c ? c.slice(0, 7) : "");

// "Version 840 (33c531a)" for a release; "Commit 33c531a" for a git checkout or an archive.
export function versionName(v: VersionInfo): string | null {
  if (v.version !== null && v.commit) return `Version ${v.version} (${shortCommit(v.commit)})`;
  if (v.commit) return `Commit ${shortCommit(v.commit)}`;
  return null;
}

export function versionStatus(r: VersionRead): SectionStatus {
  if (r === null) return { tone: "load", text: "Checking…" };
  if ("error" in r) return { tone: "err", text: `Cannot read the version: ${r.error}` };
  const name = versionName(r);
  if (r.problem) return { tone: "warn", text: name ? `${name}: ${r.problem}` : `Version not known: ${r.problem}` };
  if (!name) return { tone: "off", text: "Version not known: this build recorded no commit" };
  return { tone: "ok", text: name };
}

export const INSTALL_WORDS: Record<VersionInfo["kind"], string> = {
  checkout: "A git checkout",
  release: "A release",
  archive: "An archive file",
};

// What the person can do about new code, by the kind of install. No promise of what is not built.
export const NEW_CODE_WORDS: Record<VersionInfo["kind"], string> = {
  checkout: "New code comes with the deploy ticket in the Queue, when the chief of staff is on.",
  release: "This console does not get a new release by itself yet.",
  archive: "This console does not get new code by itself yet.",
};

// The updater of a hosted server (server/update): GET /api/deploy says what it last did.
export type UpdateView = ReturnType<UpdateService["view"]>;

export async function fetchUpdateView(deps: { fetch?: typeof fetch } = {}): Promise<UpdateView | null> {
  try {
    const res = await chiefFetch("/api/deploy", undefined, deps);
    if (!res.ok) return null;
    const b = (await res.json().catch(() => null)) as { update?: UpdateView } | null;
    return b?.update && typeof b.update.on === "boolean" ? b.update : null;
  } catch {
    return null;
  }
}

// One line: "Version 848, checked 2 h ago", or the end of a failed update. null: no updater here.
export function updateWords(u: UpdateView | null, now: number): string | null {
  if (!u?.on) return null;
  if (u.result === "failed-back" && u.tried !== null && u.installed !== null) return `Update to ${u.tried} failed. Back on ${u.installed}.`;
  if (u.result === "failed-stuck" && u.tried !== null) return `Update to ${u.tried} failed. The console needs help.`;
  const at = u.checkedAt ? Date.parse(u.checkedAt) : NaN;
  return Number.isFinite(at) ? `Version ${u.running}, checked ${ageText(now - at)} ago` : `Version ${u.running}, not checked yet`;
}

// The date and time of a release's build, in the browser's own words; "" when it is not one.
export function builtWords(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}
