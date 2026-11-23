// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Middleware } from '@floating-ui/dom';
import { describe, expect, it } from 'vitest';
import type { TriggerPlacement } from './FloatingLayer.js';
import { getPositionConfig } from './placeAtTrigger.js';

describe('getPositionConfig', () => {
  it.each<[TriggerPlacement, string, string]>([
    ['trigger-start', 'bottom-start', 'top-start'],
    ['trigger-end', 'bottom-end', 'top-end'],
  ])('As a surface placed at %s, I open at %s and fall back to %s only', (placement, preferred, fallback) => {
    // Given the trigger's placement name
    const params = { gap: 10, apply: undefined };

    // When its Floating UI options are built
    const config = getPositionConfig(placement, params);
    const flip = config.middleware?.find(
      (middleware): middleware is Middleware => typeof middleware === 'object' && middleware?.name === 'flip',
    );

    // Then it prefers the side below and falls back to the side above, on the same edge
    expect(config.placement).toBe(preferred);
    expect(flip?.options).toMatchObject({ fallbackPlacements: [fallback], fallbackStrategy: 'bestFit' });
  });
});
