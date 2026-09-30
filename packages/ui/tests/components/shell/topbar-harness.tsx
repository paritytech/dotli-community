// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';
import type { JSX } from '@solidjs/web';
import { ActionGroup } from '../../../src/components/shell/topbar/ActionGroup.js';
import { pointerPress, renderComponent, settle } from '../../helpers/solid.js';
import { byId, query } from '../../support.js';

/** The width every item and the More button take, unless given. */
export const ITEM_WIDTH = 32;

export interface TopbarLayout {
  /** Give the action group `px` of room, and let the bar measure again. */
  setRoom: (px: number) => void;
  /** Make the item named `name` `px` wide, and let the bar measure again. */
  setWidth: (name: string, px: number) => void;
}

/**
 * happy-dom lays nothing out: stand in the layout the bar measures. The
 * action group (`#topbar-actions`) has `room` pixels, each item
 * (`.topbar-item[data-item]`) is `widths[name]` or ITEM_WIDTH wide, as is
 * the More button, and there is no gap. ResizeObservers are stubbed so a
 * change can be announced. Restored by `vi.restoreAllMocks()` and
 * `vi.unstubAllGlobals()`.
 */
export function stubTopbarLayout(room: number, widths: Record<string, number> = {}): TopbarLayout {
  let available = room;
  const sizes = { ...widths };
  const callbacks = new Set<() => void>();
  class FakeResizeObserver {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(): void {
      callbacks.add(this.callback);
      // A real observer reports each target's size once it starts watching.
      const callback = this.callback;
      queueMicrotask(() => {
        if (callbacks.has(callback)) {
          callback();
        }
      });
    }
    unobserve(): void {
      /* the bar never unobserves one element alone */
    }
    disconnect(): void {
      callbacks.delete(this.callback);
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.id === 'topbar-actions' ? available : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const name =
      this instanceof HTMLElement && this.classList.contains('topbar-item') ? this.dataset['item'] : undefined;
    const width = name !== undefined ? (sizes[name] ?? ITEM_WIDTH) : this.id === 'more-button' ? ITEM_WIDTH : 0;
    return new DOMRect(0, 0, width, width === 0 ? 0 : 32);
  });
  const announce = (): void => {
    for (const callback of [...callbacks]) {
      callback();
    }
  };
  return {
    setRoom: px => {
      available = px;
      announce();
    },
    setWidth: (name, px) => {
      sizes[name] = px;
      announce();
    },
  };
}

/**
 * Render `items` as the children of an ActionGroup in the document, as the
 * topbar island does, with `room` pixels for them (see stubTopbarLayout).
 * Returns the layout, to change the room later.
 */
export async function renderTopbar(items: () => JSX.Element, room: number): Promise<TopbarLayout> {
  const layout = stubTopbarLayout(room);
  const container = document.createElement('div');
  document.body.append(container);
  renderComponent(() => <ActionGroup>{items()}</ActionGroup>, { container });
  await settle();
  return layout;
}

/** The More menu's row for the item named `name`. */
export function moreRow(name: string): HTMLElement {
  return query(document, `#more-popover .more-row[data-item="${name}"]`);
}

/** Open the More menu and tap the row of the item named `name`. */
export async function tapMoreRow(name: string): Promise<void> {
  pointerPress(byId('more-button'));
  await settle();
  pointerPress(moreRow(name));
  await settle();
}
