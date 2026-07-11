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
import { createThemeSubscribe } from "./Theme";
import { createAuthStateChanged } from "./AuthState";
import { createSessionStoreAdapters } from "./SessionStore";
import { createUserConfirmationAdapters } from "./UserConfirmation";

export interface CreateHostCallbacksOptions {
  label: string;
  pairingLabel?: string;
  pairingDotSuffix?: boolean;
  pairingHostGlobal?: boolean;
}

export function createHostCallbacks(
  options: CreateHostCallbacksOptions,
): RequiredHostCallbacks {
  const { label, pairingLabel, pairingDotSuffix, pairingHostGlobal } = options;
  return {
    navigation: { navigateTo: createNavigateTo() },
    notifications: createNotificationAdapters(label),
    permissions: createPromptPermission(label),
    features: { featureSupported: createFeatureSupported() },
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
    userConfirmation: createUserConfirmationAdapters(label),
    theme: { subscribeTheme: createThemeSubscribe() },
    preimage: createPreimageAdapters(label),
    chain: { connect: createChainConnect() },
  };
}
