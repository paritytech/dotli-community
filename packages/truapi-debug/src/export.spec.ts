// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DotliDebugEvent } from './dotli-debug-types.js';
import { EventStore } from './event-store.js';
import { buildExport, exportFilename, type ExportMeta } from './export.js';
import { initialFilterState, matches } from './filters.js';

/** A handshake request and its response, then a host boot event. */
function mixedTraffic(): EventStore {
  const store = new EventStore({ capacity: 2000 });
  store.insertTruapi({
    kind: 'truapi',
    direction: 'outgoing',
    productId: 'app.dot',
    requestId: 'req-aaa-111',
    payload: { tag: 'system_handshake_request', value: { version: 1 } },
  });
  store.insertTruapi({
    kind: 'truapi',
    direction: 'incoming',
    productId: 'app.dot',
    requestId: 'req-aaa-111',
    payload: { tag: 'system_handshake_response', value: { ok: true } },
  });
  store.insertDotli({
    layer: 'boot',
    event: 'started',
    flowId: 'flow-boot-1',
    timestamp: 0,
    payload: { chainBackend: 'smoldot', mode: 'direct', contentBackend: 'helia' },
  } as unknown as DotliDebugEvent);
  return store;
}

describe('debug export', () => {
  it('As a dotli developer, Export writes the filtered events as JSON with what was left out', () => {
    // Given
    const store = mixedTraffic();
    const filters = { ...initialFilterState(), excludeQuery: 'response' };
    const all = store.list();
    const events = all.filter(event => matches(event, filters));
    const meta: ExportMeta = {
      exportedAt: '2026-09-25T10:34:56.789Z',
      url: 'https://dot.li/app.dot',
      userAgent: 'test-agent',
      capacity: store.capacity,
      droppedCount: store.dropped(),
      totalEvents: all.length,
      exportedEvents: events.length,
      filters,
    };

    // When
    const exported = JSON.parse(buildExport(events, meta)) as {
      meta: Record<string, unknown>;
      events: { tag?: string; event?: string }[];
    };

    // Then
    expect(exported.meta).toMatchObject({
      capacity: 2000,
      droppedCount: 0,
      totalEvents: 3,
      exportedEvents: 2,
      url: 'https://dot.li/app.dot',
      userAgent: 'test-agent',
      filters: { excludeQuery: 'response', direction: 'both' },
    });
    expect(exported.events.map(event => event.tag ?? event.event)).toEqual(['system_handshake_request', 'started']);
  });

  it('As a dotli developer, the export file is named after the moment it was taken', () => {
    // When
    const filename = exportFilename(new Date(Date.UTC(2026, 8, 25, 10, 34, 56, 789)));

    // Then
    expect(filename).toBe('dotli-debug-2026-09-25T10-34-56.json');
  });
});
