// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BACKEND_KEY, backendRunnable, configureModeStorage, defaultBackend, isSharedWorkerAvailable } from './mode.js';
import { memoryModeStorage, type MemoryModeStorage } from './mode.fake.js';

describe('isSharedWorkerAvailable', () => {
  it('As a host on a browser with SharedWorker, I detect the shared light client can run', () => {
    // Given
    const scope = {
      SharedWorker: class {
        readonly port: unknown = null;
      },
    };

    // When
    const available = isSharedWorkerAvailable(scope);

    // Then
    expect(available).toBe(true);
  });

  it('As a host on a browser without SharedWorker, I detect the shared light client cannot run', () => {
    // When
    const available = isSharedWorkerAvailable({});

    // Then
    expect(available).toBe(false);
  });
});

describe('defaultBackend', () => {
  it('As a new visitor, I start on the per-tab light client whether or not my browser has SharedWorker', () => {
    // When / Then
    expect(defaultBackend()).toBe('smoldot-direct');
  });
});

// `getBackend` is `backendRunnable` fed the detection above.
describe('getBackend', () => {
  let storage: MemoryModeStorage;
  let restoreStorage: () => void;

  beforeEach(() => {
    storage = memoryModeStorage();
    restoreStorage = configureModeStorage(storage);
  });

  afterEach(() => {
    restoreStorage();
  });

  it('As a first-time visitor on a browser with SharedWorker, I read the light client per tab and nothing is stored', () => {
    // When
    const backend = backendRunnable(true);

    // Then
    expect(backend).toBe('smoldot-direct');
    expect(storage.dump()).toEqual({});
  });

  it('As a first-time visitor on a browser without SharedWorker, I read the light client per tab and nothing is stored', () => {
    // When
    const backend = backendRunnable(false);

    // Then
    expect(backend).toBe('smoldot-direct');
    expect(storage.dump()).toEqual({});
  });

  it('As a visitor whose browser lost SharedWorker, I read the light client per tab and my stored choice stays', () => {
    // Given
    storage.setItem(BACKEND_KEY, 'smoldot-shared-worker');

    // When
    const backend = backendRunnable(false);

    // Then
    expect(backend).toBe('smoldot-direct');
    expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-shared-worker');
  });

  it('As a returning visitor on the light client per tab, I read my choice even where SharedWorker exists', () => {
    // Given
    storage.setItem(BACKEND_KEY, 'smoldot-direct');

    // When
    const backend = backendRunnable(true);

    // Then
    expect(backend).toBe('smoldot-direct');
  });

  it('As a returning visitor on the shared light client, I read my choice where SharedWorker exists', () => {
    // Given
    storage.setItem(BACKEND_KEY, 'smoldot-shared-worker');

    // When
    const backend = backendRunnable(true);

    // Then
    expect(backend).toBe('smoldot-shared-worker');
  });

  it('As a visitor from an old build, I read the backend my old mode key names and the old key stays until boot moves it', () => {
    // Given
    storage.setItem('dotli:mode', 'gateway');

    // When
    const backend = backendRunnable(false);

    // Then
    expect(backend).toBe('rpc-gateway');
    expect(storage.dump()).toEqual({ 'dotli:mode': 'gateway' });
  });
});
