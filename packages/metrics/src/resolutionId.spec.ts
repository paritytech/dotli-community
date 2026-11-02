// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, onTestFinished } from 'vitest';
import { m } from './metrics.js';
import { getResolutionId, setResolutionId } from './resolutionId.js';
import { bindRecordingSentry } from './testing/index.js';

describe('resolution id', () => {
  it('As the protocol client, I read back the id the host minted, and every later metric carries it', () => {
    // Given a realm that boots before the host mints an id
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });

    // When it reads the id, the host mints one and a metric is counted
    const before = getResolutionId();
    setResolutionId('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');
    m.count('test.after_id');
    const after = getResolutionId();

    // Then it read none rather than a fabricated one, the host can thread the id onto the iframe URLs it builds, and
    // the metric and the Sentry scope carry it
    expect(before).toBeNull();
    expect(after).toBe('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');
    expect(metrics.counted('test.after_id')).toEqual([{ resolution_id: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff' }]);
    expect(metrics.tags).toContainEqual({
      key: 'dotli.resolution_id',
      value: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff',
    });
  });
});
