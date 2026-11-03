import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";

const initial = useAppStore.getState();
const get = () => useAppStore.getState();
const file = (path: string) => ({ path, name: path });
const tab = (path: string) => ({ path, name: path, type: "pdf" as const });

beforeEach(() => useAppStore.setState(initial, true));

describe("multi-file actions", () => {
  it("adds, removes, and clears files", () => {
    get().addFile(file("a.pdf"));
    get().addFile(file("b.pdf"));
    expect(get().files.map((f) => f.path)).toEqual(["a.pdf", "b.pdf"]);

    get().removeFile("a.pdf");
    expect(get().files.map((f) => f.path)).toEqual(["b.pdf"]);

    get().clearFiles();
    expect(get().files).toEqual([]);
  });

  it("reorders files", () => {
    get().setFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    get().reorderFiles(0, 2);
    expect(get().files.map((f) => f.path)).toEqual(["b.pdf", "c.pdf", "a.pdf"]);
  });

  it("setCurrentTool clears prior result and error", () => {
    useAppStore.setState({ result: "old", error: "boom", resultFiles: ["x"] });
    get().setCurrentTool("merge");
    expect(get().currentTool).toBe("merge");
    expect(get().result).toBeNull();
    expect(get().error).toBeNull();
    expect(get().resultFiles).toEqual([]);
  });
});

describe("showLibrary", () => {
  const home = (path: string) => ({ path, name: "Library", type: "home" as const });

  it("activates the existing Library tab", () => {
    get().openTab(home("__home__0"));
    get().openTab(tab("a.pdf"));
    get().showLibrary();
    expect(get().activeTabIndex).toBe(0);
    expect(get().openTabs).toHaveLength(2);
  });

  it("opens a Library tab when none is open", () => {
    get().openTab(tab("a.pdf"));
    get().showLibrary();
    const active = get().openTabs[get().activeTabIndex];
    expect(active?.type).toBe("home");
    expect(get().openTabs.map((t) => t.path)).toContain("a.pdf");
  });
});

describe("tab actions", () => {
  it("opens a tab and syncs the legacy viewerFile", () => {
    get().openTab(tab("x.pdf"));
    expect(get().openTabs).toHaveLength(1);
    expect(get().activeTabIndex).toBe(0);
    expect(get().viewerFile?.path).toBe("x.pdf");
  });

  it("does not duplicate a tab for the same path", () => {
    get().openTab(tab("x.pdf"));
    get().openTab(tab("y.pdf"));
    get().openTab(tab("x.pdf"));
    expect(get().openTabs).toHaveLength(2);
    expect(get().activeTabIndex).toBe(0); // reactivated existing x
  });

  it("closes a tab and pushes it onto the reopen stack", () => {
    get().openTab(tab("x.pdf"));
    get().closeTab(0);
    expect(get().openTabs).toHaveLength(0);
    expect(get().viewerFile).toBeNull();

    const reopened = get().reopenClosedTab();
    expect(reopened?.path).toBe("x.pdf");
    expect(get().openTabs.map((t) => t.path)).toEqual(["x.pdf"]);
  });

  it("reorders tabs and tracks the active index", () => {
    get().openTab(tab("a.pdf"));
    get().openTab(tab("b.pdf"));
    get().openTab(tab("c.pdf"));
    get().activateTab(0);
    get().reorderTab(0, 2); // move a to the end
    expect(get().openTabs.map((t) => t.path)).toEqual(["b.pdf", "c.pdf", "a.pdf"]);
    expect(get().activeTabIndex).toBe(2);
  });

  it("replaces a tab and migrates per-path state", () => {
    get().openTab(tab("old.pdf"));
    get().replaceTab(0, tab("new.pdf"));
    expect(get().openTabs.map((t) => t.path)).toEqual(["new.pdf"]);
    expect(get().tabFiles["old.pdf"]).toBeUndefined();
    expect(get().tabFiles["new.pdf"]).toBeDefined();
  });
});
