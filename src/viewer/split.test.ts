import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store/useAppStore";
import { clampRatio, dropTabOnSide, toggleSplit } from "./split";

const initial = useAppStore.getState();
const get = () => useAppStore.getState();
const tab = (path: string, type: "pdf" | "home" = "pdf") => ({ path, name: path, type });

beforeEach(() => useAppStore.setState(initial, true));

describe("toggleSplit", () => {
  it("opens the next other document beside the active one", () => {
    get().openTab(tab("a.pdf"));
    get().openTab(tab("b.pdf"));
    get().activateTab(0);
    toggleSplit();
    expect(get().splitTab).toBe("b.pdf");
  });

  it("shows the active document twice when it is the only one", () => {
    get().openTab(tab("__home__1", "home"));
    get().openTab(tab("a.pdf"));
    toggleSplit();
    expect(get().splitTab).toBe("a.pdf");
  });

  it("does nothing with no document open", () => {
    get().openTab(tab("__home__1", "home"));
    toggleSplit();
    expect(get().splitTab).toBeNull();
  });

  it("closes an open split", () => {
    get().openTab(tab("a.pdf"));
    toggleSplit();
    toggleSplit();
    expect(get().splitTab).toBeNull();
  });
});

describe("clampRatio", () => {
  it("keeps each pane at least a fifth of the width", () => {
    expect(clampRatio(0.05)).toBe(0.2);
    expect(clampRatio(0.95)).toBe(0.8);
    expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe("dropTabOnSide", () => {
  const active = () => get().openTabs[get().activeTabIndex]?.path;
  function open(...paths: string[]) {
    paths.forEach((p) => get().openTab(tab(p, p.startsWith("__home") ? "home" : "pdf")));
  }

  it("dropping another tab on the right splits it beside the active one", () => {
    open("a.pdf", "b.pdf");
    get().activateTab(0);
    dropTabOnSide("b.pdf", "right");
    expect(active()).toBe("a.pdf");
    expect(get().splitTab).toBe("b.pdf");
  });

  it("dropping another tab on the left puts it in front and the active one on the right", () => {
    open("a.pdf", "b.pdf");
    get().activateTab(0);
    dropTabOnSide("b.pdf", "left");
    expect(active()).toBe("b.pdf");
    expect(get().splitTab).toBe("a.pdf");
  });

  it("dropping the active tab on the right moves the other document to the left", () => {
    open("a.pdf", "b.pdf");
    get().activateTab(0);
    dropTabOnSide("a.pdf", "right");
    expect(get().splitTab).toBe("a.pdf");
    expect(active()).toBe("b.pdf");
  });

  it("dropping the split tab on the left swaps the panes", () => {
    open("a.pdf", "b.pdf");
    get().activateTab(0);
    get().openSplit("b.pdf");
    dropTabOnSide("b.pdf", "left");
    expect(active()).toBe("b.pdf");
    expect(get().splitTab).toBe("a.pdf");
  });

  it("with one document, dropping it on the right shows it twice", () => {
    open("a.pdf");
    dropTabOnSide("a.pdf", "right");
    expect(active()).toBe("a.pdf");
    expect(get().splitTab).toBe("a.pdf");
  });

  it("a third tab dropped on the right replaces the split tab", () => {
    open("a.pdf", "b.pdf", "c.pdf");
    get().activateTab(0);
    get().openSplit("b.pdf");
    dropTabOnSide("c.pdf", "right");
    expect(active()).toBe("a.pdf");
    expect(get().splitTab).toBe("c.pdf");
  });

  it("the Library tab does not split", () => {
    open("a.pdf", "__home__1");
    dropTabOnSide("__home__1", "right");
    expect(get().splitTab).toBeNull();
  });
});
