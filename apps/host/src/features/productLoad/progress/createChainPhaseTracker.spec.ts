// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainSyncKind } from '@dotli/chains';
import { createChainPhaseTracker } from './createChainPhaseTracker.js';

describe('The chain phase tracker', () => {
  it('As a visitor back from another tab, I watch a chain stall while ready and see it ready again once it recovers', () => {
    // Given
    const track = createChainPhaseTracker();
    track('relay', 'bootstrapComplete');

    // When
    const stalled = track('relay', 'stalled');
    const recovered = track('relay', 'recovered');

    // Then
    expect(stalled).toBe('stalled');
    expect(recovered).toBe('ready');
  });

  it.each<{ story: string; history: ChainSyncKind[]; expected: string }>([
    { story: 'stalled mid-sync', history: ['warpSyncProgress', 'stalled'], expected: 'syncing' },
    {
      story: 'reached a phase during its stall',
      history: ['bootstrapComplete', 'stalled', 'connecting'],
      expected: 'connecting',
    },
    { story: 'had no phase known before', history: [], expected: 'syncing' },
  ])('As a visitor, I watch a chain that $story recover and see it $expected', ({ history, expected }) => {
    // Given
    const track = createChainPhaseTracker();
    for (const kind of history) {
      track('relay', kind);
    }

    // When
    const recovered = track('relay', 'recovered');

    // Then
    expect(recovered).toBe(expected);
  });

  it('As a visitor, I watch a chain report a peer count and its phase does not move', () => {
    // Given
    const track = createChainPhaseTracker();

    // When
    const peers = track('bulletin', 'peers');

    // Then
    expect(peers).toBeUndefined();
  });
});
