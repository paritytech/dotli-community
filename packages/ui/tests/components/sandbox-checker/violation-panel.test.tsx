// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { mountViolationPanel } from "@dotli/ui/components/sandbox-checker/mount";
import {
  attachProductFrame,
  resetProductFrameLayout,
  setChatWidth,
} from "@dotli/ui/product-frame-layout";
import { settle } from "../../helpers/solid";

const BELOW_BAR_HEIGHT =
  "calc(100dvh - var(--topbar-height, 56px) - var(--safe-bottom, 0px))";

let iframe: HTMLIFrameElement;
/**
 * The geometry the frame layout writes. happy-dom's CSS parser discards a
 * `calc()` holding a `var()`, so the layout writes to a stand-in frame that
 * records each declaration as written.
 */
let frame: Record<string, string>;
let dispose: () => void = () => undefined;

function violation(
  data: unknown,
  source: MessageEventSource | null = iframe.contentWindow,
): void {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

function panel(): HTMLElement {
  return document.getElementById("sandbox-checker-panel")!;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="topbar"></div>';
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  frame = {};
  attachProductFrame({ style: frame } as unknown as HTMLIFrameElement);
  dispose = mountViolationPanel(iframe);
});

afterEach(() => {
  dispose();
  resetProductFrameLayout();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("sandbox checker violation panel", () => {
  it("As a dotli developer, the panel stays hidden until the first violation, then counts them", async () => {
    // Given
    await settle();

    // Then
    expect(panel().classList.contains("visible")).toBe(false);
    expect(panel().querySelector(".sc-badge")?.textContent).toBe("0");
    expect(panel().querySelector(".sc-label")?.textContent).toBe(
      "API Violations",
    );

    // When
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "localStorage.getItem",
      details: { key: "x", n: 1 },
      timestamp: 0,
    });
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "fetch",
      details: {},
      timestamp: 0,
    });
    await settle();

    // Then
    expect(panel().classList.contains("visible")).toBe(true);
    expect(panel().querySelector(".sc-badge")?.textContent).toBe("2");
    const entries = [...panel().querySelectorAll(".sc-entry")];
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector(".sc-api")?.textContent).toBe(
      "localStorage.getItem",
    );
    expect(entries[0].querySelector(".sc-details")?.textContent).toBe(
      "key=x n=1",
    );
    expect(entries[0].querySelector(".sc-time")?.textContent).toBe(
      new Date(0).toLocaleTimeString(),
    );
    expect(entries[1].querySelector(".sc-details")).toBeNull();
  });

  it("As a dotli developer, markup in a violation shows as text", async () => {
    // When
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "<img src=x onerror=alert(1)>",
      details: { a: "<b>bold</b>" },
      timestamp: 0,
    });
    await settle();

    // Then
    const entry = panel().querySelector(".sc-entry")!;
    expect(entry.querySelector("img")).toBeNull();
    expect(entry.querySelector("b")).toBeNull();
    expect(entry.querySelector(".sc-api")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(entry.querySelector(".sc-details")?.textContent).toBe(
      "a=<b>bold</b>",
    );
  });

  it("As a dotli developer, messages from other windows or of other types are ignored", async () => {
    // When
    violation(
      { type: "DOTLI_API_VIOLATION", api: "x", details: {}, timestamp: 0 },
      window,
    );
    violation({ type: "SOMETHING_ELSE", api: "x", details: {}, timestamp: 0 });
    violation("not an object");
    await settle();

    // Then
    expect(panel().querySelectorAll(".sc-entry")).toHaveLength(0);
    expect(panel().classList.contains("visible")).toBe(false);
  });

  it("As a dotli developer, showing, collapsing and expanding the panel resizes the app frame", async () => {
    // Given
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.id === "sandbox-checker-panel" ? 180 : 0;
      },
    );
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "x",
      details: {},
      timestamp: 0,
    });
    await settle();
    const toggle = panel().querySelector<HTMLButtonElement>(".sc-toggle")!;

    // Then
    expect(toggle.getAttribute("aria-label")).toBe("Toggle panel");
    expect(toggle.textContent).toBe("▼");
    expect(frame.height).toBe(`calc(${BELOW_BAR_HEIGHT} - 180px)`);

    // When
    fireEvent.click(toggle);
    await settle();

    // Then
    expect(panel().classList.contains("collapsed")).toBe(true);
    expect(toggle.textContent).toBe("▲");
    expect(frame.height).toBe(`calc(${BELOW_BAR_HEIGHT} - 32px)`);

    // When: opening chat keeps the reservation
    setChatWidth(360);

    // Then
    expect(frame.height).toBe(`calc(${BELOW_BAR_HEIGHT} - 32px)`);

    // When: resizing while collapsed does nothing
    const handle = panel().querySelector<HTMLElement>(".sc-resize-handle")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 100 });
    await settle();

    // Then
    expect(panel().style.height).toBe("");

    // When
    fireEvent.click(toggle);
    await settle();

    // Then
    expect(panel().classList.contains("collapsed")).toBe(false);
    expect(toggle.textContent).toBe("▼");
  });

  it("As a dotli developer, disposing removes the panel, stops listening and restores the frame height", async () => {
    // Given
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.id === "sandbox-checker-panel" ? 180 : 0;
      },
    );
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "x",
      details: {},
      timestamp: 0,
    });
    await settle();
    expect(frame.height).toBe(`calc(${BELOW_BAR_HEIGHT} - 180px)`);

    // When
    dispose();
    dispose = () => undefined;
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "y",
      details: {},
      timestamp: 0,
    });
    await settle();

    // Then
    expect(document.getElementById("sandbox-checker-panel")).toBeNull();
    expect(frame.height).toBe(BELOW_BAR_HEIGHT);
  });

  it("As a dotli developer, disposing while dragging cleans up the drag state", async () => {
    // Given
    violation({
      type: "DOTLI_API_VIOLATION",
      api: "x",
      details: {},
      timestamp: 0,
    });
    await settle();
    const handle = panel().querySelector<HTMLElement>(".sc-resize-handle")!;

    // When
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    await settle();

    // Then
    expect(document.body.style.userSelect).toBe("none");

    // When
    dispose();
    dispose = () => undefined;
    await settle();

    // Then
    expect(document.body.style.userSelect).toBe("");
  });

  it("As a dotli developer, a looping product keeps only the newest 500 violations while the badge counts them all", async () => {
    // When
    for (let i = 0; i < 600; i++) {
      violation({
        type: "DOTLI_API_VIOLATION",
        api: `api${String(i)}`,
        details: {},
        timestamp: 0,
      });
    }
    await settle();

    // Then
    const entries = [...panel().querySelectorAll(".sc-entry")];
    expect(entries).toHaveLength(500);
    expect(entries[0].querySelector(".sc-api")?.textContent).toBe("api100");
    expect(entries[499].querySelector(".sc-api")?.textContent).toBe("api599");
    expect(panel().querySelector(".sc-badge")?.textContent).toBe("600");
  });

  it("As a dotli developer, each new violation forces at most one layout and leaves an unchanged app frame alone", async () => {
    // Given
    const log: string[] = [];
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.id !== "sandbox-checker-panel") {
          return 0;
        }
        log.push("read");
        return 180;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (!this.classList.contains("sc-log")) {
          return 0;
        }
        log.push("read");
        return 500;
      },
    );
    let heightWrites = 0;
    const style = new Proxy({} as Record<string, string>, {
      set(target, prop, value: string) {
        if (prop === "height") {
          heightWrites++;
          log.push("write");
        }
        target[prop as string] = value;
        return true;
      },
    });
    attachProductFrame({ style } as unknown as HTMLIFrameElement);
    const send = async (i: number): Promise<void> => {
      violation({
        type: "DOTLI_API_VIOLATION",
        api: `api${String(i)}`,
        details: {},
        timestamp: 0,
      });
      // The new row is a DOM write.
      log.push("write");
      await settle();
    };
    await send(0);
    const logEl = panel().querySelector<HTMLElement>(".sc-log")!;
    let top = 0;
    Object.defineProperty(logEl, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
        log.push("write");
      },
    });
    heightWrites = 0;

    // When
    const layouts: number[] = [];
    for (let i = 1; i <= 10; i++) {
      log.length = 0;
      await send(i);
      // A read after a write forces a layout.
      let dirty = false;
      let forced = 0;
      for (const op of log) {
        if (op === "write") {
          dirty = true;
        } else if (dirty) {
          forced++;
          dirty = false;
        }
      }
      layouts.push(forced);
    }

    // Then
    expect(Math.max(...layouts)).toBe(1);
    expect(heightWrites).toBe(0);
    expect(top).toBe(500);
    expect(style.height).toBe(`calc(${BELOW_BAR_HEIGHT} - 180px)`);
  });
});
