import { useState } from "react";

/**
 * State for the inline "go to page" input that replaces the page counter in
 * the header when clicked.
 */
export function useGoToPage() {
  const [editingPage, setEditingPage] = useState<boolean>(false);
  const [pageInputValue, setPageInputValue] = useState<string>("");

  return {
    editingPage,
    setEditingPage,
    pageInputValue,
    setPageInputValue,
  };
}
