// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { queueIslandErrors, takeQueuedIslandErrors, type IslandErrorQueuePage } from './island-error-queue.js';

describe('the island error queue', () => {
  it('As a dotli user, an island that fails before the page boots is still reported once boot listens', () => {
    // Given the head script's queue, and a failure dispatched before boot
    const page: IslandErrorQueuePage = {};
    const target = new EventTarget();
    queueIslandErrors(page, target);
    const early = new Event('astro:hydration-error');
    target.dispatchEvent(early);

    // When boot takes the queue
    const taken = takeQueuedIslandErrors(page);

    // Then it gets the early failure, and later ones are left to its own listener
    expect(taken).toEqual([early]);
    target.dispatchEvent(new Event('astro:hydration-error'));
    expect(takeQueuedIslandErrors(page)).toEqual([]);
  });
});
