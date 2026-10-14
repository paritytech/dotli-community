// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindLogSink } from '@dotli/shared';

import { bindCaptureSink, captureException, recordExpected, reportExpected, reportListener } from './capture.js';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';

function recordingSink() {
  return { exception: vi.fn(), expected: vi.fn() };
}

describe('capture sink', () => {
  it('As a dotli developer, I bind a sink and it receives every capture with its context', () => {
    // Given
    const sink = recordingSink();
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
    const outer = recordingSink();
    const inner = recordingSink();
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

  it('As a dotli user, a failure captured before error reporting starts is dropped without breaking the page', () => {
    // Given no sink is bound

    // When
    const capture = (): void => {
      captureException(new Error('early'), { flow: 'boot', step: 'early' });
      recordExpected('not an error', { flow: 'boot', step: 'early' });
    };

    // Then
    expect(capture).not.toThrow();
  });

  it('As a dotli user, a failure reported through a sink that throws still lets the page recover', () => {
    // Given a sink that throws on every capture
    const tried: string[] = [];
    const unbind = bindCaptureSink({
      exception: () => {
        tried.push('exception');
        throw new Error('sink down');
      },
      expected: () => {
        tried.push('expected');
        throw new Error('sink down');
      },
    });

    // When the page reports a failure and an expected one
    const report = (): void => {
      captureException(new Error('boom'), { flow: 'ui', step: 'render' });
      recordExpected(new Error('offline'), { flow: 'storage', step: 'db_open' });
    };

    // Then neither report throws, so the code after each runs
    expect(report).not.toThrow();
    unbind();
    expect(tried).toEqual(['exception', 'expected']);
  });
});

describe('reportExpected', () => {
  /** Records what an expected failure leaves behind: its breadcrumb, its counts and its warnings. */
  function recordReports() {
    const sink = recordingSink();
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const warnings: unknown[][] = [];
    onTestFinished(bindCaptureSink(sink));
    onTestFinished(
      bindLogSink({
        emit: (level, _message, _attrs, args) => {
          if (level === 'warn') {
            warnings.push(args ?? []);
          }
        },
      }),
    );
    return { sink, counted: metrics.counted, warnings };
  }

  it('As an operator, an environment failure leaves a warning, a breadcrumb and one error count naming its reason', () => {
    // Given
    const reports = recordReports();
    const failure = new Error('storage refused');

    // When
    reportExpected(failure, {
      flow: 'storage',
      step: 'ui_cache',
      metric: 'shared_session.ui_cache',
      reason: 'read',
      message: '[test] cache read failed:',
    });

    // Then
    expect(reports.warnings).toEqual([['[test] cache read failed:', failure]]);
    expect(reports.sink.expected).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'ui_cache' });
    expect(reports.counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it('As an operator, a slow network reported as a timeout is counted with that outcome and logs nothing without a message', () => {
    // Given
    const reports = recordReports();
    const timeout = new Error('timed out');

    // When
    reportExpected(timeout, {
      flow: 'ui',
      step: 'diagnostics_block',
      metric: 'diagnostics.finalized_block',
      outcome: 'timeout',
      reason: 'timeout',
    });

    // Then
    expect(reports.warnings).toEqual([]);
    expect(reports.sink.expected).toHaveBeenCalledWith(timeout, { flow: 'ui', step: 'diagnostics_block' });
    expect(reports.counted('diagnostics.finalized_block')).toEqual([{ outcome: 'timeout', reason: 'timeout' }]);
  });
});

describe('reportListener', () => {
  it('As an owner of listeners, a throwing listener is captured, logged and counted once under my name', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const report = reportListener('protocol', 'chain_pool.status');
    const errorLines: unknown[][] = [];
    onTestFinished(
      bindLogSink({
        emit: (level, _message, _attrs, args) => {
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
