import { describe, it, expect } from "vitest";
import { keySeq, ctrlCode } from "./term-keys";

describe("keySeq", () => {
  it("maps special keys to their terminal byte sequences", () => {
    expect(keySeq("esc")).toBe("\x1b");
    expect(keySeq("tab")).toBe("\t");
    expect(keySeq("enter")).toBe("\r");
    expect(keySeq("up")).toBe("\x1b[A");
    expect(keySeq("down")).toBe("\x1b[B");
    expect(keySeq("right")).toBe("\x1b[C");
    expect(keySeq("left")).toBe("\x1b[D");
  });
});

describe("ctrlCode", () => {
  it("maps letters to control codes, case-insensitively", () => {
    expect(ctrlCode("c")).toBe("\x03");
    expect(ctrlCode("C")).toBe("\x03");
    expect(ctrlCode("a")).toBe("\x01");
    expect(ctrlCode("z")).toBe("\x1a");
  });
  it("maps the @.._ punctuation range too", () => {
    expect(ctrlCode("[")).toBe("\x1b"); // Ctrl-[ == Esc
  });
  it("returns null for out-of-range input", () => {
    expect(ctrlCode("1")).toBeNull();
    expect(ctrlCode("")).toBeNull();
    expect(ctrlCode("ab")).toBeNull();
  });
});
