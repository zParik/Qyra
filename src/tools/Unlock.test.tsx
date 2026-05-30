import { describe, it, expect, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Unlock from "./Unlock";
import { renderWithProviders } from "../test/renderWithProviders";
import { useAppStore } from "../store/useAppStore";
import { mockCommand, lastCallArgs } from "../test/mockTauri";

afterEach(() => useAppStore.setState({ files: [], result: null, isProcessing: false }));

function seedFile() {
  useAppStore.setState({
    files: [{ path: "locked.pdf", name: "locked.pdf", info: { page_count: 1, file_size: 10, metadata: {} } }],
  });
}

describe("Unlock tool", () => {
  it("sends the path and password to unlock_pdf", async () => {
    seedFile();
    mockCommand("unlock_pdf", "out.pdf");
    renderWithProviders(<Unlock />);

    await userEvent.type(screen.getByPlaceholderText(/enter the pdf password/i), "secret");
    await userEvent.click(screen.getByRole("button", { name: /^Unlock PDF$/i }));

    await waitFor(() =>
      expect(lastCallArgs("unlock_pdf")).toMatchObject({ path: "locked.pdf", password: "secret" }),
    );
  });

  it("disables the action with no password", () => {
    seedFile();
    renderWithProviders(<Unlock />);
    expect(screen.getByRole("button", { name: /^Unlock PDF$/i })).toBeDisabled();
  });
});
