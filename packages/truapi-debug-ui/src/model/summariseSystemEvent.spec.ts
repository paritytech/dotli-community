// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { StoredSystemEvent } from './storedEvent.js';
import { summariseSystemEvent } from './summariseSystemEvent.js';

describe('summariseSystemEvent()', () => {
  it('As a dotli developer, I select a monitor stop with a reason this build does not know and it reads that reason', () => {
    // Given a stop from a release that names another reason
    const event: StoredSystemEvent = {
      kind: 'system',
      seq: 1,
      receivedAt: 0,
      source: 'dotli',
      flowId: 'main-1',
      layer: 'main',
      event: 'monitor_stopped',
      payload: { reason: 'page_hidden' },
    };

    // When
    const summary = summariseSystemEvent(event);

    // Then
    expect(summary).toBe('Main-thread monitor stopped (page_hidden).');
  });
});
