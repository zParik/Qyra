import { describe, it, expect } from "vitest";
import { matchHomeShortcut } from "./shortcuts";

const ev = (over: Partial<Parameters<typeof matchHomeShortcut>[0]>) => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  target: null,
  ...over,
});

describe("matchHomeShortcut", () => {
  it("maps Ctrl+M and Cmd+M to the merge route", () => {
    expect(matchHomeShortcut(ev({ key: "m", ctrlKey: true }))).toBe("/merge");
    expect(matchHomeShortcut(ev({ key: "m", metaKey: true }))).toBe("/merge");
  });

  it("maps Ctrl+I to the images-to-pdf route", () => {
    expect(matchHomeShortcut(ev({ key: "i", ctrlKey: true }))).toBe("/images-to-pdf");
  });

  it("maps Ctrl+O to the browse action", () => {
    expect(matchHomeShortcut(ev({ key: "o", ctrlKey: true }))).toBe("browse");
  });

  it("is case-insensitive (Shift held)", () => {
    expect(matchHomeShortcut(ev({ key: "M", ctrlKey: true }))).toBe("/merge");
  });

  it("returns null without a modifier", () => {
    expect(matchHomeShortcut(ev({ key: "m" }))).toBeNull();
  });

  it("returns null for unmapped keys", () => {
    expect(matchHomeShortcut(ev({ key: "x", ctrlKey: true }))).toBeNull();
  });

  it("ignores shortcuts while typing in a field", () => {
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    expect(matchHomeShortcut(ev({ key: "m", ctrlKey: true, target: input }))).toBeNull();
  });
});
