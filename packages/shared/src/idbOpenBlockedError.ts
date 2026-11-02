// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** An IndexedDB open that an older tab's connection blocks, rejected rather than left hanging. */
export class IdbOpenBlockedError extends Error {
  override readonly name = 'IdbOpenBlockedError';
  readonly databaseName: string;

  constructor(databaseName: string) {
    super(`Failed to open ${databaseName} DB: blocked by another tab`);
    this.databaseName = databaseName;
  }
}
