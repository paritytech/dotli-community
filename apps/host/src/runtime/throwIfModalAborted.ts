// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The AbortError a disposed blocking modal scope ends its prompts with.

import { toAbortError } from '@dotli/shared';

const BLOCKING_MODAL_DISPOSED = 'Blocking modal scope disposed';

/** Throws the scope's AbortError once `signal` has aborted, and returns otherwise. */
export function throwIfModalAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw toBlockingModalAbortError(signal.reason);
  }
}

/**
 * Returns `reason` when it is an AbortError, else a new one with `reason` as its message when it is a string, or the
 * disposed scope's message. Never throws.
 */
export function toBlockingModalAbortError(reason?: unknown): DOMException {
  return toAbortError(reason, BLOCKING_MODAL_DISPOSED);
}
