// server/health/warn.ts — what needs the user, in plain words: what is wrong, the cause when it
// is known, and what to do. Pure. The worst level is the dot of the Server row in the sidebar.
import { DISPLAY_NAME } from "../brand.js";
import type { Disk, Memory } from "./sys.js";
import { diskName, percent, size, span } from "./words.js";

export type Level = "ok" | "warn" | "error";
export type Warning = { id: string; level: "warn" | "error"; title: string; text: string; todo: string };

export const DISK_WARN = 85;
export const DISK_ERROR = 95;
export const MEMORY_WARN = 90;
export const CPU_WARN = 95;
export const SWAP_WARN = 50;
// "For some minutes": a short peak (a build, a test run) is no warning.
export const MEMORY_HELD_MS = 3 * 60_000;
export const CPU_HELD_MS = 5 * 60_000;
export const SWAP_HELD_MS = 3 * 60_000;

// The biggest user of a thing, with its name ("agent Fix the login").
export type Top = { name: string; amount: string } | null;

export function warningsOf(s: {
  disks: Disk[];
  memory: Memory | null;
  // For how long the value was over its limit, up to now (history.heldMs).
  held: { cpuMs: number; memoryMs: number; swapMs: number };
  topCpu: Top;
  topMemory: Top;
  // The biggest known place on the disk of the work folder, when it is a real part of the used
  // space (the caller decides). Null: not known, or too small to be the cause.
  topPlace: Top;
  // Most of the used space of that disk is outside the places that the console knows.
  mostOutside?: boolean;
}): Warning[] {
  const out: Warning[] = [];
  for (const d of s.disks) {
    if (d.percent < DISK_WARN) continue;
    const full = d.percent >= DISK_ERROR;
    const cause = !d.holdsWork ? ""
      : s.mostOutside ? ` Most of the used space is outside the places that ${DISPLAY_NAME} knows.`
      : s.topPlace ? ` The biggest place is ${s.topPlace.name} (${s.topPlace.amount}).` : "";
    out.push({
      id: `disk:${d.path}`,
      level: full ? "error" : "warn",
      title: `${diskName(d.path)} is ${full ? "almost full" : `${percent(d.percent)} full`}`,
      text: `${size(d.free)} of ${size(d.total)} is free.${full ? " When a disk is full, agents and builds fail." : ""}${cause}`,
      todo: d.holdsWork && s.mostOutside
        ? "\"What fills the disk\" shows the places that are known. The rest is from other programs and files on your server."
        : "Delete the agents that you do not need: each agent keeps its own copy of a repo. \"What fills the disk\" shows the biggest places.",
    });
  }
  if (s.memory && s.held.memoryMs >= MEMORY_HELD_MS) {
    out.push({
      id: "memory",
      level: "warn",
      title: `The memory is over ${MEMORY_WARN}% full`,
      text: `It has been so for ${span(s.held.memoryMs / 1000)}: ${size(s.memory.used)} of ${size(s.memory.total)} is in use.${s.topMemory ? ` ${cap(s.topMemory.name)} uses the most (${s.topMemory.amount}).` : ""}`,
      todo: "Stop an agent that you do not need. If this comes back often, your server needs more memory.",
    });
  }
  if (s.memory && s.memory.swapTotal > 0 && s.held.swapMs >= SWAP_HELD_MS) {
    out.push({
      id: "swap",
      level: "warn",
      title: "The server uses its swap heavily",
      text: `${size(s.memory.swapUsed)} of ${size(s.memory.swapTotal)} swap is in use. Swap is memory on the disk: it is slow, so everything on your server gets slower.`,
      todo: "Stop an agent that you do not need. If this comes back often, your server needs more memory.",
    });
  }
  if (s.held.cpuMs >= CPU_HELD_MS) {
    out.push({
      id: "cpu",
      level: "warn",
      title: "The processor is at its limit",
      text: `It has been at 100% for ${span(s.held.cpuMs / 1000)}.${s.topCpu ? ` ${cap(s.topCpu.name)} uses the most (${s.topCpu.amount}).` : ""}`,
      todo: "A build or a test run can do this for a time: then wait. If an agent does not stop, open its thread and stop it.",
    });
  }
  return out;
}

export function levelOf(warnings: Warning[]): Level {
  return warnings.some((w) => w.level === "error") ? "error" : warnings.length ? "warn" : "ok";
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
