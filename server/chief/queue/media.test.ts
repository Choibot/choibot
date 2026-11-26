import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_MAX_BYTES, MEDIA_MAX_FILES, acceptMedia, sniffImage } from "./media.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg-body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 webp-body")]);

let root: string;
let cwd: string;
let outside: string;
let destDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-media-"));
  cwd = join(root, "wt");
  outside = join(root, "outside");
  mkdirSync(cwd);
  mkdirSync(outside);
  destDir = join(root, "media", "q7k2m9x1a");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const put = (rel: string, data: Buffer | string): string => {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
};
const mode = (p: string): number => statSync(p).mode & 0o777;

// Every refusal must leave no media folder behind.
async function refused(images: string[]): Promise<string> {
  const r = await acceptMedia({ roots: [root], cwd, images, destDir });
  expect(existsSync(destDir)).toBe(false);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.error;
}

describe("sniffImage", () => {
  it("knows PNG, JPEG and WebP by their magic bytes", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPG)).toBe("jpg");
    expect(sniffImage(WEBP)).toBe("webp");
  });

  it("refuses other and short data", () => {
    expect(sniffImage(Buffer.from("hello world\n"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(PNG.subarray(0, 7))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImage(Buffer.from("RIFF\x20\x00\x00\x00WAVEfmt "))).toBeNull();
    expect(sniffImage(Buffer.from("RIFF\x20\x00\x00\x00WEB"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF8"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF90a"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  // GIF for an answer's image (answerImages.ts); a preview stays PNG, JPEG or WebP.
  it("knows GIF 87a and 89a; a preview refuses a GIF", async () => {
    expect(sniffImage(Buffer.from("GIF87a body"))).toBe("gif");
    expect(sniffImage(Buffer.from("GIF89a body"))).toBe("gif");
    put("a.gif", Buffer.from("GIF89a body"));
    expect(await refused(["a.gif"])).toBe('"a.gif": not a PNG, JPEG or WebP image');
  });
});

describe("acceptMedia", () => {
  it("copies PNG, JPEG and WebP as 1.png, 2.jpg, 3.webp (files 0600, dir 0700)", async () => {
    put(".choibot/previews/login-1.png", PNG);
    const jpgAbs = put("shots/b.jpeg", JPG);
    put("c.webp", WEBP);
    const r = await acceptMedia({ roots: [root], cwd, images: [".choibot/previews/login-1.png", jpgAbs, "./c.webp"], destDir });
    expect(r).toEqual({ ok: true, names: ["1.png", "2.jpg", "3.webp"] });
    expect(readdirSync(destDir).sort()).toEqual(["1.png", "2.jpg", "3.webp"]);
    expect(readFileSync(join(destDir, "1.png")).equals(PNG)).toBe(true);
    expect(readFileSync(join(destDir, "2.jpg")).equals(JPG)).toBe(true);
    expect(readFileSync(join(destDir, "3.webp")).equals(WEBP)).toBe(true);
    expect(mode(destDir)).toBe(0o700);
    expect(mode(dirname(destDir))).toBe(0o700);
    for (const n of ["1.png", "2.jpg", "3.webp"]) expect(mode(join(destDir, n))).toBe(0o600);
  });

  it("names the file by its bytes, not by the extension the agent gave", async () => {
    put("shot.png", JPG);
    expect(await acceptMedia({ roots: [root], cwd, images: ["shot.png"], destDir })).toEqual({ ok: true, names: ["1.jpg"] });
  });

  it("refuses a symlink inside cwd that points to /etc/passwd, without naming the target", async () => {
    symlinkSync("/etc/passwd", join(cwd, "passwd.png"));
    const err = await refused(["passwd.png"]);
    expect(err).toBe('"passwd.png": outside the agent folder');
    expect(err).not.toContain("/etc");
  });

  it("refuses a final-component symlink to a PNG inside cwd (O_NOFOLLOW)", async () => {
    put("real.png", PNG);
    symlinkSync(join(cwd, "real.png"), join(cwd, "link.png"));
    expect(await refused(["link.png"])).toBe('"link.png": is a symlink');
  });

  it("refuses ../outside.png", async () => {
    writeFileSync(join(root, "outside.png"), PNG);
    expect(await refused(["../outside.png"])).toBe('"../outside.png": outside the agent folder');
  });

  it("refuses an absolute path outside cwd", async () => {
    const abs = join(outside, "x.png");
    writeFileSync(abs, PNG);
    const err = await refused([abs]);
    expect(err).toBe(`${JSON.stringify(abs)}: outside the agent folder`);
  });

  it("refuses text bytes named .png", async () => {
    put("notes.png", "hello world\n");
    expect(await refused(["notes.png"])).toBe('"notes.png": not a PNG, JPEG or WebP image');
  });

  it("refuses an empty file", async () => {
    put("empty.png", "");
    expect(await refused(["empty.png"])).toBe('"empty.png": not a PNG, JPEG or WebP image');
  });

  it("refuses a 6 MB file and accepts one of exactly 5 MB", async () => {
    put("big.png", Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
    expect(await refused(["big.png"])).toBe('"big.png": larger than 5 MB');
    put("edge.png", Buffer.concat([PNG, Buffer.alloc(MEDIA_MAX_BYTES - PNG.length)]));
    const r = await acceptMedia({ roots: [root], cwd, images: ["edge.png"], destDir });
    expect(r).toEqual({ ok: true, names: ["1.png"] });
    expect(statSync(join(destDir, "1.png")).size).toBe(MEDIA_MAX_BYTES);
  });

  it("refuses a file that grew after its size was read: changed while reading", async () => {
    put("grow.png", Buffer.concat([PNG, Buffer.alloc(100)]));
    const probe = await open(join(cwd, "grow.png"), "r");
    const proto = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const realStat = proto.stat;
    // fstat reports the size before the growth; the read then finds more bytes.
    const spy = vi.spyOn(proto, "stat").mockImplementation(async function (this: FileHandle) {
      return Object.assign(await realStat.call(this), { size: PNG.length });
    } as FileHandle["stat"]);
    try {
      expect(await refused(["grow.png"])).toBe('"grow.png": changed while reading');
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses 11 paths and accepts 10", async () => {
    expect(MEDIA_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(MEDIA_MAX_FILES).toBe(10);
    put("a.png", PNG);
    expect(await refused(Array(11).fill("a.png"))).toBe("too many images (max 10)");
    const r = await acceptMedia({ roots: [root], cwd, images: Array(10).fill("a.png"), destDir });
    expect(r).toEqual({ ok: true, names: Array.from({ length: 10 }, (_, i) => `${i + 1}.png`) });
  });

  it("clips a long agent path in the error text to 200 characters", async () => {
    const long = "x".repeat(500) + ".png";
    const err = await refused([long]);
    expect(err.length).toBeLessThan(260);
    expect(err).not.toContain("x".repeat(250));
    expect(err).toContain("x".repeat(150));
  });

  it("refuses zero images and empty or NUL paths", async () => {
    expect(await refused([])).toBe("no images");
    put("a.png", PNG);
    expect(await refused(["a.png", ""])).toBe("image 2: invalid path");
    expect(await refused(["a.png\0x"])).toBe("image 1: invalid path");
    expect(await refused([42 as unknown as string])).toBe("image 1: invalid path");
  });

  // Review Focus 1: all or nothing.
  it("refuses a missing path and leaves no media folder, even after a good image was copied", async () => {
    put("good.png", PNG);
    expect(await refused(["good.png", "missing.png"])).toBe('"missing.png": not found');
  });

  it("refuses a later bad image after copying earlier ones, and removes them", async () => {
    put("a.png", PNG);
    put("b.jpg", JPG);
    put("c.png", "not an image");
    expect(await refused(["a.png", "b.jpg", "c.png"])).toBe('"c.png": not a PNG, JPEG or WebP image');
  });

  // Review Focus 1: the swap race between the realpath check and the open.
  it("refuses a path whose parent dir is swapped for a symlink to an outside dir after the check", async () => {
    put("sub/shot.png", PNG);
    writeFileSync(join(outside, "shot.png"), PNG);
    const afterCheck = vi.fn(async (abs: string) => {
      expect(abs).toBe(join(cwd, "sub", "shot.png"));
      renameSync(join(cwd, "sub"), join(cwd, "sub-old"));
      symlinkSync(outside, join(cwd, "sub"));
    });
    const r = await acceptMedia({ roots: [root], cwd, images: ["sub/shot.png"], destDir, afterCheck });
    expect(afterCheck).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: false, error: '"sub/shot.png": left the agent folder while opening' });
    expect(existsSync(destDir)).toBe(false);
  });

  it("accepts a parent dir symlink that stays inside cwd", async () => {
    put("real/shot.png", PNG);
    symlinkSync(join(cwd, "real"), join(cwd, "alias"));
    expect(await acceptMedia({ roots: [root], cwd, images: ["alias/shot.png"], destDir })).toEqual({ ok: true, names: ["1.png"] });
  });

  it("refuses a directory and a FIFO without blocking", async () => {
    mkdirSync(join(cwd, "dir.png"));
    expect(await refused(["dir.png"])).toBe('"dir.png": not a regular file');
    execFileSync("mkfifo", [join(cwd, "pipe.png")]);
    expect(await refused(["pipe.png"])).toBe('"pipe.png": not a regular file');
  });

  it("refuses an existing destDir and keeps the files already in it", async () => {
    put("a.png", PNG);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "keep.txt"), "x");
    const r = await acceptMedia({ roots: [root], cwd, images: ["a.png"], destDir });
    expect(r).toEqual({ ok: false, error: "media folder already exists" });
    expect(readdirSync(destDir)).toEqual(["keep.txt"]);
  });

  it("refuses a missing agent folder", async () => {
    const r = await acceptMedia({ roots: [root], cwd: join(root, "gone"), images: ["a.png"], destDir });
    expect(r).toEqual({ ok: false, error: "agent folder not found" });
    expect(existsSync(destDir)).toBe(false);
  });
});

// Phase 2b carry-overs (2c): a hard link is another name for a file that may
// sit outside the cwd, and the agent's cwd itself must sit in an agent root.
describe("acceptMedia hard links and agent roots", () => {
  it("refuses a file with another hard link (nlink 2), and leaves no media folder", async () => {
    put("shot.png", PNG);
    linkSync(join(cwd, "shot.png"), join(outside, "secret.png"));
    expect(await refused(["shot.png"])).toBe('"shot.png": has other hard links');
  });

  it("refuses a cwd symlinked to a dir outside every root: nothing created", async () => {
    const ws = join(root, "ws");
    mkdirSync(ws);
    writeFileSync(join(outside, "a.png"), PNG);
    symlinkSync(outside, join(ws, "agent"));
    const r = await acceptMedia({ roots: [ws], cwd: join(ws, "agent"), images: ["a.png"], destDir });
    expect(r).toEqual({ ok: false, error: "agent folder outside the agent roots" });
    expect(existsSync(dirname(destDir))).toBe(false);
  });

  it("accepts a cwd equal to a root, a cwd below a root given through a symlink, and skips a root that does not resolve", async () => {
    put("a.png", PNG);
    expect(await acceptMedia({ roots: [cwd], cwd, images: ["a.png"], destDir })).toEqual({ ok: true, names: ["1.png"] });
    rmSync(dirname(destDir), { recursive: true });
    symlinkSync(root, join(outside, "root-link"));
    expect(await acceptMedia({ roots: [join(root, "missing"), join(outside, "root-link")], cwd, images: ["a.png"], destDir }))
      .toEqual({ ok: true, names: ["1.png"] });
  });

  it("checks the path boundary: a cwd <x>/wt is not below a root <x>/w; no roots refuses every cwd", async () => {
    put("a.png", PNG);
    mkdirSync(join(root, "w"));
    expect(await acceptMedia({ roots: [join(root, "w")], cwd, images: ["a.png"], destDir }))
      .toEqual({ ok: false, error: "agent folder outside the agent roots" });
    expect(await acceptMedia({ roots: [], cwd, images: ["a.png"], destDir }))
      .toEqual({ ok: false, error: "agent folder outside the agent roots" });
    expect(existsSync(dirname(destDir))).toBe(false);
  });

  it("a missing agent folder is still 'agent folder not found' (checked before the roots)", async () => {
    expect(await acceptMedia({ roots: [], cwd: join(root, "gone"), images: ["a.png"], destDir }))
      .toEqual({ ok: false, error: "agent folder not found" });
  });
});
