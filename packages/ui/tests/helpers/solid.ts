// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

/** Render a Solid view into a fresh container. Cleaned up after each test. */
export function renderComponent(
  view: () => JSX.Element,
): ReturnType<typeof render> {
  return render(view);
}

/**
 * Apply batched Solid updates, then let queued microtasks run. Solid 2 batches
 * writes, so assertions after an event or a store write come after this.
 */
export async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
}

export { resetAllStoresForTests as resetStores } from "@dotli/ui/state/create-store";

/**
 * A mouse press on `el`: pointerdown, which is what dismisses a shell
 * popover pressed outside (components/shell/popover.ts), then the click.
 */
export function pointerPress(el: Element): void {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
    }),
  );
  (el as HTMLElement).click();
}

/**
 * A mouse press on `el`, which cannot take focus: as in a browser, the
 * press's mousedown drops focus to the body before the click.
 */
export function pointerPressUnfocusable(el: Element): void {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
    }),
  );
  (document.activeElement as HTMLElement | null)?.blur();
  (el as HTMLElement).click();
}

/**
 * Tab from the focused element to `next`, the element after it in the page's
 * Tab order: the keydown, then, unless a handler prevented it, the focus move
 * the browser would make (happy-dom makes none). Returns the keydown.
 */
export function tabTo(next: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  if (!event.defaultPrevented) {
    next.focus();
  }
  return event;
}
