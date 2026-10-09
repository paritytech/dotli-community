// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BACKEND_KEY,
  CACHE_NODES_KEY,
  configureModeStorage,
  defaultBackend,
  getBackend,
  getCacheNodeSettings,
  isSharedWorkerAvailable,
  type ModeStorage,
} from '../src/mode.js';

function makeMemoryStorage(): ModeStorage & {
  dump: () => Record<string, string>;
} {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: key => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

const globalAny = globalThis as { SharedWorker?: unknown };

function installSharedWorker(): () => void {
  const hadPrior = 'SharedWorker' in globalAny;
  const prior = globalAny.SharedWorker;
  globalAny.SharedWorker = class {
    readonly port: unknown = null;
  };
  return () => {
    if (hadPrior) {
      globalAny.SharedWorker = prior;
    } else {
      delete globalAny.SharedWorker;
    }
  };
}

function ensureNoSharedWorker(): () => void {
  const hadPrior = 'SharedWorker' in globalAny;
  const prior = globalAny.SharedWorker;
  if (hadPrior) {
    delete globalAny.SharedWorker;
  }
  return () => {
    if (hadPrior) {
      globalAny.SharedWorker = prior;
    }
  };
}

describe('isSharedWorkerAvailable', () => {
  it('returns true when SharedWorker is defined', () => {
    const restore = installSharedWorker();
    try {
      expect(isSharedWorkerAvailable()).toBe(true);
    } finally {
      restore();
    }
  });

  it('returns false when SharedWorker is undefined', () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(isSharedWorkerAvailable()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('defaultBackend', () => {
  it('returns smoldot-direct even when SharedWorker is available', () => {
    const restore = installSharedWorker();
    try {
      expect(defaultBackend()).toBe('smoldot-direct');
    } finally {
      restore();
    }
  });

  it('returns smoldot-direct when SharedWorker is missing', () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(defaultBackend()).toBe('smoldot-direct');
    } finally {
      restore();
    }
  });
});

describe('getBackend', () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    configureModeStorage(storage);
  });

  afterEach(() => {
    configureModeStorage({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  it('seeds smoldot-direct on first visit even when SharedWorker is supported', () => {
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe('smoldot-direct');
      expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-direct');
    } finally {
      restore();
    }
  });

  it('seeds smoldot-direct on first visit when SharedWorker is missing', () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(getBackend()).toBe('smoldot-direct');
      expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-direct');
    } finally {
      restore();
    }
  });

  it('downgrades persisted smoldot-shared-worker and clears the key when unsupported', () => {
    storage.setItem(BACKEND_KEY, 'smoldot-shared-worker');
    const restore = ensureNoSharedWorker();
    try {
      expect(getBackend()).toBe('smoldot-direct');
      expect(storage.dump()[BACKEND_KEY]).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('keeps persisted smoldot-direct untouched even when SharedWorker is available', () => {
    storage.setItem(BACKEND_KEY, 'smoldot-direct');
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe('smoldot-direct');
      expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-direct');
    } finally {
      restore();
    }
  });

  it('keeps persisted smoldot-shared-worker untouched when supported', () => {
    storage.setItem(BACKEND_KEY, 'smoldot-shared-worker');
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe('smoldot-shared-worker');
      expect(storage.dump()[BACKEND_KEY]).toBe('smoldot-shared-worker');
    } finally {
      restore();
    }
  });
});

describe('getCacheNodeSettings', () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    configureModeStorage(storage);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configureModeStorage({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  it('As a user of a demo deployment, I read through its cache nodes until I change the setting', () => {
    // Given a build that names a provider set
    vi.stubEnv('VITE_CACHE_PROVIDERS_URL', 'https://cache.example/providers');

    // When the user has no setting yet, and then turns the setting off
    const first = getCacheNodeSettings();
    storage.setItem(CACHE_NODES_KEY, JSON.stringify({ enabled: false }));
    const changed = getCacheNodeSettings();

    // Then the build's provider set is on by default, and the stored choice wins over it
    expect({ first, changed }).toEqual({
      first: { enabled: true, providersUrl: 'https://cache.example/providers', payerSeed: '' },
      changed: { enabled: false, providersUrl: 'https://cache.example/providers', payerSeed: '' },
    });
  });

  it('As a user of a build without a provider set, cache nodes stay off', () => {
    // Given a build without VITE_CACHE_PROVIDERS_URL
    vi.stubEnv('VITE_CACHE_PROVIDERS_URL', '');

    // When / Then
    expect(getCacheNodeSettings()).toEqual({ enabled: false, providersUrl: '', payerSeed: '' });
  });
});
