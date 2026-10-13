// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { m } from './metrics.js';

function fakeSentry() {
  const count = vi.fn();
  const sentry = {
    startSpan: vi.fn(),
    startInactiveSpan: vi.fn(),
    setMeasurement: vi.fn(),
    metrics: { count, distribution: vi.fn(), gauge: vi.fn() },
    setTag: vi.fn(),
    addBreadcrumb: vi.fn(),
  };
  return { sentry, count };
}

describe('metrics binding', () => {
  it('As a dotli developer, I bind a fake Sentry, restore the one before, and counts go back to it', () => {
    // Given two fakes bound in turn
    const outer = fakeSentry();
    const inner = fakeSentry();
    const restoreOuter = m.bind(outer.sentry);
    const restoreInner = m.bind(inner.sentry);

    // When the inner binding is restored and a count fires
    restoreInner();
    m.count('test.after_restore');
    restoreOuter();

    // Then only the outer fake counted
    expect(inner.count).not.toHaveBeenCalled();
    expect(outer.count).toHaveBeenCalledWith('dotli.test.after_restore', 1, { attributes: undefined });
  });
});

describe('metrics (stripped build)', () => {
  // A build with metrics off ships the no-op twin in place of the real module.
  it('As a visitor on a build without metrics, a span still runs my function', async () => {
    // Given
    const { m: noop } = await import('./metrics.noop.js');
    const fn = vi.fn(() => 42);

    // When
    const result = noop.span('test.span', fn);

    // Then
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('As a visitor on a build without metrics, an async span still resolves with my value', async () => {
    // Given
    const { m: noop } = await import('./metrics.noop.js');
    const fn = vi.fn(() => Promise.resolve('ok'));

    // When
    const result = await noop.span('test.async', fn);

    // Then
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('As a visitor on a build without metrics, a timer stops at zero', async () => {
    // Given
    const { m: noop } = await import('./metrics.noop.js');

    // When
    const stop = noop.timer('test.timer');

    // Then
    expect(stop()).toBe(0);
  });

  it('As a dotli developer on a build without metrics, I bind a fake Sentry and get a restore like the real module gives', async () => {
    // Given
    const { m: noop } = await import('./metrics.noop.js');
    const fake = fakeSentry();

    // When
    const restore = noop.bind(fake.sentry);
    restore();

    // Then
    expect(noop.enabled).toBe(false);
    expect(typeof restore).toBe('function');
    expect(fake.sentry.startSpan).not.toHaveBeenCalled();
  });
});

describe('resolution id', () => {
  // Before any test sets an id, so the module is as a realm boots it.
  it('As a maintainer, a realm that boots before the host mints an id reports none rather than a fabricated one', async () => {
    // Given a fresh module, as a realm gets on boot.
    const { getResolutionId } = await import('./metrics.js');

    // Then
    expect(getResolutionId()).toBeNull();
  });

  it('As the protocol client, I read back the id the host minted', async () => {
    // Given
    const { setResolutionId, getResolutionId } = await import('./metrics.js');

    // When
    setResolutionId('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');

    // Then the host can thread it onto the iframe URLs it builds.
    expect(getResolutionId()).toBe('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');
  });

  it('As a maintainer, a metrics-stripped build still carries the id so the URLs line up', async () => {
    // Given the no-op twin that replaces the real module when VITE_METRICS
    // is unset. It drops the Sentry tagging but must not drop propagation,
    // or the sandbox and protocol URLs would differ between builds.
    const noop = await import('./metrics.noop.js');

    // When
    noop.setResolutionId('boot-1234-abcdef');

    // Then
    expect(noop.getResolutionId()).toBe('boot-1234-abcdef');
  });
});
