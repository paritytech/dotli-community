// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of index.ts, which must stay pure re-exports for rolldown to drop unused ones from a chunk.

import type * as ProviderNamespace from './provider.js';
import type * as ResolveNamespace from './resolve.js';
import type * as RpcResolveNamespace from './rpc-resolve.js';

export type ProviderModule = typeof ProviderNamespace;
export const loadProvider = (): Promise<ProviderModule> => import('./provider.js');
export type ResolveModule = typeof ResolveNamespace;
export const loadResolve = (): Promise<ResolveModule> => import('./resolve.js');
export type RpcResolveModule = typeof RpcResolveNamespace;
export const loadRpcResolve = (): Promise<RpcResolveModule> => import('./rpc-resolve.js');
