// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "@dotli/ui/components/shell/OfflineBanner";
import { setTopbarVisible } from "@dotli/ui/state/topbar";
import { renderComponent, resetStores, settle } from "../../helpers/solid";
import { byId } from "../../support";

// The inline style apps/host/src/offline.ts gave the banner it appended to
// `#topbar`, before the banner became a component (less `display`).
const OFFLINE_TS_STYLE = [
  "position: absolute",
  "top: 100%",
  "left: 0",
  "right: 0",
  "z-index: 999",
  "background: #b45309",
  "color: #fff",
  "font-size: 0.75rem",
  "font-weight: 500",
  "text-align: center",
  "padding: 4px 12px",
  "letter-spacing: 0.02em",
].join("; ");

/** `cssText` parsed into property/value pairs, the way the DOM reads them. */
function declarations(cssText: string): [string, string][] {
  const el = document.createElement("div");
  el.style.cssText = cssText;
  return Array.from({ length: el.style.length }, (_, i) => {
    const prop = el.style.item(i);
    return [prop, el.style.getPropertyValue(prop)];
  });
}

let online = true;

function goOffline(): void {
  online = false;
  window.dispatchEvent(new Event("offline"));
}

function goOnline(): void {
  online = true;
  window.dispatchEvent(new Event("online"));
}

function banner(): HTMLElement {
  return byId("offline-banner");
}

beforeEach(() => {
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
  resetStores();
  vi.restoreAllMocks();
});

describe("Offline banner", () => {
  it("As a user online, the banner is there with today's role, live region, text and style, but hidden", async () => {
    // When
    renderComponent(() => <OfflineBanner />);
    await settle();

    // Then
    const el = banner();
    expect(el.tagName).toBe("DIV");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.textContent).toBe("You are offline");
    const expected = declarations(OFFLINE_TS_STYLE);
    expect(expected.length).toBeGreaterThanOrEqual(12);
    for (const [prop, value] of expected) {
      expect(el.style.getPropertyValue(prop), prop).toBe(value);
    }
    expect(el.style.display).toBe("none");
    expect(el.hasAttribute("tabindex")).toBe(false);
  });

  it("As a user who is already offline when the banner mounts, I see it straight away", async () => {
    // Given
    online = false;

    // When
    renderComponent(() => <OfflineBanner />);
    await settle();

    // Then
    expect(banner().style.display).toBe("block");
  });

  it("As a user who loses the connection, I see the banner, and it goes away when I'm back", async () => {
    // Given
    renderComponent(() => <OfflineBanner />);
    await settle();

    // When
    goOffline();
    await settle();

    // Then
    expect(banner().style.display).toBe("block");

    // When
    goOnline();
    await settle();

    // Then
    expect(banner().style.display).toBe("none");
  });

  it("As a user offline, the banner hides with the topbar and shows again when the topbar comes back", async () => {
    // Given
    renderComponent(() => <OfflineBanner />);
    goOffline();
    await settle();

    // When
    setTopbarVisible(false);
    await settle();

    // Then
    expect(banner().style.display).toBe("none");

    // When
    setTopbarVisible(true);
    await settle();

    // Then
    expect(banner().style.display).toBe("block");
  });

  it("As a user whose topbar is hidden when the connection drops, the banner stays hidden until the topbar returns", async () => {
    // Given
    setTopbarVisible(false);
    renderComponent(() => <OfflineBanner />);
    await settle();

    // When
    goOffline();
    await settle();

    // Then
    expect(banner().style.display).toBe("none");

    // When
    setTopbarVisible(true);
    await settle();

    // Then
    expect(banner().style.display).toBe("block");
  });

  it("As the host, an unmounted banner stops listening for connection changes", async () => {
    // Given
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderComponent(() => <OfflineBanner />);
    await settle();
    const added = add.mock.calls.filter(
      ([type]) => type === "online" || type === "offline",
    );
    expect(added.map(([type]) => type).sort()).toEqual(["offline", "online"]);

    // When
    unmount();

    // Then
    for (const [type, listener] of added) {
      expect(remove).toHaveBeenCalledWith(type, listener);
    }
  });
});
