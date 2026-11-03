import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// What each file holds on disk, and what was written.
const files: Record<string, string> = {};
const saves: { path: string; json: string }[] = [];
vi.mock("../../lib/tauri", () => ({
  loadComments: async (path: string) => files[path] ?? "[]",
  saveComments: async (path: string, json: string) => {
    saves.push({ path, json });
    files[path] = json;
  },
}));

import { useComments } from "./useComments";
import { useCommentsStore, type Comment } from "../../store/useCommentsStore";

const c = (id: string, text = id): Comment => ({
  id, pageIndex: 1, x: 0.1, y: 0.1, text, color: "#f59e0b", resolved: false, createdAt: 1,
});

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  saves.length = 0;
  useCommentsStore.setState({ comments: {} });
});

describe("useComments across a working-file swap", () => {
  it("keeps saved and unsaved comments when an edit swaps the file", async () => {
    files["/orig.pdf"] = JSON.stringify([c("a")]);
    const { result, rerender } = renderHook(({ path }) => useComments(path), { initialProps: { path: "/orig.pdf" } });
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    // A comment added just before the edit, not yet on disk.
    act(() => useCommentsStore.getState().addComment("/orig.pdf", c("b")));
    // The edit wrote a working copy that carries the file's comments (a only).
    files["/tmp/qyra-1/orig_rotated.pdf"] = JSON.stringify([c("a")]);
    rerender({ path: "/tmp/qyra-1/orig_rotated.pdf" });

    await waitFor(() => expect(result.current.comments.map((x) => x.id).sort()).toEqual(["a", "b"]));
    // The unsaved comment reaches the new file; nothing ever writes an empty list.
    await waitFor(() => expect(JSON.parse(files["/tmp/qyra-1/orig_rotated.pdf"]!)).toHaveLength(2), { timeout: 2000 });
    expect(saves.every((s) => JSON.parse(s.json).length > 0)).toBe(true);
  });
});
