// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindLogSink } from '@dotli/shared';

import { reportListener } from './reportListener.js';
import { bindRecordingSentry, recordCaptures } from './testing/index.js';

describe('reportListener', () => {
  it('As an owner of listeners, I report a throwing listener and it is captured, logged and counted once under my name', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const report = reportListener('protocol', 'chain_pool.status');
    const errorLines: unknown[][] = [];
    onTestFinished(
      bindLogSink({
        emit: ({ level, args }) => {
          if (level === 'error') {
            errorLines.push(args ?? []);
          }
        },
      }),
    );
    const broken = new TypeError('listener broke');

    // When
    report(broken);

    // Then
    expect(errorLines).toEqual([['[dot.li] A chain_pool.status listener threw', broken]]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'chain_pool.status' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'chain_pool.status' },
    ]);
  });
});
