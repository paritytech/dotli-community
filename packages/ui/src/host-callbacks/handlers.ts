// Composes the typed host callback surface consumed by
// `createWasmRawCallbacks`. Each callback lives in its own file so the
// dotli-specific UI and storage behavior stays outside the Rust core.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - product storage keys are opaque; Rust core owns product namespacing.
//
import type { RequiredHostCallbacks } from "@parity/truapi-host";
import { createNavigateTo } from "./OpenUrl";
import { createNotificationAdapters } from "./PushNotification";
import { createPromptPermission } from "./PromptPermission";
import {
  createLocalStorageRead,
  createLocalStorageWrite,
  createLocalStorageClear,
  createLocalStorageSubscribe,
} from "./LocalStorage";
import { createProductOperations } from "./ProductOperations";
import { createPreimageAdapters } from "./Preimage";
import { createChainConnect, createHopProvider } from "./Chain";
import { createFeatureSupported } from "./FeatureSupported";
import { createSupportedChains } from "./SupportedChains";
import { createThemeSubscribe } from "./Theme";
import { createLocaleSubscribe } from "./Locale";
import { createAuthStateChanged } from "./AuthState";
import { createChatPlatform } from "./Chat";
import { createProfilePlatform } from "./Profile";
import { createSessionStoreAdapters } from "./SessionStore";
import { createUserConfirmationAdapters } from "./UserConfirmation";
import {
  createBlockingModalScope,
  type BlockingModalScope,
} from "../blocking-modal-queue";

export interface CreateHostCallbacksOptions {
  label: string;
  pairingLabel?: string;
  pairingDotSuffix?: boolean;
  pairingHostGlobal?: boolean;
  blockingModalScope?: BlockingModalScope;
  custodyLease?: string;
}

export function createHostCallbacks(
  options: CreateHostCallbacksOptions,
): RequiredHostCallbacks {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    blockingModalScope = createBlockingModalScope(),
    custodyLease,
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
    coreStorage: createSessionStoreAdapters(custodyLease),
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
    hop: createHopProvider(),
    // Always served; the core itself denies chat calls on non-Chat
    // executions and without an active session.
    chat: createChatPlatform(),
    // Any product may ask the host to show a profile it references; the
    // drawer attributes it to the product and returns nothing to it.
    profile: createProfilePlatform(),
  };
}
