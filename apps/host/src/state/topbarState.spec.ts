// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { topbarState } from './topbarState.js';
import { recordNotified } from '../testing/recordNotified.js';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

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
});
