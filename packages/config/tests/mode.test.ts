// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BACKEND_KEY,
  LOCAL_WALLET_KEY,
  configureModeStorage,
  defaultLocalWalletEnabled,
  defaultBackend,
  getBackend,
  getLocalWalletEnabled,
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

describe('getLocalWalletEnabled', () => {
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

  it('keeps the production site opt-in and enables test and local sites by default', () => {
    expect(defaultLocalWalletEnabled('dot.li')).toBe(false);
    expect(defaultLocalWalletEnabled('paseo.fyi')).toBe(true);
    expect(defaultLocalWalletEnabled('paseo.li')).toBe(true);
    expect(defaultLocalWalletEnabled('paseoli.dev')).toBe(true);
    expect(defaultLocalWalletEnabled('local.li')).toBe(true);
  });

  it('honors an explicit browser preference on every site', () => {
    storage.setItem(LOCAL_WALLET_KEY, '1');
    expect(getLocalWalletEnabled('dot.li')).toBe(true);

    storage.setItem(LOCAL_WALLET_KEY, '0');
    expect(getLocalWalletEnabled('paseo.fyi')).toBe(false);
  });

  it('falls back to the site default for an unknown stored value', () => {
    storage.setItem(LOCAL_WALLET_KEY, 'yes');
    expect(getLocalWalletEnabled('dot.li')).toBe(false);
    expect(getLocalWalletEnabled('paseoli.dev')).toBe(true);
  });
});
