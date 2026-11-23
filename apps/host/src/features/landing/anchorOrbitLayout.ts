// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each new layout of the landing page's orbit is drawn from scratch, so on its own a real node that stays would jump to
// its new angle. Turning the whole new layout onto the one shown before keeps one real node where it was drawn, so the
// picture seems to go on rather than start again.

import { isRealDot, linksToDot, type OrbitDot, type OrbitLayout } from './getOrbitLayout.js';

/**
 * Returns `next` turned so the last real node to join of those `previous` drew and `next` still holds, matched by key,
 * keeps the angle `previous` drew it at. Every dot turns by that amount, and so does each link that starts at a dot.
 * Returns `next` itself when there is no `previous` or the two share no real node. Pass the layout this returned last as
 * `previous`, so the turns add up across layouts.
 */
export function anchorOrbitLayout(previous: OrbitLayout | null, next: OrbitLayout): OrbitLayout {
  if (previous === null) {
    return next;
  }
  const placed = new Map(listRealDots(next).map(({ key, start }) => [key, start]));
  for (const { key, start } of listRealDots(previous).reverse()) {
    const place = placed.get(key);
    if (place !== undefined) {
      return turnLayout(next, start - place);
    }
  }
  return next;
}

/** Returns the real nodes of `layout` in join order, which its rings read from the centre outward give. */
function listRealDots(layout: OrbitLayout): OrbitDot[] {
  return layout.rings.flatMap(({ dots }) => dots).filter(isRealDot);
}

/** Returns `layout` with every dot, and each link that starts at a dot, turned by `delta` degrees. */
function turnLayout(layout: OrbitLayout, delta: number): OrbitLayout {
  return {
    rings: layout.rings.map(ring => ({
      ...ring,
      dots: ring.dots.map(dot => ({
        ...dot,
        start: dot.start + delta,
        from: dot.from !== null && linksToDot(dot) ? dot.from + delta : dot.from,
      })),
    })),
  };
}
