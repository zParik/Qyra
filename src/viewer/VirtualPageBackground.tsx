import { memo } from "react";
import { PageTemplate } from "../store/useNotesStore";

interface Props {
  template: PageTemplate;
  width: number;   // px
  height: number;  // px
}

const LINE_SPACING = 32; // px at 100% zoom — ruled/grid line interval
const DOT_SPACING  = 32;

function VirtualPageBackgroundInner({ template, width, height }: Props) {
  const patternId = `vp-${template}`;

  let pattern: React.ReactNode = null;
  let patternW = LINE_SPACING;
  let patternH = LINE_SPACING;

  if (template === 'ruled') {
    pattern = (
      <line
        x1={0} y1={LINE_SPACING - 0.5}
        x2={patternW} y2={LINE_SPACING - 0.5}
        stroke="#b8c5d6" strokeWidth={0.8}
      />
    );
  } else if (template === 'grid') {
    pattern = (
      <>
        <line x1={LINE_SPACING - 0.5} y1={0} x2={LINE_SPACING - 0.5} y2={patternH} stroke="#c2cdd8" strokeWidth={0.6} />
        <line x1={0} y1={LINE_SPACING - 0.5} x2={patternW} y2={LINE_SPACING - 0.5} stroke="#c2cdd8" strokeWidth={0.6} />
      </>
    );
  } else if (template === 'dotted') {
    patternW = DOT_SPACING;
    patternH = DOT_SPACING;
    pattern = (
      <circle cx={DOT_SPACING - 0.5} cy={DOT_SPACING - 0.5} r={1.2} fill="#9aaabb" />
    );
  }

  return (
    <svg
      width={width}
      height={height}
      className="absolute inset-0 pointer-events-none"
      style={{ borderRadius: "inherit" }}
    >
      <rect width={width} height={height} fill="white" />
      {template !== 'blank' && (
        <defs>
          <pattern id={patternId} x={0} y={0} width={patternW} height={patternH} patternUnits="userSpaceOnUse">
            {pattern}
          </pattern>
        </defs>
      )}
      {template !== 'blank' && (
        <rect width={width} height={height} fill={`url(#${patternId})`} />
      )}
    </svg>
  );
}

// Pure render from primitive props (template/width/height). Memoized so it does
// not re-render on every Viewer re-render while scrolling/zooming.
export const VirtualPageBackground = memo(VirtualPageBackgroundInner);
