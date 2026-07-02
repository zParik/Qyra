import { describe, it, expect } from "vitest";
import { isMacPlatform, modKeyFor, shortcutLabelFor } from "./platform";

describe("isMacPlatform", () => {
  it("is true for macOS platform strings", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
  });

  it("is false for Windows and Linux", () => {
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("modKeyFor", () => {
  it("uses the command glyph on mac", () => {
    expect(modKeyFor("MacIntel")).toBe("⌘");
  });

  it("uses Ctrl elsewhere", () => {
    expect(modKeyFor("Win32")).toBe("Ctrl");
    expect(modKeyFor("Linux x86_64")).toBe("Ctrl");
  });
});

describe("shortcutLabelFor", () => {
  it("formats mac labels with the glyph and no plus", () => {
    expect(shortcutLabelFor("MacIntel", "M")).toBe("⌘M");
  });

  it("formats non-mac labels as Ctrl+<key>", () => {
    expect(shortcutLabelFor("Win32", "M")).toBe("Ctrl+M");
    expect(shortcutLabelFor("Linux x86_64", "I")).toBe("Ctrl+I");
  });
});
