import { describe, it, expect, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RemovePages from "./RemovePages";
import { renderWithProviders } from "../test/renderWithProviders";
import { useAppStore } from "../store/useAppStore";
import { mockCommand, lastCallArgs } from "../test/mockTauri";

afterEach(() => useAppStore.setState({ files: [], result: null, isProcessing: false }));

function seedFile() {
  useAppStore.setState({
    files: [{ path: "in.pdf", name: "in.pdf", info: { page_count: 5, file_size: 10, metadata: {} } }],
  });
}

describe("RemovePages tool", () => {
  it("removes the parsed page list", async () => {
    seedFile();
    mockCommand("remove_pages", "out.pdf");
    renderWithProviders(<RemovePages />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 2, 4-6, 9/i), "2,4-5");
    await userEvent.click(screen.getByRole("button", { name: /remove 3 pages/i }));

    await waitFor(() =>
      expect(lastCallArgs("remove_pages")).toMatchObject({ path: "in.pdf", pages: [2, 4, 5] }),
    );
    await waitFor(() => expect(useAppStore.getState().result).toBe("out.pdf"));
  });

  it("disables the action when no pages are entered", () => {
    seedFile();
    renderWithProviders(<RemovePages />);
    expect(screen.getByRole("button", { name: /^Remove Pages$/i })).toBeDisabled();
  });
});
