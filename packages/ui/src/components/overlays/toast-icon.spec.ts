// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { AlertTriangleIcon, BanIcon, BellIcon, CheckIcon } from '../../icons.js';
import { toastIcon } from './toast-icon.js';

describe('toast icon', () => {
  it('As a dotli user, a toast without its own icon shows the icon of its tone', () => {
    // When
    const icons = (['info', 'ok', 'warn', 'err', 'idle'] as const).map(tone => toastIcon({ tone }));

    // Then
    expect(icons).toEqual([BellIcon, CheckIcon, AlertTriangleIcon, AlertTriangleIcon, BanIcon]);
  });

  it('As a dotli user, a toast with its own icon keeps it whatever its tone', () => {
    // Given
    const own = BanIcon;

    // When
    const icon = toastIcon({ tone: 'err', icon: own });

    // Then
    expect(icon).toBe(own);
  });
});
