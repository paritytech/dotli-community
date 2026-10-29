// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSafeStorage, type SafeStorage } from '@dotli/shared';

/** Returns a storage whose every access throws a SecurityError, as when the browser blocks it. */
export function createBlockedStorage(): SafeStorage {
  return createSafeStorage(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}
