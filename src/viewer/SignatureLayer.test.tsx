import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SignatureLayer } from "./SignatureLayer";

const sig = { id: "s1", dataUrl: "data:image/png;base64,AA==", pageNum: 1, x: 0.5, y: 0.5, width: 0.2, height: 0.1 };

describe("SignatureLayer", () => {
  it("lets clicks through to form fields outside signature mode, except on the signature", () => {
    const { container } = render(
      <SignatureLayer pdfPath="/a.pdf" pageNum={1} isEnabled={false} pendingSignature={null}
        onSignaturePlaced={vi.fn()} onSignatureUpdated={vi.fn()} onSignatureRemoved={vi.fn()} signatures={[sig]} />,
    );
    const layer = container.firstElementChild as HTMLElement;
    expect(layer.style.pointerEvents).toBe("none");
    const placed = layer.querySelector("img")?.parentElement as HTMLElement;
    expect(placed.style.pointerEvents).toBe("auto");
  });
});
