// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { BACKEND_KEY, configureModeStorage, type ModeStorage } from './mode.js';
import { memoryModeStorage } from './mode.fake.js';
import { NETWORK_KEY, NetworkName, getNetwork, setNetwork, setNetworkOverride } from './network.js';
import { persistDefaults } from './persist-defaults.js';

let restoreStorage: (() => void) | null = null;

/** Points the settings at `storage` until the test ends. */
function useStorage(storage: ModeStorage): void {
  restoreStorage = configureModeStorage(storage);
}

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
});

describe('persistDefaults', () => {
  it('As a first-time visitor, I boot and the default backend and network are stored', () => {
    // Given
    const storage = memoryModeStorage();
    useStorage(storage);

    // When
    persistDefaults();

    // Then
    expect(storage.dump()).toEqual({ [BACKEND_KEY]: 'smoldot-direct', [NETWORK_KEY]: NetworkName.PASEO });
  });

  it('As a returning visitor, I boot and keep the backend and network I chose', () => {
    // Given
    const storage = memoryModeStorage({ [BACKEND_KEY]: 'rpc-gateway', [NETWORK_KEY]: NetworkName.PREVIEWNET });
    useStorage(storage);

    // When
    persistDefaults();

    // Then
    expect(storage.dump()).toEqual({ [BACKEND_KEY]: 'rpc-gateway', [NETWORK_KEY]: NetworkName.PREVIEWNET });
  });

  it('As a visitor from an old build, I boot and my old mode key moves to the backend key', () => {
    // Given
    const storage = memoryModeStorage({ 'dotli:mode': 'gateway', [NETWORK_KEY]: NetworkName.PASEO });
    useStorage(storage);

    // When
    persistDefaults();

    // Then
    expect(storage.dump()).toEqual({ [BACKEND_KEY]: 'rpc-gateway', [NETWORK_KEY]: NetworkName.PASEO });
  });

  it('As a visitor whose browser lost SharedWorker, I boot and the backend that runs here is stored', () => {
    // Given
    const storage = memoryModeStorage({ [BACKEND_KEY]: 'smoldot-shared-worker', [NETWORK_KEY]: NetworkName.PASEO });
    useStorage(storage);

    // When
    persistDefaults(false);

    // Then
    expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-direct');
  });

  it('As a visitor with a network this build no longer offers, I boot and the default network is stored', () => {
    // Given
    const storage = memoryModeStorage({ [BACKEND_KEY]: 'smoldot-direct', [NETWORK_KEY]: 'kusama' });
    useStorage(storage);

    // When
    persistDefaults();

    // Then
    expect(storage.dump()[NETWORK_KEY]).toBe(NetworkName.PASEO);
  });

  it('As a visitor on a browser with SharedWorker, I boot and keep my shared light client choice', () => {
    // Given
    const storage = memoryModeStorage({ [BACKEND_KEY]: 'smoldot-shared-worker', [NETWORK_KEY]: NetworkName.PASEO });
    useStorage(storage);

    // When
    persistDefaults(true);

    // Then
    expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-shared-worker');
  });

  it('As a context told its network by the host, I boot and the override is never stored', () => {
    // Given
    const storage = memoryModeStorage();
    useStorage(storage);
    const clearOverride = setNetworkOverride(NetworkName.PREVIEWNET);

    try {
      // When
      persistDefaults();

      // Then
      expect(getNetwork()).toBe(NetworkName.PREVIEWNET);
      expect(storage.dump()[NETWORK_KEY]).toBe(NetworkName.PASEO);
    } finally {
      clearOverride();
    }
  });
});

describe('the network setting', () => {
  it('As a first-time visitor, I read the network and get the default, and nothing is stored', () => {
    // Given
    const storage = memoryModeStorage();
    useStorage(storage);

    // When
    const network = getNetwork();

    // Then
    expect(network).toBe(NetworkName.PASEO);
    expect(storage.dump()).toEqual({});
  });

  it('As a host whose mode storage is configured, I read and write my network choice through it', () => {
    // Given the store the page started with, then the host's own
    const pageStore = memoryModeStorage();
    useStorage(pageStore);
    const hostStore = memoryModeStorage();
    configureModeStorage(hostStore);

    // When
    setNetwork(NetworkName.PREVIEWNET);

    // Then
    expect(getNetwork()).toBe(NetworkName.PREVIEWNET);
    expect(hostStore.dump()[NETWORK_KEY]).toBe(NetworkName.PREVIEWNET);
    expect(pageStore.dump()).toEqual({});
  });
});
