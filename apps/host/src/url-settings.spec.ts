// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import {
  BACKEND_KEY,
  NETWORK_KEY,
  configureModeStorage,
  getBackend,
  getCacheSettings,
  getNetwork,
  persistDefaults,
  type ModeStorage,
} from '@dotli/config';
import type { SettingsActions } from './settings-actions.js';
import { applyUrlSettings, readPersistedSettings as readFrom, type UrlSettingsDeps } from './url-settings.js';

/** This origin's localStorage, which the settings readers and the persisted snapshot both see. */
let local: Map<string, string>;

const localStore: ModeStorage = {
  getItem: key => local.get(key) ?? null,
  setItem: (key, value) => {
    local.set(key, value);
  },
  removeItem: key => {
    local.delete(key);
  },
};

const readPersistedSettings = (): ReturnType<typeof readFrom> => readFrom(localStore);

/** The boot's collaborators, with the link's query string and a Save reset that records its calls. */
function deps(search: string): UrlSettingsDeps & {
  applyAndReset: ReturnType<typeof vi.fn<SettingsActions['applyAndReset']>>;
} {
  const applyAndReset = vi.fn<SettingsActions['applyAndReset']>(() => Promise.resolve());
  return {
    search,
    configureFrame: vi.fn(),
    bootstrapSharedMode: () => Promise.resolve(),
    actions: { applyAndReset },
    applyAndReset,
    notify: vi.fn(),
    replaceSearch: vi.fn(),
  };
}

beforeEach(() => {
  local = new Map();
  configureModeStorage(localStore);
});

describe('applyUrlSettings', () => {
  it('As a returning visitor whose link changes my saved network, the page wipes and reloads through the reset Save uses', async () => {
    // Given
    local.set(NETWORK_KEY, 'paseo-next-v2');
    const boot = deps('?network=previewnet');

    // When
    await applyUrlSettings(readPersistedSettings(), boot);

    // Then
    expect(boot.applyAndReset).toHaveBeenCalledTimes(1);
    expect(boot.applyAndReset).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'previewnet' }),
      expect.objectContaining({ network: 'paseo-next-v2' }),
      { forceFullWipe: true },
    );
  });

  it('As a first-time visitor with settings in my link, nothing is wiped and the settings in my link apply', async () => {
    // Given
    const boot = deps('?network=previewnet');

    // When
    await applyUrlSettings(readPersistedSettings(), boot);

    // Then
    expect(boot.applyAndReset).not.toHaveBeenCalled();
    expect(getNetwork()).toBe('previewnet');
  });

  it('As a visitor whose link matches my saved settings, nothing is wiped', async () => {
    // Given
    local.set(NETWORK_KEY, 'previewnet');
    const boot = deps('?network=previewnet');

    // When
    await applyUrlSettings(readPersistedSettings(), boot);

    // Then
    expect(boot.applyAndReset).not.toHaveBeenCalled();
  });

  it('As an operator, a shared-mode bootstrap whose chunk cannot load is left as a breadcrumb, counted by its cause, and the boot continues with local settings', async () => {
    // Given a bootstrap that cannot run, and a reporting pipeline that records
    const missing = new TypeError('Failed to fetch dynamically imported module');
    const boot = deps('');
    boot.bootstrapSharedMode = () => Promise.reject(missing);
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const { counted } = bindRecordingSentry({ onFinished: onTestFinished });

    // When
    await applyUrlSettings(readPersistedSettings(), boot);

    // Then the failure is a breadcrumb and one count naming the cause, and nothing is wiped
    expect(captures.expected).toHaveBeenCalledWith(missing, { flow: 'boot', step: 'shared_mode_bootstrap' });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(counted('shared_mode.bootstrap')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
    expect(boot.applyAndReset).not.toHaveBeenCalled();
  });
});

describe('readPersistedSettings', () => {
  it('As a first-time visitor, I still look fresh after the settings were read', () => {
    // Given: a fresh origin whose settings the shell state already read
    getNetwork();
    getBackend();
    getCacheSettings();

    // When
    const snapshot = readPersistedSettings();

    // Then
    expect(snapshot).toEqual({ hadPriorPersisted: false, rawPersistedBackend: null });
  });

  it('As a returning visitor, my persisted backend shows in the snapshot', () => {
    // Given
    local.set(BACKEND_KEY, 'smoldot-shared-worker');

    // When
    const snapshot = readPersistedSettings();

    // Then
    expect(snapshot).toEqual({ hadPriorPersisted: true, rawPersistedBackend: 'smoldot-shared-worker' });
  });

  it('As a first-time visitor, a snapshot taken after the boot stores the defaults would have looked persisted', () => {
    // Given
    persistDefaults();

    // When
    const late = readPersistedSettings();

    // Then
    expect(late.hadPriorPersisted).toBe(true);
  });
});
