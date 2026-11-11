// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { SystemEventPair } from './getSystemEventKey.js';
import { getSystemExplanation } from './getSystemExplanation.js';
import { findSystemEventFacts } from './systemEventFacts.js';

describe('findSystemEventFacts()', () => {
  it('As a dotli developer, I read the facts of an event the union does not name and get none', () => {
    // Given a sandbox of another release sends an event name this build's union lacks
    const pair = { layer: 'sandbox', event: 'cache_checked' } as unknown as SystemEventPair;

    // When I read its facts and its explanation
    const facts = findSystemEventFacts(pair);

    // Then there are none
    expect(facts).toBeUndefined();
    expect(getSystemExplanation(pair)).toBeUndefined();
  });
});
