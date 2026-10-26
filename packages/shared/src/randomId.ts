// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A random UUID, or a time-based id where the page is not a secure context, such as a phone checking the chrome over a
 * plain http LAN address, which has no `crypto.randomUUID`. Ids tie a flow's events together and identify nobody.
 */
export function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${String(Date.now())}-${String(Math.random()).slice(2, 10)}`;
}
