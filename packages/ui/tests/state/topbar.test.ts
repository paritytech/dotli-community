// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getTopbarState, setBlockingModalActive, setTopbarVisible, topbarStore } from '../../src/state/topbar.js';
import { resetStores } from '../helpers/solid.js';

describe('topbar store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the shell, the topbar starts absent, visible, pinned and unblocked with nothing waiting', () => {
    expect(getTopbarState()).toEqual({
      present: false,
      visible: true,
      autoHide: false,
      blockingModalActive: false,
      blockingModalsWaiting: 0,
      settingsOpen: false,
    });
  });

  it('As the auto-hide and the blocking-modal queue, my writes land in the store', () => {
    // When
    setTopbarVisible(false);
    setBlockingModalActive(true);

    // Then
    expect(topbarStore.get()).toMatchObject({
      visible: false,
      blockingModalActive: true,
    });
  });
});
