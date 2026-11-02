// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A replacement core that could not boot, already reported by the page core. */
export class CoreRedialError extends Error {
  override name = 'CoreRedialError';

  constructor(error: unknown) {
    super('The replacement wallet core could not boot', { cause: error });
  }
}
