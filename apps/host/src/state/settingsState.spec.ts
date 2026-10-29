// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { setSettings } from '@dotli/config';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';
import { settingsState } from './settingsState.js';

describe('settings store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As a user loading the prerendered shell, I read the settings before init and find none', () => {
    // When
    const state = settingsState.get();

    // Then
    expect(state).toBeNull();
  });

  it('As a user, I open the settings popover and see the settings the page booted with', () => {
    // Given
    const cache = { skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false };
    onTestFinished(setSettings({ network: 'previewnet', backend: 'rpc-gateway', cache }));

    // When
    settingsState.init();

    // Then
    expect(settingsState.get()).toEqual({
      backend: 'rpc-gateway',
      cache,
      network: 'previewnet',
      // The networks the test build enables, and Node has no SharedWorker.
      enabledNetworks: ['paseo-next-v2', 'previewnet'],
      sharedWorkerAvailable: false,
      verified: false,
    });
  });
});
