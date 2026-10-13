// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { reportChunkFailure, uiReporter } from './ui-reporter.js';

/** A capture sink bound for this test. */
function record(): { exception: ReturnType<typeof vi.fn>; expected: ReturnType<typeof vi.fn> } {
  const sink = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(sink));
  return sink;
}

describe('uiReporter', () => {
  it('As the sandbox, an expected miss ui reports is left as a breadcrumb, not an issue', () => {
    // Given
    const sink = record();
    const offline = new TypeError('Failed to fetch dynamically imported module');

    // When
    uiReporter.expected(offline, { flow: 'ui', step: 'idle_preload', reason: 'idle_preload' });

    // Then
    expect(sink.expected).toHaveBeenCalledWith(offline, { flow: 'ui', step: 'idle_preload' });
    expect(sink.exception).not.toHaveBeenCalled();
  });

  it('As the sandbox, a failure ui recovered from is raised as an issue with its context', () => {
    // Given
    const sink = record();
    const failure = new Error('render failed');
    const context = { flow: 'ui', step: 'root_render', tags: { root: 'overlays' } } as const;

    // When
    uiReporter.failure(failure, context);

    // Then
    expect(sink.exception).toHaveBeenCalledTimes(1);
    expect(sink.exception).toHaveBeenCalledWith(failure, context);
    expect(sink.expected).not.toHaveBeenCalled();
  });

  it('As a sandbox user after a deploy, a chunk that fails to load is left as a breadcrumb, not an issue', () => {
    // Given
    const sink = record();
    const failure = new TypeError('Failed to fetch dynamically imported module');

    // When
    reportChunkFailure(failure);

    // Then
    expect(sink.expected).toHaveBeenCalledWith(failure, { flow: 'boot', step: 'chunk_preload' });
    expect(sink.exception).not.toHaveBeenCalled();
  });
});
