// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PanelStorage } from '../model/section-storage.js';

/** A storage that throws on every call, as in Safari private mode. */
export function blockedStorage(): PanelStorage {
  return {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
  };
}
