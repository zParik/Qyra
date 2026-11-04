import { describe, expect, it, vi } from "vitest";
import { writeOverlays, type Overlays } from "./writeOverlays";
import type { Stroke } from "../store/useNotesStore";

const none: Overlays = { fieldValues: {}, signatures: [], strokes: [], virtualPages: [] };

function commands() {
  const calls: string[] = [];
  return {
    calls,
    fillForm: vi.fn(async (p: string) => { calls.push(`fill ${p}`); return `${p}+form`; }),
    stampImages: vi.fn(async (p: string) => { calls.push(`sign ${p}`); return `${p}+sig`; }),
    bakeAnnotations: vi.fn(async (p: string) => { calls.push(`bake ${p}`); return `${p}+ink`; }),
  };
}

const stroke = (pageSlotId: string, tool: Stroke["tool"] = "pen"): Stroke => ({
  id: crypto.randomUUID(), pageSlotId, tool, color: "#000", baseThickness: 2, points: [[0.1, 0.2, 1]],
});

describe("writeOverlays", () => {
  it("returns the path untouched when there is nothing to write", async () => {
    const c = commands();
    expect(await writeOverlays("a.pdf", none, c)).toBe("a.pdf");
    expect(c.calls).toEqual([]);
  });

  it("writes fields, then signatures, then drawings, chaining each output", async () => {
    const c = commands();
    const out = await writeOverlays("a.pdf", {
      fieldValues: { "buyer.name": "Jane" },
      signatures: [{ id: "s", dataUrl: "data:,", pageNum: 2, x: 0.5, y: 0.5, width: 0.2, height: 0.1 }],
      strokes: [stroke("pdf-2")],
      virtualPages: [],
    }, c);
    expect(c.calls).toEqual(["fill a.pdf", "sign a.pdf+form", "bake a.pdf+form+sig"]);
    expect(out).toBe("a.pdf+form+sig+ink");
    expect(c.fillForm).toHaveBeenCalledWith("a.pdf", [{ name: "buyer.name", value: "Jane" }], false);
    expect(c.stampImages.mock.calls[0][1]).toEqual([
      { page: 2, x: 0.5, y: 0.5, width: 0.2, height: 0.1, dataUrl: "data:," },
    ]);
  });

  it("groups strokes by page and keeps erasers off added pages", async () => {
    const c = commands();
    await writeOverlays("a.pdf", {
      ...none,
      strokes: [stroke("pdf-1"), stroke("pdf-3"), stroke("pdf-1"), stroke("vp", "eraser"), stroke("vp")],
      virtualPages: [{ id: "vp", template: "blank", afterRealPage: 1 }],
    }, c);
    const [, annotations, pages] = c.bakeAnnotations.mock.calls[0] as unknown as [string, { page: number; strokes: unknown[] }[], { strokes: unknown[] }[]];
    expect(annotations.map((a) => [a.page, a.strokes.length])).toEqual([[1, 2], [3, 1]]);
    expect(pages[0].strokes).toHaveLength(1);
  });
});
