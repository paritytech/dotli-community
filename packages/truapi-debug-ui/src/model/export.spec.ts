// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { EventStore } from './event-store.js';
import { buildExport, exportFilename, type ExportMeta } from './export.js';
import { initialFilterState } from './filters.js';

const META: ExportMeta = {
  exportedAt: '2026-09-25T10:34:56.789Z',
  url: 'https://dot.li/app.dot',
  userAgent: 'test-agent',
  capacity: 2000,
  droppedCount: 0,
  totalEvents: 1,
  exportedEvents: 1,
  filters: initialFilterState(),
};

/** The export of one request whose payload is `value`, read back. */
function exported(value: unknown): { meta: unknown; events?: { payload: unknown }[]; error?: string } {
  const store = new EventStore({ capacity: 2000 });
  store.insertTruapi({
    kind: 'truapi',
    direction: 'outgoing',
    productId: 'app.dot',
    requestId: 'req-1',
    payload: { tag: 'host_sign_request', value },
  });
  return JSON.parse(buildExport(store.list(), META)) as ReturnType<typeof exported>;
}

describe('debug export', () => {
  it('As a dotli developer, a bigint in a payload is exported as its digits and an n', () => {
    // When
    const out = exported({ amount: 12_345_678_901_234_567_890n });

    // Then
    expect(out.events?.[0]?.payload).toEqual({ amount: '12345678901234567890n' });
  });

  it('As a dotli developer, bytes in a payload are exported whole, as their length and hex', () => {
    // When
    const out = exported({ data: new Uint8Array([1, 2, 255]) });

    // Then
    expect(out.events?.[0]?.payload).toEqual({ data: { __type: 'Uint8Array', length: 3, hex: '0x0102ff' } });
  });

  it('As a dotli developer, a payload that refers back to itself is exported with the loop marked', () => {
    // Given
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;

    // When
    const out = exported(loop);

    // Then
    expect(out.events?.[0]?.payload).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('As a dotli developer, events that cannot be serialized are exported as the reason, beside the meta', () => {
    // Given
    const unserializable = {
      toJSON: () => {
        throw new Error('no JSON for this');
      },
    };

    // When
    const out = exported(unserializable);

    // Then
    expect(out).toEqual({ meta: META, error: 'serialization failed: no JSON for this' });
  });

  it('As a dotli developer, the export file is named after the moment it was taken', () => {
    // When
    const filename = exportFilename(new Date(Date.UTC(2026, 8, 25, 10, 34, 56, 789)));

    // Then
    expect(filename).toBe('dotli-debug-2026-09-25T10-34-56.json');
  });
});
