import { useState, useEffect } from "react";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, useSortable,
  rectSortingStrategy, arrayMove
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { reorderPages } from "../../lib/tauri";
import { seedThumbnailsForReorder } from "../../hooks/usePageThumbnails";
import { IconDocWord } from "../icons";

// Must match the scales used by Viewer.tsx's two usePageThumbnails calls.
const VIEWER_SCALES = [0.3, 2.0];

function PageChip({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
      className="v-page-chip w-12 h-14 flex flex-col items-center justify-center rounded-lg text-xs cursor-grab active:cursor-grabbing select-none"
    >
      <IconDocWord className="w-4 h-4 mb-0.5" style={{ color: "var(--viewer-text-muted)" }} />
      <span className="font-medium">{label}</span>
    </div>
  );
}

interface ReorderPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function ReorderPanel({ file, onApplied }: ReorderPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const pageCount = file.info?.page_count ?? 0;
  const [pageOrder, setPageOrder] = useState<number[]>([]);

  useEffect(() => {
    if (pageCount > 0) {
      setPageOrder(Array.from({ length: pageCount }, (_, i) => i + 1));
    }
  }, [pageCount]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const from = pageOrder.indexOf(Number(active.id));
      const to = pageOrder.indexOf(Number(over.id));
      setPageOrder(arrayMove(pageOrder, from, to));
    }
  }

  async function handle() {
    const orderSnapshot = [...pageOrder];
    await run(async () => {
      const newPath = await reorderPages(file.path, orderSnapshot);
      // Pre-populate the thumbnail cache for the new path so the viewer reload is instant.
      // Reorder only repositions pages — content is identical — so we can reuse cached renders.
      seedThumbnailsForReorder(file.path, newPath, orderSnapshot, VIEWER_SCALES);
      return newPath;
    });
  }

  if (pageCount === 0) {
    return <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>No page info available.</p>;
  }

  if (pageCount > 100) {
    return (
      <p
        className="text-xs rounded-lg p-3"
        style={{
          background: "var(--v-warn-bg)",
          border: "1px solid var(--v-warn-border)",
          color: "var(--v-warn-text)",
        }}
      >
        Visual reorder is limited to 100 pages. This document has {pageCount} pages.
      </p>
    );
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Apply New Order"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>Drag pages into the order you want, then apply.</p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={pageOrder.map(String)} strategy={rectSortingStrategy}>
          <div className="flex flex-wrap gap-1.5">
            {pageOrder.map((pg) => (
              <PageChip key={pg} id={String(pg)} label={String(pg)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </ToolPanelLayout>
  );
}
