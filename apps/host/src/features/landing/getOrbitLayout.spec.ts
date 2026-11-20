// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOrbitLayout, type OrbitDot, type OrbitLayout, type OrbitMode } from './getOrbitLayout.js';

/** One page load's seed. */
const SEED = 1;

describe('getOrbitLayout', () => {
  it('As a visitor whose light client has no peers yet, I see no dots', () => {
    // When
    const layout = getOrbitLayout(lightClient(0), SEED);

    // Then
    expect(listDots(layout)).toEqual([]);
  });

  it('As a visitor, I see peers fill 3, 6, 9, 12 and 15 slots on the rings from the centre outward', () => {
    // When
    const layouts = [5, 50].map(peers => getOrbitLayout(lightClient(peers), SEED));

    // Then
    expect(layouts.map(layout => countRealByRing(layout))).toEqual([
      [3, 2, 0, 0, 0],
      [3, 6, 9, 12, 15],
    ]);
  });

  it('As a visitor, I see the peers on each ring evenly spaced, each turned off its even place by at most a third of the spacing', () => {
    // When
    const layout = getOrbitLayout(lightClient(45), SEED);

    // Then
    const offPlace = layout.rings.flatMap(({ dots }) => {
      const peers = dots.filter(({ kind }) => kind === 'peer');
      const spacing = 360 / peers.length;
      // Each peer's angle less its even place, which is the ring's offset turned by the peer's own jitter.
      const turns = peers.map((dot, slot) => dot.start - slot * spacing);
      // Two turns of up to a third of the spacing either way differ by up to two thirds, and a degree of rounding.
      return turns.filter(turn => getAngleGap(turn, turns[0] ?? turn) > (2 * spacing) / 3 + 1);
    });
    expect(offPlace).toEqual([]);
  });

  it('As a visitor who opens the page again, I see the peers turned to other places', () => {
    // When
    const layouts = [1, 2].map(seed => getOrbitLayout(lightClient(45), seed));

    // Then
    const [first, second] = layouts.map(layout =>
      listDots(layout).flatMap(dot => (dot.kind === 'peer' ? [dot.start] : [])),
    );
    expect(first).not.toEqual(second);
  });

  it('As a visitor, I see a joining peer add its own dot and cascade and change no other dot or link', () => {
    // Given
    const before = getOrbitLayout(lightClient(5), SEED);

    // When
    const after = getOrbitLayout(lightClient(6), SEED);

    // Then
    expect(after.rings.map(({ dots }) => dots.filter(dot => !isIn(dot, before)))).toEqual(
      after.rings.map(({ dots }, index) => dots.filter(dot => findRoot(after, index, dot)?.label === '[peer#6]')),
    );
    expect(listDots(before).every(dot => isIn(dot, after))).toBe(true);
  });

  it('As a visitor, I see each peer labelled by its join order, and no simulated dot labelled', () => {
    // When
    const layout = getOrbitLayout(lightClient(4), SEED);

    // Then
    expect(listDots(layout).flatMap(({ label }) => (label === null ? [] : [label]))).toEqual([
      '[peer#1]',
      '[peer#2]',
      '[peer#3]',
      '[peer#4]',
    ]);
    expect(listDots(layout).filter(({ kind }) => kind === 'simulated')).not.toEqual([]);
  });

  it('As a visitor, I see each simulated dot linked to a dot on the ring inside its own within 40 deg of it, back to a peer', () => {
    // When
    const layout = getOrbitLayout(lightClient(10), SEED);

    // Then
    const simulated = listDots(layout).filter(({ kind }) => kind === 'simulated');
    expect(simulated.filter(dot => getAngleGap(dot.from, dot.start) > 40)).toEqual([]);
    expect(listRoots(layout).every(root => root?.kind === 'peer')).toBe(true);
  });

  it('As a visitor, I see no simulated dot within 6 deg of a place a peer can take', () => {
    // When
    const full = getOrbitLayout(lightClient(45), SEED);
    const layout = getOrbitLayout(lightClient(30), SEED);

    // Then
    const crowded = layout.rings.flatMap(({ ring, dots }) => {
      const slots = (full.rings.find(other => other.ring === ring)?.dots ?? []).filter(({ kind }) => kind === 'peer');
      return dots.filter(dot => dot.kind === 'simulated' && slots.some(slot => getAngleGap(slot.start, dot.start) < 6));
    });
    expect(crowded).toEqual([]);
  });

  it('As a visitor on a server backend, I see one server, labelled as the server, and every simulated dot cascading from it', () => {
    // When
    const layout = getOrbitLayout({ kind: 'server' }, SEED);

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
