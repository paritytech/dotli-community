// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createCacheReporter } from './cache-reporter.js';
import { memoryIdb } from './testing/index.js';

const captures = { exception: vi.fn(), expected: vi.fn() };

beforeEach(() => {
  captures.exception.mockClear();
  captures.expected.mockClear();
  return bindCaptureSink(captures);
});

describe('cache failure reporter', () => {
  it('As an operator, each cache reporter reports its own first fault of an action, whatever another has reported', () => {
    // Given two reporters for the same cache, and a fault the first has already reported
    const failure = new Error('disk gone');
    const first = createCacheReporter('cid_cache', '[test]');
    const second = createCacheReporter('cid_cache', '[test]');
    first('read', failure);

    // When both meet the same fault again
    first('read', failure);
    second('read', failure);

    // Then each reported it once
    expect(captures.exception).toHaveBeenCalledTimes(2);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'storage',
      step: 'cid_cache_read',
      tags: { kind: 'cid_cache_read_error' },
    });
  });

  it('As an operator, a connection closing under an unloading page leaves a breadcrumb, not an issue', async () => {
    // Given the failure a closed connection gives
    const idb = memoryIdb();
    const db = await idb.connect();
    db.close();
    const failure: unknown = (() => {
      try {
        db.transaction('cids');
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    const report = createCacheReporter('cid_cache', '[test]');

    // When
    report('write', failure);

    // Then the failure is recorded as expected
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'cid_cache_write' });
  });
});
