// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the product page boot leaves them out.

import type * as AccountContentNamespace from './components/account/AccountContent.js';
import type { HostBridge } from './runtime/bridge.js';
import type * as ChainsContentNamespace from './components/chains/ChainsContent.js';
import type * as ChatPanelNamespace from './components/chat/ChatPanel.js';
import type * as DebugPanelHostNamespace from './debugPanelHost.js';
import type * as HostWebNamespace from '@parity/truapi-host/web';
import type * as HostWorkerNamespace from '@parity/truapi-host/worker-runtime?worker';
import type * as LocalWalletCoreNamespace from './runtime/localWalletCore.js';
import type * as PermissionsContentNamespace from './components/permissions/PermissionsContent.js';
import type * as PhraseScreenNamespace from './components/account/PhraseScreen.js';
import type * as PolkadotApiNamespace from 'polkadot-api';
import type * as ProductCardNamespace from './components/productCard/ProductCard.js';
import type * as QrCodeNamespace from 'qrcode';
import type * as RecoveryPhraseNamespace from './runtime/recoveryPhrase.js';
import type * as SettingsContentNamespace from './components/settings/SettingsContent.js';
import type * as SignersCommonNamespace from '@polkadot-api/signers-common';
import type * as ViolationPanelMountNamespace from './components/sandboxChecker/mount.js';
import type * as WireDescriberNamespace from './runtime/debugWireDescribe.js';

/** The published host runtime's chunk: its web build and the constructor of its worker. */
type HostRuntimeChunk = {
  web: typeof HostWebNamespace;
  HostWorker: typeof HostWorkerNamespace.default;
};

/** `qrcode` is CommonJS, so its dynamic import also carries the whole module as `default`. */
type QrCodeModule = typeof QrCodeNamespace & { default: typeof QrCodeNamespace };

export type ChatPanelModule = typeof ChatPanelNamespace;
export type LocalWalletCoreModule = typeof LocalWalletCoreNamespace;
export type PhraseScreenModule = typeof PhraseScreenNamespace;

/** The page as the debug panel reads it. Rejects when its chunk fails to load. */
export async function loadDebugPanelHost(): Promise<typeof DebugPanelHostNamespace.debugPanelHost> {
  return (await import('./debugPanelHost.js')).debugPanelHost;
}

/**
 * Debug mode only. It reads every TrUAPI codec by name, so the bridge must not carry it. Rejects when its chunk fails
 * to load.
 */
export function loadWireDescriber(): Promise<typeof WireDescriberNamespace> {
  return import('./runtime/debugWireDescribe.js');
}

// The host's own views, each its own chunk, for panels and pages a visit may never open.
/** The chat panel. Rejects when its chunk fails to load. */
export function loadChatPanel(): Promise<ChatPanelModule> {
  return import('./components/chat/ChatPanel.js');
}

/** The account view. Rejects when its chunk fails to load. */
export function loadAccountContent(): Promise<typeof AccountContentNamespace> {
  return import('./components/account/AccountContent.js');
}
/** The chains view. Rejects when its chunk fails to load. */
export function loadChainsContent(): Promise<typeof ChainsContentNamespace> {
  return import('./components/chains/ChainsContent.js');
}
/** The product card. Rejects when its chunk fails to load. */
export function loadProductCard(): Promise<typeof ProductCardNamespace> {
  return import('./components/productCard/ProductCard.js');
}
/** The permissions view. Rejects when its chunk fails to load. */
export function loadPermissionsContent(): Promise<typeof PermissionsContentNamespace> {
  return import('./components/permissions/PermissionsContent.js');
}
/** The settings view. Rejects when its chunk fails to load. */
export function loadSettingsContent(): Promise<typeof SettingsContentNamespace> {
  return import('./components/settings/SettingsContent.js');
}

/** Sandbox checker builds only. Rejects when its chunk fails to load. */
export function loadViolationPanelMount(): Promise<typeof ViolationPanelMountNamespace> {
  return import('./components/sandboxChecker/mount.js');
}

/** The TrUAPI bridge and the dialogs it asks with. Rejects when its chunk fails to load. */
export async function loadHostBridge(): Promise<HostBridge> {
  return (await import('./runtime/bridge.js')).hostBridge;
}
/** The signing worker's constructor. Rejects when its chunk fails to load. */
export function loadSigningWorker(): Promise<{ default: new () => Worker }> {
  return import('./runtime/signingWorker.js?worker');
}
/** The recovery phrase check, which only a phrase import needs. Rejects when its chunk fails to load. */
export function loadRecoveryPhrase(): Promise<typeof RecoveryPhraseNamespace> {
  return import('./runtime/recoveryPhrase.js');
}
/** The debug-only recovery phrase form, which only a phrase view shows. Rejects when its chunk fails to load. */
export function loadPhraseScreen(): Promise<PhraseScreenModule> {
  return import('./components/account/PhraseScreen.js');
}
/** The in-page wallet core. Rejects when its chunk fails to load. */
export function loadLocalWalletCore(): Promise<LocalWalletCoreModule> {
  return import('./runtime/localWalletCore.js');
}

/**
 * The published host runtime and its worker, which every core boots on and the product frame mounts with. Rejects
 * when either chunk fails to load.
 */
export async function loadHostRuntimeChunk(): Promise<HostRuntimeChunk> {
  const [web, worker] = await Promise.all([
    import('@parity/truapi-host/web'),
    import('@parity/truapi-host/worker-runtime?worker'),
  ]);
  return { web, HostWorker: worker.default };
}

/** The chain client, for the reads a visit may never make. Rejects when its chunk fails to load. */
export function loadPolkadotApi(): Promise<typeof PolkadotApiNamespace> {
  return import('polkadot-api');
}

/**
 * papi's transaction extension fillers, for the first transaction a site asks to sign. Rejects when its chunk fails to
 * load.
 */
export function loadTxFillers(): Promise<typeof SignersCommonNamespace> {
  return import('@polkadot-api/signers-common');
}

/** The QR encoder, for the first code a visit shows. Rejects when its chunk fails to load. */
export function loadQrCode(): Promise<QrCodeModule> {
  return import('qrcode');
}
