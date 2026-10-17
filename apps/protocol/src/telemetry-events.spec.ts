// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { chainDetailTelemetry, chainSyncTelemetry, smoldotDbTelemetry } from './telemetry-events.js';

describe('telemetry events', () => {
  it('As the host, I hear a chain sync event with every fact kept', () => {
    // When
    const event = chainSyncTelemetry({ chain: 'relay', kind: 'warpSyncProgress', at: 5, target: 10 });

    // Then
    expect(event).toEqual({
      tag: 'chainSync',
      value: { chain: 'relay', kind: 'warpSyncProgress', at: 5, target: 10 },
    });
  });

  it("As the host, I hear a chain's details", () => {
    // When
    const event = chainDetailTelemetry({ chain: 'assethub', dbCache: 'hit' });

    // Then
    expect(event).toEqual({ tag: 'chainDetail', value: { chain: 'assethub', dbCache: 'hit' } });
  });

  it("As the host, I hear a chain's database outcome", () => {
    // When
    const event = smoldotDbTelemetry('bulletin', 'unavailable');

    // Then
    expect(event).toEqual({ tag: 'smoldotDb', value: { chain: 'bulletin', outcome: 'unavailable' } });
  });
});
