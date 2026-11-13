// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { SANDBOX_TIMEOUTS } from './timeouts.js';

/** Each ends the load, since nothing can be served without a Service Worker controller. */
export const SANDBOX_ERRORS = {
  SW_ARCHIVE_NOT_ACKNOWLEDGED: `Service worker did not acknowledge archive within ${String(SANDBOX_TIMEOUTS.SW_ARCHIVE_ACK / 1000)}s`,
  SW_ARCHIVE_NOT_SENT: 'Service worker could not be handed the archive',
  SW_NOT_CONTROLLING: 'No service worker controls the page, so the archive cannot be served',
} as const;

/** The visitor closed the password prompt without a password, which is their choice, not a defect. */
export class DecryptionCancelledError extends Error {
  override name = 'DecryptionCancelledError';

  constructor() {
    super('User cancelled decryption');
  }
}
