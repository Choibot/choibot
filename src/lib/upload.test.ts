import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_EXTS, IMAGE_TYPES, MAX_UPLOAD_BYTES, guardFileDrops, hasFiles, insertPaths, uploadFile, uploadPath } from "./upload";
import * as server from "../../server/agents/upload";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const file = (name: string, type: string, size = 3) => new File([new Uint8Array(size)], name, { type });

describe("upload limits", () => {
  it("mirror the server's", () => {
    expect(MAX_UPLOAD_BYTES).toBe(server.MAX_UPLOAD_BYTES);
    expect(IMAGE_TYPES).toEqual(Object.keys(server.EXT_BY_TYPE));
    expect(FILE_EXTS).toEqual([...server.FILE_EXTS]);
  });
});

describe("uploadFile", () => {
  const fetchMock = vi.fn();
  afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });
  const call = () => fetchMock.mock.calls[0] as [string, RequestInit];
  const type = () => new Headers(call()[1].headers).get("content-type");

  it("sends a known image as its own type and returns the path", async () => {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(json(200, { path: ".choibot/uploads/screenshot-1-0.png" })));
    expect(await uploadFile(uploadPath("a/1"), file("shot.png", "image/png"))).toEqual({ path: ".choibot/uploads/screenshot-1-0.png" });
    expect(call()[0]).toBe("/api/agents/a%2F1/upload");
    expect(type()).toBe("image/png");
  });

  it("sends another file as bytes with the extension of its name", async () => {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(json(200, { path: ".choibot/uploads/file-1-0.pdf" })));
    await uploadFile("/api/agents/a/upload", file("Report v2.PDF", "application/pdf"));
    expect(call()[0]).toBe("/api/agents/a/upload?ext=PDF");
    expect(type()).toBe("application/octet-stream");
  });

  it("returns the server's reason for a refused file", async () => {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(json(415, { error: "file type not allowed (allowed: png)" })));
    expect(await uploadFile("/u", file("a.exe", ""))).toEqual({ error: "file type not allowed (allowed: png)" });
    fetchMock.mockResolvedValue(json(413, { error: "Payload Too Large", message: "Request body is too large" }));
    expect(await uploadFile("/u", file("a.png", "image/png"))).toEqual({ error: "Request body is too large" });
    fetchMock.mockResolvedValue(new Response("oops", { status: 502 }));
    expect(await uploadFile("/u", file("a.png", "image/png"))).toEqual({ error: "HTTP 502" });
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));
    expect(await uploadFile("/u", file("a.png", "image/png"))).toEqual({ error: "Failed to fetch" });
  });

  it("refuses a file over the cap with no request", async () => {
    vi.stubGlobal("fetch", fetchMock);
    expect(await uploadFile("/u", file("big.png", "image/png", MAX_UPLOAD_BYTES + 1))).toEqual({ error: "too large (max 10 MB)" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("insertPaths", () => {
  it("puts the paths at the cursor with a space between and after", () => {
    expect(insertPaths("", 0, 0, ["a.png", "b.pdf"])).toEqual({ text: "a.png b.pdf ", cursor: 12 });
    expect(insertPaths("see ", 4, 4, ["a.png"])).toEqual({ text: "see a.png ", cursor: 10 });
  });
  it("adds a space when the path would touch a word, and replaces the selection", () => {
    expect(insertPaths("look at", 7, 7, ["a.png"])).toEqual({ text: "look at a.png ", cursor: 14 });
    expect(insertPaths("fix THIS now", 4, 8, ["a.png"])).toEqual({ text: "fix a.png now", cursor: 9 });
  });
  it("changes nothing with no path", () => {
    expect(insertPaths("abc", 1, 2, [])).toEqual({ text: "abc", cursor: 2 });
  });
});

describe("guardFileDrops", () => {
  const listen = () => {
    const handlers = new Map<string, (e: DragEvent) => void>();
    const off = guardFileDrops({
      addEventListener: (name: string, fn: unknown) => { handlers.set(name, fn as (e: DragEvent) => void); },
      removeEventListener: (name: string) => { handlers.delete(name); },
    } as unknown as Window);
    return { handlers, off };
  };
  const event = (types: string[], defaultPrevented = false) => {
    const e = { defaultPrevented, dataTransfer: { types, dropEffect: "copy" }, preventDefault: vi.fn() };
    return e as unknown as DragEvent & { preventDefault: ReturnType<typeof vi.fn> };
  };

  it("stops a file drop that nothing took, and leaves text and taken drops alone", () => {
    const { handlers, off } = listen();
    const stray = event(["Files"]);
    handlers.get("drop")!(stray);
    expect(stray.preventDefault).toHaveBeenCalled();
    expect(stray.dataTransfer!.dropEffect).toBe("none");
    const text = event(["text/plain"]);
    handlers.get("dragover")!(text);
    expect(text.preventDefault).not.toHaveBeenCalled();
    const taken = event(["Files"], true);
    handlers.get("dragover")!(taken);
    expect(taken.dataTransfer!.dropEffect).toBe("copy");
    off();
    expect(handlers.size).toBe(0);
  });

  it("hasFiles reads the drag types", () => {
    expect(hasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(hasFiles({ types: ["text/uri-list"] } as unknown as DataTransfer)).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});
