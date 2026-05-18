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
