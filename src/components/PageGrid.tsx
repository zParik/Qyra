import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LoadedFile } from "../store/useAppStore";
import { useThumbnails } from "../hooks/useThumbnails";

interface PageGridProps {
  files: LoadedFile[];
  onRemove: (path: string) => void;
  onReorder?: (from: number, to: number) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (path: string) => void;
}

function FileCard({
  file,
  thumbnail,
  onRemove,
  selectable,
  selected,
  onToggleSelect,
}: {
  file: LoadedFile;
  thumbnail?: string;
  onRemove: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
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
      style={style}
      {...attributes}
      className={`
        relative bg-white dark:bg-gray-800 rounded-lg border shadow-sm overflow-hidden
        ${selected ? "ring-2 ring-blue-500" : "border-gray-200 dark:border-gray-700"}
      `}
      onClick={selectable ? onToggleSelect : undefined}
    >
      {/* Drag handle */}
      <div
        {...listeners}
        style={{ touchAction: "none" }}
        className="absolute top-1 left-1 p-1 cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 z-10"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 2a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4zM7 8a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4zM7 14a2 2 0 110 4 2 2 0 010-4zm6 0a2 2 0 110 4 2 2 0 010-4z" />
        </svg>
      </div>

      {/* Remove button */}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="absolute top-1 right-1 p-1 text-gray-400 hover:text-red-500 z-10"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Thumbnail */}
      <div className="aspect-[3/4] bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
        {thumbnail ? (
          <img src={thumbnail} alt={file.name} className="w-full h-full object-contain" />
        ) : (
          <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        )}
      </div>

      {/* File info */}
      <div className="p-2">
        <p className="text-xs font-medium truncate text-gray-800 dark:text-gray-200" title={file.name}>
          {file.name}
        </p>
        {file.info && (
          <p className="text-xs text-gray-400">{file.info.page_count} page{file.info.page_count !== 1 ? "s" : ""}</p>
        )}
      </div>

      {/* Selection indicator */}
      {selectable && selected && (
        <div className="absolute inset-0 bg-blue-500 bg-opacity-10 pointer-events-none" />
      )}
    </div>
  );
}

export function PageGrid({ files, onRemove, onReorder, selectable, selected, onToggleSelect }: PageGridProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const thumbnails = useThumbnails(files.map((f) => f.path));

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
      <SortableContext items={files.map((f) => f.path)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              thumbnail={thumbnails[file.path]}
              onRemove={() => onRemove(file.path)}
              selectable={selectable}
              selected={selected?.has(file.path)}
              onToggleSelect={() => onToggleSelect?.(file.path)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
