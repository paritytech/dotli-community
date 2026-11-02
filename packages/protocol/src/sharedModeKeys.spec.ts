// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isSharedModeRequestMethod } from './sharedModeKeys.js';

describe('shared mode keys', () => {
  it('As the protocol frame, I route the shared mode methods to the mode store and nothing else', () => {
    // Given
    const mode = ['modeRead', 'modeWrite', 'modeClear'] as const;

    // When
    const routed = mode.map(method => isSharedModeRequestMethod(method));

    // Then
    expect(routed).toEqual([true, true, true]);
    expect(isSharedModeRequestMethod('authRead')).toBe(false);
    expect(isSharedModeRequestMethod('authChanges')).toBe(false);
  });
});
