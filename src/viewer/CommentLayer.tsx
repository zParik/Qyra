import { useEffect, useRef, useState } from "react";
import { Comment, COMMENT_COLORS, useCommentsStore } from "../store/useCommentsStore";

interface CommentLayerProps {
  pageIndex: number;    // 1-indexed
  docPath: string;
  isCommentMode: boolean;
}

const UI = "'Inter', system-ui, sans-serif";

// Small speech-bubble pin rendered as an SVG.
function Pin({ color, selected }: { color: string; selected: boolean }) {
  return (
    <svg
      width={22} height={26} viewBox="0 0 22 26" fill="none"
      style={{ filter: selected ? "drop-shadow(0 0 4px rgba(0,0,0,0.5))" : undefined }}
    >
      <path
        d="M11 1C5.477 1 1 5.477 1 11c0 4.418 2.865 8.166 6.857 9.498L11 25l3.143-4.502C18.135 19.166 21 15.418 21 11 21 5.477 16.523 1 11 1z"
        fill={color}
        stroke="rgba(0,0,0,0.25)"
        strokeWidth={1.2}
      />
      <circle cx={11} cy={11} r={4} fill="rgba(255,255,255,0.35)" />
    </svg>
  );
}

export interface EditorProps {
  comment: Comment | null; // null = new comment being placed
  x: number;               // viewport x for positioning
  y: number;               // viewport y for positioning
  docPath: string;
  pageIndex: number;
  normX: number;           // normalized page coords (for new comment)
  normY: number;
  quote?: string;          // NEW: The selected text being commented on
  onClose: () => void;
}

export function CommentEditor({ comment, x, y, docPath, pageIndex, normX, normY, quote, onClose }: EditorProps) {
  const addComment = useCommentsStore((s) => s.addComment);
  const updateComment = useCommentsStore((s) => s.updateComment);
  const removeComment = useCommentsStore((s) => s.removeComment);

  const [text, setText] = useState(comment?.text ?? "");
  const [color, setColor] = useState(comment?.color ?? COMMENT_COLORS[0]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleSave() {
    const trimmed = text.trim();
    if (!trimmed) { onClose(); return; }

    if (comment) {
      updateComment(docPath, comment.id, { text: trimmed, color });
    } else {
      addComment(docPath, {
        id: crypto.randomUUID(),
        pageIndex,
        x: normX,
        y: normY,
        text: trimmed,
        color,
        resolved: false,
        createdAt: Date.now(),
        quote: quote || undefined,
      });
    }
    onClose();
  }

  function handleDelete() {
    if (comment) removeComment(docPath, comment.id);
    onClose();
  }

  // Clamp popover so it doesn't go off-screen
  const POPOVER_W = 220;
  const POPOVER_H = 160;
  const left = Math.min(x + 14, window.innerWidth - POPOVER_W - 8);
  const top = Math.min(y - 10, window.innerHeight - POPOVER_H - 8);

  return (
    <div
      style={{
        position: "fixed",
        left,
        top,
        width: POPOVER_W,
        zIndex: 200,
        background: "var(--viewer-elevated)",
        border: "1px solid var(--viewer-border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Color picker */}
      <div style={{ display: "flex", gap: 5 }}>
        {COMMENT_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            style={{
              width: 18, height: 18, borderRadius: "50%",
              background: c, border: color === c ? "2px solid white" : "2px solid transparent",
              outline: color === c ? `2px solid ${c}` : "none",
              cursor: "pointer", padding: 0,
            }}
          />
        ))}
      </div>

      {/* Quote display */}
      {(quote || comment?.quote) && (
        <div style={{
          fontFamily: UI, fontSize: 11, color: "var(--viewer-text-sec)",
          background: "var(--viewer-surface)", padding: "4px 8px",
          borderLeft: `2px solid ${color}`, borderRadius: "0 4px 4px 0",
          overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box",
          WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          "{quote || comment?.quote}"
        </div>
      )}

      {/* Text area */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
        style={{
          resize: "none",
          width: "100%",
          background: "var(--viewer-surface)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 4,
          color: "var(--viewer-text)",
          fontFamily: UI,
          fontSize: 12,
          padding: "5px 6px",
          outline: "none",
          caretColor: "var(--accent)",
          boxSizing: "border-box",
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSave();
        }}
      />

      {/* Actions */}
      <div style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
        {comment && (
          <button
            onClick={handleDelete}
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              color: "#ef4444", fontFamily: UI, fontSize: 11, padding: "2px 6px",
            }}
          >
            Delete
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            border: "1px solid var(--viewer-border)",
            background: "var(--viewer-surface)", cursor: "pointer",
            color: "var(--viewer-text-muted)", fontFamily: UI, fontSize: 11,
            padding: "3px 10px", borderRadius: 4,
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          style={{
            border: "none",
            background: "var(--accent)", cursor: "pointer",
            color: "white", fontFamily: UI, fontSize: 11, fontWeight: 600,
            padding: "3px 10px", borderRadius: 4,
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CommentLayer
// ---------------------------------------------------------------------------

export function CommentLayer({ pageIndex, docPath, isCommentMode }: CommentLayerProps) {
  const docComments = useCommentsStore((s) => s.comments[docPath]);
  const comments = (docComments ?? []).filter((c) => c.pageIndex === pageIndex);

  // Editor state: null = closed, { comment: existing, ... } = editing, { comment: null, ... } = new
  const [editor, setEditor] = useState<{
    comment: Comment | null;
    screenX: number;
    screenY: number;
    normX: number;
    normY: number;
  } | null>(null);

  const layerRef = useRef<HTMLDivElement>(null);

  function handleLayerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!isCommentMode) return;
    // Ignore clicks that originated from a pin (they call stopPropagation)
    const rect = layerRef.current!.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top) / rect.height;
    setEditor({ comment: null, screenX: e.clientX, screenY: e.clientY, normX, normY });
  }

  function handlePinClick(e: React.MouseEvent, comment: Comment) {
    e.stopPropagation();
    setEditor({
      comment,
      screenX: e.clientX,
      screenY: e.clientY,
      normX: comment.x,
      normY: comment.y,
    });
  }

  return (
    <>
      <div
        ref={layerRef}
        onClick={handleLayerClick}
        style={{
          position: "absolute",
          inset: 0,
          cursor: isCommentMode ? "crosshair" : "default",
          pointerEvents: isCommentMode ? "auto" : "none",
          zIndex: 30,
        }}
      >
        {comments.map((c) => (
          <button
            key={c.id}
            onClick={(e) => handlePinClick(e, c)}
            title={c.text}
            style={{
              position: "absolute",
              left: `${c.x * 100}%`,
              top: `${c.y * 100}%`,
              transform: "translate(-50%, -100%)",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              opacity: c.resolved ? 0.4 : 1,
              transition: "opacity 120ms",
              pointerEvents: "auto",
              zIndex: 31,
            }}
          >
            <Pin
              color={c.color}
              selected={editor?.comment?.id === c.id}
            />
          </button>
        ))}
      </div>

      {editor && (
        <CommentEditor
          comment={editor.comment}
          x={editor.screenX}
          y={editor.screenY}
          docPath={docPath}
          pageIndex={pageIndex}
          normX={editor.normX}
          normY={editor.normY}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
