// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOrbitLayout, type OrbitDot, type OrbitLayout, type OrbitMode } from './getOrbitLayout.js';

/** One page load's seed. */
const SEED = 1;

/** The share of the real nodes' spacing a dot turns at most either way. */
const JITTER = 0.3;

/** Room for floating point error in an angle. */
const EPSILON = 1e-9;

/** Every count of peers the rings hold. */
const COUNTS = Array.from({ length: 45 }, (_, index) => index + 1);

describe('getOrbitLayout', () => {
  it('As a visitor whose light client has no peers yet, I see no dots', () => {
    // When
    const layout = getOrbitLayout(lightClient(0), SEED);

    // Then
    expect(listDots(layout)).toEqual([]);
  });

  it('As a visitor, I see peers fill 3, 6, 9, 12 and 15 places on the rings from the centre outward', () => {
    // When
    const layouts = [5, 50].map(peers => getOrbitLayout(lightClient(peers), SEED));

    // Then
    expect(layouts.map(layout => countRealByRing(layout))).toEqual([
      [3, 2, 0, 0, 0],
      [3, 6, 9, 12, 15],
    ]);
  });

  it('As a visitor, I see the peers spread evenly around the circle whatever ring each takes, each off its even place by at most 0.3 of the spacing', () => {
    // When
    const layouts = COUNTS.map(count => getOrbitLayout(lightClient(count), SEED));

    // Then
    const offPlace = layouts.flatMap(layout => {
      const peers = listPeersRoundTheCircle(layout);
      const spacing = 360 / peers.length;
      // Each peer's angle less its even place past the first peer's, which leaves the first's place and its own turn.
      const turns = peers.map((dot, place) => dot.start - place * spacing);
      // Two turns of up to 0.3 of the spacing either way differ by up to 0.6 of it.
      return turns.filter(turn => getAngleGap(turn, turns[0] ?? turn) > 2 * JITTER * spacing + EPSILON);
    });
    expect(offPlace).toEqual([]);
  });

  it('As a visitor, I see the peers on the inner ring spread round it however many peers there are', () => {
    // When
    const layouts = COUNTS.map(count => getOrbitLayout(lightClient(count), SEED));

    // Then
    const crowded = layouts.flatMap(layout => {
      const inner = layout.rings[0]?.dots ?? [];
      const count = listDots(layout).filter(({ kind }) => kind === 'peer').length;
      // The whole places of an even split among the inner peers, less two turns of up to 0.3 of a spacing. A count that
      // does not split in three leaves a third up to 2/3 of a spacing short of 120 deg, the least even places allow.
      const least = (Math.floor(count / inner.length) - 2 * JITTER) * (360 / count);
      return inner.filter(dot => inner.some(other => other !== dot && getAngleGap(other.start, dot.start) < least));
    });
    expect(crowded).toEqual([]);
  });

  it('As a visitor, I see a joining peer land between two peers already shown, which keep their order round the circle', () => {
    // Given
    const before = COUNTS.slice(0, -1).map(count => listPeersRoundTheCircle(getOrbitLayout(lightClient(count), SEED)));

    // When
    const after = COUNTS.slice(0, -1).map(count =>
      listPeersRoundTheCircle(getOrbitLayout(lightClient(count + 1), SEED)),
    );

    // Then
    const joined = after.map((peers, index) => peers.filter(({ key }) => key !== `[peer#${String(index + 2)}]`));
    expect(joined.map(peers => peers.map(({ key }) => key))).toEqual(before.map(peers => peers.map(({ key }) => key)));
  });

  it('As a visitor who opens the page again, I see the peers turned to other places', () => {
    // When
    const layouts = [1, 2].map(seed => getOrbitLayout(lightClient(45), seed));

    // Then
    const [first, second] = layouts.map(layout => listPeersInJoinOrder(layout).map(({ start }) => start));
    expect(first).not.toEqual(second);
  });

  it('As a visitor, I see a joining peer move the other peers to their new even places, each keeping its key', () => {
    // Given
    const before = listPeersInJoinOrder(getOrbitLayout(lightClient(5), SEED));

    // When
    const after = listPeersInJoinOrder(getOrbitLayout(lightClient(6), SEED));

    // Then
    expect(after.map(({ key }) => key)).toEqual([...before.map(({ key }) => key), '[peer#6]']);
    expect(after.slice(0, 5).map(({ start }) => start)).not.toEqual(before.map(({ start }) => start));
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

  it('As a visitor, I see each simulated dot linked to a dot on the ring inside its own within 0.3 of the peer spacing, back to a peer', () => {
    // When
    const layout = getOrbitLayout(lightClient(10), SEED);

    // Then
    const simulated = listDots(layout).filter(({ kind }) => kind === 'simulated');
    expect(simulated.filter(dot => getAngleGap(dot.from, dot.start) > (360 / 10) * JITTER + EPSILON)).toEqual([]);
    expect(listRoots(layout).every(root => root?.kind === 'peer')).toBe(true);
  });

  it('As a visitor, I see no simulated dot within 6 deg of another dot on its ring', () => {
    // When
    const layout = getOrbitLayout(lightClient(30), SEED);

    // Then
    const crowded = layout.rings.flatMap(({ dots }) =>
      dots.filter(
        dot => dot.kind === 'simulated' && dots.some(other => other !== dot && getAngleGap(other.start, dot.start) < 6),
      ),
    );
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

function listPeersInJoinOrder(layout: OrbitLayout): OrbitDot[] {
  const peers = listDots(layout).filter(({ kind }) => kind === 'peer');
  return peers.sort((a, b) => getJoinOrder(a) - getJoinOrder(b));
}

/** Lists the peers by angle from the first's place, which no turn of under half a spacing can reorder. */
function listPeersRoundTheCircle(layout: OrbitLayout): OrbitDot[] {
  return listDots(layout)
    .filter(({ kind }) => kind === 'peer')
    .sort((a, b) => a.start - b.start);
}

/** Reads a peer's join order from its key, `[peer#<order>]`. */
function getJoinOrder(peer: OrbitDot): number {
  return Number(peer.key.slice('[peer#'.length, -1));
}

function countRealByRing(layout: OrbitLayout): number[] {
  return layout.rings.map(({ dots }) => dots.filter(({ kind }) => kind !== 'simulated').length);
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
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
}
