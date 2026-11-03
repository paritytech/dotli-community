// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { topbarState } from './topbarState.js';
import { recordNotified } from '../testing/recordNotified.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('topbar store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user opening dotli, I find the topbar absent, visible, pinned and unblocked with nothing waiting', () => {
    // When
    const state = topbarState.get();

    // Then
    expect(state).toEqual({
      present: false,
      visible: true,
      autoHide: false,
      blockingModalActive: false,
      blockingModalsWaiting: 0,
    });
  });

  it('As a user, I hide the topbar while one prompt is open and another waits, and the topbar state holds all three', () => {
    // When
    topbarState.setVisible(false);
    topbarState.reportBlockingModals({ waiting: 1, active: true });

    // Then
    expect(topbarState.store.get()).toMatchObject({
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

  it('As a user moving over the topbar, I reveal it again and again and it redraws only when it hides', () => {
    // Given: the topbar starts visible.
    const notified = recordNotified(topbarState.store);

    // When: a reveal on every mouseenter, then the bar hides twice.
    topbarState.setVisible(true);
    topbarState.setVisible(true);
    topbarState.setVisible(false);
    topbarState.setVisible(false);

    // Then
    expect(notified).toEqual([{ ...topbarState.store.init, visible: false }]);
  });

  it('As a user with a prompt open, I get the same prompt report again and the topbar does not redraw', () => {
    // Given
    topbarState.reportBlockingModals({ waiting: 0, active: true });
    const notified = recordNotified(topbarState.store);

    // When
    topbarState.reportBlockingModals({ waiting: 0, active: true });

    // Then
    expect(notified).toEqual([]);
  });
});
