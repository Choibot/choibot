// server/chief/queue/answerImages.test.ts — the images of a user's answer: the drafts (type from
// the bytes, the limits, the clean-up), the names an answer may give, the copy to the agent with
// basic and with strong protection, and the lines that the agent gets.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES } from "../../agents/upload.js";
import { ANSWER_IMAGE_RE, ANSWER_IMAGES_MAX, DRAFT_MAX_AGE_MS, DRAFT_RE, DRAFTS_MAX, answerKeeps, checkNames, pruneDrafts, saveDraft, takeDrafts } from "./answerImages.js";
import { formatAnswerLine } from "./lines.js";
import type { Answer, QueueItem } from "./types.js";
import { ANSWER_IMAGES_MAX as CLIENT_MAX } from "../../../src/lib/answerImages.js";

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
export const GIF = Buffer.from("GIF89a gif-body");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg-body")]);
// The real clock: a draft's age is its file time.
const NOW = Date.now();

let root: string;
let dir: string; // one ticket's media folder
let wt: string; // the agent's worktree
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "answer-images-"));
  dir = join(root, "media", "q1aaaaaaa");
  wt = join(root, "wt");
  mkdirSync(wt);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const draft = async (buf: Buffer = PNG): Promise<string> => {
  const r = await saveDraft(dir, buf, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.name;
};
const files = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);

describe("saveDraft: one image of an answer, kept as a draft of its ticket", () => {
  it("takes PNG, JPEG, GIF and WebP by their bytes; the server makes the name (0600)", async () => {
    for (const [buf, ext] of [[PNG, "png"], [JPG, "jpg"], [GIF, "gif"]] as const) {
      const name = await draft(buf);
      expect(name).toMatch(DRAFT_RE);
      expect(name.endsWith(`.${ext}`)).toBe(true);
      expect(readFileSync(join(dir, name))).toEqual(buf);
    }
  });
  it("refuses a file whose bytes are not one of the four images: SVG, HTML, text, an empty file", async () => {
    for (const bad of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from("<!doctype html><script>x</script>"), Buffer.from("hello"), PNG.subarray(0, 7)]) {
      const r = await saveDraft(dir, bad, NOW);
      expect(r).toMatchObject({ ok: false, code: 415 });
    }
    expect(await saveDraft(dir, Buffer.alloc(0), NOW)).toMatchObject({ ok: false, code: 400 });
    expect(files(dir)).toEqual([]);
  });
  it("refuses more than the composer's 10 MB", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(await saveDraft(dir, big, NOW)).toMatchObject({ ok: false, code: 413 });
  });
  it("counts the drafts of the ticket: at most 12 wait, whatever the answer", async () => {
    for (let n = 0; n < DRAFTS_MAX; n++) await draft();
    const r = await saveDraft(dir, PNG, NOW);
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(files(dir)).toHaveLength(DRAFTS_MAX);
  });
  it("removes the drafts older than a day at the next upload; a kept image of an answer stays", async () => {
    const old = await draft();
    writeFileSync(join(dir, "a1-1.png"), PNG);
    const t = (NOW - DRAFT_MAX_AGE_MS - 1000) / 1000;
    utimesSync(join(dir, old), t, t);
    utimesSync(join(dir, "a1-1.png"), t, t);
    const fresh = await draft();
    expect(files(dir)).toEqual(["a1-1.png", fresh].sort());
    expect(await pruneDrafts(dir, NOW)).toEqual([fresh]);
    expect(await pruneDrafts(join(root, "none"), NOW)).toEqual([]);
  });
});

describe("checkNames: what an answer may name", () => {
  it("draft names only (the server's pattern), at most four, each once", () => {
    expect(checkNames(undefined)).toEqual({ ok: true, names: [] });
    expect(checkNames(["d-0123456789abcdef.png"])).toEqual({ ok: true, names: ["d-0123456789abcdef.png"] });
    expect(checkNames("d-0123456789abcdef.png")).toEqual({ ok: false, error: "images must be a list" });
    const five = [0, 1, 2, 3, 4].map((n) => `d-${String(n).repeat(16)}.png`);
    expect(checkNames(five)).toMatchObject({ ok: false, error: `at most ${ANSWER_IMAGES_MAX} images in one answer` });
    expect(checkNames(["d-0123456789abcdef.png", "d-0123456789abcdef.png"])).toMatchObject({ ok: false, error: "an image is named twice" });
    for (const bad of ["../d-0123456789abcdef.png", "/tmp/x.png", ".choibot/uploads/screenshot-1-0.png", "a1-1.png", "d-0123456789ABCDEF.png", "d-0123456789abcdef.svg", "d-0123456789abcdef.png/", 7]) {
      expect(checkNames([bad])).toMatchObject({ ok: false, error: "images must be the names of uploaded images" });
    }
  });
  it("the client's limit is the server's", () => {
    expect(CLIENT_MAX).toBe(ANSWER_IMAGES_MAX);
  });
});

describe("takeDrafts: the answer's images go to the agent and stay with the ticket", () => {
  const rec = (o: object = {}) => ({ id: "a1", worktree: wt, repo: wt, ...o });
  it("basic protection: the composer's path in the worktree (.choibot/uploads), the same bytes; the ticket keeps a<seq>-<n>", async () => {
    const one = await draft(PNG), two = await draft(GIF), left = await draft(JPG);
    const r = await takeDrafts(dir, [one, two], 3, rec());
    if (!r.ok) throw new Error(r.error);
    expect(r.images.map((x) => x.name)).toEqual(["a3-1.png", "a3-2.gif"]);
    expect(r.images[0]!.path).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.png$/);
    expect(r.images[1]!.path).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.gif$/);
    expect(readFileSync(join(wt, r.images[0]!.path))).toEqual(PNG);
    expect(readFileSync(join(wt, r.images[1]!.path))).toEqual(GIF);
    // The draft that was not sent stays until the answer is written (the caller removes it).
    expect(files(dir)).toEqual(["a3-1.png", "a3-2.gif", left].sort());
    for (const x of r.images) expect(x.name).toMatch(ANSWER_IMAGE_RE);
  });
  it("undo: the kept images are drafts again under their own names (a failed answer write)", async () => {
    const one = await draft(PNG), two = await draft(GIF);
    const r = await takeDrafts(dir, [one, two], 1, rec());
    if (!r.ok) throw new Error(r.error);
    expect(files(dir)).toEqual(["a1-1.png", "a1-2.gif"]);
    await r.undo();
    expect(files(dir)).toEqual([one, two].sort());
    // The same answer once more: it works, and the agent gets a new copy of each.
    const again = await takeDrafts(dir, [one, two], 1, rec());
    expect(again.ok).toBe(true);
    expect(files(join(wt, ".choibot", "uploads"))).toHaveLength(4);
  });
  it("strong protection with a clone: AGENT_HOME_ROOT/uploads/<id>/, the full path that the agent opens; never the clone", async () => {
    const homes = join(root, "homes");
    mkdirSync(join(homes, "uploads"), { recursive: true });
    chmodSync(join(homes, "uploads"), 0o750);
    for (const [k, v] of Object.entries({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242", AGENT_HOME_ROOT: homes })) vi.stubEnv(k, v);
    const clone = join(homes, "clones", "a1");
    const name = await draft();
    const r = await takeDrafts(dir, [name], 1, rec({ worktree: clone, clone: true as const }));
    if (!r.ok) throw new Error(r.error);
    expect(r.images[0]!.path.startsWith(join(homes, "uploads", "a1") + "/")).toBe(true);
    expect(readFileSync(r.images[0]!.path)).toEqual(PNG);
    expect(existsSync(clone)).toBe(false);
  });
  it("a name that is no draft of THIS ticket (another ticket's, gone, changed) is refused, and no file is touched", async () => {
    const other = join(root, "media", "q2bbbbbbb");
    const theirs = (await saveDraft(other, PNG, NOW) as { name: string }).name;
    const mine = await draft();
    const save = vi.fn(async () => "x");
    expect(await takeDrafts(dir, [mine, theirs], 1, rec(), { save })).toMatchObject({ ok: false, code: 409 });
    writeFileSync(join(dir, "d-ffffffffffffffff.gif"), PNG); // its bytes are not a GIF
    expect(await takeDrafts(dir, [mine, "d-ffffffffffffffff.gif"], 1, rec(), { save })).toMatchObject({ ok: false, code: 409 });
    expect(save).not.toHaveBeenCalled();
    expect(files(dir)).toEqual(["d-ffffffffffffffff.gif", mine].sort());
    expect(files(other)).toEqual([theirs]);
    expect(files(join(wt, ".choibot", "uploads"))).toEqual([]);
  });
  it("an agent with no folder: refused (the user sends without them), the drafts stay", async () => {
    const name = await draft();
    expect(await takeDrafts(dir, [name], 1, rec({ worktree: join(root, "gone") }))).toMatchObject({ ok: false, code: 409 });
    expect(await takeDrafts(dir, [name], 1, null)).toMatchObject({ ok: false, code: 409 });
    expect(files(dir)).toEqual([name]);
  });
  it("answerKeeps: only a name that an answer (now or in the history) keeps, never a draft", () => {
    const item = { answer: { images: [{ name: "a2-1.png", path: "p" }] }, history: [{ images: [{ name: "a1-1.jpg", path: "p" }] }] };
    expect(answerKeeps(item, "a2-1.png")).toBe(true);
    expect(answerKeeps(item, "a1-1.jpg")).toBe(true);
    expect(answerKeeps(item, "a3-1.png")).toBe(false);
    expect(answerKeeps({ ...item, answer: { images: [{ name: "d-0123456789abcdef.png", path: "p" }] } }, "d-0123456789abcdef.png")).toBe(false);
  });
});

describe("the lines that the agent gets", () => {
  const mk = (o: Partial<QueueItem> = {}): QueueItem => ({
    id: "q7k2m9x1a", kind: "question", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "r",
    title: "t", body: "b", createdAt: 1, updatedAt: 1, status: "open", blocking: true, history: [], answerSeq: 0, ...o,
  });
  const ans = (o: Partial<Answer>): Answer => ({ value: "reply", by: "user", via: "tab", at: 1, ...o });
  const BASIC = [{ name: "a1-1.png", path: ".choibot/uploads/screenshot-1764100000000-0.png" }, { name: "a1-2.jpg", path: ".choibot/uploads/screenshot-1764100000000-1.jpg" }];
  const STRONG = [{ name: "a1-1.png", path: "/srv/choibot/agent-homes/uploads/a1/screenshot-1764100000000-0.png" }];
  it("one indented line for each image: the bare path, as the composer puts it (basic protection)", () => {
    expect(formatAnswerLine(mk(), ans({ text: "this error\nafter the deploy", images: BASIC }))).toBe(
      "[queue q7k2m9x1a] question: this error\n  after the deploy\n  .choibot/uploads/screenshot-1764100000000-0.png\n  .choibot/uploads/screenshot-1764100000000-1.jpg");
  });
  it("strong protection: the full path in AGENT_HOME_ROOT/uploads/<id>/", () => {
    expect(formatAnswerLine(mk(), ans({ text: "see", images: STRONG }))).toBe(
      "[queue q7k2m9x1a] question: see\n  /srv/choibot/agent-homes/uploads/a1/screenshot-1764100000000-0.png");
  });
  it("no text: the header says how many; the same for other on a choice and a change request", () => {
    expect(formatAnswerLine(mk(), ans({ images: BASIC }))).toBe(
      "[queue q7k2m9x1a] question: (2 images)\n  .choibot/uploads/screenshot-1764100000000-0.png\n  .choibot/uploads/screenshot-1764100000000-1.jpg");
    const choice = mk({ kind: "choice", choice: { options: [{ key: "A", label: "x" }] } });
    expect(formatAnswerLine(choice, ans({ images: STRONG }))).toBe("[queue q7k2m9x1a] choice: other: (1 image)\n  /srv/choibot/agent-homes/uploads/a1/screenshot-1764100000000-0.png");
    const pr = mk({ kind: "pr", pr: { url: "https://github.com/o/r/pull/3", number: 3 } });
    expect(formatAnswerLine(pr, ans({ value: "changes", text: "the button", images: STRONG }))).toBe(
      "[queue q7k2m9x1a] pr: changes requested: the button\n  /srv/choibot/agent-homes/uploads/a1/screenshot-1764100000000-0.png");
  });
  it("an answer of the master never carries image lines", () => {
    expect(formatAnswerLine(mk(), ans({ by: "master", text: "t", ruleIds: ["r_ab12c"], images: STRONG }))).toBe("[queue q7k2m9x1a] auto (rule r_ab12c): question: t");
  });
});
