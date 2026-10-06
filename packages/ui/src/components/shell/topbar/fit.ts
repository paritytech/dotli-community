// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The priority of an item that never collapses (the account button). */
export const PINNED = Number.POSITIVE_INFINITY;

/**
 * How early each topbar item moves into the More menu when the bar runs out
 * of room: the lowest goes first.
 */
export const TOPBAR_PRIORITY = {
  settings: 1,
  theme: 2,
  permissions: 3,
  chat: 4,
  network: 5,
  auth: PINNED,
} as const;

/**
 * The nearest ancestor of `el` that lays out a box. An island hydrates inside
 * an `<astro-island>` drawn with `display: contents`, which has no size of its
 * own, so the pill row is the first ancestor past it.
 */
export function layoutParent(el: Element): HTMLElement | null {
  let parent = el.parentElement;
  while (parent !== null && getComputedStyle(parent).display === 'contents') {
    parent = parent.parentElement;
  }
  return parent;
}

export interface FitItem {
  /** The item's own width, in pixels. */
  width: number;
  /** See TOPBAR_PRIORITY. */
  priority: number;
}

/**
 * Which of `items` (the visible ones, in bar order) collapse into the More
 * menu so that the rest, with `gap` between neighbours and the More button
 * (`moreWidth`) once anything collapsed, fit in `available`. Items collapse
 * by ascending priority, the earlier of two equal ones first, until the rest
 * fit or only pinned items are left. Returns one flag per item.
 */
export function fitActions(items: readonly FitItem[], available: number, gap: number, moreWidth: number): boolean[] {
  const collapsed = items.map(() => false);
  const fits = (): boolean => {
    let count = 0;
    let width = 0;
    for (const [i, item] of items.entries()) {
      if (collapsed[i] !== true) {
        count += 1;
        width += item.width;
      }
    }
    if (collapsed.includes(true)) {
      count += 1;
      width += moreWidth;
    }
    return width + gap * Math.max(0, count - 1) <= available;
  };
  if (fits()) {
    return collapsed;
  }
  const order = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.priority !== PINNED)
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index);
  for (const { index } of order) {
    collapsed[index] = true;
    if (fits()) {
      break;
    }
  }
  return collapsed;
}
