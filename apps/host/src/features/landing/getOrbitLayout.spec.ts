// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOrbitLayout, type OrbitDot, type OrbitLayout, type OrbitMode } from './getOrbitLayout.js';

describe('getOrbitLayout', () => {
  it('As a visitor whose light client has no peers yet, I see no dots', () => {
    // When
    const layout = getOrbitLayout(lightClient(0));

    // Then
    expect(listDots(layout)).toEqual([]);
  });

  it('As a visitor, I see peers fill 3, 6, 9, 12 and 15 slots on the rings from the centre outward', () => {
    // When
    const layouts = [5, 50].map(peers => getOrbitLayout(lightClient(peers)));

    // Then
    expect(layouts.map(layout => countRealByRing(layout))).toEqual([
      [3, 2, 0, 0, 0],
      [3, 6, 9, 12, 15],
    ]);
  });

  it('As a visitor, I see a joining peer add its own dot and cascade and change no other dot or link', () => {
    // Given
    const before = getOrbitLayout(lightClient(5));

    // When
    const after = getOrbitLayout(lightClient(6));

    // Then
    expect(after.rings.map(({ dots }) => dots.filter(dot => !isIn(dot, before)))).toEqual(
      after.rings.map(({ dots }, index) => dots.filter(dot => findRoot(after, index, dot)?.label === '[peer#6]')),
    );
    expect(listDots(before).every(dot => isIn(dot, after))).toBe(true);
  });

  it('As a visitor, I see each peer labelled by its join order, and no simulated dot labelled', () => {
    // When
    const layout = getOrbitLayout(lightClient(4));

    // Then
    expect(listDots(layout).flatMap(({ label }) => (label === null ? [] : [label]))).toEqual([
      '[peer#1]',
      '[peer#2]',
      '[peer#3]',
      '[peer#4]',
    ]);
    expect(listDots(layout).filter(({ kind }) => kind === 'simulated')).not.toEqual([]);
  });

  it('As a visitor, I see each simulated dot grow from a dot on the ring inside its own, back to a peer', () => {
    // When
    const layout = getOrbitLayout(lightClient(10));

    // Then
    expect(listRoots(layout).every(root => root?.kind === 'peer')).toBe(true);
  });

  it('As a visitor, I see no simulated dot within 6 deg of a slot a peer can take', () => {
    // When
    const full = getOrbitLayout(lightClient(45));
    const layout = getOrbitLayout(lightClient(30));

    // Then
    const crowded = layout.rings.flatMap(({ ring, dots }) => {
      const slots = (full.rings.find(other => other.ring === ring)?.dots ?? []).filter(({ kind }) => kind === 'peer');
      return dots.filter(dot => dot.kind === 'simulated' && slots.some(slot => getAngleGap(slot.start, dot.start) < 6));
    });
    expect(crowded).toEqual([]);
  });

  it('As a visitor on a server backend, I see one server, labelled as the server, and every simulated dot cascading from it', () => {
    // When
    const layout = getOrbitLayout({ kind: 'server' });

    // Then
    expect(listDots(layout).filter(({ kind }) => kind !== 'simulated')).toEqual([
      expect.objectContaining({ kind: 'server', label: '[server]' }),
    ]);
    expect(listRoots(layout).every(root => root?.kind === 'server')).toBe(true);
  });
});

function lightClient(peers: number): OrbitMode {
  return { kind: 'lightClient', peers };
}

function listDots(layout: OrbitLayout): OrbitDot[] {
  return layout.rings.flatMap(({ dots }) => dots);
}

function countRealByRing(layout: OrbitLayout): number[] {
  return layout.rings.map(({ dots }) => dots.filter(({ kind }) => kind !== 'simulated').length);
}

function isIn(dot: OrbitDot, layout: OrbitLayout): boolean {
  return listDots(layout).some(other => JSON.stringify(other) === JSON.stringify(dot));
}

/** The real dot each simulated dot cascades from, or null where the chain breaks. */
function listRoots(layout: OrbitLayout): (OrbitDot | null)[] {
  return layout.rings.flatMap(({ dots }, index) =>
    dots.filter(({ kind }) => kind === 'simulated').map(dot => findRoot(layout, index, dot)),
  );
}

/** Returns the real dot `dot` on ring `index` cascades from, following each link inward, or null when it breaks. */
function findRoot(layout: OrbitLayout, index: number, dot: OrbitDot): OrbitDot | null {
  if (dot.kind !== 'simulated') {
    return dot;
  }
  const parent = layout.rings[index - 1]?.dots.find(({ start }) => start === dot.from);
  return parent ? findRoot(layout, index - 1, parent) : null;
}

function getAngleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
