// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { must } from '@dotli/shared/testing';
import { getOrbitLayout, type OrbitDot, type OrbitLayout, type OrbitMode } from './getOrbitLayout.js';

/** One page load's seed. */
const SEED = 1;

/** The share of the real nodes' spacing a dot turns at most either way. */
const JITTER = 0.3;

/** How far, in degrees, a light client's tree reaches further either way on each ring out. */
const REACH = 30;

/** Room for floating point error in an angle. */
const EPSILON = 1e-9;

/** Every count of peers the rings hold. */
const COUNTS = Array.from({ length: 45 }, (_, index) => index + 1);

/** A few page loads' seeds, for a case about every picture rather than one. */
const SEEDS = [1, 2, 3, 4, 5];

/** The least distance along a ring between a simulated dot and another dot on that ring. */
const MIN_GAP = 10;

/** The most simulated dots the orbit draws. */
const MAX_SIMULATED = 120;

/** A backend with no light client, which reaches the network through one trusted provider. */
const TRUSTED_PROVIDER: OrbitMode = { kind: 'trustedProvider' };

/** How far, in degrees, the trusted provider's tree reaches further either way on each ring out. */
const TRUSTED_PROVIDER_REACH = 8;

/** The simulated nodes the trusted provider's tree is budgeted, and the one more each of its four rings may hold. */
const TRUSTED_PROVIDER_TREE = 20;
const TRUSTED_PROVIDER_RINGS = 4;

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

  it("As a visitor, I see each simulated dot linked to a dot on the ring inside its own within a tree's reach, back to a peer", () => {
    // When
    const layouts = COUNTS.flatMap(count => SEEDS.map(seed => getOrbitLayout(lightClient(count), seed)));

    // Then
    const far = layouts.flatMap(layout =>
      listDots(layout).filter(
        dot => dot.kind === 'simulated' && (dot.from === null || getAngleGap(dot.from, dot.start) > REACH + EPSILON),
      ),
    );
    expect(far).toEqual([]);
    expect(layouts.every(layout => listRoots(layout).every(root => root?.kind === 'peer'))).toBe(true);
  });

  it("As a visitor, I see a staying peer's tree keep its shape when another peer joins, each dot it keeps as far from the peer and linked to the same parent", () => {
    // Given
    const before = COUNTS.slice(0, -1).flatMap(count =>
      SEEDS.map(seed => ({ count, seed, layout: getOrbitLayout(lightClient(count), seed) })),
    );

    // When
    const after = before.map(({ count, seed }) => getOrbitLayout(lightClient(count + 1), seed));

    // Then
    const kept = before.flatMap(({ layout }, index) => {
      const joined = new Map(listTreeDots(must(after[index], 'after')).map(dot => [dot.key, dot]));
      return listTreeDots(layout).flatMap(dot => {
        const next = joined.get(dot.key);
        return next ? [{ dot, next }] : [];
      });
    });
    const reshaped = kept.filter(
      ({ dot, next }) => Math.abs(dot.offset - next.offset) > EPSILON || dot.parent !== next.parent,
    );
    expect(reshaped).toEqual([]);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('As a visitor, I see each peer on the two inner rings grow a tree that branches', () => {
    // When
    const layouts = [3, 7, 20].flatMap(count => SEEDS.map(seed => getOrbitLayout(lightClient(count), seed)));

    // Then
    const unbranched = layouts.flatMap(layout => {
      const branching = listDots(layout).filter(dot => countChildren(layout, dot) >= 2);
      return layout.rings
        .slice(0, 2)
        .flatMap(({ dots }) => dots.filter(({ kind }) => kind === 'peer'))
        .filter(peer => !branching.some(dot => dot === peer || dot.key.startsWith(`${peer.key}.`)));
    });
    expect(unbranched).toEqual([]);
  });

  it('As a visitor, I see no dot closer to another on its ring than the least distance between two dots', () => {
    // When
    const layouts = COUNTS.flatMap(count => SEEDS.map(seed => getOrbitLayout(lightClient(count), seed)));

    // Then
    expect(layouts.flatMap(layout => listCrowded(layout))).toEqual([]);
  });

  it('As a visitor with the most peers the rings hold, I see the simulated dots kept within their budget', () => {
    // When
    const layouts = SEEDS.map(seed => getOrbitLayout(lightClient(45), seed));

    // Then
    const counts = layouts.map(layout => listDots(layout).filter(({ kind }) => kind === 'simulated').length);
    expect(counts.filter(count => count > MAX_SIMULATED)).toEqual([]);
  });

  it("As a visitor, I see each simulated dot in its own peer's part of its ring, nearer its own peer than any other once 0.3 of the peer spacing per ring out from each peer is taken off", () => {
    // When
    const layouts = COUNTS.flatMap(count =>
      SEEDS.map(seed => ({ count, layout: getOrbitLayout(lightClient(count), seed) })),
    );

    // Then
    const astray = layouts.flatMap(({ count, layout }) => {
      const peers = layout.rings.flatMap(({ dots }, index) =>
        dots.filter(({ kind }) => kind === 'peer').map(dot => ({ dot, index })),
      );
      return layout.rings.flatMap(({ dots }, index) =>
        dots
          .filter(({ kind }) => kind === 'simulated')
          .filter(dot => {
            const root = findRoot(layout, index, dot);
            // How near each peer with a tree on the dot's ring is, less the lead a peer further in has there.
            const nearness = peers
              .filter(peer => peer.index <= index)
              .map(peer => ({
                peer: peer.dot,
                near: getAngleGap(peer.dot.start, dot.start) - (index - peer.index) * (360 / count) * JITTER,
              }));
            const own = must(
              nearness.find(({ peer }) => peer === root),
              'root',
            ).near;
            return nearness.some(({ peer, near }) => peer !== root && near < own - EPSILON);
          }),
      );
    });
    expect(astray).toEqual([]);
  });

  it('As a visitor on a trusted provider backend, I see one trusted provider, labelled as the trusted provider, and every simulated dot cascading from it', () => {
    // When
    const layout = getOrbitLayout(TRUSTED_PROVIDER, SEED);

    // Then
    expect(listDots(layout).filter(({ kind }) => kind !== 'simulated' && kind !== 'loose')).toEqual([
      expect.objectContaining({ kind: 'trustedProvider', label: '[trusted provider]' }),
    ]);
    expect(listDots(layout).filter(({ kind, label }) => kind !== 'trustedProvider' && label !== null)).toEqual([]);
    expect(listRoots(layout).every(root => root?.kind === 'trustedProvider')).toBe(true);
  });

  it("As a visitor on a trusted provider backend, I see the trusted provider grow one small tree that branches within its narrow fan, each dot linked to its parent within the trusted provider's reach", () => {
    // When
    const layouts = SEEDS.map(seed => getOrbitLayout(TRUSTED_PROVIDER, seed));

    // Then
    const astray = layouts.flatMap(layout => {
      const trustedProvider = findTrustedProvider(layout);
      return layout.rings.flatMap(({ dots }, index) =>
        dots.filter(
          dot =>
            dot.kind === 'simulated' &&
            (getAngleGap(dot.start, trustedProvider.start) > index * TRUSTED_PROVIDER_REACH + EPSILON ||
              dot.from === null ||
              getAngleGap(dot.from, dot.start) > TRUSTED_PROVIDER_REACH + EPSILON),
        ),
      );
    });
    expect(astray).toEqual([]);
    const trees = layouts.map(layout => listDots(layout).filter(({ kind }) => kind === 'simulated'));
    expect(trees.filter(tree => tree.length > TRUSTED_PROVIDER_TREE + TRUSTED_PROVIDER_RINGS)).toEqual([]);
    const branching = layouts.map(layout => listDots(layout).some(dot => countChildren(layout, dot) >= 2));
    expect(branching).toEqual(layouts.map(() => true));
  });

  it("As a visitor on a trusted provider backend, I see the trusted provider's one tree hold its budget however the seed turns its dots", () => {
    // When
    const layouts = SEEDS.map(seed => getOrbitLayout(TRUSTED_PROVIDER, seed));

    // Then
    const trees = layouts.map(layout => listDots(layout).filter(({ kind }) => kind === 'simulated'));
    expect(trees.filter(tree => tree.length < TRUSTED_PROVIDER_TREE)).toEqual([]);
  });

  it("As a visitor on a trusted provider backend, I see loose dots on every ring, linked to nothing and outside the trusted provider's tree", () => {
    // When
    const layouts = SEEDS.map(seed => getOrbitLayout(TRUSTED_PROVIDER, seed));

    // Then
    const looseByRing = layouts.map(layout =>
      layout.rings.map(({ dots }) => dots.filter(({ kind }) => kind === 'loose').length > 0),
    );
    expect(looseByRing).toEqual(layouts.map(layout => layout.rings.map(() => true)));
    const misplaced = layouts.flatMap(layout => {
      const trustedProvider = findTrustedProvider(layout);
      return layout.rings.flatMap(({ dots }, index) =>
        dots.filter(
          dot =>
            dot.kind === 'loose' &&
            (dot.from !== null || getAngleGap(dot.start, trustedProvider.start) <= index * TRUSTED_PROVIDER_REACH),
        ),
      );
    });
    expect(misplaced).toEqual([]);
  });

  it('As a visitor on a trusted provider backend, I see no dot closer to another on its ring than the least distance between two dots', () => {
    // When
    const layouts = SEEDS.map(seed => getOrbitLayout(TRUSTED_PROVIDER, seed));

    // Then
    expect(layouts.flatMap(layout => listCrowded(layout))).toEqual([]);
  });

  it('As a visitor on a trusted provider backend, I see no more simulated and loose dots than the most a light client shows', () => {
    // When
    const layouts = SEEDS.map(seed => getOrbitLayout(TRUSTED_PROVIDER, seed));

    // Then
    const counts = layouts.map(layout => listDots(layout).filter(({ kind }) => kind !== 'trustedProvider').length);
    expect(counts.filter(count => count > MAX_SIMULATED)).toEqual([]);
  });

  it('As a visitor on a trusted provider backend who opens the page again, I see the loose dots in other places', () => {
    // When
    const layouts = [1, 2].map(seed => getOrbitLayout(TRUSTED_PROVIDER, seed));

    // Then
    const [first, second] = layouts.map(layout =>
      listDots(layout)
        .filter(({ kind }) => kind === 'loose')
        .map(({ start }) => start),
    );
    expect(first).not.toEqual(second);
  });
});

/** Returns the trusted provider of a trusted provider backend's layout. */
function findTrustedProvider(layout: OrbitLayout): OrbitDot {
  return must(
    listDots(layout).find(({ kind }) => kind === 'trustedProvider'),
    'trustedProvider',
  );
}

/** Lists the dots closer to another on their ring than `MIN_GAP` along it. */
function listCrowded(layout: OrbitLayout): OrbitDot[] {
  return layout.rings.flatMap(({ dots, radius }) =>
    dots.filter(dot =>
      dots.some(
        other => other !== dot && (getAngleGap(other.start, dot.start) / 180) * Math.PI * radius < MIN_GAP - EPSILON,
      ),
    ),
  );
}

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

/** Counts the simulated dots linked to `dot` from the ring outside its own. */
function countChildren(layout: OrbitLayout, dot: OrbitDot): number {
  const index = layout.rings.findIndex(({ dots }) => dots.includes(dot));
  return (layout.rings[index + 1]?.dots ?? []).filter(({ from }) => from === dot.start).length;
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

/**
 * Lists the simulated dots of a layout whose links reach a peer, each with its key, its angle from that peer and the key
 * of the dot it links to.
 */
function listTreeDots(layout: OrbitLayout): { key: string; offset: number; parent: string | null }[] {
  return layout.rings.flatMap(({ dots }, index) =>
    dots.flatMap(dot => {
      const root = findRoot(layout, index, dot);
      if (dot.kind !== 'simulated' || root === null) {
        return [];
      }
      const parent = layout.rings[index - 1]?.dots.find(({ start }) => start === dot.from);
      return [{ key: dot.key, offset: dot.start - root.start, parent: parent?.key ?? null }];
    }),
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
