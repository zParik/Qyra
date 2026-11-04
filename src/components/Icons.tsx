import React from "react";

export type IconProps = { size?: number; style?: React.CSSProperties };

function Ic({ children, size = 16, style }: { children: React.ReactNode; size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}>
      {children}
    </svg>
  );
}

export const IcHome    = (p: IconProps) => <Ic {...p}><path d="M2.5 7L8 2.5 13.5 7v6.5h-3.5V10h-3v3.5H2.5z"/></Ic>;
export const IcRecent  = (p: IconProps) => <Ic {...p}><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></Ic>;
export const IcStar    = (p: IconProps) => <Ic {...p}><path d="M8 2l1.7 3.7 4 .5-3 2.8.8 4L8 11l-3.5 2 .8-4-3-2.8 4-.5z"/></Ic>;
export const IcFolder  = (p: IconProps) => <Ic {...p}><path d="M2 4.5h4l1.5 1.5h6.5v7H2z"/></Ic>;
export const IcArchive = (p: IconProps) => <Ic {...p}><rect x="2.5" y="3" width="11" height="3"/><path d="M3 6v7.5h10V6M6.5 9h3"/></Ic>;
export const IcMerge   = (p: IconProps) => <Ic {...p}><path d="M3 3v3.5c0 1 .5 1.5 1.5 1.5h7c1 0 1.5-.5 1.5-1.5V3M8 8v5M5.5 10.5L8 13l2.5-2.5"/></Ic>;
export const IcImage   = (p: IconProps) => <Ic {...p}><rect x="2.5" y="3" width="11" height="10" rx="0.5"/><circle cx="6" cy="6.5" r="1"/><path d="M3 11l3-3 3 3 2-2 2 2"/></Ic>;
export const IcUpload  = (p: IconProps) => <Ic {...p}><path d="M8 11V3M5 6l3-3 3 3M3 13h10"/></Ic>;
export const IcChevron = (p: IconProps) => <Ic {...p}><path d="M6 4l4 4-4 4"/></Ic>;
export const IcGrid    = (p: IconProps) => <Ic {...p}><rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/></Ic>;
export const IcList    = (p: IconProps) => <Ic {...p}><path d="M3 4h10M3 8h10M3 12h10"/></Ic>;
export const IcFile    = (p: IconProps) => <Ic {...p}><path d="M3.5 2h6l3 3v9h-9z"/><path d="M9.5 2v3h3"/></Ic>;

// ── Tool families and shell glyphs (same 16-unit grid, 1.5 stroke) ──
export const IcScan     = (p: IconProps) => <Ic {...p}><path d="M2.5 5.5v-2a1 1 0 011-1h2M10.5 2.5h2a1 1 0 011 1v2M13.5 10.5v2a1 1 0 01-1 1h-2M5.5 13.5h-2a1 1 0 01-1-1v-2"/><path d="M5 8h6"/></Ic>;
export const IcWrench   = (p: IconProps) => <Ic {...p}><path d="M9.5 2.5a3.5 3.5 0 004 4L7 13a1.6 1.6 0 01-2.3-2.3l6.5-6.5"/><path d="M11.5 2.5a3.5 3.5 0 00-2 2v1.5h1.5a3.5 3.5 0 002-2"/></Ic>;
export const IcStack    = (p: IconProps) => <Ic {...p}><path d="M3 5.5l5-2.5 5 2.5-5 2.5z"/><path d="M3 8.5l5 2.5 5-2.5M3 11l5 2.5 5-2.5"/></Ic>;
export const IcGear     = (p: IconProps) => <Ic {...p}><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></Ic>;
export const IcSearch   = (p: IconProps) => <Ic {...p}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></Ic>;
export const IcPen      = (p: IconProps) => <Ic {...p}><path d="M3 13l.8-3.2L11 2.6a1.2 1.2 0 011.7 0l.7.7a1.2 1.2 0 010 1.7L6.2 12.2z"/><path d="M9.8 3.8l2.4 2.4"/></Ic>;
export const IcHighlight= (p: IconProps) => <Ic {...p}><path d="M3 10.5l6.5-6.5 3 3L6 13.5H3z"/><path d="M2 14h12"/></Ic>;
export const IcSign     = (p: IconProps) => <Ic {...p}><path d="M2.5 12c2-5 4-7 5.5-7s1 3 .5 5 0 3 1 3 2-1 3-3"/><path d="M2 14h12"/></Ic>;
export const IcForm     = (p: IconProps) => <Ic {...p}><rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M5 6.5h6M5 9.5h3"/></Ic>;
export const IcRedact   = (p: IconProps) => <Ic {...p}><rect x="2.5" y="6" width="11" height="4" rx="0.5" fill="currentColor"/><path d="M4 3.5h8M4 12.5h5"/></Ic>;
export const IcCompress = (p: IconProps) => <Ic {...p}><path d="M8 2v4M6 4l2 2 2-2M8 14v-4M6 12l2-2 2 2M3 8h10"/></Ic>;
export const IcConvert  = (p: IconProps) => <Ic {...p}><path d="M3 6h8l-2-2M13 10H5l2 2"/></Ic>;
export const IcLock     = (p: IconProps) => <Ic {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></Ic>;
export const IcClose    = (p: IconProps) => <Ic {...p}><path d="M4 4l8 8M12 4l-8 8"/></Ic>;
export const IcPlus     = (p: IconProps) => <Ic {...p}><path d="M8 3v10M3 8h10"/></Ic>;
export const IcCheck    = (p: IconProps) => <Ic {...p}><path d="M3 8.5l3 3 7-7"/></Ic>;
export const IcAlert    = (p: IconProps) => <Ic {...p}><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11v.5"/></Ic>;
export const IcInfo     = (p: IconProps) => <Ic {...p}><circle cx="8" cy="8" r="6"/><path d="M8 7.5V11M8 5v.5"/></Ic>;
export const IcSun      = (p: IconProps) => <Ic {...p}><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></Ic>;
export const IcMoon     = (p: IconProps) => <Ic {...p}><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z"/></Ic>;
export const IcMonitor  = (p: IconProps) => <Ic {...p}><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M5.5 13.5h5M8 11v2.5"/></Ic>;
export const IcArrowLeft= (p: IconProps) => <Ic {...p}><path d="M13 8H3M7 4L3 8l4 4"/></Ic>;
export const IcExternal = (p: IconProps) => <Ic {...p}><path d="M7 3H3.5v9.5H13V9M9 3h4v4M13 3l-6 6"/></Ic>;
