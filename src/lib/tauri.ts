import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { isAndroid, androidSavePath, androidOutputDir } from "./androidFileUtils";
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
  return save({ defaultPath, filters: [{ name: "PDF", extensions: ["pdf"] }] });
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
