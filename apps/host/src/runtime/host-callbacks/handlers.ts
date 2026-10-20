// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each callback lives in its own file so dotli's UI and storage behaviour stays outside the Rust core.
// Product storage keys are opaque because the core owns product namespacing.

import type { RequiredHostCallbacks } from '@parity/truapi-host';
import { createNavigateTo } from './open-url.js';
import { createNotificationAdapters, type NotificationScheduler } from './push-notification.js';
import { createPromptPermission, type PromptPermissionStores } from './prompt-permission.js';
import {
  createLocalStorageRead,
  createLocalStorageWrite,
  createLocalStorageClear,
  createLocalStorageSubscribe,
} from './local-storage.js';
import { createProductOperations } from './product-operations.js';
import { createPreimageAdapters } from './preimage.js';
import { createChainConnect } from './chain.js';
import { createFeatureSupported } from './feature-supported.js';
import { createSupportedChains } from './supported-chains.js';
import { createThemeSubscribe } from './theme.js';
import { createLocaleSubscribe } from './locale.js';
import { createAuthStateChanged } from '../session/auth-state.js';
import { createChatPlatform } from './chat.js';
import { coreStorage } from '../session/core-storage.js';
import { createUserConfirmationAdapters } from './user-confirmation.js';
import type { BlockingModalScope } from '../blocking-modal-queue.js';
import type { HostPrompts } from '../host-prompts.js';
import type { PhoneRequestTracker } from '../phone-requests.js';

export interface CreateHostCallbacksOptions {
  label: string;
  pairingLabel?: string | undefined;
  pairingDotSuffix?: boolean | undefined;
  pairingHostGlobal?: boolean | undefined;
  /** Where the callbacks' prompts queue, on the page's one coordinator. */
  blockingModalScope: BlockingModalScope;
  /** For a local wallet core, whose storage must not touch the paired session. */
  local?: boolean | undefined;
  /** Whether the core still speaks for the session. */
  inService?: (() => boolean) | undefined;
  /** What the core's confirmations claim the phone's requests from. A local wallet core's claims nothing. */
  phoneRequests: PhoneRequestTracker;
}

/**
 * What the callbacks ask the page for: the user's answers, where push notifications wait until due, and the
 * permissions a prompt reads and records.
 */
export interface HostCallbackDeps {
  prompts: HostPrompts;
  notifications: NotificationScheduler;
  permissions: PromptPermissionStores;
}

export function createHostCallbacks(options: CreateHostCallbacksOptions & HostCallbackDeps): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope,
    local,
    inService,
    phoneRequests,
    prompts,
    notifications,
    permissions,
  } = options;
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters(label, notifications, prompts.notify),
    permissions: createPromptPermission(
      label,
      { ask: prompts.askPermission, notify: prompts.notify, permissions },
      blockingModalScope,
    ),
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
    coreStorage: coreStorage.adapters({ local }),
    auth: {
      authStateChanged: createAuthStateChanged(pairingLabel ?? label, {
        dotSuffix: pairingDotSuffix,
        hostGlobal: pairingHostGlobal,
        inService,
      }),
    },
    userConfirmation: createUserConfirmationAdapters(label, prompts, blockingModalScope, phoneRequests),
    theme: { subscribeTheme: createThemeSubscribe() },
    locale: { subscribeLocale: createLocaleSubscribe() },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
    // Always served, since the core denies chat calls on non-Chat executions and without a session.
    chat: createChatPlatform(),
  };
}
