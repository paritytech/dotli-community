// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { chainDetailEnvelope, chainSyncEnvelope } from './envelopes.js';

describe('telemetry envelopes', () => {
  it('As the host, I hear a chain sync event as a chain-sync envelope, its kind as the sync kind and every fact kept', () => {
    // When
    const envelope = chainSyncEnvelope({ chain: 'relay', kind: 'warpSyncProgress', at: 5, target: 10 });

    // Then
    expect(envelope).toEqual({
      namespace: 'dotli:protocol',
      kind: 'chain-sync',
      chain: 'relay',
      syncKind: 'warpSyncProgress',
      at: 5,
      target: 10,
    });
  });

  it("As the host, I hear a chain's details as a chain-detail envelope", () => {
    // When
    const envelope = chainDetailEnvelope({ chain: 'assethub', dbCache: 'hit' });

    // Then
    expect(envelope).toEqual({ namespace: 'dotli:protocol', kind: 'chain-detail', chain: 'assethub', dbCache: 'hit' });
  });
});
