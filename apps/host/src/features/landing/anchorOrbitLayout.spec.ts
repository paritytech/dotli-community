// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { must } from '@dotli/shared/testing';
import { anchorOrbitLayout } from './anchorOrbitLayout.js';
import { getOrbitLayout, type OrbitDot, type OrbitLayout, type OrbitMode } from './getOrbitLayout.js';

/** One page load's seed. */
const SEED = 1;

/** Room for floating point error in an angle. */
const EPSILON = 1e-9;

/** A backend with no light client, which reaches the network through one trusted provider. */
const TRUSTED_PROVIDER: OrbitMode = { kind: 'trustedProvider' };

describe('anchorOrbitLayout', () => {
  it('As a visitor whose light client gains a peer, I see the peer that joined last before keep its place', () => {
    // Given
    const previous = getOrbitLayout(lightClient(4), SEED);
    const next = getOrbitLayout(lightClient(5), SEED);

    // When
    const anchored = anchorOrbitLayout(previous, next);

    // Then
    expect(findDot(anchored, '[peer#4]').start).toBeCloseTo(findDot(previous, '[peer#4]').start, 9);
  });

  it('As a visitor whose light client loses its latest peers, I see the latest peer it keeps stay in place', () => {
    // Given
    const previous = getOrbitLayout(lightClient(5), SEED);
    const next = getOrbitLayout(lightClient(3), SEED);

    // When
    const anchored = anchorOrbitLayout(previous, next);

    // Then
    expect(findDot(anchored, '[peer#3]').start).toBeCloseTo(findDot(previous, '[peer#3]').start, 9);
  });

  it('As a visitor, I see the whole picture turn by one amount, each link still starting where it did', () => {
    // Given another page load's picture, so the trusted provider, its tree and the loose dots all sit elsewhere
    const previous = getOrbitLayout(TRUSTED_PROVIDER, 2);
    const next = getOrbitLayout(TRUSTED_PROVIDER, SEED);
    const turn = findDot(previous, '[trusted provider]').start - findDot(next, '[trusted provider]').start;

    // When
    const anchored = anchorOrbitLayout(previous, next);

    // Then
    const nextDots = listDots(next);
    const offsets = listDots(anchored).map((dot, index) => dot.start - must(nextDots[index], 'a dot').start);
    expect(offsets.filter(offset => Math.abs(offset - turn) > EPSILON)).toEqual([]);
    expect(listLinkStarts(anchored)).toEqual(listLinkStarts(next));
  });

  it.each([
    ['no layout was shown before', undefined],
    ['the light client gives way to a trusted provider', getOrbitLayout(lightClient(5), SEED)],
  ])('As a visitor, when %s, I see the new layout unturned', (_, previous) => {
    // Given
    const next = getOrbitLayout(TRUSTED_PROVIDER, SEED);

    // When
    const anchored = anchorOrbitLayout(previous, next);

    // Then
    expect(anchored).toBe(next);
  });
});

function lightClient(peers: number): OrbitMode {
  return { kind: 'lightClient', peers };
}

function listDots(layout: OrbitLayout): OrbitDot[] {
  return layout.rings.flatMap(({ dots }) => dots);
}

function findDot(layout: OrbitLayout, key: string): OrbitDot {
  return must(
    listDots(layout).find(dot => dot.key === key),
    key,
  );
}

/** Lists where each dot's link starts: at the centre, at a dot on the ring inside, nowhere, or at no dot at all. */
function listLinkStarts(layout: OrbitLayout): string[] {
  return layout.rings.flatMap(({ dots }, index) =>
    dots.map(({ from }) => {
      if (from === null) {
        return 'none';
      }
      if ((layout.rings[index - 1]?.dots ?? []).some(({ start }) => start === from)) {
        return 'dot';
      }
      return from === 0 ? 'centre' : 'broken';
    }),
  );
}
