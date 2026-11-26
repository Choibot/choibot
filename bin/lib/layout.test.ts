import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutInWorkspace, defaultWorkspaceDir } from "./layout.js";

let dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "choibot-layout-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("console layout", () => {
  it("default workspace: ~/workspace when the checkout is elsewhere", () => {
    const home = temp();
    const checkout = join(home, "choibot");
    mkdirSync(checkout);
    expect(defaultWorkspaceDir(home, checkout)).toBe(join(home, "workspace"));
  });

  it("default workspace: ~/agent-workspace when the checkout sits in ~/workspace", () => {
    const home = temp();
    const checkout = join(home, "workspace", "choibot");
    mkdirSync(checkout, { recursive: true });
    expect(defaultWorkspaceDir(home, checkout)).toBe(join(home, "agent-workspace"));
  });

  it("checkoutInWorkspace: by real path, a symlinked workspace included", () => {
    const home = temp();
    const checkout = join(home, "workspace", "choibot");
    mkdirSync(checkout, { recursive: true });
    symlinkSync(join(home, "workspace"), join(home, "ws-link"));
    expect(checkoutInWorkspace(checkout, join(home, "workspace"))).toBe(true);
    expect(checkoutInWorkspace(checkout, join(home, "ws-link"))).toBe(true);
    expect(checkoutInWorkspace(checkout, checkout)).toBe(true);
    expect(checkoutInWorkspace(checkout, join(home, "workspace-other"))).toBe(false);
    expect(checkoutInWorkspace(join(home, "workspacex"), join(home, "workspace"))).toBe(false);
  });
});
