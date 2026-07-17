import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigateTo } from "@dotli/ui/host-callbacks/OpenUrl";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenUrl host callback", () => {
  it("isolates every newly opened navigation from its opener", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const navigateTo = createNavigateTo();

    await navigateTo("example.dot/path");
    await navigateTo("localhost:3000/path");
    await navigateTo("https://example.com/path");

    expect(open).toHaveBeenCalledTimes(3);
    for (const call of open.mock.calls) {
      expect(call).toEqual([expect.any(String), "_blank", "noopener"]);
    }
  });
});
