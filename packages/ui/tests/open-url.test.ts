import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigateTo } from "@dotli/ui/host-callbacks/OpenUrl";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenUrl host callback", () => {
  it("As a dotli integrator, the host isolates every newly opened navigation from its opener", async () => {
    // Given
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const navigateTo = createNavigateTo();

    // When
    await navigateTo("example.dot/path");
    await navigateTo("localhost:3000/path");
    await navigateTo("https://example.com/path");

    // Then
    expect(open).toHaveBeenCalledTimes(3);
    for (const call of open.mock.calls) {
      expect(call).toEqual([expect.any(String), "_blank", "noopener"]);
    }
  });
});
