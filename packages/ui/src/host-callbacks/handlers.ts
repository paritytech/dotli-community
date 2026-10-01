// Composes the typed host callback surface consumed by
// `createWasmRawCallbacks`. Each callback lives in its own file so the
// dotli-specific UI and storage behavior stays outside the Rust core.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - product storage keys are opaque; Rust core owns product namespacing.
//
import type { RequiredHostCallbacks } from '@parity/truapi-host';
import { createNavigateTo } from './OpenUrl.js';
import { createNotificationAdapters } from './PushNotification.js';
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
import { createSessionStoreAdapters } from './SessionStore.js';
import { createUserConfirmationAdapters } from './UserConfirmation.js';
import { createBlockingModalScope, type BlockingModalScope } from '../blocking-modal-queue.js';

export interface CreateHostCallbacksOptions {
  label: string;
  pairingLabel?: string | undefined;
  pairingDotSuffix?: boolean | undefined;
  pairingHostGlobal?: boolean | undefined;
  blockingModalScope?: BlockingModalScope;
}

export function createHostCallbacks(options: CreateHostCallbacksOptions): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope = createBlockingModalScope(),
  } = options;
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters(label),
    permissions: createPromptPermission(label, blockingModalScope),
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
    coreStorage: createSessionStoreAdapters(),
    auth: {
      authStateChanged: createAuthStateChanged(pairingLabel ?? label, {
        dotSuffix: pairingDotSuffix,
        hostGlobal: pairingHostGlobal,
      }),
    },
    userConfirmation: createUserConfirmationAdapters(label, blockingModalScope),
    theme: { subscribeTheme: createThemeSubscribe() },
    locale: { subscribeLocale: createLocaleSubscribe() },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
    // Always served; the core itself denies chat calls on non-Chat
    // executions and without an active session.
    chat: createChatPlatform(),
  };
}
