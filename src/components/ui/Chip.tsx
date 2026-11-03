import { clsx } from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { chipStyle, type Family } from "../../lib/families";

interface ChipProps {
  family?: Family;
  /** Any CSS colour; overrides `family`. */
  color?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}

/** A stock tag: a colour edge plus a tracked uppercase label. The signature of the system. */
export function Chip({ family = "library", color, children, className, title }: ChipProps) {
  const style = (color ? { "--chip": color } : chipStyle(family)) as CSSProperties;
  return (
    <span className={clsx("chip", className)} style={style} title={title}>
      {children}
    </span>
  );
}
