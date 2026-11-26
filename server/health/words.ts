// server/health/words.ts — sizes, shares and times in plain words. Pure, no imports: the server's
// warnings and the browser's Server page use the same words.

// "512 MB", "3.4 GB", "120 GB": the units a person knows, 1 GB = 1024 MB.
export function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return bytes < 1024 ? `${Math.round(bytes)} bytes` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  if (gb < 1000) return `${gb < 100 ? gb.toFixed(1) : Math.round(gb)} GB`;
  return `${(gb / 1024).toFixed(1)} TB`;
}

// "7%", and "0.4%" for a small share that is not zero.
export function percent(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  return p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

// "12 minutes", "5 hours", "3 days 4 hours".
export function span(seconds: number): string {
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"}`;
  const min = Math.floor(seconds / 60);
  if (min < 1) return "less than a minute";
  if (min < 60) return n(min, "minute");
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 && h < 6 ? `${n(h, "hour")} ${n(min % 60, "minute")}` : n(h, "hour");
  const d = Math.floor(h / 24);
  return h % 24 ? `${n(d, "day")} ${n(h % 24, "hour")}` : n(d, "day");
}

// How the page names a disk: "/" is the main disk.
export function diskName(path: string): string {
  return path === "/" ? "The main disk" : `The disk at ${path}`;
}
