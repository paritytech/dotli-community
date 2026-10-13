// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of index.ts, which must stay pure re-exports for rolldown to drop unused ones from a chunk.

import type * as VerifyNamespace from './verify.js';

/** On first use, so the host's entry stays free of the hashing code. */
export type VerifyModule = typeof VerifyNamespace;
export const loadVerify = (): Promise<VerifyModule> => import('./verify.js');
