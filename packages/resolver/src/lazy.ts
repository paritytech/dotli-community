// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of index.ts, which must stay pure re-exports for rolldown to drop unused ones from a chunk.

import type * as ResolveNamespace from './resolve.js';

export type ResolveModule = typeof ResolveNamespace;
export const loadResolve = (): Promise<ResolveModule> => import('./resolve.js');
