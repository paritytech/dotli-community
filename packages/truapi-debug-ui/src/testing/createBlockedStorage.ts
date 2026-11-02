// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSafeStorage } from '@dotli/shared';
import type { PanelStorage } from '../model/panelStorage.js';

/** The page's storage where the browser blocks it, as in Safari private mode. Never throws. */
export function createBlockedStorage(): PanelStorage {
  return createSafeStorage(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
}
