// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The record exists but its key no longer opens it, so it can never be used again. */
export class LocalWalletUnreadableError extends Error {
  override readonly name = 'LocalWalletUnreadableError';

  constructor(cause: unknown) {
    super('Local wallet cannot be decrypted', { cause });
  }
}
