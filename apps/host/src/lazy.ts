// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the product page boot leaves them out.

import type * as BridgeNamespace from './runtime/bridge.js';
import type * as DebugPanelHostNamespace from './debug-panel-host.js';
import type * as LocalWalletCoreNamespace from './runtime/local-wallet-core.js';
import type * as WorkboxWindowNamespace from 'workbox-window';

export type DebugPanelHostModule = typeof DebugPanelHostNamespace;
export const loadDebugPanelHost = (): Promise<DebugPanelHostModule> => import('./debug-panel-host.js');

/** Debug mode only. It reads every TrUAPI codec by name, so the bridge must not carry it. */
export const loadWireDescriber = () => import('./runtime/debug-wire-describe.js');

// The host's own views, each its own chunk, for panels and pages a visit may never open.
export const loadChatPanel = () => import('./components/chat/ChatPanel.js');
export type ChatPanelModule = Awaited<ReturnType<typeof loadChatPanel>>;

export const loadAccountContent = () => import('./components/account/AccountContent.js');
export const loadChainsContent = () => import('./components/chains/ChainsContent.js');
export const loadPermissionsContent = () => import('./components/permissions/PermissionsContent.js');
export const loadSettingsContent = () => import('./components/settings/SettingsContent.js');

/** Sandbox checker builds only. */
export const loadViolationPanelMount = () => import('./components/sandbox-checker/mount.js');

export type WorkboxWindowModule = typeof WorkboxWindowNamespace;
export const loadWorkboxWindow = (): Promise<WorkboxWindowModule> => import('workbox-window');

export type BridgeModule = typeof BridgeNamespace;
export const loadBridge = (): Promise<BridgeModule> => import('./runtime/bridge.js');
export const loadSigningWorker = (): Promise<{ default: new () => Worker }> =>
  import('./runtime/signing-worker.js?worker');
export type LocalWalletCoreModule = typeof LocalWalletCoreNamespace;
export const loadLocalWalletCore = (): Promise<LocalWalletCoreModule> => import('./runtime/local-wallet-core.js');
