/**
 * Tool families and their swatch colours. The colour is functional: the same
 * hue marks a family on Home, on a document tab, and on the sample-book thumb
 * index in the viewer panel, so a tool is found by colour before it is read.
 */
export type Family =
  | "library"
  | "annotate"
  | "pages"
  | "sign"
  | "forms"
  | "redact"
  | "compress"
  | "export";

export const FAMILY: Record<Family, { label: string; color: string }> = {
  library:  { label: "Library",  color: "var(--sw-library)" },
  annotate: { label: "Annotate", color: "var(--sw-annotate)" },
  pages:    { label: "Pages",    color: "var(--sw-pages)" },
  sign:     { label: "Sign",     color: "var(--sw-sign)" },
  forms:    { label: "Forms",    color: "var(--sw-forms)" },
  redact:   { label: "Redact",   color: "var(--sw-redact)" },
  compress: { label: "Compress", color: "var(--sw-compress)" },
  export:   { label: "Export",   color: "var(--sw-export)" },
};

/** Style object that sets the `--chip` custom property a `.chip` or `.thumb-tab` reads. */
export function chipStyle(family: Family): { ["--chip"]: string } & Record<string, string> {
  return { "--chip": FAMILY[family].color };
}
