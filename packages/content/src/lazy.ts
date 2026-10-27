// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of index.ts, which must stay pure re-exports for rolldown to drop unused ones from a chunk.

import type * as VerifyNamespace from './verify.js';

export type VerifyModule = typeof VerifyNamespace;

/** Loads the hashing code on first use, so the host's entry stays free of it. Rejects when the chunk fails to load. */
export function loadVerify(): Promise<VerifyModule> {
  return import('./verify.js');
}
