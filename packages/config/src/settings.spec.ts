// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import { BACKEND_KEY, CACHE_KEY } from './mode.js';
import { NETWORK_KEY } from './network.js';
import { hasStoredSettings, resolveSettings, sharedSettingsOf, writeLocalSettings } from './settings.js';
import { parseSettingsFromSearch, type ParsedUrlSettings } from './url-settings.js';

const CACHE_OFF = JSON.stringify({ skipCidCache: true, skipArchiveCache: true, skipWorkerCache: false });
const DEFAULT_CACHE = { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false };

describe('resolveSettings', () => {
  it('As a first-time visitor, I get the default network, the per-tab light client and every cache on', () => {
    // When
    const settings = resolveSettings({ local: memoryStorage(), shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings).toEqual({ network: 'paseo-next-v2', backend: 'smoldot-direct', cache: DEFAULT_CACHE });
  });

  it('As a returning visitor, I get the network and backend I chose on this origin', () => {
    // Given
    const local = memoryStorage({ [NETWORK_KEY]: 'previewnet', [BACKEND_KEY]: 'rpc-gateway' });

    // When
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings).toMatchObject({ network: 'previewnet', backend: 'rpc-gateway' });
  });

  it('As a visitor on a new subdomain, the backend and caches I chose elsewhere win over this origin', () => {
    // Given
    const local = memoryStorage({ [BACKEND_KEY]: 'smoldot-direct' });
    const shared = { backend: 'rpc-gateway', cache: CACHE_OFF };

    // When
    const settings = resolveSettings({ local, shared, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(settings.cache).toEqual({ skipCidCache: true, skipArchiveCache: true, skipWorkerCache: false });
  });

  it('As a parallel test worker on localhost, this origin keeps its own choice over the shared one', () => {
    // Given
    const local = memoryStorage({ [BACKEND_KEY]: 'smoldot-direct' });

    // When
    const settings = resolveSettings({
      local,
      shared: { backend: 'rpc-gateway', cache: CACHE_OFF },
      sharedWorkerAvailable: true,
      preferLocal: true,
    });

    // Then the backend is this origin's, and the cache, which it never chose, is the shared one
    expect(settings.backend).toBe('smoldot-direct');
    expect(settings.cache.skipCidCache).toBe(true);
  });

  it('As a visitor following a shared link, the link wins over both stores', () => {
    // Given
    const local = memoryStorage({ [NETWORK_KEY]: 'paseo-next-v2' });
    const url = parseSettingsFromSearch(new URLSearchParams('network=previewnet&chainBackend=rpc-gateway'));

    // When
    const settings = resolveSettings({
      local,
      shared: { backend: 'smoldot-direct', cache: null },
      url,
      sharedWorkerAvailable: true,
    });

    // Then
    expect(settings).toMatchObject({ network: 'previewnet', backend: 'rpc-gateway' });
  });

  it('As a visitor with a network this build no longer offers, I get the default network', () => {
    // Given
    const local = memoryStorage({ [NETWORK_KEY]: 'kusama' });

    // When
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.network).toBe('paseo-next-v2');
  });

  it('As a visitor from an old build, the backend my old mode key names is the one I get', () => {
    // Given
    const local = memoryStorage({ 'dotli:mode': 'gateway' });

    // When
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('rpc-gateway');
  });

  it('As a visitor whose browser lost SharedWorker, I get the light client per tab', () => {
    // Given
    const local = memoryStorage({ [BACKEND_KEY]: 'smoldot-shared-worker' });

    // When
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: false });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });

  it('As a visitor whose browser lacks SharedWorker, a link naming the shared light client runs me per tab', () => {
    // Given
    const local = memoryStorage({ [BACKEND_KEY]: 'rpc-gateway' });
    const url = parseSettingsFromSearch(new URLSearchParams('chainBackend=smoldot-shared-worker'));

    // When
    const settings = resolveSettings({ local, shared: null, url, sharedWorkerAvailable: false });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });

  it('As a visitor whose stored cache settings are malformed, every cache is on', () => {
    // Given
    const local = memoryStorage({ [CACHE_KEY]: '{"skipCidCache":' });

    // When
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.cache).toEqual(DEFAULT_CACHE);
  });

  it('As a first visit on a localhost origin, I get the default backend whatever the shared store holds', () => {
    // When
    const settings = resolveSettings({
      local: memoryStorage(),
      shared: { backend: 'rpc-gateway', cache: null },
      sharedWorkerAvailable: true,
      preferLocal: true,
    });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });

  it('As a visitor following a shared link, the cache switches in the link win over both stores', () => {
    // Given
    const local = memoryStorage({ [CACHE_KEY]: CACHE_OFF });
    const url = parseSettingsFromSearch(new URLSearchParams('skipCidCache=0&skipWorkerCache=1'));

    // When
    const settings = resolveSettings({
      local,
      shared: { backend: null, cache: CACHE_OFF },
      url,
      sharedWorkerAvailable: true,
    });

    // Then the link sets two switches and the stored one it leaves out stays
    expect(settings.cache).toEqual({ skipCidCache: false, skipArchiveCache: true, skipWorkerCache: true });
  });

  it('As a visitor following a link to a network this build does not offer, I get the stored network', () => {
    // Given
    const local = memoryStorage({ [NETWORK_KEY]: 'previewnet' });
    const url = {
      network: 'kusama',
      chainBackend: null,
      skipArchiveCache: null,
      skipCidCache: null,
      skipWorkerCache: null,
    };

    // When
    const settings = resolveSettings({
      local,
      shared: null,
      url: url as unknown as ParsedUrlSettings,
      sharedWorkerAvailable: true,
    });

    // Then
    expect(settings.network).toBe('previewnet');
  });

  it('As a visitor with a valid backend and a stale old mode key, the backend I chose wins', () => {
    // Given
    const local = memoryStorage({ [BACKEND_KEY]: 'smoldot-direct', 'dotli:mode': 'gateway' });

    // When
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });
});

describe('writeLocalSettings', () => {
  it('As a visitor from an old build, my settings are stored under the current keys and the old key is gone', () => {
    // Given
    const local = memoryStorage({ 'dotli:mode': 'gateway' });
    const settings = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // When
    writeLocalSettings(settings, local);

    // Then
    expect(local.getItem(NETWORK_KEY)).toBe('paseo-next-v2');
    expect(local.getItem(BACKEND_KEY)).toBe('rpc-gateway');
    expect(local.getItem(CACHE_KEY)).toBe(JSON.stringify(DEFAULT_CACHE));
    expect(local.getItem('dotli:mode')).toBeNull();
    expect(local.length).toBe(3);
  });
});

describe('sharedSettingsOf', () => {
  it('As a visitor, the network I use stays on this origin and only the backend and caches are shared', () => {
    // When
    const shared = sharedSettingsOf({ network: 'previewnet', backend: 'rpc-gateway', cache: DEFAULT_CACHE });

    // Then
    expect(shared).toEqual({ backend: 'rpc-gateway', cache: JSON.stringify(DEFAULT_CACHE) });
  });
});

describe('hasStoredSettings', () => {
  it('As a first-time visitor, I hold no stored settings, and a returning one does', () => {
    // When / Then
    expect(hasStoredSettings(memoryStorage())).toBe(false);
    expect(hasStoredSettings(memoryStorage({ [CACHE_KEY]: CACHE_OFF }))).toBe(true);
  });
});
