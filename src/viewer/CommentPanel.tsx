import { useState, useMemo } from "react";
import { Comment, useCommentsStore } from "../store/useCommentsStore";

import { UI, MONO } from "../lib/tokens";

interface CommentPanelProps {
  docPath: string;
  onPageSelect: (page: number) => void;
  isCommentMode?: boolean;
  onToggleMode?: () => void;
}

function CommentRow({
  comment,
  docPath,
  onPageSelect,
}: {
  comment: Comment;
  docPath: string;
  onPageSelect: (page: number) => void;
}) {
  const updateComment = useCommentsStore((s) => s.updateComment);
  const removeComment = useCommentsStore((s) => s.removeComment);
  const [hover, setHover] = useState(false);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 12px",
        background: hover ? "var(--viewer-elevated)" : "transparent",
        transition: "background 80ms",
        opacity: comment.resolved ? 0.5 : 1,
        cursor: "pointer",
      }}
      onClick={() => onPageSelect(comment.pageIndex)}
    >
      {/* Color indicator */}
      <div
        style={{
          width: 8, height: 8, borderRadius: "50%",
          background: comment.color, flexShrink: 0, marginTop: 4,
        }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Page badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
          <span style={{
            fontFamily: MONO, fontSize: 10, color: "var(--accent)",
            background: "var(--accent-soft)", borderRadius: 3,
            padding: "0 4px", lineHeight: "16px",
          }}>
            p.{comment.pageIndex}
          </span>
          {comment.resolved && (
            <span style={{ fontFamily: UI, fontSize: 10, color: "var(--viewer-text-muted)" }}>
              resolved
            </span>
          )}
        </div>

        {/* Comment text */}
        <p style={{
          fontFamily: UI, fontSize: 12, color: "var(--viewer-text)",
          margin: 0, lineHeight: 1.45,
          overflow: "hidden", display: "-webkit-box",
          WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
          wordBreak: "break-word",
        }}>
          {comment.text || <span style={{ color: "var(--viewer-text-muted)" }}>(empty)</span>}
        </p>
      </div>

      {/* Action buttons — visible on hover */}
      <div
        style={{
          display: "flex", gap: 2, flexShrink: 0, opacity: hover ? 1 : 0,
          transition: "opacity 80ms",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Resolve toggle */}
        <button
          title={comment.resolved ? "Unresolve" : "Resolve"}
          onClick={() => updateComment(docPath, comment.id, { resolved: !comment.resolved })}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: comment.resolved ? "var(--accent)" : "var(--viewer-text-muted)",
            padding: 3, borderRadius: 3,
          }}
        >
          <svg width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </button>

        {/* Delete */}
        <button
          title="Delete comment"
          onClick={() => removeComment(docPath, comment.id)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--viewer-text-muted)", padding: 3, borderRadius: 3,
          }}
        >
          <svg width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function CommentPanel({ docPath, onPageSelect, isCommentMode, onToggleMode }: CommentPanelProps) {
  const docComments = useCommentsStore((s) => s.comments[docPath]);
  const allComments = docComments ?? [];
  const [showResolved, setShowResolved] = useState(false);

  // Sort + filter only when comments or the toggle change, not on every render
  // (parent re-renders, unrelated state). docComments is a stable store ref.
  const visible = useMemo(() => {
    const sorted = [...allComments].sort((a, b) =>
      a.pageIndex !== b.pageIndex ? a.pageIndex - b.pageIndex : a.y - b.y
    );
    return showResolved ? sorted : sorted.filter((c) => !c.resolved);
  }, [allComments, showResolved]);
  const resolvedCount = allComments.filter((c) => c.resolved).length;

  if (allComments.length === 0) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", height: "100%", gap: 10, paddingTop: 40,
      }}>
        <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.5}
          strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
          style={{ color: "var(--viewer-text-muted)", opacity: 0.45 }}>
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <p style={{
          fontFamily: UI, fontSize: 12, color: "var(--viewer-text-muted)",
          textAlign: "center", margin: 0,
        }}>
          No comments yet.<br />Activate <strong>Comment</strong> mode and click on a page.
        </p>
        {onToggleMode && (
          <button
            onClick={onToggleMode}
            style={{
              marginTop: 8,
              padding: "6px 12px",
              background: isCommentMode ? "var(--accent-soft)" : "var(--accent)",
              color: isCommentMode ? "var(--accent)" : "#fff",
              border: "none",
              borderRadius: 6,
              fontFamily: UI,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {isCommentMode ? "Exit Comment Mode" : "Add Comment"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 12px", borderBottom: "1px solid var(--viewer-border-sub)",
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: UI, fontSize: 11, color: "var(--viewer-text-muted)" }}>
          {allComments.length} comment{allComments.length !== 1 ? "s" : ""}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {resolvedCount > 0 && (
            <button
              onClick={() => setShowResolved((s) => !s)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontFamily: UI, fontSize: 11,
                color: showResolved ? "var(--accent)" : "var(--viewer-text-muted)",
              }}
            >
              {showResolved ? "Hide" : "Show"} resolved
            </button>
          )}
          {onToggleMode && (
            <button
              onClick={onToggleMode}
              style={{
                background: isCommentMode ? "var(--accent-soft)" : "transparent",
                border: "1px solid",
                borderColor: isCommentMode ? "transparent" : "var(--viewer-border)",
                color: isCommentMode ? "var(--accent)" : "var(--viewer-text)",
                padding: "3px 8px",
                borderRadius: 4,
                fontFamily: UI,
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {isCommentMode ? "Done" : "Add"}
            </button>
          )}
        </div>
      </div>

      {/* Comment list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {visible.length === 0 ? (
          <p style={{
            fontFamily: UI, fontSize: 12, color: "var(--viewer-text-muted)",
            textAlign: "center", padding: "20px 12px", margin: 0,
          }}>
            All comments are resolved.
          </p>
        ) : (
          visible.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              docPath={docPath}
              onPageSelect={onPageSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
