// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

// `tsc` only sees the real modules, so an export missing from a twin fails only a metrics-stripped build.

const PAIRS: readonly [string, () => Promise<object>, () => Promise<object>][] = [
  ['sentry', () => import('../src/sentry.js'), () => import('../src/sentry.noop.js')],
  ['metrics', () => import('../src/metrics.js'), () => import('../src/metrics.noop.js')],
];

describe('no-op module parity', () => {
  it.each(PAIRS)(
    'As a dotli developer, the %s no-op exports everything the real module does',
    async (_name, loadReal, loadNoop) => {
      // Given
      const [real, noop] = await Promise.all([loadReal(), loadNoop()]);

      // When
      const missing = Object.keys(real).filter(key => !(key in noop));

      // Then
      // A name here means a metrics-stripped build fails to bundle.
      expect(missing).toEqual([]);
    },
  );
});
