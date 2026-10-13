// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BACKEND_KEY, NETWORK_KEY, getSettings, setSettings, type Settings, type SharedSettings } from '@dotli/config';
import { memoryModeStorage, type MemoryModeStorage } from '@dotli/config/testing';
import { deferred } from '@dotli/shared/testing';
import { bootSettings, type SettingsBootDeps } from './boot-settings.js';
import type { SettingsActions } from './settings-actions.js';

const CACHE_ON = { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false };

/** The boot's collaborators: this origin's storage, a shared store answering `shared`, and recorders. */
function deps(
  search: string,
  local: MemoryModeStorage = memoryModeStorage(),
  shared: Promise<SharedSettings | null> = Promise.resolve({ backend: null, cache: null }),
) {
  const applyAndReset = vi.fn<SettingsActions['applyAndReset']>(() => Promise.resolve());
  const boot = {
    search,
    local,
    sharedWorkerAvailable: true,
    preferLocal: false,
    readShared: () => shared,
    writeShared: vi.fn<SettingsBootDeps['writeShared']>(),
    configureFrame: vi.fn<(settings: Settings) => void>(),
    actions: { applyAndReset },
    notify: vi.fn<SettingsBootDeps['notify']>(),
    replaceSearch: vi.fn<(query: string) => void>(),
  } satisfies SettingsBootDeps;
  // The boot sets this context's settings, so each test puts them back.
  onTestFinished(setSettings(getSettings()));
  return { ...boot, applyAndReset };
}

describe('bootSettings', () => {
  it('As a returning visitor whose link changes my saved network, the page wipes and reloads through the reset Save uses', async () => {
    // Given
    const boot = deps('?network=previewnet', memoryModeStorage({ [NETWORK_KEY]: 'paseo-next-v2' }));

    // When
    await bootSettings(boot);

    // Then
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
    const settings = await bootSettings(boot);

    // Then
    expect(boot.applyAndReset).not.toHaveBeenCalled();
    expect(settings.network).toBe('previewnet');
    expect(getSettings().network).toBe('previewnet');
  });

  it('As a visitor whose link matches my saved settings, nothing is wiped', async () => {
    // Given
    const boot = deps('?network=previewnet', memoryModeStorage({ [NETWORK_KEY]: 'previewnet' }));

    // When
    await bootSettings(boot);

    // Then
    expect(boot.applyAndReset).not.toHaveBeenCalled();
  });

  it('As a visitor on a new subdomain, the backend I chose elsewhere applies and is stored here too', async () => {
    // Given
    const local = memoryModeStorage();
    const boot = deps('', local, Promise.resolve({ backend: 'rpc-gateway', cache: null }));

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(local.dump()[BACKEND_KEY]).toBe('rpc-gateway');
    expect(boot.writeShared).toHaveBeenCalledWith({ backend: 'rpc-gateway', cache: JSON.stringify(CACHE_ON) });
  });

  it('As a developer on a fresh localhost origin, I boot on the default backend whatever another origin shared', async () => {
    // Given
    const boot = {
      ...deps('', memoryModeStorage(), Promise.resolve({ backend: 'rpc-gateway', cache: null })),
      preferLocal: true,
    };

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('smoldot-direct');
    expect(boot.writeShared).toHaveBeenCalledWith({ backend: 'smoldot-direct', cache: JSON.stringify(CACHE_ON) });
  });

  it('As a visitor whose shared store cannot be reached, I boot on this origin and my link, and write nothing to it', async () => {
    // Given
    const local = memoryModeStorage({ [BACKEND_KEY]: 'rpc-gateway' });
    const boot = deps('?network=previewnet', local, Promise.resolve(null));

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings).toEqual({ network: 'previewnet', backend: 'rpc-gateway', cache: CACHE_ON });
    expect(boot.writeShared).not.toHaveBeenCalled();
  });

  it('As the shell, my settings are set and the frame boots on them before the shared store answers', async () => {
    // Given
    const shared = deferred<SharedSettings | null>();
    const boot = deps('?network=previewnet', memoryModeStorage(), shared.promise);

    // When
    const booted = bootSettings(boot);

    // Then
    expect(getSettings().network).toBe('previewnet');
    expect(boot.configureFrame).toHaveBeenCalledWith(expect.objectContaining({ network: 'previewnet' }));

    // And the boot finishes inside the test, so its last write is put back with the rest
    shared.resolve(null);
    await booted;
  });

  it('As a visitor from an old build, my old mode key is read as my backend and gone after boot', async () => {
    // Given
    const local = memoryModeStorage({ 'dotli:mode': 'gateway' });
    const boot = deps('', local);

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(local.dump()['dotli:mode']).toBeUndefined();
  });

  it('As a visitor without SharedWorker whose saved choice is the shared light client, I run per tab and am told once', async () => {
    // Given
    const boot = {
      ...deps('', memoryModeStorage({ [BACKEND_KEY]: 'smoldot-shared-worker' })),
      sharedWorkerAvailable: false,
    };

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('smoldot-direct');
    expect(boot.notify).toHaveBeenCalledTimes(1);
    expect(boot.notify).toHaveBeenCalledWith(expect.objectContaining({ label: 'Light client shared unavailable' }));
  });

  it('As a visitor without SharedWorker who was told of the fallback, my next boot stays quiet', async () => {
    // Given a first boot that fell back and stored the per-tab light client
    const local = memoryModeStorage({ [BACKEND_KEY]: 'smoldot-shared-worker' });
    await bootSettings({ ...deps('', local), sharedWorkerAvailable: false });
    const next = { ...deps('', local), sharedWorkerAvailable: false };

    // When
    const settings = await bootSettings(next);

    // Then
    expect(local.dump()[BACKEND_KEY]).toBe('smoldot-direct');
    expect(settings.backend).toBe('smoldot-direct');
    expect(next.notify).not.toHaveBeenCalled();
  });

  it('As a visitor without SharedWorker whose link names the shared light client, I run per tab and am told once', async () => {
    // Given
    const boot = { ...deps('?chainBackend=smoldot-shared-worker'), sharedWorkerAvailable: false };

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('smoldot-direct');
    expect(boot.notify).toHaveBeenCalledTimes(1);
    expect(boot.notify).toHaveBeenCalledWith(expect.objectContaining({ label: 'Light client shared unavailable' }));
  });

  it('As a visitor without SharedWorker and with trusted providers saved, a link naming the shared light client runs me per tab and tells me once', async () => {
    // Given
    const boot = {
      ...deps('?chainBackend=smoldot-shared-worker', memoryModeStorage({ [BACKEND_KEY]: 'rpc-gateway' })),
      sharedWorkerAvailable: false,
    };

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('smoldot-direct');
    expect(boot.notify).toHaveBeenCalledTimes(1);
    expect(boot.notify).toHaveBeenCalledWith(expect.objectContaining({ label: 'Light client shared unavailable' }));
  });

  it('As a visitor without SharedWorker whose link names another backend over my saved shared choice, I am told nothing', async () => {
    // Given
    const boot = {
      ...deps('?chainBackend=rpc-gateway', memoryModeStorage({ [BACKEND_KEY]: 'smoldot-shared-worker' })),
      sharedWorkerAvailable: false,
    };

    // When
    const settings = await bootSettings(boot);

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(boot.notify).not.toHaveBeenCalled();
  });
});
