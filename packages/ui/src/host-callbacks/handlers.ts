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
} from "./LocalStorage";
import { createPreimageAdapters } from "./Preimage";
import { createChainConnect } from "./Chain";
import { createFeatureSupported } from "./FeatureSupported";
import { createSupportedChains } from "./SupportedChains";
import { createThemeSubscribe } from "./Theme";
import { createLocaleSubscribe } from "./Locale";
import { createAuthStateChanged } from "./AuthState";
import { createChatPlatform } from "./Chat";
import { createSessionStoreAdapters } from "./SessionStore";
import { createUserConfirmationAdapters } from "./UserConfirmation";
import {
  createBlockingModalScope,
  type BlockingModalScope,
} from "../blocking-modal-queue";
import { createSubmitRateLimiter } from "./rate-limit";

export interface CreateHostCallbacksOptions {
  label: string;
  pairingLabel?: string;
  pairingDotSuffix?: boolean;
  pairingHostGlobal?: boolean;
  blockingModalScope?: BlockingModalScope;
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
  } = options;
  // Permission and notification prompts draw from one budget so a product
  // cannot double its prompt rate by alternating prompt kinds.
  const promptLimiter = createSubmitRateLimiter();
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters(
      label,
      blockingModalScope,
      promptLimiter,
    ),
    permissions: createPromptPermission(
      label,
      blockingModalScope,
      promptLimiter,
    ),
    features: {
      featureSupported: createFeatureSupported(),
      supportedChains: createSupportedChains(),
    },
    productStorage: {
      read: createLocalStorageRead(),
      write: createLocalStorageWrite(),
      clear: createLocalStorageClear(),
    },
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
