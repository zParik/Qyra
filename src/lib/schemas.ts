import { z } from "zod";

export const PdfMetadataSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  subject: z.string().optional(),
  keywords: z.string().optional(),
  creator: z.string().optional(),
  producer: z.string().optional(),
  creation_date: z.string().optional(),
  mod_date: z.string().optional(),
});

export const PdfInfoSchema = z.object({
  page_count: z.number().int().positive(),
  file_size: z.number().nonnegative(),
  metadata: PdfMetadataSchema,
});

export const CompressResultSchema = z.object({
  path: z.string(),
  original_bytes: z.number().nonnegative(),
  compressed_bytes: z.number().nonnegative(),
});

export const LibraryEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  starred: z.boolean(),
  archived: z.boolean(),
  addedAt: z.number(),
});

export const DiskSpaceSchema = z.object({
  total: z.number().nonnegative(),
  available: z.number().nonnegative(),
  used: z.number().nonnegative(),
});

export const PageRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});

export const StrokeAnnotationSchema = z.object({
  tool: z.string(),
  color: z.string(),
  thickness: z.number().positive(),
  points: z.array(z.tuple([z.number(), z.number()])),
});

export const PageAnnotationSchema = z.object({
  page: z.number().int().positive(),
  strokes: z.array(StrokeAnnotationSchema),
});

export const PageNumberOptionsSchema = z.object({
  start_at: z.number().int().optional(),
  position: z.enum([
    "bottom-center", "bottom-right", "bottom-left",
    "top-center", "top-right", "top-left",
  ]).optional(),
  font_size: z.number().positive().optional(),
  margin: z.number().optional(),
});

export const CommentSchema = z.object({
  id: z.string(),
  pageIndex: z.number().int(),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  color: z.string(),
  resolved: z.boolean(),
  createdAt: z.number(),
  quote: z.string().optional(),
});

export const RecentFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  openedAt: z.number(),
});

export type PdfMetadata = z.infer<typeof PdfMetadataSchema>;
export type PdfInfo = z.infer<typeof PdfInfoSchema>;
export type CompressResult = z.infer<typeof CompressResultSchema>;
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;
export type DiskSpace = z.infer<typeof DiskSpaceSchema>;
export type PageRange = z.infer<typeof PageRangeSchema>;
export type StrokeAnnotation = z.infer<typeof StrokeAnnotationSchema>;
export type PageAnnotation = z.infer<typeof PageAnnotationSchema>;
export type PageNumberOptions = z.infer<typeof PageNumberOptionsSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type RecentFile = z.infer<typeof RecentFileSchema>;
