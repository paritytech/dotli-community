// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSyncStore } from '@dotli/shared';
import { startShieldAutoHide } from './shield-autohide.js';

/** The auto-hide over a login store, counting how often it let the topbar fold. */
function shieldAutoHide(): { login: { set: (next: boolean) => void }; arms: () => number; settle: () => void } {
  const login = createSyncStore('shield-autohide-spec-login', false);
  let arms = 0;
  const autoHide = startShieldAutoHide({
    loggedIn: login,
    arm: () => {
      arms += 1;
    },
  });
  return { login, arms: () => arms, settle: autoHide.settle };
}

describe('startShieldAutoHide', () => {
  it('As a visitor signing in while the page still loads, I keep the topbar until the shield settles', () => {
    // Given
    const { login, arms, settle } = shieldAutoHide();

    // When
    login.set(true);
    const armedBeforeShield = arms();
    settle();

    // Then
    expect(armedBeforeShield).toBe(0);
    expect(arms()).toBe(1);
  });

  it('As a visitor signing in after the shield settled, I see the topbar fold again, and signing out folds nothing', () => {
    // Given
    const { login, arms, settle } = shieldAutoHide();
    settle();
    const armedBySettle = arms();

    // When
    login.set(true);
    const armedBySignIn = arms() - armedBySettle;
    login.set(false);
    const armedBySignOut = arms() - armedBySettle - armedBySignIn;

    // Then
    expect(armedBySignIn).toBe(1);
    expect(armedBySignOut).toBe(0);
  });
});
