// Composes the full `WasmHostCallbacks` surface expected by
// `createWebWorkerHostRuntime`. Each callback lives in its own file,
// mirroring the demo host layout under `demos/hosts/web/src/callbacks/`.
//
// Scoping:
// - `label` identifies the dApp, used in topbar notifications, permission
//   storage keys, and sign modal titles.
// - `storagePrefix` scopes `localStorage` per dApp (and per nested bridge).
//
// Callbacks not yet owned by the Rust core (accounts, signing, statement
// store, preimage) are wired through temporary adapters that bridge into
// `@dotli/auth`. Phase D will swap those for core-native handlers.

import {
  createUnavailableCallbacks,
  type WasmHostCallbacks,
} from "@truapi/host-shared/dist/runtime.js";
import { createOpenUrl } from "./OpenUrl";
import { createPushNotification } from "./PushNotification";
import { createPromptPermission } from "./PromptPermission";
import {
  createLocalStorageRead,
  createLocalStorageWrite,
  createLocalStorageClear,
} from "./LocalStorage";
import { createAccountAdapters } from "./Account";
import { createSigningAdapters } from "./Signing";
import { createStatementStoreAdapters } from "./StatementStore";
import { createPreimageAdapters } from "./Preimage";
import { createChainConnect } from "./Chain";

export interface CreateHostCallbacksOptions {
  label: string;
  storagePrefix: string;
}

export function createHostCallbacks(
  options: CreateHostCallbacksOptions,
): WasmHostCallbacks {
  const { label, storagePrefix } = options;
  return {
    ...createUnavailableCallbacks(),
    openUrl: createOpenUrl(),
    pushNotification: createPushNotification(label),
    promptPermission: createPromptPermission(label),
    localStorageRead: createLocalStorageRead(storagePrefix),
    localStorageWrite: createLocalStorageWrite(storagePrefix),
    localStorageClear: createLocalStorageClear(storagePrefix),
    ...createAccountAdapters(label),
    ...createSigningAdapters(label),
    ...createStatementStoreAdapters(label),
    ...createPreimageAdapters(label),
    chainConnect: createChainConnect(),
  };
}
