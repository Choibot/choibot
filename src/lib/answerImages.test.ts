import { describe, expect, it } from "vitest";
import { ANSWER_IMAGE_ACCEPT, ANSWER_IMAGES_MAX, hasImage, makeAnswerImages, ticketAt, uploadAnswerImage } from "./answerImages";
import { MAX_UPLOAD_BYTES } from "./upload";

const file = (name: string, type: string, size = 10): File => new File([new Uint8Array(size)], name, { type });
const flush = () => new Promise((r) => setTimeout(r, 0));

function store(answer: (id: string, f: File) => { name: string } | { error: string } | Promise<{ name: string } | { error: string }>) {
  const urls: string[] = [], revoked: string[] = [], ups: string[] = [];
  let n = 0;
  const s = makeAnswerImages({
    upload: async (id, f) => { ups.push(`${id}:${f.name}`); return answer(id, f); },
    createObjectURL: () => { const u = `blob:${n++}`; urls.push(u); return u; },
    revokeObjectURL: (u) => { revoked.push(u); },
  });
  return { s, urls, revoked, ups };
}

describe("the images of a reply (makeAnswerImages)", () => {
  it("adds images only, at most four for one ticket, and says why a file was left out", async () => {
    const { s, ups } = store((_id, f) => ({ name: `d-${f.name.padEnd(16, "0").slice(0, 16)}.png` }));
    expect(s.add("q1", [file("a", "image/png"), file("b.pdf", "application/pdf")])).toBe("Only PNG, JPEG, GIF and WebP images go with an answer.");
    expect(s.add("q1", [file("b", "image/jpeg"), file("c", "image/gif"), file("d", "image/webp"), file("e", "image/png")])).toBe(`At most ${ANSWER_IMAGES_MAX} images in one answer.`);
    expect(s.add("q1", [file("f", "image/heic")])).toBe("Only PNG, JPEG, GIF and WebP images go with an answer.");
    expect(s.get("q1").map((a) => a.label)).toEqual(["a", "b", "c", "d"]);
    expect(ups).toEqual(["q1:a", "q1:b", "q1:c", "q1:d"]);
    expect(s.get("q2")).toEqual([]);
    expect(s.blocked("q1")).toBe(true); // uploads still run
    await flush();
    expect(s.blocked("q1")).toBe(false);
    expect(s.names("q1")).toHaveLength(4);
  });
  it("a failed upload keeps the reply back until it is removed; remove and clear free the previews", async () => {
    const { s, urls, revoked } = store((_id, f) => (f.name === "bad" ? { error: "not a PNG, JPEG, GIF or WebP image" } : { name: "d-0123456789abcdef.png" }));
    s.add("q1", [file("good", "image/png"), file("bad", "image/png")]);
    await flush();
    expect(s.get("q1").map((a) => a.state)).toEqual(["ok", "err"]);
    expect(s.get("q1")[1]!.error).toBe("not a PNG, JPEG, GIF or WebP image");
    expect(s.blocked("q1")).toBe(true);
    s.remove("q1", s.get("q1")[1]!.key);
    expect(s.blocked("q1")).toBe(false);
    expect(s.names("q1")).toEqual(["d-0123456789abcdef.png"]);
    s.clear("q1");
    expect(s.get("q1")).toEqual([]);
    expect(revoked.sort()).toEqual(urls.sort());
  });
  it("the note: why the last add left a file out, per ticket; a clean add, a remove or a clear ends it", () => {
    const { s } = store(() => new Promise(() => {}));
    s.add("q1", [file("a.pdf", "application/pdf")]);
    expect(s.note("q1")).toBe("Only PNG, JPEG, GIF and WebP images go with an answer.");
    expect(s.note("q2")).toBeNull();
    s.add("q1", [file("a", "image/png")]);
    expect(s.note("q1")).toBeNull();
    s.add("q1", [file("b", "image/png"), file("c", "image/png"), file("d", "image/png"), file("e", "image/png")]);
    expect(s.note("q1")).toBe(`At most ${ANSWER_IMAGES_MAX} images in one answer.`);
    s.remove("q1", s.get("q1")[0]!.key);
    expect(s.note("q1")).toBeNull();
    s.add("q1", [file("x.txt", "text/plain")]);
    s.clear("q1");
    expect(s.note("q1")).toBeNull();
    expect(s.get("q1")).toEqual([]);
  });
  it("an upload that ends after a remove changes nothing", async () => {
    let done!: (v: { name: string }) => void;
    const { s } = store(() => new Promise((r) => { done = r; }));
    s.add("q1", [file("a", "image/png")]);
    s.remove("q1", s.get("q1")[0]!.key);
    done({ name: "d-0123456789abcdef.png" });
    await flush();
    expect(s.get("q1")).toEqual([]);
  });
  it("the list keeps its identity until it changes (useSyncExternalStore)", () => {
    const { s } = store(() => new Promise(() => {}));
    let calls = 0;
    const off = s.subscribe(() => { calls++; });
    s.add("q1", [file("a", "image/png")]);
    expect(s.get("q1")).toBe(s.get("q1"));
    expect(calls).toBe(1);
    off();
  });
});

describe("uploadAnswerImage", () => {
  it("sends the bytes as application/octet-stream to the ticket's route and returns the draft name", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => { seen.push({ url, ...(init ? { init } : {}) }); return new Response(JSON.stringify({ name: "d-0123456789abcdef.png" }), { status: 200 }); }) as never;
    expect(await uploadAnswerImage("q1", file("a.png", "image/png"), { fetch })).toEqual({ name: "d-0123456789abcdef.png" });
    expect(seen[0]!.url).toBe("/api/queue/q1/answer-image");
    expect(seen[0]!.init?.method).toBe("POST");
    expect((seen[0]!.init?.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
  });
  it("gives the server's reason, and says the size limit before the upload", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: "pair-required" }), { status: 403 })) as never;
    expect(await uploadAnswerImage("q1", file("a.png", "image/png"), { fetch })).toEqual({ error: "pair-required" });
    const never = (async () => { throw new Error("no call"); }) as never;
    expect(await uploadAnswerImage("q1", file("big.png", "image/png", MAX_UPLOAD_BYTES + 1), { fetch: never })).toEqual({ error: "too large (max 10 MB)" });
    expect(await uploadAnswerImage("q1", file("a.png", "image/png"), { fetch: never })).toEqual({ error: "no call" });
  });
  it("the file picker asks for the four types only (an iPhone gives a JPEG for a HEIC photo)", () => {
    expect(ANSWER_IMAGE_ACCEPT).toBe("image/png,image/jpeg,image/gif,image/webp");
  });
});

describe("a drop on the agent's pane (AgentPane's cover)", () => {
  const el = (attrs: Record<string, string> | null, parent: unknown = null) => ({
    dataset: attrs ?? {}, closest: (sel: string) => (sel === "[data-answer-images]" ? (attrs && "answerImages" in attrs ? el(attrs) : (parent as { closest?: (s: string) => unknown })?.closest?.(sel) ?? null) : null),
  });
  it("finds the ticket card that takes images under the point, through the cover", () => {
    const card = el({ ticketCard: "q1", answerImages: "" });
    const inner = el({}, card);
    const cover = el({});
    expect(ticketAt(1, 2, { elementsFromPoint: () => [cover, inner] as never })).toBe("q1");
    expect(ticketAt(1, 2, { elementsFromPoint: () => [cover, el({ ticketCard: "q2" })] as never })).toBeNull();
    expect(ticketAt(1, 2, { elementsFromPoint: () => [cover] as never })).toBeNull();
  });
  it("goes to the ticket only with an image; other files stay the composer's", () => {
    expect(hasImage([file("a.png", "image/png"), file("b.pdf", "application/pdf")])).toBe(true);
    expect(hasImage([file("b.pdf", "application/pdf")])).toBe(false);
    expect(hasImage([])).toBe(false);
  });
});
