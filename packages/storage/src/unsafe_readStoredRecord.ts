// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A value read back from one of this package's databases, typed as the record the caller stored there. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the stored shape
export function unsafe_readStoredRecord<Stored>(value: unknown): Stored {
  // Only this package writes these databases, so a record has the shape it was written in.
  return value as Stored;
}
