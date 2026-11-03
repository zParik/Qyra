import type { ReactElement } from "react";
import type { Family } from "../../lib/families";
import type { IconProps } from "../../components/Icons";
import { IcMerge, IcImage, IcScan, IcWrench, IcStack } from "../../components/Icons";

export interface StandaloneTool {
  id: string;
  route: string;
  title: string;
  desc: string;
  family: Family;
  Icon: (p: IconProps) => ReactElement;
  /** Letter combined with the platform modifier, e.g. "M" → Ctrl+M. */
  shortcut?: string;
}

/** Tools that work on files without opening the viewer, filed by family like the sample book. */
export const TOOL_FAMILIES: { family: Family; tools: StandaloneTool[] }[] = [
  { family: "pages", tools: [
    { id: "merge",  route: "/merge",  title: "Merge PDFs", desc: "Combine several PDFs into one, in the order you choose.", family: "pages", Icon: IcMerge,  shortcut: "M" },
    { id: "repair", route: "/repair", title: "Repair PDF", desc: "Recover a damaged or unreadable file.",                 family: "pages", Icon: IcWrench },
  ]},
  { family: "export", tools: [
    { id: "images", route: "/images-to-pdf", title: "Images to PDF",   desc: "Bundle JPG, PNG, HEIC or WebP into a paginated PDF.", family: "export", Icon: IcImage, shortcut: "I" },
    { id: "ocr",    route: "/ocr",           title: "Make searchable", desc: "Add an OCR text layer to a scanned PDF, offline.",    family: "export", Icon: IcScan },
  ]},
  { family: "compress", tools: [
    { id: "batch", route: "/batch", title: "Batch operations", desc: "Compress, OCR or flatten many PDFs at once.", family: "compress", Icon: IcStack },
  ]},
];

export const STANDALONE_TOOLS: StandaloneTool[] = TOOL_FAMILIES.flatMap((g) => g.tools);

/** What opens up once a document is on the counter. Shown so the viewer tools are not a secret. */
export const IN_DOCUMENT: { family: Family; note: string }[] = [
  { family: "annotate", note: "Highlight, draw, comment" },
  { family: "sign",     note: "Sign and stamp" },
  { family: "forms",    note: "Fill forms" },
  { family: "redact",   note: "Redact" },
  { family: "pages",    note: "Rotate, reorder, split" },
  { family: "compress", note: "Compress, protect" },
  { family: "export",   note: "Images, text" },
];
