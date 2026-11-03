import { describe, expect, it } from "vitest";
import { batchOutputs } from "./batchOutputs";

describe("batchOutputs", () => {
  it("numbers inputs that share a file name in the output folder", () => {
    expect(batchOutputs(["/a/report.pdf", "/b/report.pdf", "/c/Report.PDF", "/d/other.pdf"], "compress", "/out")).toEqual([
      "/out/report_compress.pdf",
      "/out/report_compress (2).pdf",
      "/out/Report_compress (3).pdf",
      "/out/other_compress.pdf",
    ]);
  });

  it("writes next to each input when no folder is chosen", () => {
    expect(batchOutputs(["/a/report.pdf", "/b/report.pdf"], "flatten", null)).toEqual([
      "/a/report_flatten.pdf",
      "/b/report_flatten.pdf",
    ]);
  });
});
