// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * Render a Solid view into `options.container`, or a fresh one when none is
 * given. Cleaned up after each test.
 */
export function renderComponent(
  view: () => JSX.Element,
  options: { container?: HTMLElement } = {},
): ReturnType<typeof render> {
  return render(view, options);
}

/**
 * Apply batched Solid updates, then let queued microtasks run. Solid 2 batches
 * writes, so assertions after an event or a store write come after this.
 */
export async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
}

export { resetAllStoresForTests as resetStores } from '../../src/state/create-store.js';

/**
 * A mouse press on `el`: pointerdown, which is what dismisses a shell
 * popover pressed outside (components/shell/create-popover.ts), then the click.
 */
export function pointerPress(el: Element): void {
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
    }),
  );
  mouseClick(el);
}

/**
 * A mouse press on `el`, which cannot take focus: as in a browser, the
 * press's mousedown drops focus to the body before the click.
 */
export function pointerPressUnfocusable(el: Element): void {
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
    }),
  );
  (document.activeElement as HTMLElement | null)?.blur();
  mouseClick(el);
}

/**
 * The click of a mouse or a tap, which (unlike a key's, or `.click()`'s)
 * has a `detail` of at least 1.
 */
export function mouseClick(el: Element): MouseEvent {
  const click = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: 1,
  });
  el.dispatchEvent(click);
  return click;
}

/**
 * Tab from the focused element to `next`, the element after it in the page's
 * Tab order: the keydown, then, unless a handler prevented it, the focus move
 * the browser would make (happy-dom makes none). Returns the keydown.
 */
export function tabTo(next: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  if (!event.defaultPrevented) {
    next.focus();
  }
  return event;
}

/**
 * The body of popover `#id` once its lazy content has loaded. Await Vite's
 * import barrier before polling the DOM; module compilation is not a UI timeout.
 */
export async function waitForContent(id: string): Promise<HTMLElement> {
  flush();
  await vi.dynamicImportSettled();
  const body = await vi.waitFor(() => {
    flush();
    const found = document.querySelector<HTMLElement>(`#${id} > .popover-body`);
    const loaded =
      found !== null && found.firstElementChild !== null && found.querySelector('.popover-loading') === null;
    if (!loaded) {
      throw new Error(`#${id} has no content yet`);
    }
    return found;
  });
  flush();
  return body;
}
