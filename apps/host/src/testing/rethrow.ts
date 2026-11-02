// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Throws what it is told, so a failure the code under test reports fails the spec. */
export function rethrow(error: unknown): never {
  throw error;
}
