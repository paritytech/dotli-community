// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getCapsuleStatus } from './getCapsuleStatus.js';
import type { NetworkHealth } from './networkVerdict.js';

const HEALTHS: NetworkHealth[] = ['ok', 'idle', 'warn', 'err', 'quiet'];

describe('getCapsuleStatus', () => {
  it('As a user, I glance at the capsule and its colour follows the network health', () => {
    // When
    const tones = HEALTHS.map(health => getCapsuleStatus({ health, action: false, online: true }).tone);

    // Then
    expect(tones).toEqual(HEALTHS);
  });

  it('As a user with a prompt waiting, I glance at the capsule and it leads with the action dot', () => {
    // When
    const dots = {
      idle: getCapsuleStatus({ health: 'ok', action: false, online: true }).action,
      waiting: getCapsuleStatus({ health: 'ok', action: true, online: true }).action,
    };

    // Then
    expect(dots).toEqual({ idle: false, waiting: true });
  });

  it('As a screen reader user, I hear when I go offline, and the line clears when I am back', () => {
    // When
    const lines = {
      offline: getCapsuleStatus({ health: 'err', action: false, online: false }).announcement,
      online: getCapsuleStatus({ health: 'ok', action: false, online: true }).announcement,
    };

    // Then
    expect(lines).toEqual({ offline: 'You are offline', online: '' });
  });
});
