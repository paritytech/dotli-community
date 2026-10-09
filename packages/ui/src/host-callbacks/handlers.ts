// Each callback lives in its own file so dotli's UI and storage behaviour stays outside the Rust core.
// Product storage keys are opaque because the core owns product namespacing.

import { localizeTimestamps, type ContactsPlatform, type RequiredHostCallbacks } from '@parity/truapi-host';
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
import { createChainConnect, createHopProvider } from './Chain.js';
import { createFeatureSupported } from './FeatureSupported.js';
import { createSupportedChains } from './SupportedChains.js';
import { createThemeSubscribe } from './Theme.js';
import { createLocaleSubscribe } from './Locale.js';
import { createAuthStateChanged } from './AuthState.js';
import { createChatPlatform } from './Chat.js';
import { createSessionStoreAdapters } from './SessionStore.js';
import { createUserConfirmationAdapters } from './UserConfirmation.js';
import { createBlockingModalScope, type BlockingModalScope } from '../blocking-modal-queue.js';
import { setNotificationAccount } from '../notification-activation.js';

export interface CreateHostCallbacksOptions {
  label: string;
  pairingLabel?: string | undefined;
  pairingDotSuffix?: boolean | undefined;
  pairingHostGlobal?: boolean | undefined;
  blockingModalScope?: BlockingModalScope;
  custodyLease?: string;
  contacts?: Required<ContactsPlatform>;
}

export function createHostCallbacks(options: CreateHostCallbacksOptions): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope = createBlockingModalScope(),
    custodyLease,
    contacts,
  } = options;
  const presentAuth = createAuthStateChanged(pairingLabel ?? label, {
    dotSuffix: pairingDotSuffix,
    hostGlobal: pairingHostGlobal,
  });
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
    coreStorage: createSessionStoreAdapters(custodyLease),
    auth: {
      authStateChanged: state => {
        setNotificationAccount(label, state.tag === 'Connected' ? state.value.identityAccountId : undefined);
        presentAuth(state);
      },
    },
    userConfirmation: createUserConfirmationAdapters(label, blockingModalScope),
    theme: { subscribeTheme: createThemeSubscribe() },
    locale: { subscribeLocale: createLocaleSubscribe(), localizeTimestamps },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
    hop: createHopProvider(),
    // Always served; the core itself denies chat calls on non-Chat
    // executions and without an active session.
    chat: createChatPlatform(),
    ...(contacts === undefined ? {} : { contacts }),
  };
}
