// server/ids.ts — the one pattern for record ids that become a path segment
// (a store file name, a widgets folder, a dtach socket name): no dots, no
// separators, at most 64 chars. Agent ids (UUIDs, `fleet-master`,
// `cron-master`) and service ids (`svc-<uuid>`, the seed ids) all match it.
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isAgentId(v: unknown): v is string {
  return typeof v === "string" && RECORD_ID_RE.test(v);
}

export function isServiceId(v: unknown): v is string {
  return typeof v === "string" && RECORD_ID_RE.test(v);
}
