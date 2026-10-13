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
});
