/** The one bundled family (Geist Variable via @fontsource-variable/geist). No remote fonts. */
export const UI = '"Geist Variable", ui-sans-serif, system-ui, sans-serif';
/**
 * Monospace is reserved for code (crash logs, raw metadata). Counts, sizes and
 * shortcuts use the sans with tabular numerals; see `NUM` below.
 * @deprecated for UI chrome — use `UI` plus `NUM` for figures.
 */
export const MONO = 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", "DejaVu Sans Mono", monospace';
/** Spread into a style object to get aligned figures in the sans. */
export const NUM = { fontFamily: UI, fontVariantNumeric: "tabular-nums" } as const;
