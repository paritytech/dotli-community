// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { preloadWhenIdle, type IdleScheduler } from '@dotli/ui-core';
import { reportChunkFailure, uiReporter } from './ui-reporter.js';

/** Captures and counts recorded for this test, with the expected breadcrumb as a signal. */
function record(): {
  exception: ReturnType<typeof vi.fn>;
  expected: Promise<{ error: unknown; ctx: Pick<CaptureContext, 'flow' | 'step'> }>;
  counted: ReturnType<typeof bindRecordingSentry>['counted'];
} {
  const exception = vi.fn();
  let breadcrumb: (seen: { error: unknown; ctx: Pick<CaptureContext, 'flow' | 'step'> }) => void = () => undefined;
  const expected = new Promise<{ error: unknown; ctx: Pick<CaptureContext, 'flow' | 'step'> }>(resolve => {
    breadcrumb = resolve;
  });
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  onTestFinished(
    bindCaptureSink({
      exception,
      expected: (error, ctx) => {
        breadcrumb({ error, ctx });
      },
    }),
  );
  return { exception, expected, counted: metrics.counted };
}

describe('uiReporter', () => {
  it('As the host offline, a chunk that fails to preload is counted under lazy_chunk.load and left as a breadcrumb, not an issue', async () => {
    // Given a browser that cannot fetch the chunk, and a fake Sentry that records
    const { exception, expected, counted } = record();
    const offline = new TypeError('Failed to fetch dynamically imported module');
    let idle: (() => void) | undefined;
    const scheduler: IdleScheduler = {
      requestIdleCallback: run => {
        idle = run;
        return 1;
      },
      cancelIdleCallback: () => undefined,
    };
    preloadWhenIdle({ preload: () => Promise.reject(offline) }, uiReporter, scheduler);

    // When
    idle?.();

    // Then
    await expect(expected).resolves.toEqual({ error: offline, ctx: { flow: 'ui', step: 'idle_preload' } });
    expect(counted('lazy_chunk.load')).toEqual([{ outcome: 'error', reason: 'idle_preload' }]);
    expect(exception).not.toHaveBeenCalled();
  });

  it('As the host, a failure ui recovered from is raised as an issue with its context', () => {
    // Given
    const { exception } = record();
    const failure = new Error('render failed');
    const context = { flow: 'ui', step: 'root_render', tags: { root: 'page' } } as const;

    // When
    uiReporter.failure(failure, context);

    // Then
    expect(exception).toHaveBeenCalledTimes(1);
    expect(exception).toHaveBeenCalledWith(failure, context);
  });

  it('As a visitor after a deploy, a chunk that fails to load is counted under chunk.preload and left as a breadcrumb, not an issue', async () => {
    // Given
    const { exception, expected, counted } = record();
    const failure = new TypeError('Failed to fetch dynamically imported module');

    // When
    reportChunkFailure(failure);

    // Then
    await expect(expected).resolves.toEqual({ error: failure, ctx: { flow: 'boot', step: 'chunk_preload' } });
    expect(counted('chunk.preload')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
    expect(exception).not.toHaveBeenCalled();
  });
});
