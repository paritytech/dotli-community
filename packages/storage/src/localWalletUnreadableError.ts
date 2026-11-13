// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The record exists but its key no longer opens it, so it can never be used again. */
export class LocalWalletUnreadableError extends Error {
  override readonly name = 'LocalWalletUnreadableError';
  /** The unreadable record's version, so a forget drops that record and not one saved since. */
  readonly version: Uint8Array;

  constructor(cause: unknown, version: Uint8Array) {
    super('Local wallet cannot be decrypted', { cause });
    this.version = version;
  }
}
