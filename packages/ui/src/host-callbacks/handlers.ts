// Composes the typed host callback surface consumed by
// `createWasmRawCallbacks`. Each callback lives in its own file so the
// dotli-specific UI and storage behavior stays outside the Rust core.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - product storage keys are opaque; Rust core owns product namespacing.
//
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
import { createProfilePlatform } from './Profile.js';
import type { NativeChatContactsDirectory } from './Contacts.js';
import type { ContactAvatarOverlay } from '../profile/avatar-overlay.js';
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
  /** Avatar layer of the product frame this connection serves, if any. */
  contactAvatars?: ContactAvatarOverlay;
  /** Retires Profile presentations and loads with the native connection. */
  profileSignal?: AbortSignal;
  contacts?: Required<ContactsPlatform>;
  contactsDirectory?: NativeChatContactsDirectory;
}

export function createHostCallbacks(options: CreateHostCallbacksOptions): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope = createBlockingModalScope(),
    custodyLease,
    contactAvatars,
    profileSignal,
    contacts,
    contactsDirectory,
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
    // Any product may ask the host to show a profile it references; the
    // drawer attributes it to the product and returns nothing to it. Placed
    // contact avatars are drawn on the frame's own host layer.
    profile: createProfilePlatform(contactAvatars, profileSignal, contactsDirectory),
    ...(contacts === undefined ? {} : { contacts }),
  };
}
