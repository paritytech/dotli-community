// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The chainHead follow stopped, so the caller must redial. Distinct from a `null` unset slot. */
export class ApiStoppedError extends Error {
  override readonly name = 'ApiStoppedError';

  constructor(cause?: unknown) {
    super('chainHead follow stopped', { cause });
  }
}
