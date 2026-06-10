import { memo, useMemo } from "react";
import {
  DndContext, closestCenter, KeyboardSensor,
  MouseSensor, TouchSensor, useSensor, useSensors, DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates,
  useSortable, rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LoadedFile } from "../store/useAppStore";
import { useThumbnails } from "../hooks/useThumbnails";

import { UI, MONO } from "../lib/tokens";

interface PageGridProps {
  files: LoadedFile[];
  onRemove: (path: string) => void;
  onReorder?: (from: number, to: number) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (path: string) => void;
}

// Memoized: parent passes path-based, stable handlers so only the card whose
// `thumbnail`/`selected` actually changed re-renders — not every card on each
// parent render (e.g. a thumbnail arriving, or a sibling being removed).
const FileCard = memo(function FileCard({ file, thumbnail, onRemove, selectable, selected, onToggleSelect }: {
  file: LoadedFile; thumbnail?: string;
  onRemove: (path: string) => void; selectable?: boolean;
  selected?: boolean; onToggleSelect?: (path: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: file.path });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        position: "relative",
        background: "var(--bg2)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--line)"}`,
        borderRadius: 6,
        overflow: "hidden",
        boxShadow: selected ? `0 0 0 1px var(--accent)` : undefined,
      }}
      onClick={selectable && onToggleSelect ? () => onToggleSelect(file.path) : undefined}
    >
      {/* Drag handle */}
      <div
        {...listeners}
        {...attributes}
        className="pg-handle"
        style={{ touchAction: "none", position: "absolute", top: 4, left: 4, zIndex: 10,
          cursor: "grab", color: "var(--fg3)", padding: 6,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.18)", borderRadius: 4, backdropFilter: "blur(2px)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg1)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg3)")}
      >
        <svg width={16} height={16} fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 2a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4zM7 8a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4zM7 14a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4z" />
        </svg>
      </div>

      {/* Remove button */}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(file.path); }}
        aria-label="Remove file"
        className="pg-remove"
        style={{
          position: "absolute", top: 4, right: 4, zIndex: 10,
          background: "rgba(0,0,0,0.18)", border: "none", cursor: "pointer",
          color: "var(--fg1)", padding: 6, borderRadius: 4,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          backdropFilter: "blur(2px)", WebkitTapHighlightColor: "transparent",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg1)")}
      >
        <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8}
          strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      </button>

      {/* Thumbnail */}
      <div style={{
        aspectRatio: "3/4",
        background: "var(--bg3)",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderBottom: "1px solid var(--line2)",
      }}>
        {thumbnail ? (
          <img src={thumbnail} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <svg width={32} height={32} fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
            style={{ color: "var(--fg3)" }}>
            <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        )}
      </div>

      {/* File info */}
      <div style={{ padding: "6px 8px" }}>
        <p style={{ fontFamily: UI, fontSize: 11, fontWeight: 500, color: "var(--fg0)",
          margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={file.name}>
          {file.name}
        </p>
        {file.info && (
          <p style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg2)", margin: "2px 0 0" }}>
            {file.info.page_count} pg
          </p>
        )}
      </div>

      {/* Selection overlay */}
      {selectable && selected && (
        <div style={{
          position: "absolute", inset: 0,
          background: "var(--accent-soft)",
          pointerEvents: "none",
        }} />
      )}
    </div>
  );
});

export function PageGrid({ files, onRemove, onReorder, selectable, selected, onToggleSelect }: PageGridProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // Stable across renders unless `files` itself changes — feeds both the
  // thumbnail hook and SortableContext without allocating a new array each render.
  const filePaths = useMemo(() => files.map((f) => f.path), [files]);
  const thumbnails = useThumbnails(filePaths);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id && onReorder) {
      const from = files.findIndex((f) => f.path === active.id);
      const to = files.findIndex((f) => f.path === over.id);
      if (from !== -1 && to !== -1) onReorder(from, to);
    }
  }

  if (files.length === 0) return null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={filePaths} strategy={rectSortingStrategy}>
        <div className="pg-grid" style={{
          display: "grid", gap: 10,
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        }}>
          {files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              thumbnail={thumbnails[file.path]}
              onRemove={onRemove}
              selectable={selectable}
              selected={selected?.has(file.path)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
