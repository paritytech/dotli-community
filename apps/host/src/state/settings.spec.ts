// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { getSettingsState, initSettingsStore } from './settings.js';
import { getEnabledNetworks, isSharedWorkerAvailable, setSettings } from '@dotli/config';

import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';

describe('settings store', () => {
  afterEach(() => {
    resetStores();
  });

  it('As the prerendered shell, the settings store is empty until the host seeds it', () => {
    // When / Then
    expect(getSettingsState()).toBeNull();
  });

  it('As the settings popover, initSettingsStore snapshots the settings the page booted with', () => {
    // Given
    const cache = { skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false };
    onTestFinished(setSettings({ network: 'previewnet', backend: 'rpc-gateway', cache }));

    // When
    initSettingsStore();

    // Then
    expect(getSettingsState()).toEqual({
      backend: 'rpc-gateway',
      cache,
      network: 'previewnet',
      enabledNetworks: getEnabledNetworks(),
      sharedWorkerAvailable: isSharedWorkerAvailable(),
      verified: false,
    });
  });
});
