// Composes the typed host callback surface consumed by
// `createWasmRawCallbacks`. Each callback lives in its own file so the
// dotli-specific UI and storage behavior stays outside the Rust core.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - `storagePrefix` scopes `localStorage` per dApp.
//
import type { HostCallbacks } from "@parity/truapi-host/callbacks";
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
  storagePrefix: string;
}

export function createHostCallbacks(
  options: CreateHostCallbacksOptions,
): Partial<HostCallbacks> {
  const {
    label,
    pairingLabel,
    pairingDotSuffix,
    pairingHostGlobal,
    storagePrefix,
  } = options;
  return {
    navigateTo: createNavigateTo(),
    ...createNotificationAdapters(label),
    ...createPromptPermission(label),
    featureSupported: createFeatureSupported(),
    read: createLocalStorageRead(storagePrefix),
    write: createLocalStorageWrite(storagePrefix),
    clear: createLocalStorageClear(storagePrefix),
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
