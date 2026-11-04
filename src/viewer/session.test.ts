import { describe, expect, it } from "vitest";
import { sessionToSave } from "./session";

const pdf = (path: string) => ({ type: "pdf" as const, path, name: path });
const home = (path: string) => ({ type: "home" as const, path, name: "Library" });

describe("sessionToSave", () => {
  it("indexes the active tab within the saved (document-only) list", () => {
    const s = sessionToSave([home("__home__0"), pdf("a.pdf"), pdf("b.pdf")], 2);
    expect(s?.tabs.map((t) => t.path)).toEqual(["a.pdf", "b.pdf"]);
    expect(s?.activeIndex).toBe(1);
  });

  it("falls back to the first document when a Library tab is active", () => {
    expect(sessionToSave([pdf("a.pdf"), home("__home__0")], 1)?.activeIndex).toBe(0);
  });

  it("saves nothing for a Library-only session", () => {
    expect(sessionToSave([home("__home__0")], 0)).toBeNull();
  });
});
