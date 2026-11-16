// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createSessionErrorSightings } from './createSessionErrorSightings.js';

describe('sessionErrorSightings', () => {
  it('As a visitor reloading after a failure, I find the sighting kept for this tab and it goes once forgotten', () => {
    // Given the tab's session storage
    const session = createMemoryStorage();
    const sessionErrorSightings = createSessionErrorSightings({ session });
    sessionErrorSightings.remember('hub-sync-timeout');

    // When
    const kept = sessionErrorSightings.hasSeen('hub-sync-timeout');
    const other = sessionErrorSightings.hasSeen('rpc-timeout');
    sessionErrorSightings.forget();
    const forgotten = sessionErrorSightings.hasSeen('hub-sync-timeout');

    // Then
    expect(kept).toBe(true);
    expect(other).toBe(false);
    expect(forgotten).toBe(false);
  });
});
