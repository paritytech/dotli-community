// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type FitItem = {
  width: number;
  /** The lowest moves into More first. */
  priority: number;
};

type Params = {
  /** The visible items, in bar order. */
  items: readonly FitItem[];
  /** The width the bar has. */
  available: number;
  /** The space between two items. */
  gap: number;
  /** The width of the More button. */
  moreWidth: number;
};

/** The priority of an item that never collapses into More. */
export const PINNED = Number.POSITIVE_INFINITY;

/**
 * Which visible `items`, in bar order, collapse into More so the rest fit in `available`, More included once
 * anything collapsed. The lowest priority goes first, the earlier of equals first. Never throws.
 */
export function fitActions({ items, available, gap, moreWidth }: Params): boolean[] {
  const collapsed = items.map(() => false);

  function isFitting(): boolean {
    let count = 0;
    let width = 0;
    for (const [index, item] of items.entries()) {
      if (collapsed[index] !== true) {
        count += 1;
        width += item.width;
      }
    }
    if (collapsed.includes(true)) {
      count += 1;
      width += moreWidth;
    }
    return width + gap * Math.max(0, count - 1) <= available;
  }

  if (isFitting()) {
    return collapsed;
  }
  const order = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.priority !== PINNED)
    .sort((first, second) => first.item.priority - second.item.priority || first.index - second.index);
  for (const { index } of order) {
    collapsed[index] = true;
    if (isFitting()) {
      break;
    }
  }
  return collapsed;
}

/**
 * The nearest ancestor that lays out a box, past `display: contents` wrappers such as the one an island hydrates in,
 * or null for none. Never throws.
 */
export function findLayoutParent(element: Element): HTMLElement | null {
  let parent = element.parentElement;
  while (parent !== null && getComputedStyle(parent).display === 'contents') {
    parent = parent.parentElement;
  }
  return parent;
}
