// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { BanIcon } from '../../icons.js';
import { toastIcon } from './toastIcon.js';

describe('toast icon', () => {
  it('As a dotli user, I get a toast with its own icon and it keeps that icon whatever its tone', () => {
    // Given
    const own = BanIcon;

    // When
    const icon = toastIcon({ tone: 'err', icon: own });

    // Then
    expect(icon).toBe(own);
  });
});
