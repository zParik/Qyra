import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { decodeRgba, renderTile, rgbaToCanvas, thumbUrl } from "./renderClient";
import { bumpDocVersion } from "./docVersion";

function wire(w: number, h: number): ArrayBuffer {
  const buf = new ArrayBuffer(8 + w * h * 4);
  const v = new DataView(buf);
  v.setUint32(0, w, true);
  v.setUint32(4, h, true);
  new Uint8Array(buf, 8).fill(7);
  return buf;
}

beforeEach(() => invoke.mockReset());

describe("decodeRgba", () => {
  it("parses the LE header and pixels", () => {
    const r = decodeRgba(wire(3, 2))!;
    expect([r.w, r.h, r.pixels.length, r.pixels[0]]).toEqual([3, 2, 24, 7]);
  });
  it("treats 0x0 as nothing", () => {
    expect(decodeRgba(wire(0, 0))).toBeNull();
  });
});

describe("renderTile", () => {
  const req = { path: "/a.pdf", page: 1, scale: 2, tx: 0, ty: 0, priority: "visible" as const };

  it("returns decoded pixels", async () => {
    invoke.mockResolvedValueOnce(wire(2, 2));
    expect((await renderTile(req))!.w).toBe(2);
    expect(invoke).toHaveBeenCalledWith("render_tile", { req: expect.objectContaining({ path: "/a.pdf", tx: 0, id: expect.any(Number) }) });
  });

  it("resolves null (not a rejection) when aborted, and cancels in Rust", async () => {
    let resolve!: (b: ArrayBuffer) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "render_tile" ? new Promise((r) => (resolve = r)) : Promise.resolve(),
    );
    const ctl = new AbortController();
    const p = renderTile(req, ctl.signal);
    ctl.abort();
    resolve(wire(2, 2));
    expect(await p).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(invoke).toHaveBeenCalledWith("cancel_renders", { ids: [expect.any(Number)] });
  });

  it("resolves null when an aborted request's IPC call fails", async () => {
    let reject!: (e: unknown) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "render_tile" ? new Promise((_, r) => (reject = r)) : Promise.resolve(),
    );
    const ctl = new AbortController();
    const p = renderTile(req, ctl.signal);
    ctl.abort();
    reject(new Error("tile worker dropped reply"));
    await expect(p).resolves.toBeNull();
  });

  it("returns null without invoking when already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(await renderTile(req, ctl.signal)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("thumbUrl", () => {
  it("encodes path, page, width and version", () => {
    const u = thumbUrl("/home/z/my doc.pdf", 3, 256, "42");
    expect(u).toMatch(/thumb\/3\?path=%2Fhome%2Fz%2Fmy%20doc\.pdf&w=256&v=42\.0$/);
  });

  it("changes when the document is rewritten, even without a version", () => {
    const before = thumbUrl("/t.pdf", 1, 256);
    bumpDocVersion("/t.pdf");
    expect(thumbUrl("/t.pdf", 1, 256)).not.toBe(before);
  });
});

describe("rgbaToCanvas", () => {
  it("sizes the canvas to the pixels", () => {
    const c = rgbaToCanvas(decodeRgba(wire(3, 2))!);
    expect([c.width, c.height]).toEqual([3, 2]);
  });
});
