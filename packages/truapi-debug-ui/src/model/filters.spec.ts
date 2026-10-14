// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { EventStore } from './event-store.js';
import { compileQuery, initialFilterState, matches, type FilterState } from './filters.js';

/** Two products, an event without a product and a host boot event. */
function filterTraffic(): EventStore {
  const store = new EventStore({ capacity: 10 });
  const truapi = (tag: string, requestId: string, productId: string | null, direction: 'incoming' | 'outgoing') => {
    store.insertTruapi({
      kind: 'truapi',
      direction,
      ...(productId !== null ? { productId } : {}),
      requestId,
      payload: { tag, value: {} },
    });
  };
  truapi('alpha_request', 'a1', 'b.dot', 'outgoing');
  truapi('alpha_response', 'a1', 'b.dot', 'incoming');
  truapi('beta_request', 'b1', 'a.dot', 'incoming');
  truapi('gamma_request', 'c1', null, 'outgoing');
  store.insertDotli({
    layer: 'boot',
    event: 'started',
    flowId: 'flow-1',
    timestamp: 0,
    payload: { chainBackend: 'smoldot' },
  } as unknown as DotliDebugEvent);
  return store;
}

/** The row labels the filters leave, as the list shows them. */
function shown(store: EventStore, query: Partial<FilterState>): string[] {
  const filters = { ...initialFilterState(), ...query };
  return store
    .list()
    .filter(event => matches(event, filters))
    .map(event => (event.kind === 'truapi' ? event.tag : `${event.layer}.${event.event}`));
}

describe('debug panel text filters', () => {
  it('As a dotli developer, I include a substring in any case and see the tags that hold it', () => {
    // Given
    const store = filterTraffic();

    // When
    const rows = shown(store, { tagQuery: 'ALPHA' });

    // Then
    expect(rows).toEqual(['alpha_request', 'alpha_response']);
  });

  it('As a dotli developer, I include layer:event and see that system event', () => {
    // Given
    const store = filterTraffic();

    // When
    const rows = shown(store, { tagQuery: 'boot:start' });

    // Then
    expect(rows).toEqual(['boot.started']);
  });

  it('As a dotli developer, I include a regex and see the tags it matches', () => {
    // Given
    const store = filterTraffic();

    // When
    const rows = shown(store, { tagQuery: '/^(alpha|beta)_request$/' });

    // Then
    expect(rows).toEqual(['alpha_request', 'beta_request']);
    expect(compileQuery('/^(alpha|beta)_request$/').invalid).toBe(false);
  });

  it('As a dotli developer, I exclude what I also include and the exclude wins', () => {
    // Given
    const store = filterTraffic();

    // When
    const rows = shown(store, { tagQuery: '/^(alpha|beta)_request$/', excludeQuery: 'beta' });

    // Then
    expect(rows).toEqual(['alpha_request']);
  });

  it('As a dotli developer, I include a regex that does not parse and it is flagged and inert', () => {
    // Given
    const store = filterTraffic();

    // When
    const rows = shown(store, { tagQuery: '/(/', excludeQuery: 'beta' });

    // Then
    expect(compileQuery('/(/').invalid).toBe(true);
    expect(rows).toEqual(['alpha_request', 'alpha_response', 'gamma_request', 'boot.started']);
  });

  it('As a dotli developer, I exclude a regex that does not parse and it is flagged and inert', () => {
    // Given
    const store = filterTraffic();

    // When
    const rows = shown(store, { excludeQuery: '/[/' });

    // Then
    expect(compileQuery('/[/').invalid).toBe(true);
    expect(rows).toEqual(['alpha_request', 'alpha_response', 'beta_request', 'gamma_request', 'boot.started']);
  });
});
