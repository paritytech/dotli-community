// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk. They live apart from index.ts so the barrel stays pure
// re-exports, which rolldown's lazy barrel optimization needs to drop unused ones.

import type * as BridgeNamespace from './bridge.js';
import type * as LocalWalletCoreNamespace from './local-wallet-core.js';
import type * as SharedModeNamespace from './shared-mode.js';
import type * as TruapiDebugMountNamespace from './components/truapi-debug/mount.js';

export type BridgeModule = typeof BridgeNamespace;
export const loadBridge = (): Promise<BridgeModule> => import('./bridge.js');
export type TruapiDebugMountModule = typeof TruapiDebugMountNamespace;
export const loadTruapiDebugMount = (): Promise<TruapiDebugMountModule> => import('./components/truapi-debug/mount.js');
export type SharedModeModule = typeof SharedModeNamespace;
export const loadSharedMode = (): Promise<SharedModeModule> => import('./shared-mode.js');
export const loadSigningWorker = (): Promise<{ default: new () => Worker }> => import('./signing-worker.js?worker');

export type LocalWalletCoreModule = typeof LocalWalletCoreNamespace;
export const loadLocalWalletCore = (): Promise<LocalWalletCoreModule> => import('./local-wallet-core.js');
