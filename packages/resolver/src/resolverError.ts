// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Dashboards and Sentry filters read these verbatim, so a rename breaks them. */
export type ResolverErrorName =
  | 'PartialStorageReadError'
  | 'CorruptBytesSlotError'
  | 'UnsupportedContenthashCodecError'
  | 'ContenthashDecodeError'
  | 'NetworkSyncTimeoutError';

/** The base of every failure a resolution reports by name. */
export abstract class ResolverError extends Error {
  abstract override readonly name: ResolverErrorName;
}
