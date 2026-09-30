// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BACKEND_KEY,
  POLKAVM_APPS_KEY,
  configureModeStorage,
  defaultBackend,
  getBackend,
  getPolkaVmAppsEnabled,
  isSharedWorkerAvailable,
  setPolkaVmAppsEnabled,
  type ModeStorage,
} from "@dotli/config/mode";

interface MemoryStorage extends ModeStorage {
  dump: () => Record<string, string>;
}

function makeMemoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

const globalAny = globalThis as { SharedWorker?: unknown };

function installSharedWorker(): () => void {
  const hadPrior = "SharedWorker" in globalAny;
  const prior = globalAny.SharedWorker;
  globalAny.SharedWorker = class {};
  return () => {
    if (hadPrior) {
      globalAny.SharedWorker = prior;
    } else {
      delete globalAny.SharedWorker;
    }
  };
}

function ensureNoSharedWorker(): () => void {
  const hadPrior = "SharedWorker" in globalAny;
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

describe("isSharedWorkerAvailable", () => {
  it("returns true when SharedWorker is defined", () => {
    const restore = installSharedWorker();
    try {
      expect(isSharedWorkerAvailable()).toBe(true);
    } finally {
      restore();
    }
  });

  it("returns false when SharedWorker is undefined", () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(isSharedWorkerAvailable()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("defaultBackend", () => {
  it("returns smoldot-direct even when SharedWorker is available", () => {
    const restore = installSharedWorker();
    try {
      expect(defaultBackend()).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });

  it("returns smoldot-direct when SharedWorker is missing", () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(defaultBackend()).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });
});

describe("getBackend", () => {
  let storage: MemoryStorage;

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

  it("seeds smoldot-direct on first visit even when SharedWorker is supported", () => {
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });

  it("seeds smoldot-direct on first visit when SharedWorker is missing", () => {
    const restore = ensureNoSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });

  it("downgrades persisted smoldot-shared-worker and clears the key when unsupported", () => {
    storage.setItem(BACKEND_KEY, "smoldot-shared-worker");
    const restore = ensureNoSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("keeps persisted smoldot-direct untouched even when SharedWorker is available", () => {
    storage.setItem(BACKEND_KEY, "smoldot-direct");
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-direct");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-direct");
    } finally {
      restore();
    }
  });

  it("keeps persisted smoldot-shared-worker untouched when supported", () => {
    storage.setItem(BACKEND_KEY, "smoldot-shared-worker");
    const restore = installSharedWorker();
    try {
      expect(getBackend()).toBe("smoldot-shared-worker");
      expect(storage.dump()[BACKEND_KEY]).toBe("smoldot-shared-worker");
    } finally {
      restore();
    }
  });
});

describe("PolkaVM apps setting", () => {
  let storage: MemoryStorage;

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

  it.each([
    ["dot.li", false],
    ["paseo.fyi", true],
    ["paseo.li", true],
    ["testnet.li", true],
    ["local.li", true],
  ] as const)(
    "uses the %s default unless the user explicitly chooses",
    (siteId, enabledByDefault) => {
      expect(getPolkaVmAppsEnabled(siteId)).toBe(enabledByDefault);

      setPolkaVmAppsEnabled(false);
      expect(getPolkaVmAppsEnabled(siteId)).toBe(false);

      setPolkaVmAppsEnabled(true);
      expect(getPolkaVmAppsEnabled(siteId)).toBe(true);

      storage.setItem(POLKAVM_APPS_KEY, "yes");
      expect(getPolkaVmAppsEnabled(siteId)).toBe(enabledByDefault);

      storage.removeItem(POLKAVM_APPS_KEY);
      expect(getPolkaVmAppsEnabled(siteId)).toBe(enabledByDefault);
    },
  );
});
