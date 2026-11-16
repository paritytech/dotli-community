// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createBootTracker } from './createBootTracker.js';

describe('createBootTracker', () => {
  it('As a maintainer reading a boot failure that came before any step, I read its step and see it failed at start', () => {
    // Given
    const tracker = createBootTracker();

    // When
    const step = tracker.getStep();

    // Then
    expect(step).toBe('start');
  });

  it('As a maintainer reading a boot failure, I read its step and see the one the boot entered last', () => {
    // Given
    const tracker = createBootTracker();
    tracker.setStep('url_settings');

    // When
    tracker.setStep('bridge_load');

    // Then
    expect(tracker.getStep()).toBe('bridge_load');
  });
});
