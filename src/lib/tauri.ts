import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { isAndroid, androidSavePath, androidOutputDir } from "./androidFileUtils";

export interface PageRange {
  start: number;
  end: number;
}

export interface PageNumberOptions {
  start_at?: number;
  position?: "bottom-center" | "bottom-right" | "bottom-left" | "top-center" | "top-right" | "top-left";
  font_size?: number;
  margin?: number;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creation_date?: string;
  mod_date?: string;
}

export interface PdfInfo {
  page_count: number;
  file_size: number;
  metadata: PdfMetadata;
}

// --- Core PDF commands ---

export const mergePdfs = (paths: string[], output?: string) =>
  invoke<string>("merge_pdfs", { paths, output });

export const splitPdf = (path: string, ranges: PageRange[], outputDir?: string) =>
  invoke<string[]>("split_pdf", { path, ranges, outputDir });

export const splitPdfPerPage = (path: string, outputDir?: string) =>
  invoke<string[]>("split_pdf_per_page", { path, outputDir });

export const compressPdf = (path: string, output?: string, level?: number) =>
  invoke<string>("compress_pdf", { path, output, level });

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

export interface StrokeAnnotation {
  tool: string;
  color: string;
  thickness: number;
  points: [number, number][];
}

export interface PageAnnotation {
  page: number;
  strokes: StrokeAnnotation[];
}

export const bakeAnnotations = (path: string, annotations: PageAnnotation[], output?: string) =>
  invoke<string>("bake_annotations", { path, annotations, output });
