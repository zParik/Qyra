import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockCommand } from "../../test/mockTauri";
import { triggerPrint, usePrintJob } from "./PrintPanel";

describe("triggerPrint", () => {
  beforeEach(() => {
    usePrintJob.setState({ job: null, cancel: null });
    document.querySelectorAll("iframe").forEach((f) => f.remove());
  });

  it("prints natively when the backend can, with no webview frame", async () => {
    mockCommand("print_pdf", true);
    await triggerPrint("/docs/a.pdf");
    expect(document.querySelector("iframe")).toBeNull();
    expect(usePrintJob.getState().job).toBeNull();
  });

  it("asks the qyra scheme for every page instead of rendering them here", async () => {
    mockCommand("print_pdf", false);
    mockCommand("get_page_count", 3);
    const print = vi.fn();
    const append = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      const out = append(node);
      if (node instanceof HTMLIFrameElement && node.contentWindow) node.contentWindow.print = print;
      return out;
    });

    const job = triggerPrint("/docs/a b.pdf");
    const imgs = () => Array.from(document.querySelector("iframe")?.contentDocument?.querySelectorAll("img") ?? []);
    await vi.waitFor(() => expect(imgs()).toHaveLength(3));
    expect(usePrintJob.getState().job).toEqual({ name: "a b.pdf", done: 0, total: 3 });
    imgs()[0].dispatchEvent(new Event("load"));
    expect(usePrintJob.getState().job?.done).toBe(1);
    expect(print).not.toHaveBeenCalled();
    imgs().slice(1).forEach((img) => img.dispatchEvent(new Event("load")));
    await job;

    const srcs = imgs().map((i) => i.getAttribute("src"));
    expect(srcs).toHaveLength(3);
    expect(srcs[0]).toMatch(/\/print\/1\?path=%2Fdocs%2Fa%20b\.pdf/);
    expect(srcs[2]).toMatch(/\/print\/3\?/);
    expect(print).toHaveBeenCalledOnce();
    expect(usePrintJob.getState().job).toBeNull();
    vi.restoreAllMocks();
  });

  it("runs one job at a time", async () => {
    mockCommand("print_pdf", false);
    let release: (n: number) => void = () => {};
    mockCommand("get_page_count", () => new Promise<number>((r) => { release = r; }));
    const first = triggerPrint("/a.pdf");
    await triggerPrint("/b.pdf");
    expect(usePrintJob.getState().job?.name).toBe("a.pdf");
    usePrintJob.getState().cancel?.();
    release(1);
    await first;
    expect(usePrintJob.getState().job).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });
});
