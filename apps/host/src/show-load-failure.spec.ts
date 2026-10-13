// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import { createSessionErrorSightings } from './show-load-failure.js';

describe('sessionErrorSightings', () => {
  it('As a visitor reloading after a failure, I find the sighting kept for this tab until it is forgotten', () => {
    // Given the tab's session storage
    const session = memoryStorage();
    const sessionErrorSightings = createSessionErrorSightings(() => session);
    sessionErrorSightings.remember('hub-sync-timeout');

    // When
    const kept = sessionErrorSightings.seen('hub-sync-timeout');
    const other = sessionErrorSightings.seen('rpc-timeout');
    sessionErrorSightings.forget();

    // Then
    expect(kept).toBe(true);
    expect(other).toBe(false);
    expect(sessionErrorSightings.seen('hub-sync-timeout')).toBe(false);
  });
});
