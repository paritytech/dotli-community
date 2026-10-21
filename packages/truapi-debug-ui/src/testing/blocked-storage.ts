// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { safeStorage } from '@dotli/shared';
import type { PanelStorage } from '../model/section-storage.js';

/** The page's storage where the browser blocks it, as in Safari private mode. */
export function blockedStorage(): PanelStorage {
  return safeStorage(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
}
