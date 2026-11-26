import { describe, expect, it } from "vitest";
import { CLI_NAME, USER_CLI } from "./brand";
import { cli } from "./setup/steps";
import { userCli } from "./usercli.mjs";

describe("userCli: the command a user types on this install", () => {
  const made = (paths: string[]) => (p: string) => paths.includes(p);

  it("is the short command on an install that the install line made", () => {
    expect(userCli("/srv/ada/choibot/app", made(["/srv/ada/choibot/.installed-by-choibot", "/srv/ada/choibot/bin/choibot"]))).toBe(CLI_NAME);
  });

  it("is `pnpm choibot` on every other install, as before", () => {
    expect(userCli("/srv/ada/console", made([]))).toBe(`pnpm ${CLI_NAME}`);
    // The marker alone, or the command alone, is not an install of the install line.
    expect(userCli("/srv/ada/choibot/app", made(["/srv/ada/choibot/.installed-by-choibot"]))).toBe(`pnpm ${CLI_NAME}`);
    expect(userCli("/srv/ada/choibot/app", made(["/srv/ada/choibot/bin/choibot"]))).toBe(`pnpm ${CLI_NAME}`);
  });

  it("this checkout is not an install of the install line: the texts of the tests stay as they were", () => {
    expect(userCli()).toBe(`pnpm ${CLI_NAME}`);
    expect(USER_CLI).toBe(`pnpm ${CLI_NAME}`);
    expect(cli("doctor")).toBe(`pnpm ${CLI_NAME} doctor`);
  });
});
