// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each new layout of the landing page's orbit is drawn from scratch, so on its own a real node that stays would jump to
// its new angle. Turning the whole new layout onto the one shown before keeps one real node where it was drawn, so the
// picture seems to go on rather than start again.

import type { OrbitDot, OrbitLayout } from './getOrbitLayout.js';

/**
 * What the anchor knows of each kind of dot: whether it is a real node, which can hold its drawn angle, and whether its
 * link starts at another dot, so turns with it, rather than at the centre or nowhere.
 */
const KIND_FACTS = {
  peer: { anchors: true, linkTurns: false },
  trustedProvider: { anchors: true, linkTurns: false },
  simulated: { anchors: false, linkTurns: true },
  loose: { anchors: false, linkTurns: false },
} satisfies Record<OrbitDot['kind'], { anchors: boolean; linkTurns: boolean }>;

/**
 * Returns `next` turned so the last real node to join of those `previous` drew and `next` still holds, matched by key,
 * keeps the angle `previous` drew it at. Every dot turns by that amount, and so does each link that starts at a dot.
 * Returns `next` itself when there is no `previous` or the two share no real node. Pass the layout this returned last as
 * `previous`, so the turns add up across layouts.
 */
export function anchorOrbitLayout(previous: OrbitLayout | undefined, next: OrbitLayout): OrbitLayout {
  if (previous === undefined) {
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
  return layout.rings.flatMap(({ dots }) => dots).filter(({ kind }) => KIND_FACTS[kind].anchors);
}

/** Returns `layout` with every dot, and each link that starts at a dot, turned by `delta` degrees. */
function turnLayout(layout: OrbitLayout, delta: number): OrbitLayout {
  return {
    rings: layout.rings.map(ring => ({
      ...ring,
      dots: ring.dots.map(dot => ({
        ...dot,
        start: dot.start + delta,
        from: dot.from !== null && KIND_FACTS[dot.kind].linkTurns ? dot.from + delta : dot.from,
      })),
    })),
  };
}
