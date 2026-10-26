// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each callback lives in its own file so dotli's UI and storage behaviour stays outside the Rust core.
// Product storage keys are opaque because the core owns product namespacing.

import type { Permissions, RequiredHostCallbacks, UserConfirmation } from '@parity/truapi-host';
import { createNavigateTo } from './openUrl.js';
import { createNotificationAdapters, type NotificationScheduler } from './pushNotification.js';
import { createPromptPermission, type PromptPermissionStores } from './promptPermission.js';
import {
  createLocalStorageRead,
  createLocalStorageWrite,
  createLocalStorageClear,
  createLocalStorageSubscribe,
} from './localStorage.js';
import { createProductOperations } from './productOperations.js';
import { createPreimageAdapters } from './preimage.js';
import { createChainConnect } from './chain.js';
import { createFeatureSupported } from './featureSupported.js';
import { createSupportedChains } from './supportedChains.js';
import { createThemeSubscribe } from './theme.js';
import { createLocaleSubscribe } from './locale.js';
import { createAuthStateChanged } from '../session/authState.js';
import { createChatPlatform } from './chat.js';
import { coreStorage } from '../session/coreStorage.js';
import { createUserConfirmationAdapters } from './userConfirmation.js';
import type { BlockingModalScope } from '../blockingModalQueue.js';
import type { HostPrompts } from '../hostPrompts.js';
import type { PhoneRequestTracker } from '../phoneRequests.js';

export type CreateHostCallbacksOptions = {
  label: string;
  pairingLabel?: string | undefined;
  pairingDotSuffix?: boolean | undefined;
  pairingHostGlobal?: boolean | undefined;
  /** Where the callbacks' prompts queue, on the page's one coordinator. */
  blockingModalScope: BlockingModalScope;
  /**
   * Keeps the core's session away from the stored session and the signed-in flag, for a core that must never write
   * either.
   */
  sessionInMemory?: boolean | undefined;
  /** Whether the core still speaks for the session. */
  inService?: (() => boolean) | undefined;
  /** What the core's confirmations claim the phone's requests from. A local wallet core's claims nothing. */
  phoneRequests: PhoneRequestTracker;
};

/** How a core's permission and confirmation asks are answered, given the core's own label, queue scope and phone. */
export type HostAsks = (core: {
  label: string;
  blockingModalScope: BlockingModalScope;
  phoneRequests: PhoneRequestTracker;
}) => { permissions: Permissions; userConfirmation: Required<UserConfirmation> };

/**
 * What the callbacks ask the page for: the user's answers, where push notifications wait until due, and how the
 * core's permission and confirmation asks are answered.
 */
export type HostCallbackDeps = {
  prompts: HostPrompts;
  notifications: NotificationScheduler;
  asks: HostAsks;
};

/** Answers the core's asks by showing the page's prompts, and reads and records the permissions they decide. */
export function promptAsks(deps: { prompts: HostPrompts; permissions: PromptPermissionStores }): HostAsks {
  const { prompts, permissions } = deps;
  return ({ label, blockingModalScope, phoneRequests }) => ({
    permissions: createPromptPermission(
      label,
      { ask: prompts.askPermission, notify: prompts.notify, permissions },
      blockingModalScope,
    ),
    userConfirmation: createUserConfirmationAdapters(label, prompts, blockingModalScope, phoneRequests),
  });
}

export function createHostCallbacks(options: CreateHostCallbacksOptions & HostCallbackDeps): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope,
    sessionInMemory,
    inService,
    phoneRequests,
    prompts,
    notifications,
    asks,
  } = options;
  const { permissions, userConfirmation } = asks({ label, blockingModalScope, phoneRequests });
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters(label, notifications, prompts.notify),
    permissions,
    features: {
      featureSupported: createFeatureSupported(),
      supportedChains: createSupportedChains(),
    },
    productStorage: {
      read: createLocalStorageRead(),
      write: createLocalStorageWrite(),
      clear: createLocalStorageClear(),
      subscribeStorage: createLocalStorageSubscribe(),
    },
    productOperations: createProductOperations(),
    coreStorage: coreStorage.adapters({ sessionInMemory }),
    auth: {
      authStateChanged: createAuthStateChanged(pairingLabel ?? label, {
        dotSuffix: pairingDotSuffix,
        hostGlobal: pairingHostGlobal,
        inService,
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
