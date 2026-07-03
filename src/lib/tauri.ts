import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { isAndroid, androidSavePath, androidOutputDir, saveFolderLabel } from "./androidFileUtils";
import { loadSetting, Settings } from "./settings";
import type {
  PageRange, PageNumberOptions, PdfMetadata, PdfInfo,
  CompressResult, StrokeAnnotation, PageAnnotation, VirtualPageAnnotation,
  DiskSpace, LibraryEntry,
} from "./schemas";

export type {
  PageRange, PageNumberOptions, PdfMetadata, PdfInfo,
  CompressResult, StrokeAnnotation, PageAnnotation, VirtualPageAnnotation,
  DiskSpace, LibraryEntry,
};

// --- Core PDF commands ---

export const mergePdfs = (paths: string[], output?: string) =>
  invoke<string>("merge_pdfs", { paths, output });

export const splitPdf = (path: string, ranges: PageRange[], outputDir?: string) =>
  invoke<string[]>("split_pdf", { path, ranges, outputDir });

export const splitPdfPerPage = (path: string, outputDir?: string) =>
  invoke<string[]>("split_pdf_per_page", { path, outputDir });

export const splitPdfByBookmarks = (path: string, outputDir?: string) =>
  invoke<string[]>("split_pdf_by_bookmarks", { path, outputDir });

export const compressPdf = (path: string, output?: string, level?: number) =>
  invoke<CompressResult>("compress_pdf", { path, output, level });

/** Signal the in-flight Native (Rust) compression to abort. */
export const cancelCompress = () => invoke<void>("cancel_compress");

/**
 * Save a freshly-compressed temp file as a NEW file next to `original`
 * (`<name>-compressed.pdf`, auto-numbered). Never overwrites the source.
 * Returns the saved file's path.
 */
export const saveCompressedCopy = (src: string, original: string) =>
  invoke<string>("save_compressed_copy", { src, original });

export const rotatePages = (path: string, pages: number[], degrees: number, output?: string) =>
  invoke<string>("rotate_pages", { path, pages, degrees, output });

export const removePages = (path: string, pages: number[], output?: string) =>
  invoke<string>("remove_pages", { path, pages, output });

export const reorderPages = (path: string, order: number[], output?: string) =>
  invoke<string>("reorder_pages", { path, order, output });

export const renderThumbnail = (path: string, page: number, dpi?: number) =>
  invoke<string>("render_thumbnail", { path, page, dpi });

export const pdfToImages = (path: string, format?: string, dpi?: number, outputDir?: string) =>
  invoke<string[]>("pdf_to_images", { path, format, dpi, outputDir });

export const imagesToPdf = (imagePaths: string[], output?: string) =>
  invoke<string>("images_to_pdf", { imagePaths, output });

export const addPageNumbers = (path: string, options?: PageNumberOptions, output?: string) =>
  invoke<string>("add_page_numbers", { path, options, output });

export const removePageNumbers = (path: string, output?: string) =>
  invoke<string>("remove_page_numbers", { path, output });

export const protectPdf = (path: string, userPassword: string, ownerPassword?: string, output?: string) =>
  invoke<string>("protect_pdf", { path, userPassword, ownerPassword, output });

export const unlockPdf = (path: string, password: string, output?: string) =>
  invoke<string>("unlock_pdf", { path, password, output });

export const getMetadata = (path: string) =>
  invoke<PdfMetadata>("get_metadata", { path });

export const setMetadata = (path: string, metadata: PdfMetadata, output?: string) =>
  invoke<string>("set_metadata", { path, metadata, output });

export const getPdfInfo = (path: string) =>
  invoke<PdfInfo>("get_pdf_info", { path });

export interface PdfPermissions {
  encrypted: boolean;
  print: boolean;
  modifyContents: boolean;
  copyExtract: boolean;
  annotate: boolean;
  fillForms: boolean;
  accessibilityExtract: boolean;
  assemble: boolean;
  printHighQuality: boolean;
  pValue: number | null;
  revision: number | null;
  algorithm: string | null;
}

export const getPdfPermissions = (path: string) =>
  invoke<PdfPermissions>("get_pdf_permissions", { path });

export const readPdfBytes = (path: string) =>
  invoke<string>("read_pdf_bytes", { path });

export const copyFile = (src: string, dst: string) =>
  invoke<void>("copy_file", { src, dst });

export const openFile = (path: string) =>
  invoke<void>("open_file", { path });

export const showInFolder = (path: string) =>
  invoke<void>("show_in_folder", { path });

export const showSaveDialog = async (defaultPath?: string): Promise<string | null> => {
  if (isAndroid()) {
    const name = defaultPath ? (defaultPath.split(/[\\/]/).pop() ?? "output.pdf") : "output.pdf";
    return androidSavePath(name);
  }
  // If the caller passed a bare filename (no directory) and a default save
  // folder is configured, open the dialog in that folder.
  let effectivePath = defaultPath;
  const isBareName = !!defaultPath && !/[\\/]/.test(defaultPath);
  if (isBareName) {
    const folder = await loadSetting(Settings.defaultSaveFolder);
    if (folder && !folder.startsWith("content://")) {
      const sep = folder.includes("\\") ? "\\" : "/";
      effectivePath = `${folder.replace(/[\\/]$/, "")}${sep}${defaultPath}`;
    }
  }
  return save({ defaultPath: effectivePath, filters: [{ name: "PDF", extensions: ["pdf"] }] });
};

export const writeBytes = (path: string, data: number[]) =>
  invoke<void>("write_bytes", { path, data });

export const pickDirectory = async (): Promise<string | null> => {
  if (isAndroid()) return androidOutputDir();
  return open({ directory: true, multiple: false }) as Promise<string | null>;
};

export const getContentUriDisplayName = (uri: string) =>
  invoke<string>("get_content_uri_display_name", { uri });

export const shareFile = (path: string) =>
  invoke<void>("share_file", { path });

export const saveToSafTree = (treeUri: string, srcPath: string, displayName: string) =>
  invoke<string>("save_to_saf_tree", { treeUri, srcPath, displayName });

/**
 * Export/save a generated file to the user's chosen destination.
 * - Android with a default save folder set → write into the SAF tree.
 * - Android with no default folder → existing share/Downloads behavior.
 * - Desktop → existing share behavior (desktop save uses showSaveDialog elsewhere).
 * Returns a short human label of where it went, or null if it fell back to share.
 */
export const exportFile = async (path: string): Promise<string | null> => {
  if (isAndroid()) {
    const folder = await loadSetting(Settings.defaultSaveFolder);
    if (folder && folder.startsWith("content://")) {
      const name = path.split(/[\\/]/).pop() ?? "output.pdf";
      try {
        await saveToSafTree(folder, path, name);
        return saveFolderLabel(folder);
      } catch {
        // Stale grant or removed folder — fall back to share.
        await shareFile(path);
        return null;
      }
    }
  }
  await shareFile(path);
  return null;
};

export const bakeAnnotations = (
  path: string,
  annotations: PageAnnotation[],
  virtualPages: VirtualPageAnnotation[],
  output?: string,
) =>
  invoke<string>("bake_annotations", { path, annotations, virtualPages, output });

export const loadComments = (path: string) =>
  invoke<string>("load_comments", { path });

export const saveComments = (path: string, commentsJson: string) =>
  invoke<void>("save_comments", { path, commentsJson });

export const getDiskSpace = () => invoke<DiskSpace>("get_disk_space");

// ─── Word (.docx) viewer ──────────────────────────────────────────────────────

export interface WordPageSize { width: number; height: number }
export interface WordDocInfo { pageCount: number; pages: WordPageSize[] }

/** Parse + lay out a .docx, returning page count and per-page sizes (in points). */
export const openWord = (path: string) =>
  invoke<WordDocInfo>("open_word", { path });

/** Render one page (0-indexed) to a base64 PNG at `scale` device px per point. */
export const renderWordPage = (path: string, page: number, scale: number) =>
  invoke<string>("render_word_page", { path, page, scale });

/** Basic edit: replace text in the body and save to `output` (lossless). */
export const replaceInWord = (path: string, find: string, replace: string, output: string) =>
  invoke<string>("replace_in_word", { path, find, replace, output });

/** Text of each top-level body paragraph (index-aligned with setWordParagraph). */
export const getWordParagraphs = (path: string) =>
  invoke<string[]>("get_word_paragraphs", { path });

/** Styled HTML of the document body for the contenteditable editing surface. */
export const getWordHtml = (path: string) =>
  invoke<string>("get_word_html", { path });

/** Page geometry (points) for laying the editor content onto real page sheets. */
export interface WordPageMetrics {
  widthPt: number; heightPt: number;
  marginTopPt: number; marginRightPt: number; marginBottomPt: number; marginLeftPt: number;
}
export const getWordMetrics = (path: string) =>
  invoke<WordPageMetrics>("get_word_metrics", { path });

/** The document's default header + footer as HTML, stamped on each page's margins. */
export interface WordChrome { header: string; footer: string }
export const getWordChrome = (path: string) =>
  invoke<WordChrome>("get_word_chrome", { path });

export interface RunEdit {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;   // "RRGGBB"
  size_pt?: number;
  font?: string;    // family name
  highlight?: string; // "RRGGBB"
  vert?: "super" | "sub";
  br?: "page" | "line"; // a break run instead of text
  link?: string;    // hyperlink target URL
}

/** Rich edit: replace body paragraph `index`'s runs (keeps formatting) + set
 *  alignment ("left"|"center"|"right"|"justify"), then save. */
export const setWordParagraphRuns = (
  path: string, index: number, runs: RunEdit[], align: string | null, output: string,
) => invoke<string>("set_word_paragraph_runs", { path, index, runs, align, output });

export interface ParaEdit { runs: RunEdit[]; align?: string | null }

/** Structural save: regenerate the whole body (add/remove/reorder paragraphs).
 *  Rejected for documents containing tables. */
export const saveWordBody = (path: string, paras: ParaEdit[], output: string) =>
  invoke<string>("save_word_body", { path, paras, output });

/** A uniform (all-sides) cell border from the shading/border UI. */
export interface CellBorder { style: "single" | "nil"; color?: string | null; sz?: number | null }

/** One cell in an edited table.
 *  - `verbatim`: cell unchanged → re-emit its original `<w:tc>` bytes.
 *  - `cell`: changed / new cell; `orig_row`/`orig_col` map to the source cell for
 *    `tcPr` reuse (null = new). `grid_span`/`v_merge` carry merges; `shd`/`border`
 *    carry shading + borders. */
export type CellEdit =
  | { kind: "verbatim"; orig_row: number; orig_col: number }
  | {
      kind: "cell";
      orig_row: number | null;
      orig_col: number | null;
      grid_span?: number | null;
      v_merge?: "restart" | "continue" | null;
      shd?: string | null;
      border?: CellBorder | null;
      blocks: ParaEdit[];
    };

/** One row in an edited table; `orig_row` maps to the source row for `trPr` reuse. */
export interface RowEdit { orig_row: number | null; cells: CellEdit[] }

/** One top-level block in the editor's save order.
 *  - `verbatim`: block unchanged → re-emit its original source bytes.
 *  - `para`: a paragraph; `orig` = original block index (keeps its pPr) or null
 *    for a newly inserted paragraph.
 *  - `table`: a table; `orig` = original block index (reuses tblPr/grid/tcPr),
 *    `cols` = current column count, `rows` = current grid. */
export type BlockEdit =
  | { kind: "verbatim"; orig: number }
  | { kind: "para"; orig: number | null; runs: RunEdit[]; align?: string | null; style?: string | null; indent?: number | null; line?: number | null; list?: "bullet" | "decimal" | "none" | null; ilvl?: number | null }
  | { kind: "table"; orig: number | null; cols: number; rows: RowEdit[] };

/** Structure-preserving save: rebuild the body from the ordered block list,
 *  re-emitting untouched blocks byte-for-byte and re-serializing only changed
 *  paragraphs. Preserves tables, styles, and page geometry. */
export const saveWordDocument = (path: string, blocks: BlockEdit[], output: string) =>
  invoke<string>("save_word_document", { path, blocks, output });

/** Replace body paragraph `index`'s text and save to `output` (lossless). */
export const setWordParagraph = (path: string, index: number, text: string, output: string) =>
  invoke<string>("set_word_paragraph", { path, index, text, output });

export const setStarred = (path: string, name: string, starred: boolean) =>
  invoke<void>("set_starred", { path, name, starred });

export const setArchived = (path: string, name: string, archived: boolean) =>
  invoke<void>("set_archived", { path, name, archived });

export const getStarred = () => invoke<LibraryEntry[]>("get_starred");
export const getArchived = () => invoke<LibraryEntry[]>("get_archived");
export const getEntry = (path: string) => invoke<LibraryEntry | null>("get_entry", { path });

export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });

// --- OCR ---

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrPage {
  words: OcrWord[];
}

export const makeSearchable = (path: string, pages: OcrPage[], output?: string) =>
  invoke<string>("make_searchable", { path, pages, output });

// --- Watermark ---

export interface WatermarkOptions {
  text: string;
  font_size?: number;  // default 48
  opacity?: number;    // 0–1, default 0.25
  angle?: number;      // degrees CCW, default 45
  color?: string;      // hex "#rrggbb", default "#888888"
  mode?: "diagonal" | "center" | "tile";
  pages?: number[];    // 1-indexed; omit = all pages
}

export const addWatermark = (path: string, options: WatermarkOptions, output?: string) =>
  invoke<string>("add_watermark", { path, options, output });

// --- Outline / Bookmarks ---

export interface OutlineNode {
  title: string;
  page: number | null;
  items: OutlineNode[];
}

export const getOutline = (path: string) =>
  invoke<OutlineNode[]>("get_outline", { path });

// --- Form filling ---

export interface FormField {
  name: string;
  field_type: string;
  value: string;
  page: number;
  rect: [number, number, number, number];
  options: string[];
  flags: number;
}

export interface FieldValue {
  name: string;
  value: string;
}

export const getFormFields = (path: string) =>
  invoke<FormField[]>("get_form_fields", { path });

export const fillForm = (path: string, fields: FieldValue[], flatten: boolean, output?: string) =>
  invoke<string>("fill_form", { path, fields, flatten, output });

// --- Standard PDF annotations ---

export interface PdfAnnotation {
  id: string;
  subtype: string;
  rect: [number, number, number, number];
  color: string | null;
  contents: string | null;
  quad_points: number[] | null;
}

export interface NewAnnotation {
  subtype: string;
  page: number;
  rect: [number, number, number, number];
  color: string;
  contents?: string;
  quad_points?: number[];
  author?: string;
}

export const getPageAnnotations = (path: string, page: number) =>
  invoke<PdfAnnotation[]>("get_page_annotations", { path, page });

export const addPdfAnnotation = (path: string, annotation: NewAnnotation, output?: string) =>
  invoke<string>("add_pdf_annotation", { path, annotation, output });

// --- Redaction ---

export interface RedactRegion {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const redactPdf = (path: string, regions: RedactRegion[], output?: string) =>
  invoke<string>("redact_pdf", { path, regions, output });

// --- Crop ---

export const cropPages = (path: string, pages: number[], cropRect: [number, number, number, number], output?: string) =>
  invoke<string>("crop_pages", { path, pages, cropRect, output });

// --- Flatten ---

export const flattenPdf = (path: string, output?: string) =>
  invoke<string>("flatten_pdf", { path, output });

// --- Export text ---

export const exportPdfToText = (path: string, output?: string) =>
  invoke<string>("export_pdf_to_text", { path, output });

export const setActiveDocument = (path: string | null) =>
  invoke<void>("set_active_document", { path });
