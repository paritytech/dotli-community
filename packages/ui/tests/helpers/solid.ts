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
