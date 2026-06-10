import { useState, useEffect } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { reorderPages } from "../lib/tauri";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, useSortable,
  rectSortingStrategy, arrayMove
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function PageChip({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
      className="
        w-16 h-20 flex flex-col items-center justify-center
        bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
        rounded-lg text-sm cursor-grab active:cursor-grabbing shadow-sm
        hover:border-blue-300 dark:hover:border-blue-600 select-none
      "
    >
      <svg className="w-6 h-6 text-gray-300 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
      <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
    </div>
  );
}

export default function ReorderPages() {
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const { run } = usePdfCommand();
  const file = files[0];
  const pageCount = file?.info?.page_count ?? 0;

  // pageOrder[i] = original page number at position i (1-indexed)
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

  async function handleReorder() {
    if (!file) return;
    await run(() => reorderPages(file.path, pageOrder));
  }

  return (
    <ToolLayout title="Reorder Pages" description="Drag and drop pages into a new order">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">{file!.name}</p>
              <p className="text-xs text-gray-400">{pageCount} pages</p>
            </div>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          {pageCount > 0 && pageCount <= 100 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
              <p className="text-xs text-gray-500 mb-3">Drag pages to reorder</p>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={pageOrder.map(String)} strategy={rectSortingStrategy}>
                  <div className="flex flex-wrap gap-2">
                    {pageOrder.map((pg) => (
                      <PageChip key={pg} id={String(pg)} label={String(pg)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {pageCount > 100 && (
            <p className="text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
              Document has {pageCount} pages — visual reorder is limited to 100 pages. Use the range reorder below.
            </p>
          )}

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <p className="text-xs text-gray-500">Current order: {pageOrder.slice(0, 10).join(", ")}{pageOrder.length > 10 ? "..." : ""}</p>
            <button
              disabled={!file || isProcessing}
              onClick={handleReorder}
              className="btn-primary w-full"
            >
              Apply New Order
            </button>
          </div>
        </div>
      )}
    </ToolLayout>
  );
}
