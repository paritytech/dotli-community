// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModeStorage } from './mode.js';

export interface MemoryModeStorage extends ModeStorage {
  dump: () => Record<string, string>;
}

/** A mode store held in memory, seeded with `seed`, whose `dump` shows what was written. */
export function memoryModeStorage(seed: Record<string, string> = {}): MemoryModeStorage {
  const map = new Map<string, string>(Object.entries(seed));
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
