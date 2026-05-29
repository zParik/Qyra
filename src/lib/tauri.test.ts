import { describe, it, expect } from "vitest";
import { mergePdfs, splitPdf, rotatePages } from "./tauri";
import { mockCommand, lastCallArgs } from "../test/mockTauri";

// Smoke test for the IPC mock seam: the typed wrappers in lib/tauri.ts must
// reach `invoke` with the right command name + argument shape, and surface the
// resolved value back to the caller.
describe("tauri wrapper seam", () => {
  it("mergePdfs invokes merge_pdfs with paths + output and returns the path", async () => {
    mockCommand("merge_pdfs", "C:/out/merged.pdf");

    const result = await mergePdfs(["a.pdf", "b.pdf"], "C:/out/merged.pdf");

    expect(result).toBe("C:/out/merged.pdf");
    expect(lastCallArgs("merge_pdfs")).toEqual({
      paths: ["a.pdf", "b.pdf"],
      output: "C:/out/merged.pdf",
    });
  });

  it("splitPdf forwards ranges + outputDir and returns the file list", async () => {
    mockCommand("split_pdf", (args) => [`${args.outputDir}/part1.pdf`]);

    const result = await splitPdf("in.pdf", [{ start: 1, end: 2 }], "C:/out");

    expect(result).toEqual(["C:/out/part1.pdf"]);
    expect(lastCallArgs("split_pdf")).toEqual({
      path: "in.pdf",
      ranges: [{ start: 1, end: 2 }],
      outputDir: "C:/out",
    });
  });

  it("rejects when no mock is registered for a command", async () => {
    await expect(rotatePages("in.pdf", [1], 90)).rejects.toThrow(/No mock registered/);
  });
});
