// Composes the typed host callback surface consumed by
// `createWasmRawCallbacks`. Each callback lives in its own file so the
// dotli-specific UI and storage behavior stays outside the Rust core.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - `storagePrefix` scopes `localStorage` per dApp (and per nested bridge).
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
import { createPresentPairing } from "./Pairing";
import { createSessionStoreAdapters } from "./SessionStore";

export interface CreateHostCallbacksOptions {
  label: string;
  storagePrefix: string;
}

export function createHostCallbacks(
  options: CreateHostCallbacksOptions,
): Partial<HostCallbacks> {
  const { label, storagePrefix } = options;
  return {
    navigateTo: createNavigateTo(),
    ...createNotificationAdapters(label),
    ...createPromptPermission(label),
    featureSupported: createFeatureSupported(),
    read: createLocalStorageRead(storagePrefix),
    write: createLocalStorageWrite(storagePrefix),
    clear: createLocalStorageClear(storagePrefix),
    presentPairing: createPresentPairing(label),
    ...createSessionStoreAdapters(),
    ...createPreimageAdapters(label),
    subscribeTheme: createThemeSubscribe(),
    connect: createChainConnect(),
  };
}
