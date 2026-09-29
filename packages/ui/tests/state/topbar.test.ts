// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import {
  getTopbarState,
  setBlockingModalActive,
  recordChainsButtonVisible,
  setTopbarVisible,
  topbarStore,
} from '../../src/state/topbar.js';
import { resetStores } from '../helpers/solid.js';

describe('topbar store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the shell, the topbar starts visible, unblocked, with the chains button hidden', () => {
    expect(getTopbarState()).toEqual({
      visible: true,
      blockingModalActive: false,
      chainsButtonVisible: false,
    });
  });

  it('As the auto-hide and the blocking-modal queue, my writes land in the store', () => {
    // When
    setTopbarVisible(false);
    setBlockingModalActive(true);

    // Then
    expect(topbarStore.get()).toEqual({
      visible: false,
      blockingModalActive: true,
      chainsButtonVisible: false,
    });
  });

  it('As the host, chains button visibility is recorded', () => {
    // When
    recordChainsButtonVisible(true);

    // Then
    expect(getTopbarState().chainsButtonVisible).toBe(true);
  });
});
