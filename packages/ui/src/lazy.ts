// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points of the package, re-exported from index.ts. Each module
// is its own chunk, fetched on first call. They live apart from the barrel
// so index.ts stays pure re-exports, which rolldown's lazy barrel
// optimization needs to leave unused re-exports out of an importer's chunk.

import type * as BridgeNamespace from './bridge.js';
import type * as HostChainNamespace from './host-callbacks/Chain.js';
import type * as SharedModeNamespace from './shared-mode.js';
import type * as TruapiDebugMountNamespace from './components/truapi-debug/mount.js';

export type BridgeModule = typeof BridgeNamespace;
export const loadBridge = (): Promise<BridgeModule> => import('./bridge.js');
export type TruapiDebugMountModule = typeof TruapiDebugMountNamespace;
export const loadTruapiDebugMount = (): Promise<TruapiDebugMountModule> => import('./components/truapi-debug/mount.js');
export type SharedModeModule = typeof SharedModeNamespace;
export const loadSharedMode = (): Promise<SharedModeModule> => import('./shared-mode.js');
export type HostChainModule = typeof HostChainNamespace;
export const loadHostChain = (): Promise<HostChainModule> => import('./host-callbacks/Chain.js');
