// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { ReadableStore } from '@dotli/shared';
import { getTopbarState, reportBlockingModals, setTopbarVisible, topbarStore } from './topbar.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

function countNotifications<T>(store: ReadableStore<T>): {
  count: () => number;
  stop: () => void;
} {
  let count = 0;
  const stop = store.subscribe(() => {
    count += 1;
  });
  return { count: () => count, stop };
}

describe('topbar store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the shell, the topbar starts absent, visible, pinned and unblocked with nothing waiting', () => {
    // When / Then
    expect(getTopbarState()).toEqual({
      present: false,
      visible: true,
      autoHide: false,
      blockingModalActive: false,
      blockingModalsWaiting: 0,
    });
  });

  it('As the auto-hide and the blocking-modal queue, my writes land in the store', () => {
    // When
    setTopbarVisible(false);
    reportBlockingModals({ waiting: 1, active: true });

    // Then
    expect(topbarStore.get()).toMatchObject({
      visible: false,
      blockingModalActive: true,
      blockingModalsWaiting: 1,
    });
  });
});

// The store skips a write that would not change it.
describe('topbar store equality', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the topbar, an unchanged visibility notifies nobody', () => {
    // Given: the topbar starts visible.
    const topbar = countNotifications(topbarStore);

    // When: the auto-hide reveal fires on every mouseenter.
    setTopbarVisible(true);
    setTopbarVisible(true);

    // Then
    expect(topbar.count()).toBe(0);

    // When
    setTopbarVisible(false);
    setTopbarVisible(false);

    // Then
    expect(topbar.count()).toBe(1);
    topbar.stop();
  });

  it('As the topbar, an unchanged blocking-modal report notifies nobody', () => {
    // Given
    reportBlockingModals({ waiting: 0, active: true });
    const topbar = countNotifications(topbarStore);

    // When
    reportBlockingModals({ waiting: 0, active: true });

    // Then
    expect(topbar.count()).toBe(0);
    topbar.stop();
  });
});
