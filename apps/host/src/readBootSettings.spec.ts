// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BACKEND_KEY, NETWORK_KEY, getSettings, setSettings, type Settings, type SharedSettings } from '@dotli/config';
import { createDeferred } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import { readBootSettings, type BootSettingsParams } from './readBootSettings.js';
import type { SettingsActions } from './createSettingsActions.js';

type Params = {
  /** This origin's storage, empty by default. */
  local?: Storage;
  /** What the shared store answers, no settings by default. */
  shared?: Promise<SharedSettings | null>;
};

const CACHE_ON = { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false };

describe('readBootSettings', () => {
  it('As a returning visitor whose link changes my saved network, I open it and the page wipes and reloads through the reset Save uses', async () => {
    // Given
    const boot = createBootParams('?network=previewnet', {
      local: createMemoryStorage({ entries: { [NETWORK_KEY]: 'paseo-next-v2' } }),
    });

    // When
    await readBootSettings(boot);

    // Then
    expect(boot.applyAndReset).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'previewnet' }),
      expect.objectContaining({ network: 'paseo-next-v2' }),
      { forceFullWipe: true },
    );
  });

  it('As a first-time visitor with settings in my link, I open it and nothing is wiped while the settings in my link apply', async () => {
    // Given
    const boot = createBootParams('?network=previewnet');

    // When
    const settings = await readBootSettings(boot);

    // Then
    expect(boot.applyAndReset).not.toHaveBeenCalled();
    expect(settings.network).toBe('previewnet');
    expect(getSettings().network).toBe('previewnet');
  });

  it('As a visitor whose link matches my saved settings, I open it and nothing is wiped', async () => {
    // Given
    const boot = createBootParams('?network=previewnet', {
      local: createMemoryStorage({ entries: { [NETWORK_KEY]: 'previewnet' } }),
    });

    // When
    await readBootSettings(boot);

    // Then
    expect(boot.applyAndReset).not.toHaveBeenCalled();
  });

  it('As a visitor on a new subdomain, I open it and the backend I chose elsewhere applies and is stored here too', async () => {
    // Given
    const local = createMemoryStorage();
    const boot = createBootParams('', { local, shared: Promise.resolve({ backend: 'rpc-gateway', cache: null }) });

    // When
    const settings = await readBootSettings(boot);

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(local.getItem(BACKEND_KEY)).toBe('rpc-gateway');
    expect(boot.writeShared).toHaveBeenCalledWith({ backend: 'rpc-gateway', cache: JSON.stringify(CACHE_ON) });
  });

  it('As a developer on a fresh localhost origin, I boot and get the default backend whatever another origin shared', async () => {
    // Given
    const boot = {
      ...createBootParams('', { shared: Promise.resolve({ backend: 'rpc-gateway', cache: null }) }),
      preferLocal: true,
    };

    // When
    const settings = await readBootSettings(boot);

    // Then
    expect(settings.backend).toBe('smoldot-direct');
    expect(boot.writeShared).toHaveBeenCalledWith({ backend: 'smoldot-direct', cache: JSON.stringify(CACHE_ON) });
  });

  it('As a visitor whose shared store cannot be reached, I boot on this origin and my link, and write nothing to it', async () => {
    // Given
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'rpc-gateway' } });
    const boot = createBootParams('?network=previewnet', { local, shared: Promise.resolve(null) });

    // When
    const settings = await readBootSettings(boot);

    // Then
    expect(settings).toEqual({ network: 'previewnet', backend: 'rpc-gateway', cache: CACHE_ON });
    expect(boot.writeShared).not.toHaveBeenCalled();
  });

  it('As a visitor, I boot and my settings are set and the frame boots on them before the shared store answers', () => {
    // Given
    const shared = createDeferred<SharedSettings | null>();
    const boot = createBootParams('?network=previewnet', { shared: shared.promise });

    // When
    const booted = readBootSettings(boot);
    // The boot finishes inside the test, so its last write is put back with the rest.
    onTestFinished(async () => {
      shared.resolve(null);
      await booted;
    });

    // Then
    expect(getSettings().network).toBe('previewnet');
    expect(boot.configureFrame).toHaveBeenCalledWith(expect.objectContaining({ network: 'previewnet' }));
  });

  it('As a visitor from an old build, I boot and my old mode key is read as my backend and gone after', async () => {
    // Given
    const local = createMemoryStorage({ entries: { 'dotli:mode': 'gateway' } });
    const boot = createBootParams('', { local });

    // When
    const settings = await readBootSettings(boot);

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(local.getItem('dotli:mode')).toBeNull();
  });

  it.each<{ story: string; search: string; entries: Record<string, string> }>([
    {
      story: 'whose saved choice is the shared light client',
      search: '',
      entries: { [BACKEND_KEY]: 'smoldot-shared-worker' },
    },
    { story: 'whose link names the shared light client', search: '?chainBackend=smoldot-shared-worker', entries: {} },
    {
      story: 'with trusted providers saved and a link naming the shared light client',
      search: '?chainBackend=smoldot-shared-worker',
      entries: { [BACKEND_KEY]: 'rpc-gateway' },
    },
  ])(
    'As a visitor without SharedWorker $story, I boot and run per tab and am told once',
    async ({ search, entries }) => {
      // Given
      const boot = {
        ...createBootParams(search, { local: createMemoryStorage({ entries }) }),
        sharedWorkerAvailable: false,
      };

      // When
      const settings = await readBootSettings(boot);

      // Then
      expect(settings.backend).toBe('smoldot-direct');
      expect(boot.notify).toHaveBeenCalledTimes(1);
      expect(boot.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Light client shared unavailable',
          text: "This browser doesn't support Light client shared. Falling back to Light client per tab.",
        }),
      );
    },
  );

  it('As a visitor without SharedWorker who was told of the fallback, I boot again and am told nothing', async () => {
    // Given a first boot that fell back and stored the per-tab light client
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-shared-worker' } });
    await readBootSettings({ ...createBootParams('', { local }), sharedWorkerAvailable: false });
    const next = { ...createBootParams('', { local }), sharedWorkerAvailable: false };

    // When
    const settings = await readBootSettings(next);

    // Then
    expect(local.getItem(BACKEND_KEY)).toBe('smoldot-direct');
    expect(settings.backend).toBe('smoldot-direct');
    expect(next.notify).not.toHaveBeenCalled();
  });

  it('As a visitor without SharedWorker whose link names another backend over my saved shared choice, I boot and am told nothing', async () => {
    // Given
    const boot = {
      ...createBootParams('?chainBackend=rpc-gateway', {
        local: createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-shared-worker' } }),
      }),
      sharedWorkerAvailable: false,
    };

    // When
    const settings = await readBootSettings(boot);

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(boot.notify).not.toHaveBeenCalled();
  });

  it('As a visitor, I boot and the frame is configured on my own settings first, then once more on what the shared store adds', async () => {
    // Given
    const boot = createBootParams('', { shared: Promise.resolve({ backend: 'rpc-gateway', cache: null }) });

    // When
    await readBootSettings(boot);

    // Then
    expect(boot.configureFrame.mock.calls.map(([settings]) => settings.backend)).toEqual([
      'smoldot-direct',
      'rpc-gateway',
    ]);
  });

  it('As a visitor whose shared settings change the frame, I boot and the shared store is written after the frame is rebuilt on them', async () => {
    // Given the shared store on trusted providers, which this origin does not run yet
    const boot = createBootParams('', { shared: Promise.resolve({ backend: 'rpc-gateway', cache: null }) });

    // When
    await readBootSettings(boot);

    // Then
    expect(boot.configureFrame.mock.calls.map(([settings]) => settings.backend)).toEqual([
      'smoldot-direct',
      'rpc-gateway',
    ]);
    expect(boot.writeShared.mock.invocationCallOrder[0]).toBeGreaterThan(
      boot.configureFrame.mock.invocationCallOrder[1] ?? Infinity,
    );
  });

  it('As a returning visitor whose link resets my settings, I open it and the shared store is written on the frame that answered it while the reset reloads without rebuilding it', async () => {
    // Given this origin on the per-tab light client, the shared store on trusted providers, and a link to another network
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-direct', [NETWORK_KEY]: 'paseo-next-v2' } });
    const boot = createBootParams('?network=previewnet', {
      local,
      shared: Promise.resolve({ backend: 'rpc-gateway', cache: null }),
    });

    // When
    await readBootSettings(boot);

    // Then the frame keeps the config it read the shared store on, and the write goes out before the reset
    expect(boot.configureFrame.mock.calls.map(([settings]) => settings.backend)).toEqual(['smoldot-direct']);
    expect(boot.writeShared).toHaveBeenCalledWith(expect.objectContaining({ backend: 'rpc-gateway' }));
    expect(boot.writeShared.mock.invocationCallOrder[0]).toBeLessThan(
      boot.applyAndReset.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('As a visitor without SharedWorker whose link names the shared light client, I boot and the frame runs per tab both times', async () => {
    // Given
    const boot = { ...createBootParams('?chainBackend=smoldot-shared-worker'), sharedWorkerAvailable: false };

    // When
    await readBootSettings(boot);

    // Then
    expect(boot.configureFrame.mock.calls.map(([settings]) => settings.backend)).toEqual([
      'smoldot-direct',
      'smoldot-direct',
    ]);
    expect(boot.notify).toHaveBeenCalledTimes(1);
  });
});

/** Returns the boot's collaborators: this origin's storage, a shared store answering `shared`, and recorders. */
function createBootParams(
  search: string,
  { local = createMemoryStorage(), shared = Promise.resolve({ backend: null, cache: null }) }: Params = {},
) {
  const applyAndReset = vi.fn<SettingsActions['applyAndReset']>(() => Promise.resolve());
  const boot = {
    search,
    local,
    sharedWorkerAvailable: true,
    preferLocal: false,
    readShared: () => shared,
    writeShared: vi.fn<BootSettingsParams['writeShared']>(),
    configureFrame: vi.fn<(settings: Settings) => void>(),
    actions: { applyAndReset },
    notify: vi.fn<BootSettingsParams['notify']>(),
    replaceSearch: vi.fn<(query: string) => void>(),
  } satisfies BootSettingsParams;
  // The boot sets this context's settings, so each test puts them back.
  onTestFinished(setSettings(getSettings()));
  return { ...boot, applyAndReset };
}
