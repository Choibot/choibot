// server/chief/queue/schema.ts — input validation for queue add, answers and
// recommendations (spec §5.1, §5.2, Appendix A). zod on the server; no I/O.
import { z } from "zod";
import { validBranchName } from "../../agents/worktree.js";
import { PR_URL_RE } from "../../master/events.js";
import { oneLine } from "../../text.js";
import type { QueueKind } from "../kinds.js";
import { RICH_BODY_MAX, RICH_HEIGHT_MAX, RICH_HEIGHT_MIN } from "./rich.js";
import type { QueueItem } from "./types.js";

export const TITLE_MAX = 80;
export const BODY_MAX = 1500;
// The one count of a body, for both of its limits (BODY_MAX, and RICH_BODY_MAX with a page): the
// UTF-16 length, as zod's .max counted before. A body that passes one limit is never refused by
// the other for another count.
export const bodyLength = (s: string): number => s.length;
const LABEL_MAX = 40, DETAIL_MAX = 200, WHY_MAX = 300, URL_MAX = 256, BRANCH_MAX = 200, IMAGE_MAX = 512;
const KEYS = ["A", "B", "C", "D", "E", "F"];
const RULE_ID = /^r_[0-9a-z]{5}$/;
// The kinds an agent may add. Never `deploy`: only the console itself makes that item (spec §5.7).
const KINDS = ["pr", "choice", "preview", "question"] as const;

type Res<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const zfail = (e: z.ZodError): { ok: false; error: string } => {
  const i = e.issues[0]!;
  const path = i.path.join(".");
  return fail(path ? `${path}: ${i.message}` : i.message);
};

export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch { return false; }
}

export type AddInputValue = {
  kind: QueueKind; title: string; body: string; blocking?: boolean;
  options?: { key: string; label: string; detail?: string }[];
  pr?: { url: string } | { branch: string };
  preview?: { images: string[]; url?: string };
  html?: { file: string; height?: number };
};

const option = z.object({
  key: z.string(),
  label: z.string().trim().min(1).max(LABEL_MAX),
  detail: z.string().max(DETAIL_MAX).optional(),
});
const prBody = z.object({
  url: z.string().max(URL_MAX).regex(PR_URL_RE, "must be a GitHub pull request URL").optional(),
  branch: z.string().max(BRANCH_MAX).optional(),
}).superRefine((p, ctx) => {
  if (p.url !== undefined && p.branch !== undefined) ctx.addIssue({ code: "custom", message: "give a url or a branch, not both" });
  else if (p.url === undefined && p.branch === undefined) ctx.addIssue({ code: "custom", message: "needs a url or a branch" });
  else if (p.branch !== undefined && validBranchName(p.branch) === null) ctx.addIssue({ code: "custom", path: ["branch"], message: "is not a valid branch name" });
});
const previewBody = z.object({
  images: z.array(z.string().min(1).max(IMAGE_MAX)).min(1).max(10),
  url: z.string().max(URL_MAX).refine(isHttpUrl, "must be an http or https URL").optional(),
});
// The rich part of any kind of item: one HTML file of the agent's folder (rich.ts checks it).
const htmlBody = z.object({
  file: z.string().min(1).max(IMAGE_MAX),
  height: z.number().int().min(RICH_HEIGHT_MIN).max(RICH_HEIGHT_MAX).optional(),
}).strict();
const addBody = z.object({
  kind: z.enum(KINDS),
  // One line: control characters and whitespace runs collapse before the length check.
  title: z.string().transform(oneLine).pipe(z.string().min(1).max(TITLE_MAX)),
  body: z.string().refine((s) => bodyLength(s) <= BODY_MAX, `must be at most ${BODY_MAX} characters`),
  blocking: z.boolean().optional(),
  options: z.array(option).min(2).max(6).optional(),
  pr: prBody.optional(),
  preview: previewBody.optional(),
  html: htmlBody.optional(),
}).superRefine((b, ctx) => {
  // One main form per ticket. With a page, the page carries the content and the body is its short
  // summary: Telegram, the master and a search read only the body, so it is required, and a long
  // body would repeat the page. Checked at add time only: an item in the queue does not change.
  if (b.html !== undefined) {
    const n = bodyLength(b.body);
    if (b.body.trim() === "") ctx.addIssue({ code: "custom", path: ["body"], message: "is required with html: write a short summary (what it is, the one or two facts that decide, what to answer)" });
    else if (n > RICH_BODY_MAX) {
      ctx.addIssue({
        code: "custom", path: ["body"],
        message: `with a page, the body is a short summary of at most ${RICH_BODY_MAX} characters (this one has ${n}). `
          + "Write what it is, the one or two facts that decide and what to answer; keep the rest in the page only. "
          + `Or remove the page and keep the body (at most ${BODY_MAX}).`,
      });
    }
  }
  const need = (name: "options" | "pr" | "preview", kind: QueueKind): void => {
    if (b.kind === kind && b[name] === undefined) ctx.addIssue({ code: "custom", path: [name], message: `is required for ${kind} items` });
    // A pr item may carry screenshots (overview decision 65): one ticket for a PR and its look.
    if (name === "preview" && b.kind === "pr") return;
    if (b.kind !== kind && b[name] !== undefined) {
      ctx.addIssue({ code: "custom", path: [name], message: name === "preview" ? "is only for preview and pr items" : `is only for ${kind} items` });
    }
  };
  need("options", "choice"); need("pr", "pr"); need("preview", "preview");
  b.options?.forEach((o, i) => {
    if (o.key !== KEYS[i]) ctx.addIssue({ code: "custom", path: ["options", i, "key"], message: `must be ${KEYS[i]} (keys run A.. in order)` });
  });
});

export function parseAddInput(body: unknown, o: { previewEnabled: boolean }): Res<AddInputValue> {
  if (!isObj(body)) return fail("body must be an object");
  if (body.kind === "preview" && !o.previewEnabled) return fail("preview items arrive in Phase 2b");
  if (body.preview !== undefined && !o.previewEnabled) return fail("screenshots arrive in Phase 2b");
  const r = addBody.safeParse(body);
  if (!r.success) return zfail(r.error);
  const d = r.data;
  const v: AddInputValue = { kind: d.kind, title: d.title, body: d.body };
  if (d.blocking !== undefined) v.blocking = d.blocking;
  if (d.options) v.options = d.options.map((x) => (x.detail === undefined ? { key: x.key, label: x.label } : { key: x.key, label: x.label, detail: x.detail }));
  if (d.pr) v.pr = d.pr.url !== undefined ? { url: d.pr.url } : { branch: validBranchName(d.pr.branch!)! };
  if (d.preview) v.preview = d.preview.url === undefined ? { images: d.preview.images } : { images: d.preview.images, url: d.preview.url };
  if (d.html) v.html = d.html.height === undefined ? { file: d.html.file } : { file: d.html.file, height: d.html.height };
  return { ok: true, value: v };
}

const answerBody = z.object({ value: z.string(), text: z.string().max(BODY_MAX).optional(), images: z.unknown().optional() });

type UserAnswer = { ok: true; value: string; text?: string; images?: string[] } | { ok: false; error: string };

// The images of an answer (answerImages.ts), as the client names them: each the name of a draft
// that the server made (the pattern), at most four, each once. No file is read here.
export const ANSWER_IMAGES_MAX = 4;
export const DRAFT_RE = /^d-[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
export function checkNames(names: unknown): { ok: true; names: string[] } | { ok: false; error: string } {
  if (names === undefined) return { ok: true, names: [] };
  if (!Array.isArray(names)) return fail("images must be a list");
  if (names.length > ANSWER_IMAGES_MAX) return fail(`at most ${ANSWER_IMAGES_MAX} images in one answer`);
  if (!names.every((n): n is string => typeof n === "string" && DRAFT_RE.test(n))) return fail("images must be the names of uploaded images");
  if (new Set(names).size !== names.length) return fail("an image is named twice");
  return { ok: true, names };
}

// `images` (answerImages.ts): the draft names of a reply, of "other" on a choice, or of a change
// request; then text is not needed. Never with an option key or an approve.
export function validateUserAnswer(item: QueueItem, body: unknown): UserAnswer {
  if (!isObj(body)) return fail("body must be an object");
  if ("auto" in body) return fail('"auto" is a master-only verb');
  const r = answerBody.safeParse(body);
  if (!r.success) return zfail(r.error);
  const value = r.data.value;
  const text = r.data.text?.trim() ? r.data.text : undefined;
  const named = checkNames(r.data.images);
  if (!named.ok) return fail(named.error);
  const images = named.names;
  const done = (needText: boolean, takesImages = false): UserAnswer => {
    if (images.length > 0 && !takesImages) return fail("images go only with a reply or a change request");
    if (needText && !text && images.length === 0) return fail(`${value} needs text`);
    return { ok: true, value, ...(text ? { text } : {}), ...(images.length > 0 ? { images } : {}) };
  };
  switch (item.kind) {
    case "pr": case "preview":
      if (value === "approve") return done(false);
      if (value === "changes") return done(true, true);
      return fail("value must be approve or changes");
    case "choice":
      if (value === "reply") return done(true, true);
      if (item.choice?.options.some((x) => x.key === value)) return done(false);
      return fail("value must be an option key or reply");
    case "question":
      if (value === "reply") return done(true, true);
      return fail("value must be reply");
    // The console's own ticket (spec §5.7): no value is an answer. Deploy has its own route.
    case "deploy":
      return fail("a deploy ticket takes no answer: use Deploy");
    default:
      return fail("unknown item kind");
  }
}

const recommendBody = z.object({
  value: z.string().trim().min(1),
  why: z.string().trim().min(1).max(WHY_MAX),
  ruleIds: z.array(z.string().regex(RULE_ID, "must look like r_ab12c")).min(1).max(5),
});

export function parseRecommend(item: QueueItem, body: unknown): Res<{ value: string; why: string; ruleIds: string[] }> {
  if (!isObj(body)) return fail("body must be an object");
  const r = recommendBody.safeParse(body);
  if (!r.success) return zfail(r.error);
  const { value, why } = r.data;
  const ruleIds = [...new Set(r.data.ruleIds)];
  if (item.kind === "choice") {
    if (!item.choice?.options.some((x) => x.key === value)) return fail("value must be an option key");
  } else if (item.kind === "question") {
    if (value.trim().toLowerCase() === "reply") return fail("value must be the suggested answer text, not reply");
    if (value.length > BODY_MAX) return fail(`value must be at most ${BODY_MAX} chars`);
  } else return fail("recommend is only for choice and question items");
  return { ok: true, value: { value, why, ruleIds } };
}
