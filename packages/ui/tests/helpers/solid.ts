// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

export function renderComponent(
  view: () => JSX.Element,
  options: { container?: HTMLElement } = {},
): ReturnType<typeof render> {
  return render(view, options);
}

/** Solid 2 batches writes, so assertions after an event or a store write come after this. */
export async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
}

export { resetAllStoresForTests as resetStores } from '../../src/state/create-store.js';

/** Pointerdown first, as a floating layer reads a press outside from it. */
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

/** A press on an element that cannot take focus, which drops focus to the body before the click. */
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

/** A mouse or tap click, which unlike a key's or `.click()`'s has a `detail` of at least 1. */
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

/** Tabs to `next`, moving focus as a browser would unless a handler prevented it, since happy-dom moves none. */
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

export function popoverBody(id: string): HTMLElement | null {
  const root = document.getElementById(id);
  if (root === null) {
    return null;
  }
  return root.querySelector<HTMLElement>('[data-sheet]') ?? root;
}

/** Waits for the popover's lazy content chunk, a dynamic import that resolves over several microtasks. */
export async function waitForContent(id: string): Promise<HTMLElement> {
  flush();
  await vi.dynamicImportSettled();
  const body = await vi.waitFor(() => {
    flush();
    const found = popoverBody(id);
    const loaded =
      found !== null &&
      found.firstElementChild !== null &&
      found.querySelector('[data-testid="popover-loading"]') === null;
    if (!loaded) {
      throw new Error(`#${id} has no content yet`);
    }
    return found;
  });
  flush();
  return body;
}
