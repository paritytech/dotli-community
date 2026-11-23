// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Opens no storage, as when the browser blocks it. Throws a SecurityError. */
export function openBlocked(): Storage {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}
