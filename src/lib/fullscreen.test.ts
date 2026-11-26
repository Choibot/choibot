import { describe, expect, it, vi } from "vitest";
import { requestElementFullscreen } from "./fullscreen.js";

describe("requestElementFullscreen", () => {
  it("uses the standard fullscreen method", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    expect(await requestElementFullscreen({ requestFullscreen } as unknown as Element)).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("uses the Safari-prefixed method when needed", async () => {
    const webkitRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    expect(await requestElementFullscreen({ webkitRequestFullscreen } as unknown as Element)).toBe(true);
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
  });

  it("fails closed when fullscreen is unavailable or rejected", async () => {
    expect(await requestElementFullscreen(null)).toBe(false);
    expect(await requestElementFullscreen({} as Element)).toBe(false);
    const requestFullscreen = vi.fn().mockRejectedValue(new Error("denied"));
    expect(await requestElementFullscreen({ requestFullscreen } as unknown as Element)).toBe(false);
  });
});
