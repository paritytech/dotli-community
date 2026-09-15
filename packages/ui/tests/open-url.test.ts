import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { withActiveTld } from "@dotli/config/network";
import { createNavigateTo } from "@dotli/ui/host-callbacks/OpenUrl";

afterEach(() => {
  vi.restoreAllMocks();
});

function spyOnNavigation(): { assign: MockInstance; open: MockInstance } {
  return {
    assign: vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined),
    open: vi.spyOn(window, "open").mockImplementation(() => null),
  };
}

describe("OpenUrl host callback", () => {
  it("As a product user, a handoff to another dotNS product moves the current tab", async () => {
    // Given
    const { assign, open } = spyOnNavigation();
    const navigateTo = createNavigateTo();

    // When
    await navigateTo(`https://${withActiveTld("dim2")}`);

    // Then
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      `http://dim2.localhost:${window.location.port}`,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("As a product user, the path, query and hash of the target product survive the handoff", async () => {
    // Given
    const { assign } = spyOnNavigation();
    const navigateTo = createNavigateTo();

    // When
    await navigateTo(`polkadot://${withActiveTld("dim2")}/play?round=3#top`);

    // Then
    expect(assign).toHaveBeenCalledWith(
      `http://dim2.localhost:${window.location.port}/play?round=3#top`,
    );
  });

  it("As a product developer, a handoff to a localhost product moves the current tab into the host proxy path", async () => {
    // Given
    const { assign, open } = spyOnNavigation();
    const navigateTo = createNavigateTo();

    // When
    await navigateTo("localhost:5199/path?q=1");

    // Then
    expect(assign).toHaveBeenCalledWith(
      `http://localhost:${window.location.port}/localhost:5199/path?q=1`,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("As a dotli integrator, the host opens external websites apart from the current tab and isolates them from their opener", async () => {
    // Given
    const { assign, open } = spyOnNavigation();
    const navigateTo = createNavigateTo();

    // When
    await navigateTo("https://example.com/path");
    await navigateTo("example.dot/path");

    // Then
    expect(assign).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/path",
      "_blank",
      "noopener",
    );
    expect(open).toHaveBeenCalledWith("example.dot/path", "_blank", "noopener");
  });
});
