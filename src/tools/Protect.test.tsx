import { describe, it, expect, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Protect from "./Protect";
import { renderWithProviders } from "../test/renderWithProviders";
import { useAppStore } from "../store/useAppStore";
import { mockCommand, lastCallArgs } from "../test/mockTauri";

afterEach(() => useAppStore.setState({ files: [], result: null, isProcessing: false }));

function seedFile() {
  useAppStore.setState({
    files: [{ path: "in.pdf", name: "in.pdf", info: { page_count: 1, file_size: 10, metadata: {} } }],
  });
}

describe("Protect tool", () => {
  it("encrypts with the entered user password", async () => {
    seedFile();
    mockCommand("protect_pdf", "out.pdf");
    renderWithProviders(<Protect />);

    await userEvent.type(screen.getByPlaceholderText(/^enter password$/i), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /^Protect PDF$/i }));

    await waitFor(() =>
      expect(lastCallArgs("protect_pdf")).toMatchObject({ path: "in.pdf", userPassword: "hunter2" }),
    );
  });

  it("disables the action with no user password", () => {
    seedFile();
    renderWithProviders(<Protect />);
    expect(screen.getByRole("button", { name: /^Protect PDF$/i })).toBeDisabled();
  });
});
