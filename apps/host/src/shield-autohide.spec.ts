// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { startShieldAutoHide } from './shield-autohide.js';

function loginState(): {
  store: { get: () => boolean; subscribe: (listener: () => void) => () => void };
  set: (next: boolean) => void;
} {
  let loggedIn = false;
  const listeners = new Set<() => void>();
  return {
    store: {
      get: () => loggedIn,
      subscribe: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set: next => {
      loggedIn = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

describe('startShieldAutoHide', () => {
  it('As a visitor signing in while the page still loads, I keep the topbar until the shield settles', () => {
    // Given
    const login = loginState();
    const arm = vi.fn();
    const autoHide = startShieldAutoHide({ loggedIn: login.store, arm });

    // When
    login.set(true);
    const armedBeforeShield = arm.mock.calls.length;
    autoHide.settle();

    // Then
    expect(armedBeforeShield).toBe(0);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('As a visitor signing in after the shield settled, I see the topbar fold again', () => {
    // Given
    const login = loginState();
    const arm = vi.fn();
    const autoHide = startShieldAutoHide({ loggedIn: login.store, arm });
    autoHide.settle();

    // When
    login.set(true);
    login.set(false);

    // Then
    expect(arm).toHaveBeenCalledTimes(2);
  });
});
