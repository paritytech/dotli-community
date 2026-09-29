// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points of the package, re-exported from index.ts. Each module
// is its own chunk, fetched on first call. They live apart from the barrel
// so index.ts stays pure re-exports, which rolldown's lazy barrel
// optimization needs to leave unused re-exports out of an importer's chunk.

import type * as ProviderNamespace from "./provider.js";
import type * as ResolveNamespace from "./resolve.js";
import type * as RpcResolveNamespace from "./rpc-resolve.js";

export type ProviderModule = typeof ProviderNamespace;
export const loadProvider = (): Promise<ProviderModule> =>
  import("./provider.js");
export type ResolveModule = typeof ResolveNamespace;
export const loadResolve = (): Promise<ResolveModule> => import("./resolve.js");
export type RpcResolveModule = typeof RpcResolveNamespace;
export const loadRpcResolve = (): Promise<RpcResolveModule> =>
  import("./rpc-resolve.js");
