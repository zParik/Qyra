import { describe, expect, it, vi } from "vitest";
import { prepareToClose, registerCloseFlusher } from "./closeGuard";

describe("prepareToClose", () => {
  it("waits for every tab's pending writes before allowing the close", async () => {
    let done = 0;
    const slow = () => new Promise<void>((r) => setTimeout(() => { done++; r(); }, 20));
    const offA = registerCloseFlusher({ hasPending: () => true, flush: slow });
    const offB = registerCloseFlusher({ hasPending: () => true, flush: slow });
    const offC = registerCloseFlusher({ hasPending: () => false, flush: slow });
    expect(await prepareToClose({ dirtyCount: 0, confirm: () => true })).toBe(true);
    expect(done).toBe(2);
    offA(); offB(); offC();
  });

  it("asks before closing with unsaved documents, and stays open on no", async () => {
    const confirm = vi.fn(() => false);
    expect(await prepareToClose({ dirtyCount: 2, confirm })).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("still closes when a flush fails", async () => {
    const off = registerCloseFlusher({ hasPending: () => true, flush: () => Promise.reject(new Error("disk full")) });
    expect(await prepareToClose({ dirtyCount: 0, confirm: () => true })).toBe(true);
    off();
  });
});
