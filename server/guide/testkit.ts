// server/guide/testkit.ts — parts the tests of the guide share. Not shipped.
import type { ActionFacts } from "./actions.js";
import type { GuideModel, ModelAnswer } from "./model.js";
import { STEPS, type StepId, type StepState, type StepStatus } from "../setup/steps.js";

// Texts with the shape of each kind of secret. Made here from parts, so that no file of the
// repo holds a text that looks like a real one.
const body = (n: number): string => "aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0zA".repeat(4).slice(0, n);
export const FAKE = {
  telegram: `123456789:${body(35)}`,
  githubClassic: `ghp_${body(36)}`,
  githubOauth: `gho_${body(36)}`,
  githubFine: `github_pat_${body(22)}_${body(40)}`,
  anthropic: `sk-ant-api03-${body(40)}`,
  claudeLogin: `sk-ant-oat01-${body(40)}`,
  openai: `sk-proj-${body(40)}`,
  tailscale: `tskey-auth-${body(20)}`,
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  random: body(40),
};

// The list as the server gives it: every step with a state. `set` names the steps that differ
// from "todo" (or gives a whole status).
export function list(set: Partial<Record<StepId, StepState | Partial<StepStatus>>> = {}): StepStatus[] {
  return STEPS.map((s): StepStatus => {
    const v = set[s.id];
    const over = typeof v === "string" ? { state: v } : v ?? {};
    const state = over.state ?? "todo";
    return {
      id: s.id, title: s.title, why: s.why, optional: s.optional === true, state,
      text: state === "done" ? `${s.title}: ok` : state === "blocked" ? "First: another step." : `${s.title} is open.`,
      ...over,
    };
  });
}

// The first 4 steps are done in the terminal before the browser opens.
export const BOX_DONE = { install: "done", claude: "done", access: "done", pair: "done" } as const;

export const IDLE: ActionFacts = { login: { state: "idle" }, clone: { state: "idle" }, first: null };

// A model that gives the next answer of a list, and keeps what it was asked.
export function fakeModel(answers: (ModelAnswer | string)[] = []): GuideModel & { calls: { system: string; input: string }[]; hold?: Promise<void> } {
  const calls: { system: string; input: string }[] = [];
  const model = (async (o: { system: string; input: string }) => {
    calls.push(o);
    if (model.hold) await model.hold;
    const next = answers.shift() ?? "Ok.";
    return typeof next === "string" ? { ok: true as const, text: next } : next;
  }) as GuideModel & { calls: typeof calls; hold?: Promise<void> };
  model.calls = calls;
  return model;
}
