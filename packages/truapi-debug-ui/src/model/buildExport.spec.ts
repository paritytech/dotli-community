// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildTruapiEvent } from '../testing/buildTruapiEvent.js';
import { createEventStore } from './createEventStore.js';
import { buildExport, type ExportMeta } from './buildExport.js';
import { createInitialFilterState } from './filterState.js';

type ReadExport = { meta: unknown; events?: { payload: unknown }[]; error?: string };

const META: ExportMeta = {
  exportedAt: '2026-09-25T10:34:56.789Z',
  url: 'https://dot.li/app.dot',
  userAgent: 'test-agent',
  capacity: 2000,
  droppedCount: 0,
  totalEvents: 1,
  exportedEvents: 1,
  filters: createInitialFilterState(),
};

/** The export of one request whose payload is `value`, read back. */
function exportPayload(value: unknown): ReadExport {
  const store = createEventStore({ capacity: 2000 });
  store.insertTruapi(buildTruapiEvent({ tag: 'host_sign_request', requestId: 'req-1', value }));
  // The export is JSON this test reads back, whose shape it states here.
  return JSON.parse(buildExport(store.list(), META)) as ReadExport;
}

describe('debug export', () => {
  it('As a dotli developer, I export a bigint in a payload and it reads as its digits and an n', () => {
    // When
    const out = exportPayload({ amount: 12_345_678_901_234_567_890n });

    // Then
    expect(out.events?.[0]?.payload).toEqual({ amount: '12345678901234567890n' });
  });

  it('As a dotli developer, I export bytes in a payload and they read whole, as their length and hex', () => {
    // When
    const out = exportPayload({ data: new Uint8Array([1, 2, 255]) });

    // Then
    expect(out.events?.[0]?.payload).toEqual({ data: { __type: 'Uint8Array', length: 3, hex: '0x0102ff' } });
  });

  it('As a dotli developer, I export a payload that refers back to itself and the loop is marked', () => {
    // Given
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;

    // When
    const out = exportPayload(loop);

    // Then
    expect(out.events?.[0]?.payload).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('As a dotli developer, I export events that cannot be serialized and the reason is exported beside the meta', () => {
    // Given
    const unserializable = {
      toJSON() {
        throw new Error('no JSON for this');
      },
    };

    // When
    const out = exportPayload(unserializable);

    // Then
    expect(out).toEqual({ meta: META, error: 'serialization failed: no JSON for this' });
  });
});
