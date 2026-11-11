import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store/useAppStore";
import { clampRatio, toggleSplit } from "./split";

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
