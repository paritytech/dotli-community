// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { AlertTriangleIcon, BanIcon, CircleCheckIcon, CircleXIcon } from '../../icons.js';
import { toastIcon } from './toastIcon.js';

describe('toast icon', () => {
  it('As a dotli user, I get a notice with its own icon and it keeps that icon', () => {
    // Given
    const own = BanIcon;

    // When
    const icon = toastIcon({ tone: 'info', icon: own });

    // Then
    expect(icon).toBe(own);
  });

  it('As a dotli user, I get an error or a warning with its own icon and it shows its alarm icon', () => {
    // Given
    const own = BanIcon;

    // When
    const icons = [toastIcon({ tone: 'err', icon: own }), toastIcon({ tone: 'warn', icon: own })];

    // Then
    expect(icons).toEqual([CircleXIcon, AlertTriangleIcon]);
  });

  it('As a dotli user, I get a success without an icon of its own and it shows its tone icon', () => {
    // Given
    const entry = { tone: 'ok' as const };

    // When
    const icon = toastIcon(entry);

    // Then
    expect(icon).toBe(CircleCheckIcon);
  });
});
