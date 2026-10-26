// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An abort reason as the AbortError a caller rejects with. An AbortError passes through, a string becomes its
 * message, and any other reason takes `fallbackMessage`.
 */
export function toAbortError(reason: unknown, fallbackMessage: string): DOMException {
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return reason;
  }
  return new DOMException(typeof reason === 'string' ? reason : fallbackMessage, 'AbortError');
}
