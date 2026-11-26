import { describe, expect, it } from "vitest";
import { isPersistentAgentId } from "../kinds.js";
import { newItemId, type QueueItem } from "./types.js";
import { BODY_MAX, bodyLength, isHttpUrl, parseAddInput, parseRecommend, validateUserAnswer } from "./schema.js";
import { RICH_BODY_MAX } from "./rich.js";

const noPreview = { previewEnabled: false };
const opts = [{ key: "A", label: "Flat" }, { key: "B", label: "Registry", detail: "driven" }];
const item = (kind: QueueItem["kind"]): QueueItem => ({
  id: "q7k2m9x1a", kind, agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "r",
  title: "t", body: "b", createdAt: 1, updatedAt: 1, status: "open", blocking: true, history: [], answerSeq: 0,
  ...(kind === "choice" ? { choice: { options: opts } } : {}),
});

describe("newItemId / isPersistentAgentId", () => {
  it("makes q + 8 base36", () => { expect(newItemId()).toMatch(/^q[0-9a-z]{8}$/); });
  it("flags persistent agent ids", () => {
    expect(isPersistentAgentId("fleet-master")).toBe(true);
    expect(isPersistentAgentId("cron-master")).toBe(true);
    expect(isPersistentAgentId("lead-app")).toBe(true);
    expect(isPersistentAgentId("worker-1")).toBe(false);
  });
});

describe("isHttpUrl", () => {
  it("accepts http(s) only", () => {
    expect(isHttpUrl("https://x.dev/a")).toBe(true);
    expect(isHttpUrl("http://x.dev")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("nope")).toBe(false);
  });
});

describe("parseAddInput", () => {
  it("accepts valid choice, pr, question", () => {
    expect(parseAddInput({ kind: "choice", title: "t", body: "b", options: opts }, noPreview).ok).toBe(true);
    expect(parseAddInput({ kind: "pr", title: "t", body: "b", pr: { url: "https://github.com/o/r/pull/3" } }, noPreview).ok).toBe(true);
    expect(parseAddInput({ kind: "question", title: "t", body: "b" }, noPreview).ok).toBe(true);
    expect(parseAddInput({ kind: "pr", title: "t", body: "b", pr: { branch: "agent/x" } }, noPreview).ok).toBe(true);
  });
  it("rejects bad fields", () => {
    expect(parseAddInput({ kind: "question", title: "x".repeat(81), body: "b" }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "question", title: "t", body: "x".repeat(1501) }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "question", title: "t", body: "b", options: opts }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "choice", title: "t", body: "b" }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "choice", title: "t", body: "b", options: [opts[0]] }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "choice", title: "t", body: "b", options: [{ key: "B", label: "x" }, { key: "A", label: "y" }] }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "pr", title: "t", body: "b", pr: { url: "https://github.com/o/r/issues/1" } }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "pr", title: "t", body: "b" }, noPreview).ok).toBe(false);
    expect(parseAddInput({ kind: "question", title: "t", body: "b", pr: { branch: "x" } }, noPreview).ok).toBe(false);
    expect(parseAddInput("x", noPreview).ok).toBe(false);
  });
  it("refuses preview in 2a", () => {
    const r = parseAddInput({ kind: "preview", title: "t", body: "b", preview: { images: [] } }, noPreview);
    expect(r).toEqual({ ok: false, error: "preview items arrive in Phase 2b" });
  });
  it("a pr item may carry screenshots (decision 65); a choice or a question may not", () => {
    const e = { previewEnabled: true };
    const pr = { kind: "pr", title: "t", body: "b", pr: { url: "https://github.com/o/r/pull/7" } };
    expect(parseAddInput({ ...pr, preview: { images: [".choibot/previews/a-1.png"] } }, e)).toEqual({
      ok: true, value: { kind: "pr", title: "t", body: "b", pr: { url: "https://github.com/o/r/pull/7" }, preview: { images: [".choibot/previews/a-1.png"] } },
    });
    expect(parseAddInput({ kind: "pr", title: "t", body: "b", pr: { branch: "agent/x" }, preview: { images: ["a.png"], url: "https://x.dev" } }, e).ok).toBe(true);
    expect(parseAddInput(pr, e).ok).toBe(true); // screenshots stay optional on a pr item
    expect(parseAddInput({ ...pr, preview: { images: [] } }, e).ok).toBe(false);
    expect(parseAddInput({ ...pr, preview: { images: ["a.png"], url: "javascript:alert(1)" } }, e).ok).toBe(false);
    expect(parseAddInput({ kind: "question", title: "t", body: "b", preview: { images: ["a.png"] } }, e)).toEqual({ ok: false, error: "preview: is only for preview and pr items" });
    expect(parseAddInput({ kind: "choice", title: "t", body: "b", options: opts, preview: { images: ["a.png"] } }, e).ok).toBe(false);
    // The relay's own add (no screenshots are served there) refuses them on a pr item too.
    expect(parseAddInput({ ...pr, preview: { images: ["a.png"] } }, noPreview)).toEqual({ ok: false, error: "screenshots arrive in Phase 2b" });
    expect(parseAddInput(pr, noPreview).ok).toBe(true);
  });
  it("checks preview url when enabled", () => {
    const base = { kind: "preview", title: "t", body: "b" };
    const e = { previewEnabled: true };
    expect(parseAddInput({ ...base, preview: { images: ["/a.png"], url: "javascript:alert(1)" } }, e).ok).toBe(false);
    expect(parseAddInput({ ...base, preview: { images: ["/a.png"], url: "https://x.dev" } }, e).ok).toBe(true);
  });
});

describe("parseAddInput html (the rich part)", () => {
  const q = { kind: "question", title: "t", body: "b" };
  it("any kind takes one html file, with an optional height", () => {
    expect(parseAddInput({ ...q, html: { file: ".choibot/tickets/a.html" } }, noPreview)).toEqual({ ok: true, value: { ...q, html: { file: ".choibot/tickets/a.html" } } });
    expect(parseAddInput({ kind: "choice", title: "t", body: "b", options: opts, html: { file: "a.html", height: 420 } }, noPreview)).toMatchObject({ ok: true, value: { html: { file: "a.html", height: 420 } } });
    expect(parseAddInput({ kind: "pr", title: "t", body: "b", pr: { branch: "agent/x" }, html: { file: "a.html" } }, noPreview).ok).toBe(true);
  });
  it("the body stays required: with a page it is the short summary", () => {
    expect(parseAddInput({ kind: "question", title: "t", body: "  ", html: { file: "a.html" } }, noPreview)).toEqual({ ok: false, error: "body: is required with html: write a short summary (what it is, the one or two facts that decide, what to answer)" });
    expect(parseAddInput({ ...q, body: "x".repeat(1501), html: { file: "a.html" } }, noPreview)).toEqual({ ok: false, error: "body: must be at most 1500 characters" });
  });
  // The owner's ask of 2026-11-26: one main form per ticket. With a page, the page carries the
  // content and the body is a short summary; a body over the limit is refused at add time.
  it("with a page, a body over the summary limit is refused with what to do; a body at the limit passes", () => {
    expect(RICH_BODY_MAX).toBe(500);
    expect(parseAddInput({ ...q, body: "x".repeat(RICH_BODY_MAX), html: { file: "a.html" } }, noPreview)).toEqual({ ok: true, value: { ...q, body: "x".repeat(RICH_BODY_MAX), html: { file: "a.html" } } });
    expect(parseAddInput({ ...q, body: "x".repeat(RICH_BODY_MAX + 1), html: { file: "a.html" } }, noPreview)).toEqual({
      ok: false,
      error: "body: with a page, the body is a short summary of at most 500 characters (this one has 501). "
        + "Write what it is, the one or two facts that decide and what to answer; keep the rest in the page only. "
        + "Or remove the page and keep the body (at most 1500).",
    });
    for (const k of [{ kind: "choice", title: "t", options: opts }, { kind: "pr", title: "t", pr: { branch: "agent/x" } }]) {
      expect(parseAddInput({ ...k, body: "x".repeat(1400), html: { file: "a.html" } }, noPreview)).toMatchObject({ ok: false, error: expect.stringContaining("(this one has 1400)") });
    }
  });
  it("without a page the body keeps its limit of 1500, also with screenshots", () => {
    expect(parseAddInput({ ...q, body: "x".repeat(BODY_MAX) }, noPreview).ok).toBe(true);
    expect(parseAddInput({ ...q, body: "x".repeat(BODY_MAX + 1) }, noPreview)).toEqual({ ok: false, error: "body: must be at most 1500 characters" });
    const pr = { kind: "pr", title: "t", body: "x".repeat(BODY_MAX), pr: { url: "https://github.com/o/r/pull/7" }, preview: { images: [".choibot/previews/a-1.png"] } };
    expect(parseAddInput(pr, { previewEnabled: true }).ok).toBe(true);
  });
  // One count for both limits (bodyLength, the UTF-16 length that zod's .max used): a body that
  // passes one limit is never refused by the other for another count.
  it("counts the body one way for both limits", () => {
    expect(bodyLength("😀")).toBe(2);
    expect(parseAddInput({ ...q, body: "😀".repeat(BODY_MAX / 2) }, noPreview).ok).toBe(true);
    expect(parseAddInput({ ...q, body: "😀".repeat(BODY_MAX / 2 + 1) }, noPreview).ok).toBe(false);
    expect(parseAddInput({ ...q, body: "😀".repeat(RICH_BODY_MAX / 2), html: { file: "a.html" } }, noPreview).ok).toBe(true);
    expect(parseAddInput({ ...q, body: "😀".repeat(RICH_BODY_MAX / 2 + 1), html: { file: "a.html" } }, noPreview)).toMatchObject({ ok: false, error: expect.stringContaining("(this one has 502)") });
  });
  it("rejects a bad shape", () => {
    for (const html of [{}, { file: "" }, { file: 1 }, { file: "a.html", height: 20 }, { file: "a.html", height: 5000 }, { file: "a.html", height: 1.5 }, { file: "a.html", url: "https://x" }, "a.html", [{ file: "a.html" }]]) {
      expect(parseAddInput({ ...q, html }, noPreview).ok).toBe(false);
    }
  });
});

describe("validateUserAnswer", () => {
  it("validates choice", () => {
    expect(validateUserAnswer(item("choice"), { value: "B" })).toEqual({ ok: true, value: "B" });
    expect(validateUserAnswer(item("choice"), { value: "G" }).ok).toBe(false);
    expect(validateUserAnswer(item("choice"), { value: "approve" }).ok).toBe(false);
    expect(validateUserAnswer(item("choice"), { value: "reply", text: "other" })).toEqual({ ok: true, value: "reply", text: "other" });
    expect(validateUserAnswer(item("choice"), { value: "reply" }).ok).toBe(false);
  });
  it("validates pr", () => {
    expect(validateUserAnswer(item("pr"), { value: "approve" }).ok).toBe(true);
    expect(validateUserAnswer(item("pr"), { value: "changes" }).ok).toBe(false);
    expect(validateUserAnswer(item("pr"), { value: "changes", text: "fix" }).ok).toBe(true);
  });
  it("validates question and limits", () => {
    expect(validateUserAnswer(item("question"), { value: "reply", text: "yes" }).ok).toBe(true);
    expect(validateUserAnswer(item("question"), { value: "reply", text: "x".repeat(1501) }).ok).toBe(false);
    expect(validateUserAnswer(item("question"), { value: "approve" }).ok).toBe(false);
  });
  it("refuses auto", () => {
    expect(validateUserAnswer(item("pr"), { auto: true, value: "approve" })).toEqual({ ok: false, error: '"auto" is a master-only verb' });
  });
});

describe("parseRecommend", () => {
  it("validates choice and question", () => {
    expect(parseRecommend(item("choice"), { value: "A", why: "w", ruleIds: ["r_abc12"] }).ok).toBe(true);
    expect(parseRecommend(item("choice"), { value: "G", why: "w", ruleIds: ["r_abc12"] }).ok).toBe(false);
    expect(parseRecommend(item("question"), { value: "reply", why: "w", ruleIds: ["r_abc12"] }).ok).toBe(false);
    expect(parseRecommend(item("question"), { value: "Use the registry.", why: "w", ruleIds: ["r_abc12"] }).ok).toBe(true);
  });
  it("limits why and ruleIds", () => {
    const ids = ["r_aaaaa", "r_bbbbb", "r_ccccc", "r_ddddd", "r_eeeee", "r_fffff"];
    expect(parseRecommend(item("choice"), { value: "A", why: "w", ruleIds: ids }).ok).toBe(false);
    expect(parseRecommend(item("choice"), { value: "A", why: "w", ruleIds: [] }).ok).toBe(false);
    expect(parseRecommend(item("choice"), { value: "A", why: "w", ruleIds: ["bad"] }).ok).toBe(false);
    expect(parseRecommend(item("choice"), { value: "A", why: "x".repeat(301), ruleIds: ["r_abc12"] }).ok).toBe(false);
  });
});

const err = (r: { ok: boolean; error?: string }): string => (r.ok ? "" : (r as { error: string }).error);

describe("hardening", () => {
  const q = { kind: "question", title: "t", body: "b" };
  const mk = (extra: object) => parseAddInput({ kind: "choice", title: "t", body: "b", ...extra }, noPreview);
  it("bounds options", () => {
    const seven = "ABCDEFG".split("").map((key) => ({ key, label: "x" }));
    expect(err(mk({ options: seven }))).toMatch(/options/);
    expect(err(mk({ options: [{ key: "A", label: "x".repeat(41) }, { key: "B", label: "y" }] }))).toMatch(/label/);
    expect(err(mk({ options: [{ key: "A", label: "  " }, { key: "B", label: "y" }] }))).toMatch(/label/);
    expect(err(mk({ options: [{ key: "A", label: "x", detail: "d".repeat(201) }, { key: "B", label: "y" }] }))).toMatch(/detail/);
    expect(err(mk({ options: [{ key: "A", label: "x" }, { key: "A", label: "y" }] }))).toMatch(/key/);
  });
  it("rejects non-boolean blocking", () => {
    expect(err(parseAddInput({ ...q, blocking: "yes" }, noPreview))).toMatch(/blocking/);
  });
  it("validates pr.branch", () => {
    const pr = (p: object) => parseAddInput({ kind: "pr", title: "t", body: "b", pr: p }, noPreview);
    expect(err(pr({ branch: "-x" }))).toMatch(/branch/);
    expect(err(pr({ branch: "a..b" }))).toMatch(/branch/);
    expect(err(pr({ branch: "a b" }))).toMatch(/branch/);
    expect(err(pr({ url: "https://github.com/o/r/pull/1", branch: "agent/x" }))).toMatch(/not both/);
    expect(err(pr({}))).toMatch(/url or a branch/);
    expect(err(pr({ branch: "x".repeat(201) }))).toMatch(/branch/);
    expect(pr({ branch: " agent/x " })).toEqual({ ok: true, value: { kind: "pr", title: "t", body: "b", pr: { branch: "agent/x" } } });
  });
  it("bounds preview images and urls", () => {
    const pv = (p: object) => parseAddInput({ kind: "preview", title: "t", body: "b", preview: p }, { previewEnabled: true });
    expect(err(pv({ images: [] }))).toMatch(/images/);
    expect(err(pv({ images: Array(11).fill("/a.png") }))).toMatch(/images/);
    expect(pv({ images: Array(10).fill("/a.png") }).ok).toBe(true);
    expect(err(pv({ images: ["x".repeat(513)] }))).toMatch(/images/);
    expect(err(pv({ images: ["/a.png"], url: "https://x.dev/" + "a".repeat(260) }))).toMatch(/url/);
  });
  it("refuses auto even when false", () => {
    expect(err(validateUserAnswer(item("pr"), { auto: false, value: "approve" }))).toBe('"auto" is a master-only verb');
  });
  it("gives 400 text for an unknown kind", () => {
    const bad = { ...item("pr"), kind: "weird" } as unknown as QueueItem;
    expect(err(validateUserAnswer(bad, { value: "approve" }))).toMatch(/unknown item kind/);
  });
  it("refuses reply in any case and whitespace", () => {
    for (const v of [" reply", "Reply", "REPLY "]) expect(err(parseRecommend(item("question"), { value: v, why: "w", ruleIds: ["r_abc12"] }))).toMatch(/not reply/);
  });
  it("dedupes ruleIds", () => {
    const r = parseRecommend(item("choice"), { value: "A", why: "w", ruleIds: ["r_abc12", "r_abc12"] });
    expect(r).toEqual({ ok: true, value: { value: "A", why: "w", ruleIds: ["r_abc12"] } });
  });
  it("refuses recommend on pr and preview items", () => {
    expect(err(parseRecommend(item("pr"), { value: "approve", why: "w", ruleIds: ["r_abc12"] }))).toMatch(/only for choice and question/);
    expect(err(parseRecommend(item("preview"), { value: "approve", why: "w", ruleIds: ["r_abc12"] }))).toMatch(/only for choice and question/);
  });
});

describe("parseAddInput title is one line", () => {
  it("newlines, tabs and runs collapse to one space; a blank title fails", () => {
    const r = parseAddInput({ kind: "question", title: "  a\nb\t\tc \n", body: "b" }, noPreview);
    expect(r.ok && r.value.title).toBe("a b c");
    expect(parseAddInput({ kind: "question", title: "\n\t", body: "b" }, noPreview).ok).toBe(false);
  });
});
