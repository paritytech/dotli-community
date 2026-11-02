// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each callback lives in its own file so dotli's UI and storage behaviour stays outside the Rust core.
// Product storage keys are opaque because the core owns product namespacing.

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
import type { BlockingModalScope } from '../createBlockingModalCoordinator.js';
import type { HostPrompts } from '../hostPrompts.js';
import type { PhoneRequestTracker } from '../createPhoneRequestTracker.js';

/** What one core's callbacks are built for: its label, pairing, queue scope, session and phone. */
export type CoreCallbacksParams = {
  /** The product the core serves. */
  label: string;
  /** The label the pairing shows, the product's own by default. */
  pairingLabel?: string | undefined;
  /** Whether the pairing label takes the active TLD suffix. `false` shows it as given. */
  pairingDotSuffix?: boolean | undefined;
  /** Whether the pairing speaks for the host, so the sign-in names no product. */
  pairingHostGlobal?: boolean | undefined;
  /** Where the callbacks' prompts queue, on the page's one coordinator. */
  blockingModalScope: BlockingModalScope;
  /**
   * Keeps the core's session away from the stored session and the signed-in flag, for a core that must never write
   * either.
   */
  sessionInMemory?: boolean | undefined;
  /** Whether the core still speaks for the session. */
  isInService?: (() => boolean) | undefined;
  /** What the core's confirmations claim the phone's requests from. A local wallet core's claims nothing. */
  phoneRequests: PhoneRequestTracker;
};

/** How a core's permission and confirmation asks are answered, given the core's own label, queue scope and phone. */
export type HostAsks = (core: {
  label: string;
  blockingModalScope: BlockingModalScope;
  phoneRequests: PhoneRequestTracker;
}) => { permissions: Permissions; userConfirmation: Required<UserConfirmation> };

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
  label,
  pairingLabel,
  pairingDotSuffix,
  pairingHostGlobal,
  blockingModalScope,
  sessionInMemory,
  isInService,
  phoneRequests,
  prompts,
  notifications,
  createAsks,
}: Params): RequiredHostCallbacks {
  const { permissions, userConfirmation } = createAsks({ label, blockingModalScope, phoneRequests });
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters({ label, scheduler: notifications, notify: prompts.notify }),
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
      authStateChanged: createAuthStateChanged(pairingLabel ?? label, {
        dotSuffix: pairingDotSuffix,
        hostGlobal: pairingHostGlobal,
        isInService,
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
