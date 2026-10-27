// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createCacheReporter } from './createCacheReporter.js';
import { createMemoryIdb } from './testing/index.js';

const captures = { exception: vi.fn(), expected: vi.fn() };

beforeEach(() => {
  captures.exception.mockClear();
  captures.expected.mockClear();
  return bindCaptureSink(captures);
});

describe('cache failure reporter', () => {
  it('As an operator, I get the first fault of an action from each cache reporter, whatever another has reported', () => {
    // Given two reporters for the same cache, and a fault the first has already reported
    const failure = new Error('disk gone');
    const first = createCacheReporter({ cache: 'cid_cache', tag: '[test]' });
    const second = createCacheReporter({ cache: 'cid_cache', tag: '[test]' });
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

  it('As an operator, I see a connection closing under an unloading page as a breadcrumb, not an issue', async () => {
    // Given the failure a closed connection gives
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const idb = createMemoryIdb();
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
    const report = createCacheReporter({ cache: 'cid_cache', tag: '[test]' });

    // When
    report('write', failure);

    // Then the failure is recorded as expected
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'cid_cache_write' });
    expect(sentry.counted(S.CACHE_STORAGE)).toEqual([
      { outcome: 'error', reason: 'InvalidStateError', surface: 'cid_cache', step: 'write' },
    ]);
  });

  it('As an operator, I count every cache storage failure with its reason, though only the first is captured', () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const report = createCacheReporter({ cache: 'block_cache', tag: '[test]' });
    const failure = new Error('disk gone');

    // When
    report('write', failure);
    report('write', failure);

    // Then
    expect(sentry.counted(S.CACHE_STORAGE)).toEqual([
      { outcome: 'error', reason: 'Error', surface: 'block_cache', step: 'write' },
      { outcome: 'error', reason: 'Error', surface: 'block_cache', step: 'write' },
    ]);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I count a write refused for a full quota and see a breadcrumb, not an issue', () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const report = createCacheReporter({ cache: 'block_cache', tag: '[test]' });
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

    // When
    report('write', quota);

    // Then
    expect(sentry.counted(S.CACHE_STORAGE)).toEqual([
      { outcome: 'error', reason: 'QuotaExceededError', surface: 'block_cache', step: 'write' },
    ]);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledWith(quota, { flow: 'storage', step: 'block_cache_write' });
  });
});
