// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DebugBus } from '@dotli/truapi-debug';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import { createPanelFeed } from './createPanelFeed.js';
import { buildSystemEvent } from './testing/buildSystemEvent.js';
import { BOOT_STARTED } from './testing/constants.js';
import { buildTruapiEvent } from './testing/buildTruapiEvent.js';
import { getEventLabel } from './model/getEventLabel.js';

/** A bus buffering for a panel that has not loaded yet. */
function createBufferingBus(): DebugBus {
  const bus = createDebugBus();
  bus.enableBuffering();
  return bus;
}

describe('debug panel feed', () => {
  it('As a dotli developer, I start the feed on a buffering bus and the buffered events are in the store before any frame', () => {
    // Given the bus is buffering and nothing listens yet
    const bus = createBufferingBus();
    bus.emit(buildSystemEvent({ ...BOOT_STARTED, flowId: 'flow-early' }));
    bus.emit(buildTruapiEvent({ tag: 'early_request', requestId: 'early-1' }));

    // When
    const feed = createPanelFeed({ bus, capacity: 2000 });

    // Then
    expect(feed.store.list().map(event => getEventLabel(event))).toEqual(['boot.started', 'early_request']);
    expect(feed.resolution.events().map(event => event.event)).toEqual(['started']);
  });

  it('As a dotli developer, I pause the panel and the system events emitted meanwhile do not reach the Resolution view', () => {
    // Given
    const bus = createBufferingBus();
    const feed = createPanelFeed({ bus, capacity: 2000 });
    feed.store.setPaused(true);

    // When
    bus.emit(buildSystemEvent({ ...BOOT_STARTED, flowId: 'flow-boot' }));
    bus.emit(
      buildSystemEvent({
        layer: 'resolve',
        event: 'started',
        flowId: 'flow-res',
        payload: { label: 'app', source: 'smoldot' },
      }),
    );
    feed.store.setPaused(false);

    // Then
    expect(feed.resolution.events()).toEqual([]);
    expect(feed.store.list()).toEqual([]);
  });

  it('As a dotli developer, I stop the feed and it takes no more events', () => {
    // Given
    const bus = createBufferingBus();
    const feed = createPanelFeed({ bus, capacity: 2000 });

    // When
    feed.dispose();
    bus.emit(buildTruapiEvent({ tag: 'late_request', requestId: 'late-1' }));

    // Then
    expect(feed.store.list()).toEqual([]);
  });
});
