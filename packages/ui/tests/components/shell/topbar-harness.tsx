// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';
import type { JSX } from '@solidjs/web';
import { ActionGroup } from '../../../src/components/shell/topbar/ActionGroup.js';
import type { TopbarMorph } from '../../../src/topbar-status.js';
import { mouseClick, pointerPress, renderComponent, settle } from '../../helpers/solid.js';
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
 * Stands in the layout the bar measures, which happy-dom lacks: the group has `room` pixels, and each item
 * and More is `widths[name]` or ITEM_WIDTH wide, with no gap.
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
      this instanceof HTMLElement && this.dataset['testid'] === 'topbar-item' ? this.dataset['item'] : undefined;
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
 * Render `items` in an ActionGroup with `room` pixels, as the topbar island does, or `options.room`, as the pill
 * does. Returns the layout, to change the room later.
 */
export async function renderTopbar(
  items: () => JSX.Element,
  room: number,
  options: {
    room?: (group: HTMLElement) => number | undefined;
    morph?: TopbarMorph;
    end?: () => JSX.Element;
  } = {},
): Promise<TopbarLayout> {
  const layout = stubTopbarLayout(room);
  const container = document.createElement('div');
  document.body.append(container);
  renderComponent(
    () => (
      <ActionGroup room={options.room} morph={options.morph} end={options.end?.()}>
        {items()}
      </ActionGroup>
    ),
    { container },
  );
  await settle();
  return layout;
}

export function moreRow(name: string): HTMLElement {
  return query(document, `#more-popover [role="menuitem"][data-item="${name}"]`);
}

/** Opens the More menu unless open, since its rows are in the page only while it is. */
export async function openMore(): Promise<void> {
  if (document.getElementById('more-popover')?.hasAttribute('data-open') !== true) {
    mouseClick(byId('more-button'));
    await settle();
  }
}

export async function moreRowNames(): Promise<string[]> {
  await openMore();
  return [...document.querySelectorAll<HTMLElement>('#more-popover [role="menuitem"]')].map(
    el => el.dataset['item'] ?? '',
  );
}

export async function tapMoreRow(name: string): Promise<void> {
  pointerPress(byId('more-button'));
  await settle();
  pointerPress(moreRow(name));
  await settle();
}
