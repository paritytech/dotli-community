// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each callback lives in its own file so dotli's UI and storage behaviour stays outside the Rust core.
// Product storage keys are opaque because the core owns product namespacing.

import type { RequiredHostCallbacks } from '@parity/truapi-host';
import { createNavigateTo } from './OpenUrl.js';
import { createNotificationAdapters, type NotificationScheduler } from './PushNotification.js';
import { createPromptPermission } from './PromptPermission.js';
import {
  createLocalStorageRead,
  createLocalStorageWrite,
  createLocalStorageClear,
  createLocalStorageSubscribe,
} from './LocalStorage.js';
import { createProductOperations } from './ProductOperations.js';
import { createPreimageAdapters } from './Preimage.js';
import { createChainConnect } from './Chain.js';
import { createFeatureSupported } from './FeatureSupported.js';
import { createSupportedChains } from './SupportedChains.js';
import { createThemeSubscribe } from './Theme.js';
import { createLocaleSubscribe } from './Locale.js';
import { createAuthStateChanged } from './AuthState.js';
import { createChatPlatform } from './Chat.js';
import { coreStorage } from './core-storage.js';
import { createUserConfirmationAdapters } from './UserConfirmation.js';
import type { BlockingModalScope } from '../blocking-modal-queue.js';
import type { HostPrompts } from '../host-prompts.js';

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
}

/** What the callbacks ask the page for: the user's answers, and where push notifications wait until due. */
export interface HostCallbackPorts {
  prompts: HostPrompts;
  notifications: NotificationScheduler;
}

export function createHostCallbacks(options: CreateHostCallbacksOptions & HostCallbackPorts): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope,
    local,
    inService,
    prompts,
    notifications,
  } = options;
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters(label, notifications, prompts.notify),
    permissions: createPromptPermission(
      label,
      { ask: prompts.askPermission, notify: prompts.notify },
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
    userConfirmation: createUserConfirmationAdapters(label, prompts, blockingModalScope),
    theme: { subscribeTheme: createThemeSubscribe() },
    locale: { subscribeLocale: createLocaleSubscribe() },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
    // Always served, since the core denies chat calls on non-Chat executions and without a session.
    chat: createChatPlatform(),
  };
}
