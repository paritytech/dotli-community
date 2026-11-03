// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { atom } from 'nanostores';
import { startShieldAutoHide } from './startShieldAutoHide.js';

/** The auto-hide over a login store, counting how often it let the topbar fold. */
type CountedAutoHide = {
  login: { set: (next: boolean) => void };
  /** Returns how often the auto-hide let the topbar fold. */
  countArms: () => number;
  settle: () => void;
  dispose: () => void;
};

describe('startShieldAutoHide', () => {
  it('As a visitor, I sign in while the page still loads and keep the topbar until the shield settles', () => {
    // Given
    const { login, countArms, settle } = startCountedAutoHide();

    // When
    login.set(true);
    const armedBeforeShield = countArms();
    settle();

    // Then
    expect(armedBeforeShield).toBe(0);
    expect(countArms()).toBe(1);
  });

  it('As a visitor signing in after the shield settled, I see the topbar fold again, and signing out folds nothing', () => {
    // Given
    const { login, countArms, settle } = startCountedAutoHide();
    settle();
    const armedBySettle = countArms();

    // When
    login.set(true);
    const armedBySignIn = countArms() - armedBySettle;
    login.set(false);
    const armedBySignOut = countArms() - armedBySettle - armedBySignIn;

    // Then
    expect(armedBySignIn).toBe(1);
    expect(armedBySignOut).toBe(0);
  });

  it('As a visitor, I sign in after the auto-hide was disposed and the topbar stays', () => {
    // Given
    const { login, countArms, settle, dispose } = startCountedAutoHide();
    settle();
    const armedBefore = countArms();

    // When the auto-hide is disposed, and the visitor signs in
    dispose();
    login.set(true);

    // Then
    expect(countArms()).toBe(armedBefore);
  });
});

/** Starts the auto-hide over a login store, disposed when the case ends. */
function startCountedAutoHide(): CountedAutoHide {
  const login = atom(false);
  let arms = 0;
  const autoHide = startShieldAutoHide({
    loggedIn: login,
    arm() {
      arms += 1;
    },
  });
  onTestFinished(autoHide.dispose);
  return { login, countArms: () => arms, settle: autoHide.settle, dispose: autoHide.dispose };
}
