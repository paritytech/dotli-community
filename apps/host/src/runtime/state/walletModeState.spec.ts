// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { walletModeState } from './walletModeState.js';

describe('wallet mode state', () => {
  afterEach(() => {
    resetAllStoresForTests();
  });

  it('As a page whose restore has not settled, I ask whether it runs on a local wallet and hear no', () => {
    // Given a page as it opens

    // When
    const local = walletModeState.isLocal();
    const followed = walletModeState.localStore.get();

    // Then
    expect(local).toBe(false);
    expect(followed).toBe(false);
  });

  it('As the account button, I follow the local store while the mode is set twice and hear it turn local once', () => {
    // Given a follower of the local store
    const heard: boolean[] = [];
    onTestFinished(
      walletModeState.localStore.listen(next => {
        heard.push(next);
      }),
    );

    // When a failed local read keeps the page on the app and a later read finds the wallet
    walletModeState.set({ mode: 'app', failure: 'x' });
    walletModeState.set({ mode: 'local', failure: null });

    // Then
    expect(heard).toEqual([true]);
  });
});
