// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getSettingsState, initSettingsStore } from '../../src/state/settings.js';
import {
  getBackend,
  getCacheNodeSettings,
  getCacheSettings,
  isSharedWorkerAvailable,
  isVerifiedSession,
  getEnabledNetworks,
  getNetwork,
} from '@dotli/config';

import { resetStores } from '../helpers/solid.js';

describe('settings store', () => {
  afterEach(() => {
    resetStores();
    localStorage.clear();
  });

  it('As the prerendered shell, the settings store is empty until the host seeds it', () => {
    expect(getSettingsState()).toBeNull();
  });

  it('As the settings popover, initSettingsStore snapshots the config getters', () => {
    // When
    initSettingsStore();

    // Then
    expect(getSettingsState()).toEqual({
      backend: getBackend(),
      cache: getCacheSettings(),
      cacheNodes: getCacheNodeSettings(),
      network: getNetwork(),
      enabledNetworks: getEnabledNetworks(),
      sharedWorkerAvailable: isSharedWorkerAvailable(),
      verified: isVerifiedSession(getBackend()),
    });
  });
});
