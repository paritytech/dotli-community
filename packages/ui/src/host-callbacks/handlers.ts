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
  /** For a local wallet core, whose storage must not touch the paired session. */
  local?: boolean | undefined;
  /** Served only beside the local signer, from the native Chat directory. */
  contacts?: Required<ContactsPlatform> | undefined;
  /** Avatar layer of the product frame this connection serves, if any. */
  contactAvatars?: ContactAvatarOverlay | undefined;
  /** Retires Profile presentations with the connection or its current session. */
  profileSignal?: AbortSignal | (() => AbortSignal);
  /** The native Chat contacts directory beside the local signer, for Profile lookups. */
  contactsDirectory?: NativeChatContactsDirectory | undefined;
}

export function createHostCallbacks(options: CreateHostCallbacksOptions): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope = createBlockingModalScope(),
    local,
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
    coreStorage: createSessionStoreAdapters({ local }),
    auth: {
      authStateChanged: state => {
        setNotificationAccount(
          label,
          state.tag === 'Connected' ? (state.value.identityAccountId ?? state.value.publicKey) : undefined,
        );
        presentAuth(state);
      },
    },
    userConfirmation: createUserConfirmationAdapters(label, blockingModalScope),
    theme: { subscribeTheme: createThemeSubscribe() },
    locale: { subscribeLocale: createLocaleSubscribe(), localizeTimestamps },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
    hop: createHopProvider(),
    // Always served, since the core denies chat calls on non-Chat executions and without a session.
    chat: createChatPlatform(),
    // Any product may ask the host to show a profile it references; the
    // drawer attributes it to the product and returns nothing to it. Placed
    // contact avatars are drawn on the frame's own host layer.
    profile: createProfilePlatform(contactAvatars, profileSignal, contactsDirectory),
    ...(contacts === undefined ? {} : { contacts }),
  };
}
