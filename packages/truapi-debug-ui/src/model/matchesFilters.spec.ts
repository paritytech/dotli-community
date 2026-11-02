// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createEventStore, type EventStore } from './createEventStore.js';
import { compileQuery } from './compileQuery.js';
import { createInitialFilterState, type FilterState } from './filterState.js';
import { matchesFilters } from './matchesFilters.js';
import { buildSystemEvent } from '../testing/buildSystemEvent.js';
import { buildTruapiEvent } from '../testing/buildTruapiEvent.js';
import { BOOT_STARTED } from '../testing/constants.js';
import { getEventLabel } from './getEventLabel.js';

/** Two products, an event without a product and a host boot event. */
function createFilterTraffic(): EventStore {
  const store = createEventStore({ capacity: 10 });
  store.insertTruapi(buildTruapiEvent({ tag: 'alpha_request', requestId: 'a1', productId: 'b.dot' }));
  store.insertTruapi(
    buildTruapiEvent({ tag: 'alpha_response', requestId: 'a1', productId: 'b.dot', direction: 'incoming' }),
  );
  store.insertTruapi(
    buildTruapiEvent({ tag: 'beta_request', requestId: 'b1', productId: 'a.dot', direction: 'incoming' }),
  );
  store.insertTruapi(buildTruapiEvent({ tag: 'gamma_request', requestId: 'c1', productId: null }));
  store.insertDotli(buildSystemEvent(BOOT_STARTED));
  return store;
}

/** The labels of the events the filters leave. */
function listShown(store: EventStore, query: Partial<FilterState>): string[] {
  const filters = { ...createInitialFilterState(), ...query };
  return store
    .list()
    .filter(event => matchesFilters(event, filters))
    .map(event => getEventLabel(event));
}

describe('debug panel text filters', () => {
  it('As a dotli developer, I include a substring in any case and the tags that hold it show', () => {
    // Given
    const store = createFilterTraffic();

    // When
    const rows = listShown(store, { tagQuery: 'ALPHA' });

    // Then
    expect(rows).toEqual(['alpha_request', 'alpha_response']);
  });

  it('As a dotli developer, I include layer:event and that system event shows', () => {
    // Given
    const store = createFilterTraffic();

    // When
    const rows = listShown(store, { tagQuery: 'boot:start' });

    // Then
    expect(rows).toEqual(['boot.started']);
  });

  it('As a dotli developer, I include a regex and the tags it matches show', () => {
    // Given
    const store = createFilterTraffic();

    // When
    const rows = listShown(store, { tagQuery: '/^(alpha|beta)_request$/' });
    const compiled = compileQuery('/^(alpha|beta)_request$/');

    // Then
    expect(rows).toEqual(['alpha_request', 'beta_request']);
    expect(compiled.invalid).toBe(false);
  });

  it('As a dotli developer, I exclude what I also include and the exclude wins', () => {
    // Given
    const store = createFilterTraffic();

    // When
    const rows = listShown(store, { tagQuery: '/^(alpha|beta)_request$/', excludeQuery: 'beta' });

    // Then
    expect(rows).toEqual(['alpha_request']);
  });

  it('As a dotli developer, I include a regex that does not parse and it is flagged and inert', () => {
    // Given
    const store = createFilterTraffic();

    // When
    const rows = listShown(store, { tagQuery: '/(/', excludeQuery: 'beta' });
    const compiled = compileQuery('/(/');

    // Then
    expect(compiled.invalid).toBe(true);
    expect(rows).toEqual(['alpha_request', 'alpha_response', 'gamma_request', 'boot.started']);
  });

  it('As a dotli developer, I exclude a regex that does not parse and it is flagged and inert', () => {
    // Given
    const store = createFilterTraffic();

    // When
    const rows = listShown(store, { excludeQuery: '/[/' });
    const compiled = compileQuery('/[/');

    // Then
    expect(compiled.invalid).toBe(true);
    expect(rows).toEqual(['alpha_request', 'alpha_response', 'beta_request', 'gamma_request', 'boot.started']);
  });
});
