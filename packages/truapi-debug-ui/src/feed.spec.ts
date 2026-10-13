// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { loadDotliDebugBus, type DotliDebugBus, type DotliDebugBusEvent } from '@dotli/truapi-debug';
import { createPanelFeed } from './feed.js';

/** A bus buffering for a panel that has not loaded yet, as the host's entry leaves it. */
async function bufferingBus(): Promise<DotliDebugBus> {
  const bus = (await loadDotliDebugBus()).createDotliDebugBus();
  bus.enableBuffering();
  return bus;
}

function system(bus: DotliDebugBus, layer: string, event: string, flowId: string): void {
  bus.emit({
    layer,
    event,
    flowId,
    timestamp: 0,
    payload: { chainBackend: 'smoldot' },
  } as unknown as DotliDebugBusEvent);
}

function truapi(bus: DotliDebugBus, tag: string, requestId: string): void {
  bus.emit({ kind: 'truapi', direction: 'outgoing', productId: 'app.dot', requestId, payload: { tag, value: {} } });
}

describe('debug panel feed', () => {
  it('As a dotli developer, buffered boot events are in the store as soon as the feed starts, before any frame', async () => {
    // Given the bus is buffering and nothing listens yet
    const bus = await bufferingBus();
    system(bus, 'boot', 'started', 'flow-early');
    truapi(bus, 'early_request', 'early-1');

    // When
    const feed = createPanelFeed({ bus, capacity: 2000 });

    // Then
    expect(feed.store.list().map(ev => (ev.kind === 'truapi' ? ev.tag : `${ev.layer}.${ev.event}`))).toEqual([
      'boot.started',
      'early_request',
    ]);
    expect(feed.resolution.events().map(ev => ev.event)).toEqual(['started']);
  });

  it('As a dotli developer, system events emitted while paused do not reach the Resolution view', async () => {
    // Given
    const bus = await bufferingBus();
    const feed = createPanelFeed({ bus, capacity: 2000 });
    feed.store.setPaused(true);

    // When
    system(bus, 'boot', 'started', 'flow-boot');
    system(bus, 'resolve', 'started', 'flow-res');
    feed.store.setPaused(false);

    // Then
    expect(feed.resolution.events()).toEqual([]);
    expect(feed.store.list()).toEqual([]);
  });

  it('As a dotli developer, a feed that stopped takes no more events', async () => {
    // Given
    const bus = await bufferingBus();
    const feed = createPanelFeed({ bus, capacity: 2000 });

    // When
    feed.unsubscribe();
    truapi(bus, 'late_request', 'late-1');

    // Then
    expect(feed.store.list()).toEqual([]);
  });
});
