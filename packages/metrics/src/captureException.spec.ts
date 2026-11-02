// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { bindCaptureSink, captureException, recordExpected } from './captureException.js';

function createRecordingSink() {
  return { exception: vi.fn(), expected: vi.fn() };
}

describe('capture sink', () => {
  it('As a dotli developer, I bind a sink and it receives every capture with its context', () => {
    // Given
    const sink = createRecordingSink();
    const unbind = bindCaptureSink(sink);
    const failure = new Error('boom');
    const expected = new Error('offline');

    // When
    captureException(failure, { flow: 'wallet', step: 'login', tags: { reason: 'boot' } });
    recordExpected(expected, { flow: 'storage', step: 'db_open' });
    unbind();

    // Then
    expect(sink.exception).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'login', tags: { reason: 'boot' } });
    expect(sink.expected).toHaveBeenCalledWith(expected, { flow: 'storage', step: 'db_open' });
  });

  it('As a dotli developer, I unbind my sink and captures go back to the sink bound before it', () => {
    // Given
    const outer = createRecordingSink();
    const inner = createRecordingSink();
    const unbindOuter = bindCaptureSink(outer);
    const unbindInner = bindCaptureSink(inner);

    // When
    unbindInner();
    captureException(new Error('after unbind'), { flow: 'ui', step: 'render' });
    unbindOuter();

    // Then
    expect(inner.exception).not.toHaveBeenCalled();
    expect(outer.exception).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I hit a failure before error reporting starts and the page carries on while the capture is dropped', () => {
    // Given no sink is bound

    // When the page reports a failure and an expected one
    const completed: string[] = [];
    captureException(new Error('early'), { flow: 'boot', step: 'early' });
    completed.push('exception');
    recordExpected('not an error', { flow: 'boot', step: 'early' });
    completed.push('expected');

    // Then both reports returned and the code after each ran
    expect(completed).toEqual(['exception', 'expected']);
  });

  it('As a dotli user, I hit a failure while the capture sink throws and the page still recovers', () => {
    // Given a sink that throws on every capture
    const tried: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: () => {
          tried.push('exception');
          throw new Error('sink down');
        },
        expected: () => {
          tried.push('expected');
          throw new Error('sink down');
        },
      }),
    );

    // When the page reports a failure and an expected one
    captureException(new Error('boom'), { flow: 'ui', step: 'render' });
    recordExpected(new Error('offline'), { flow: 'storage', step: 'db_open' });

    // Then neither report threw, so the code after each ran and reached the sink
    expect(tried).toEqual(['exception', 'expected']);
  });
});
