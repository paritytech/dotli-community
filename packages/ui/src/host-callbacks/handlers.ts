// Composes the typed host callback surface consumed by
// `createWasmRawCallbacks`. Each callback lives in its own file so the
// dotli-specific UI and storage behavior stays outside the Rust core.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - product storage keys are opaque; Rust core owns product namespacing.
//
import type { HostCallbacks } from "@parity/truapi-host-wasm";
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
): Required<HostCallbacks> {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
  } = options;
  return {
    navigateTo: createNavigateTo(),
    ...createNotificationAdapters(label),
    ...createPromptPermission(label),
    featureSupported: createFeatureSupported(),
    read: createLocalStorageRead(),
    write: createLocalStorageWrite(),
    clear: createLocalStorageClear(),
    authStateChanged: createAuthStateChanged(pairingLabel ?? label, {
      dotSuffix: pairingDotSuffix,
      hostGlobal: pairingHostGlobal,
    }),
    ...createSessionStoreAdapters(),
    ...createUserConfirmationAdapters(label),
    ...createPreimageAdapters(label),
    subscribeTheme: createThemeSubscribe(),
    connect: createChainConnect(),
  };
}
