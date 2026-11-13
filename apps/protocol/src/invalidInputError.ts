// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A call named a site or key that does not check, so the frame refused it before touching storage. */
export class InvalidInputError extends Error {
  override readonly name = 'InvalidInputError';
}
