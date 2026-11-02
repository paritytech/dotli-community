// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { BACKEND_KEY } from './backend.js';
import { CACHE_KEY, DEFAULT_CACHE } from './cacheSettings.js';
import { NETWORK_KEY } from './networkNames.js';
import { resolveSettings } from './resolveSettings.js';
import { parseSettingsFromSearch } from './urlSettings.js';

const CACHE_OFF = JSON.stringify({ skipCidCache: true, skipArchiveCache: true, skipWorkerCache: false });

describe('resolveSettings', () => {
  it('As a first-time visitor, I get the default network, the per-tab light client and every cache on', () => {
    // When
    const { settings } = resolveSettings({ local: createMemoryStorage(), shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings).toEqual({ network: 'paseo-next-v2', backend: 'smoldot-direct', cache: DEFAULT_CACHE });
  });

  it('As a returning visitor, I get the network and backend I chose on this origin', () => {
    // Given
    const local = createMemoryStorage({ entries: { [NETWORK_KEY]: 'previewnet', [BACKEND_KEY]: 'rpc-gateway' } });

    // When
    const { settings } = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings).toMatchObject({ network: 'previewnet', backend: 'rpc-gateway' });
  });

  it('As a visitor on a new subdomain, I open it and the backend and caches I chose elsewhere win over this origin', () => {
    // Given
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-direct' } });
    const shared = { backend: 'rpc-gateway', cache: CACHE_OFF };

    // When
    const { settings } = resolveSettings({ local, shared, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('rpc-gateway');
    expect(settings.cache).toEqual({ skipCidCache: true, skipArchiveCache: true, skipWorkerCache: false });
  });

  it("As a page reading a shared backend this build does not know, I keep this origin's backend", () => {
    // Given a newer deploy's backend in the shared store
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'rpc-gateway' } });
    const shared = { backend: 'a-backend-from-a-newer-deploy', cache: null };

    // When
    const { settings } = resolveSettings({ local, shared, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('rpc-gateway');
  });

  it("As a parallel test worker on localhost, I resolve the settings and keep this origin's choice over the shared one", () => {
    // Given
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-direct' } });

    // When
    const { settings } = resolveSettings({
      local,
      shared: { backend: 'rpc-gateway', cache: CACHE_OFF },
      sharedWorkerAvailable: true,
      preferLocal: true,
    });

    // Then the backend is this origin's, and the cache, which it never chose, is the shared one
    expect(settings.backend).toBe('smoldot-direct');
    expect(settings.cache.skipCidCache).toBe(true);
  });

  it('As a visitor, I follow a shared link and its settings win over both stores', () => {
    // Given
    const local = createMemoryStorage({ entries: { [NETWORK_KEY]: 'paseo-next-v2' } });
    const url = parseSettingsFromSearch(new URLSearchParams('network=previewnet&chainBackend=rpc-gateway'));

    // When
    const { settings } = resolveSettings({
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
    const local = createMemoryStorage({ entries: { [NETWORK_KEY]: 'kusama' } });

    // When
    const { settings } = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.network).toBe('paseo-next-v2');
  });

  it('As a visitor from an old build, I return and get the backend my old mode key names', () => {
    // Given
    const local = createMemoryStorage({ entries: { 'dotli:mode': 'gateway' } });

    // When
    const { settings } = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('rpc-gateway');
  });

  it('As a visitor whose browser lacks SharedWorker, I follow a link naming the shared light client and run per tab', () => {
    // Given
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'rpc-gateway' } });
    const url = parseSettingsFromSearch(new URLSearchParams('chainBackend=smoldot-shared-worker'));

    // When
    const { settings } = resolveSettings({ local, shared: null, url, sharedWorkerAvailable: false });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });

  it('As a visitor whose stored cache settings are malformed, I return and every cache is on', () => {
    // Given
    const local = createMemoryStorage({ entries: { [CACHE_KEY]: '{"skipCidCache":' } });

    // When
    const { settings } = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.cache).toEqual(DEFAULT_CACHE);
  });

  it('As a first-time visitor on a localhost origin, I get the default backend whatever the shared store holds', () => {
    // When
    const { settings } = resolveSettings({
      local: createMemoryStorage(),
      shared: { backend: 'rpc-gateway', cache: null },
      sharedWorkerAvailable: true,
      preferLocal: true,
    });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });

  it('As a visitor, I follow a shared link and its cache switches win over both stores', () => {
    // Given
    const local = createMemoryStorage({ entries: { [CACHE_KEY]: CACHE_OFF } });
    const url = parseSettingsFromSearch(new URLSearchParams('skipCidCache=0&skipWorkerCache=1'));

    // When
    const { settings } = resolveSettings({
      local,
      shared: { backend: null, cache: CACHE_OFF },
      url,
      sharedWorkerAvailable: true,
    });

    // Then the link sets two switches and the stored one it leaves out stays
    expect(settings.cache).toEqual({ skipCidCache: false, skipArchiveCache: true, skipWorkerCache: true });
  });

  it('As a visitor, I follow a link to a network this build does not know and get the stored one', () => {
    // Given
    const local = createMemoryStorage({ entries: { [NETWORK_KEY]: 'previewnet' } });
    const url = parseSettingsFromSearch(new URLSearchParams('network=kusama'));

    // When
    const { settings } = resolveSettings({
      local,
      shared: null,
      url,
      sharedWorkerAvailable: true,
    });

    // Then
    expect(url.network).toBeNull();
    expect(settings.network).toBe('previewnet');
  });

  it('As a visitor with a valid backend and a stale old mode key, I return and the backend I chose wins', () => {
    // Given
    const local = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-direct', 'dotli:mode': 'gateway' } });

    // When
    const { settings } = resolveSettings({ local, shared: null, sharedWorkerAvailable: true });

    // Then
    expect(settings.backend).toBe('smoldot-direct');
  });

  it('As a visitor whose browser lacks SharedWorker, I am told only when the shared light client was my choice', () => {
    // Given
    const sharedChoice = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-shared-worker' } });
    const perTabChoice = createMemoryStorage({ entries: { [BACKEND_KEY]: 'smoldot-direct' } });

    // When
    const fellBack = resolveSettings({ local: sharedChoice, shared: null, sharedWorkerAvailable: false });
    const kept = resolveSettings({ local: perTabChoice, shared: null, sharedWorkerAvailable: false });

    // Then
    expect(fellBack).toMatchObject({ settings: { backend: 'smoldot-direct' }, sharedWorkerFallback: true });
    expect(kept).toMatchObject({ settings: { backend: 'smoldot-direct' }, sharedWorkerFallback: false });
  });
});
