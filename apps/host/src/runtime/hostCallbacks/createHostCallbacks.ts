// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each callback lives in its own file so dotli's UI and storage behaviour stays outside the Rust core.
// Product storage keys are opaque because the core owns product namespacing.

import type { ProductId } from '@parity/truapi';
import type { Permissions, RequiredHostCallbacks, UserConfirmation } from '@parity/truapi-host';
import { createNavigateTo } from './createNavigateTo.js';
import { createNotificationAdapters, type NotificationScheduler } from './createNotificationAdapters.js';
import { localStorageCallbacks } from './createLocalStorageCallbacks.js';
import { createProductOperations } from './createProductOperations.js';
import { createPreimageAdapters } from './createPreimageAdapters.js';
import { createChainConnect } from './createChainConnect.js';
import { createFeatureSupported } from './createFeatureSupported.js';
import { createSupportedChains } from './createSupportedChains.js';
import { createThemeSubscribe } from './createThemeSubscribe.js';
import { createLocaleSubscribe } from './createLocaleSubscribe.js';
import { createAuthStateChanged } from '../session/createAuthStateChanged.js';
import { createChatPlatform } from './createChatPlatform.js';
import { coreStorage } from '../session/createCoreStorage.js';
import type { CoreContext } from '../createPageCore.js';
import type { HostPrompts } from '../hostPrompts.js';

/** What one core's callbacks are built for. */
export type CoreCallbacksParams = {
  /** The core the callbacks serve. */
  core: CoreContext;
  /** The id the core parsed for the product. Throws until the core has parsed it. */
  getProductId: () => ProductId;
  /**
   * Keeps the core's session away from the stored session and the signed-in flag. The boot's answer, which also holds
   * the session in memory for a core on the local wallet, so it wins over `core.sessionInMemory`.
   */
  sessionInMemory: boolean;
};

/**
 * How a core's permission and confirmation asks are answered, given the core's own context. Never throws. The adapters
 * it returns reject as their types state.
 */
export type HostAsks = (core: CoreContext) => {
  permissions: Permissions;
  userConfirmation: Required<UserConfirmation>;
};

/** One core's params, plus what the callbacks ask the page for. */
type Params = CoreCallbacksParams & {
  /** The page's prompts, which show the user's notifications. */
  prompts: HostPrompts;
  /** Where push notifications wait until due. */
  notifications: NotificationScheduler;
  /** Builds the callbacks that answer the core's permission and confirmation asks. */
  createAsks: HostAsks;
};

/** Builds every callback one core requires, with the permission and confirmation callbacks taken from `createAsks`. */
export function createHostCallbacks({
  core,
  getProductId,
  sessionInMemory,
  prompts,
  notifications,
  createAsks,
}: Params): RequiredHostCallbacks {
  const { label, pairing } = core.product;
  const { permissions, userConfirmation } = createAsks(core);
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters({
      label,
      getProductId,
      scheduler: notifications,
      notify: prompts.notify,
    }),
    permissions,
    features: {
      featureSupported: createFeatureSupported(),
      supportedChains: createSupportedChains(),
    },
    // Every chain builds as V4. The V5-only extrinsics (allowances, PGAS claims, dotNS registrations) are built by
    // native cores alone, and Bulletin preimages, the browser core's own, are V4 on every host.
    extrinsicVersion: { transactionExtensionVersions: () => Promise.resolve({ chains: [] }) },
    productStorage: {
      read: localStorageCallbacks.read,
      write: localStorageCallbacks.write,
      clear: localStorageCallbacks.clear,
      subscribeStorage: localStorageCallbacks.subscribe,
    },
    productOperations: createProductOperations(),
    coreStorage: coreStorage.createAdapters({ sessionInMemory }),
    auth: {
      authStateChanged: createAuthStateChanged(pairing?.label ?? label, {
        dotSuffix: pairing?.dotSuffix,
        hostGlobal: pairing?.hostGlobal,
        isInService: core.isInService,
      }),
    },
    userConfirmation,
    theme: { subscribeTheme: createThemeSubscribe() },
    locale: { subscribeLocale: createLocaleSubscribe() },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
    // Always served, since the core denies chat calls on non-Chat executions and without a session.
    chat: createChatPlatform(),
  };
}
