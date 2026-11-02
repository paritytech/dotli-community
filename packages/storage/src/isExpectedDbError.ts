// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IdbOpenBlockedError } from '@dotli/shared';

/**
 * Whether `error` is a connection closing under unload or another tab's upgrade, or an open blocked by an older tab,
 * which are not faults.
 */
export function isExpectedDbError(error: unknown): boolean {
  if (error instanceof IdbOpenBlockedError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  // The browser's error carries only a name and a message, and browsers word the message differently ("is closing",
  // "is no longer usable").
  return (error.name === 'InvalidStateError' || error.name === 'AbortError') && /clos|no longer/i.test(error.message);
}
