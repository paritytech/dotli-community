// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import {
  getTopbarState,
  openSettings,
  setBlockingModalActive,
  recordChainsButtonVisible,
  setLandingPage,
  setTopbarAutoHide,
  setTopbarPresent,
  setTopbarVisible,
  topbarStore,
} from '../../src/state/topbar.js';
import { resetStores } from '../helpers/solid.js';

describe('topbar store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the shell, the topbar starts absent, visible, pinned, unblocked, with the chains button hidden', () => {
    expect(getTopbarState()).toEqual({
      present: false,
      visible: true,
      autoHide: false,
      landing: false,
      blockingModalActive: false,
      chainsButtonVisible: false,
      settingsRequests: 0,
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
      chainsButtonVisible: false,
    });
  });

  it('As the host, the page marks the topbar present, the landing page and the auto-hide, and asks for the settings panel', () => {
    // When
    setTopbarPresent();
    setLandingPage();
    setTopbarAutoHide(true);
    openSettings();
    openSettings();

    // Then
    expect(getTopbarState()).toMatchObject({ present: true, landing: true, autoHide: true, settingsRequests: 2 });
  });

  it('As the host, chains button visibility is recorded', () => {
    // When
    recordChainsButtonVisible(true);

    // Then
    expect(getTopbarState().chainsButtonVisible).toBe(true);
  });
});
