import { memo, useMemo } from "react";
import {
  DndContext, closestCenter, KeyboardSensor,
  MouseSensor, useSensor, useSensors, DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates,
  useSortable, rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LoadedFile } from "../store/useAppStore";
import { thumbUrl } from "../render/renderClient";
import { useDocVersion } from "../render/docVersion";
import { IcClose, IcFile } from "./Icons";

interface PageGridProps {
  files: LoadedFile[];
  onRemove: (path: string) => void;
  onReorder?: (from: number, to: number) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (path: string) => void;
}

// Memoized: parent passes path-based, stable handlers so only the card whose
// `selected` changed (or whose file was rewritten) re-renders — not every card
// on each parent render (e.g. a sibling being removed).
const FileCard = memo(function FileCard({ file, index, onRemove, selectable, selected, onToggleSelect }: {
  file: LoadedFile;
  index: number;
  onRemove: (path: string) => void; selectable?: boolean;
  selected?: boolean; onToggleSelect?: (path: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: file.path });
  // Re-render (new thumbnail URL) when Qyra rewrites this file.
  useDocVersion(file.path);
  const thumbnail = thumbUrl(file.path, 1, 256);

  return (
    <div
      ref={setNodeRef}
      className="filecard"
      data-selected={selected ? "true" : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      onClick={selectable && onToggleSelect ? () => onToggleSelect(file.path) : undefined}
    >
      <div className="filecard-thumb">
        <IcFile size={28} style={{ color: "var(--paper-5)" }} />
        {thumbnail && <img src={thumbnail} alt="" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />}
        <span className="filecard-index" aria-hidden="true">{index + 1}</span>
        <button
          type="button"
          {...listeners}
          {...attributes}
          className="filecard-handle"
          aria-label={`Drag to reorder ${file.name}`}
          title="Drag to reorder"
        >
          <svg width={14} height={14} fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7 2a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4zM7 8a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4zM7 14a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(file.path); }}
          aria-label={`Remove ${file.name}`}
          title="Remove"
          className="filecard-remove"
        >
          <IcClose size={14} />
        </button>
      </div>

      <div className="filecard-text">
        <span className="filecard-name" title={file.name}>{file.name}</span>
        {file.info && (
          <span className="t-meta">{file.info.page_count} {file.info.page_count === 1 ? "page" : "pages"}</span>
        )}
      </div>
    </div>
  );
});

export function PageGrid({ files, onRemove, onReorder, selectable, selected, onToggleSelect }: PageGridProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // Stable across renders unless `files` itself changes — feeds SortableContext
  // without allocating a new array each render.
  const filePaths = useMemo(() => files.map((f) => f.path), [files]);

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
        <div className="pg-grid filecard-grid">
          {files.map((file, i) => (
            <FileCard
              key={file.path}
              file={file}
              index={i}
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
