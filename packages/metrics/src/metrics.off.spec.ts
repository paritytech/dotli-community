// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs in its own project with VITE_METRICS off, as a build without metrics compiles the module.

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { getResolutionId, m, setResolutionId } from './metrics.js';
import { bindRecordingSentry } from './testing.js';

describe('metrics in a build without metrics', () => {
  it('As a visitor on a build without metrics, a span still runs my function and returns its value', () => {
    // Given
    const fn = vi.fn(() => 42);

    // When
    const result = m.span('test.span', fn);

    // Then
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('As a visitor on a build without metrics, an async span still resolves with my value', async () => {
    // Given
    const fn = vi.fn(() => Promise.resolve('ok'));

    // When
    const result = await m.span('test.async', fn);

    // Then
    expect(result).toBe('ok');
  });

  it('As a visitor on a build without metrics, a timer stops at zero', () => {
    // When
    const stop = m.timer('test.timer');

    // Then
    expect(stop()).toBe(0);
  });

  it('As a visitor on a build without metrics, a count reaches no Sentry even when one is bound', () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });

    // When
    m.count('test.count');

    // Then
    expect(m.enabled).toBe(false);
    expect(sentry.counts).toEqual([]);
  });

  it('As the sandbox on a build without metrics, I read back the resolution id the host passed, so the frames line up', () => {
    // When
    setResolutionId('resolution-1');

    // Then
    expect(getResolutionId()).toBe('resolution-1');
  });
});
