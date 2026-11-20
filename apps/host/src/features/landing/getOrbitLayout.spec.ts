// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  getOrbitLayout,
  type OrbitDot,
  type OrbitEnd,
  type OrbitLayout,
  type OrbitMode,
  type OrbitRing,
} from './getOrbitLayout.js';

describe('getOrbitLayout', () => {
  it('As a visitor whose light client has no peers yet, I see no dots and no links', () => {
    // When
    const layout = getOrbitLayout(lightClient(0));

    // Then
    expect(listDots(layout)).toEqual([]);
    expect(layout.links).toEqual([]);
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
      after.rings.map(({ dots }) => dots.filter(dot => isFrom(after, dot, '[peer#6]'))),
    );
    expect(listDots(before).every(dot => isIn(dot, after))).toBe(true);
    expect(before.links.every(link => after.links.some(other => JSON.stringify(other) === JSON.stringify(link)))).toBe(
      true,
    );
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

  it('As a visitor whose light client has peers, I see the centre linked straight to each peer and no peer linked to another', () => {
    // When
    const layout = getOrbitLayout(lightClient(10));

    // Then
    const real = listEnds(layout, dot => dot.kind !== 'simulated');
    expect(
      layout.links
        .filter(({ from, to }) => real.includes(getEndText(from)) || real.includes(getEndText(to)))
        .filter(({ kind }) => kind === 'real')
        .map(({ from, to }) => `${getEndText(from)}>${getEndText(to)}`),
    ).toEqual(real.map(end => `centre:0>${end}`));
    expect(
      layout.links.filter(({ from, to }) => real.includes(getEndText(from)) && real.includes(getEndText(to))),
    ).toEqual([]);
  });

  it('As a visitor, I see each simulated dot linked once, dimly, from a dot on the ring inside its own', () => {
    // When
    const layout = getOrbitLayout(lightClient(10));

    // Then
    const simulated = listEnds(layout, dot => dot.kind === 'simulated');
    const order: (OrbitRing | 'centre')[] = ['centre', ...layout.rings.map(({ ring }) => ring)];
    const into = layout.links.filter(({ to }) => simulated.includes(getEndText(to)));
    expect(into.map(({ to }) => getEndText(to)).sort()).toEqual([...simulated].sort());
    expect(
      into.every(
        ({ from, to, kind }) => kind === 'simulated' && order.indexOf(from.ring) === order.indexOf(to.ring) - 1,
      ),
    ).toBe(true);
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

  it('As a visitor on a server backend, I see one server, labelled as the server, linked from the centre, and every simulated dot cascading from it', () => {
    // When
    const layout = getOrbitLayout({ kind: 'server' });

    // Then
    expect(listDots(layout).filter(({ kind }) => kind !== 'simulated')).toEqual([
      expect.objectContaining({ kind: 'server', label: '[server]' }),
    ]);
    expect(layout.links.filter(({ kind }) => kind === 'real')).toEqual([
      expect.objectContaining({ from: { ring: 'centre', start: 0 }, to: { ring: 'inner', start: 282 } }),
    ]);
    expect(listEnds(layout, dot => dot.kind === 'simulated').map(end => findRoot(layout, end))).not.toContain(null);
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

/** The ends of the dots `pick` selects, as text. */
function listEnds(layout: OrbitLayout, pick: (dot: OrbitDot) => boolean): string[] {
  return layout.rings.flatMap(({ ring, dots }) => dots.filter(pick).map(({ start }) => getEndText({ ring, start })));
}

function isIn(dot: OrbitDot, layout: OrbitLayout): boolean {
  return listDots(layout).some(other => JSON.stringify(other) === JSON.stringify(dot));
}

/** Whether `dot` is the real dot labelled `label` or descends from it through the links. */
function isFrom(layout: OrbitLayout, dot: OrbitDot, label: string): boolean {
  const ring = layout.rings.find(({ dots }) => dots.includes(dot))?.ring;
  return ring !== undefined && findRoot(layout, getEndText({ ring, start: dot.start }))?.label === label;
}

/** Returns the real dot a dot cascades from, following its links inward, or null when the chain breaks. */
function findRoot(layout: OrbitLayout, end: string): OrbitDot | null {
  const dot = layout.rings.flatMap(({ ring, dots }) =>
    dots.filter(({ start }) => getEndText({ ring, start }) === end),
  )[0];
  if (!dot) {
    return null;
  }
  if (dot.kind !== 'simulated') {
    return dot;
  }
  const from = layout.links.find(({ to }) => getEndText(to) === end)?.from;
  return from ? findRoot(layout, getEndText(from)) : null;
}

function getEndText({ ring, start }: OrbitEnd): string {
  return `${ring}:${String(start)}`;
}

function getAngleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
