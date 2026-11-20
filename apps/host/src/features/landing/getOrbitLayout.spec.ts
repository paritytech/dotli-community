// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOrbitLayout, type OrbitLayout, type OrbitRing } from './getOrbitLayout.js';

describe('getOrbitLayout', () => {
  it('As a visitor, I see every dot linked once, inward from the ring inside its own or from the centre', () => {
    // When
    const layout = getOrbitLayout();

    // Then
    expect(listLinkedEnds(layout)).toEqual(listDots(layout));
  });

  it('As a visitor, I see a dot just past 0 deg linked to the nearest dot just before it, around the circle', () => {
    // When
    const layout = getOrbitLayout();

    // Then
    expect(findLinkFrom(layout, 'ring2', 344)).toEqual({ ring: 'ring1', start: -34 });
  });
});

function listDots(layout: OrbitLayout): string[] {
  return layout.rings.flatMap(({ ring, dots }) => dots.map(({ start }) => `${ring}:${String(start)}`)).sort();
}

/** Each link's outer end, with the ring it links in from, which must be the ring inside its own. */
function listLinkedEnds(layout: OrbitLayout): string[] {
  const order: (OrbitRing | 'centre')[] = ['centre', ...layout.rings.map(({ ring }) => ring)];
  return layout.links
    .filter(({ from, to }) => order.indexOf(from.ring) === order.indexOf(to.ring) - 1)
    .map(({ to }) => `${to.ring}:${String(to.start)}`)
    .sort();
}

function findLinkFrom(layout: OrbitLayout, ring: OrbitRing, start: number) {
  return layout.links.find(({ to }) => to.ring === ring && to.start === start)?.from;
}
