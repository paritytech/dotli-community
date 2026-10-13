// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from './dotli-debug-types.js';
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
  it('As a dotli developer, include and exclude text filters match the tag or layer:event', () => {
    // Given
    const store = filterTraffic();

    // When a case-insensitive substring is included
    // Then
    expect(shown(store, { tagQuery: 'ALPHA' })).toEqual(['alpha_request', 'alpha_response']);

    // When a system event is named by layer:event
    // Then
    expect(shown(store, { tagQuery: 'boot:start' })).toEqual(['boot.started']);

    // When the include is a regex
    // Then
    expect(shown(store, { tagQuery: '/^(alpha|beta)_request$/' })).toEqual(['alpha_request', 'beta_request']);
    expect(compileQuery('/^(alpha|beta)_request$/').invalid).toBe(false);

    // When the exclude matches too, it wins
    // Then
    expect(shown(store, { tagQuery: '/^(alpha|beta)_request$/', excludeQuery: 'beta' })).toEqual(['alpha_request']);

    // When an include regex does not parse, it is flagged and inert
    // Then
    expect(compileQuery('/(/').invalid).toBe(true);
    expect(shown(store, { tagQuery: '/(/', excludeQuery: 'beta' })).toEqual([
      'alpha_request',
      'alpha_response',
      'gamma_request',
      'boot.started',
    ]);

    // When an exclude regex does not parse, it is flagged and inert
    // Then
    expect(compileQuery('/[/').invalid).toBe(true);
    expect(shown(store, { excludeQuery: '/[/' })).toHaveLength(5);
  });
});
