// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one refcounted TrUAPI core, under its product's label. The core goes with its last lease,
// and a faulted one is never handed out again.

import type {
  AuthState,
  ContactsPlatform,
  CoreStorage,
  CoreStorageKey,
  MediaPlatform,
  PermissionAuthorizationRequest,
  ProductExecutionKind,
  RequiredHostCallbacks,
  TrUApiProductProvider,
} from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { log } from '@dotli/shared';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { loadLocalWalletCore } from './lazy.js';
import type { LocalWalletChat } from './local-wallet-chat.js';
import { createHostCallbacks } from './host-callbacks/handlers.js';
import {
  onStoredSessionChanged,
  registerCoreStoragePermissionProvider,
  waitForCoreStoragePermissionRefresh,
} from './host-callbacks/SessionStore.js';
import { createTruapiRuntimeConfig, labelToProductId } from './runtime-config.js';
import { getWalletMode } from './state/wallet-mode.js';
import { readWalletBoot } from './wallet-boot.js';
import { setNotificationAccount } from './notification-activation.js';

export interface PageProduct {
  label: string;
  /** Overrides the label-derived product id, for the local debug routes. */
  productId?: string | undefined;
  /** How pairing presents itself, when not as the product. */
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
}

/** Host-owned Media for one product connection, never supplied by the product. */
export interface ConnectionMedia {
  platform: Required<MediaPlatform>;
  authChanged(state: AuthState): void;
  observeStorage(key: CoreStorageKey): void;
}

/** Close it through `close`, never the provider, or the core is marked faulted. */
export interface CoreConnection {
  provider: TrUApiProductProvider;
  productId: string;
  /** Settles once every live core sharing this storage applied the decision. */
  waitForPermissionRefresh(request: PermissionAuthorizationRequest): Promise<void>;
  close(): void;
}

export interface CoreLease {
  runtime: WorkerPairingHostRuntime;
  connect(executionKind?: ProductExecutionKind, media?: ConnectionMedia): Promise<CoreConnection>;
  /** Idempotent. */
  release(): void;
}

interface Core {
  product: PageProduct;
  runtime: Promise<WorkerPairingHostRuntime>;
  leases: number;
  faulted: boolean;
  /** The session-store adapter before the Chat and Media observing wrappers. */
  permissionStorage(): CoreStorage;
  /** Callbacks scoped to one product connection, so its prompts end with it. */
  openCallbacks(media?: ConnectionMedia): { callbacks: RequiredHostCallbacks; dispose(): void };
  dispose(): void;
}

const LANDING_PRODUCT: PageProduct = {
  label: 'dotli',
  pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
};

let modalCoordinator: BlockingModalCoordinator | null = null;
let pageProduct: PageProduct = LANDING_PRODUCT;
let current: Core | null = null;
// Also holds cores a product change or fault replaced while they still had leases.
const cores = new Set<Core>();

export function initPageCore(coordinator: BlockingModalCoordinator): void {
  modalCoordinator = coordinator;
}

/** Called as soon as the page knows it, so a core booted by an early login is already the product's. */
export function setPageProduct(product: PageProduct): void {
  pageProduct = product;
}

function productIdOf(product: PageProduct): string {
  return product.productId ?? labelToProductId(product.label);
}

function isPageProduct(core: Core): boolean {
  return core.product.label === pageProduct.label && productIdOf(core.product) === productIdOf(pageProduct);
}

export async function acquireCore(): Promise<CoreLease> {
  if (current === null || current.faulted || !isPageProduct(current)) {
    current = createCore(pageProduct);
  }
  const core = current;
  core.leases++;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    core.leases--;
    if (core.leases === 0) {
      core.dispose();
    }
  };
  let runtime: WorkerPairingHostRuntime;
  try {
    runtime = await core.runtime;
  } catch (error) {
    release();
    throw error;
  }
  return {
    runtime,
    connect: (executionKind, media) => connect(core, runtime, executionKind, media),
    release,
  };
}

export function cancelPairing(): void {
  // A signing runtime has no pairing to cancel.
  if (getWalletMode() === 'local') {
    return;
  }
  for (const core of cores) {
    core.runtime.then(
      runtime => {
        runtime.cancelPairing();
      },
      () => {
        // A core that never booted has no pairing to cancel.
      },
    );
  }
}

function createCore(product: PageProduct): Core {
  if (modalCoordinator === null) {
    throw new Error('TrUAPI page core used before initPageCore');
  }
  log.event('wallet core create', { flow: 'wallet', landing: product === LANDING_PRODUCT });
  const coordinator = modalCoordinator;
  const blockingModalScope = coordinator.createScope();
  const { productId: _productId, ...hostConfig } = createTruapiRuntimeConfig(product.label, product.productId);
  let unsubscribeStore: (() => void) | null = null;
  let coreCallbacks: RequiredHostCallbacks | null = null;
  let permissionStorage: CoreStorage | null = null;
  const connectionMedia = new Set<ConnectionMedia>();
  // Native Chat runs only beside the local signer; a Polkadot App session leaves Chat on the phone.
  let chat: LocalWalletChat | null = null;
  const connectionDisposers = new Set<() => void>();
  const callbacksFor = (local: boolean, contacts?: Required<ContactsPlatform>): RequiredHostCallbacks => {
    coreCallbacks = createHostCallbacks({
      label: product.label,
      pairingLabel: product.pairing?.label,
      pairingDotSuffix: product.pairing?.dotSuffix,
      pairingHostGlobal: product.pairing?.hostGlobal,
      blockingModalScope,
      local,
      contacts,
    });
    const storage = coreCallbacks.coreStorage;
    permissionStorage = storage;
    const observePermission = (key: CoreStorageKey): void => {
      if (key.tag === 'PermissionAuthorization') {
        for (const media of connectionMedia) {
          media.observeStorage(key);
        }
      }
    };
    coreCallbacks.coreStorage = {
      ...storage,
      readCoreStorage: key => {
        observePermission(key);
        return storage.readCoreStorage(key);
      },
      writeCoreStorage: async (key, value) => {
        await storage.writeCoreStorage(key, value);
        observePermission(key);
      },
      compareExchangeCoreStorage: async (key, expected, replacement, notifyOnSuccess) => {
        const changed = await storage.compareExchangeCoreStorage(key, expected, replacement, notifyOnSuccess);
        if (changed) {
          observePermission(key);
        }
        return changed;
      },
    };
    const presentAuth = coreCallbacks.auth.authStateChanged;
    coreCallbacks.auth.authStateChanged = state => {
      for (const media of connectionMedia) {
        media.authChanged(state);
      }
      presentAuth(state);
    };
    return coreCallbacks;
  };
  // The wallet read, the host chunk and the worker wrapper load in parallel, so a Polkadot App boot waits on
  // whichever is slower. The wrapper fetches its worker script only when constructed, so local mode pays nothing.
  const runtime = Promise.all([
    readWalletBoot(),
    import('@parity/truapi-host/web'),
    import('@parity/truapi-host/worker-runtime?worker'),
  ]).then(async ([wallet, { createWebWorkerPairingHostRuntime }, { default: HostWorker }]) => {
    if (wallet !== null) {
      const { bootLocalWalletCore, createLocalWalletChat } = await loadLocalWalletCore();
      if (!cores.has(core)) {
        throw new Error('Page core retired before the local wallet booted');
      }
      const localChat = createLocalWalletChat(wallet, () => cores.has(core));
      chat = localChat;
      const callbacks = callbacksFor(true, localChat.openContacts(blockingModalScope).callbacks);
      callbacks.coreStorage = localChat.coreStorage(callbacks.coreStorage);
      callbacks.nativeChatFiles = localChat.nativeChatFiles;
      const presentAuth = callbacks.auth.authStateChanged;
      callbacks.auth.authStateChanged = state => {
        localChat.authStateChanged(state);
        presentAuth(state);
      };
      const booted = await bootLocalWalletCore(createWebWorkerPairingHostRuntime, callbacks, hostConfig, wallet, () =>
        cores.has(core),
      );
      localChat.activated(booted);
      log.event('wallet core booted', { flow: 'wallet', local: true });
      return booted;
    }
    const booted = await createWebWorkerPairingHostRuntime(new HostWorker(), callbacksFor(false), { hostConfig });
    log.event('wallet core booted', { flow: 'wallet' });
    // Other tabs' logins land in the shared session store. Once now too, for a session stored before boot.
    unsubscribeStore = onStoredSessionChanged(() => {
      // Fence both local and cross-tab changes before the worker reloads auth.
      setNotificationAccount(product.label, undefined);
      booted.notifySessionStoreChanged();
    });
    queueMicrotask(() => {
      if (cores.has(core)) {
        booted.notifySessionStoreChanged();
      }
    });
    return booted;
  });
  const core: Core = {
    product,
    runtime,
    leases: 0,
    faulted: false,
    permissionStorage() {
      if (permissionStorage === null || !cores.has(core)) {
        throw new Error('Page core storage is unavailable');
      }
      return permissionStorage;
    },
    openCallbacks(media) {
      const shared = coreCallbacks;
      if (shared === null || !cores.has(core)) {
        throw new Error('Page core callbacks are unavailable');
      }
      const scope = coordinator.createScope();
      const contacts = chat?.openContacts(scope);
      const callbacks = createHostCallbacks({
        label: product.label,
        blockingModalScope: scope,
        contacts: contacts?.callbacks,
      });
      // Authentication, session storage and Chat custody stay core-owned; interactive
      // product prompts cannot outlive the connection that requested them.
      let closed = false;
      callbacks.auth = {
        authStateChanged: state => {
          if (!closed) {
            shared.auth.authStateChanged(state);
          }
        },
      };
      callbacks.coreStorage = shared.coreStorage;
      if (media !== undefined) {
        callbacks.media = media.platform;
        connectionMedia.add(media);
      }
      if (shared.nativeChatFiles !== undefined) {
        callbacks.nativeChatFiles = shared.nativeChatFiles;
      }
      const dispose = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        connectionDisposers.delete(dispose);
        if (media !== undefined) {
          connectionMedia.delete(media);
        }
        contacts?.dispose();
        scope.dispose();
      };
      connectionDisposers.add(dispose);
      return { callbacks, dispose };
    },
    dispose() {
      if (!cores.delete(core)) {
        return;
      }
      if (current === core) {
        current = null;
      }
      log.event('wallet core disposed', { flow: 'wallet', faulted: core.faulted });
      unsubscribeStore?.();
      for (const dispose of connectionDisposers) {
        dispose();
      }
      blockingModalScope.dispose();
      // Ends Chat custody; writes the stopping signer still makes are refused, never interleaved with a successor's.
      chat?.dispose();
      runtime.then(
        booted => {
          booted.dispose();
        },
        () => {
          // Nothing booted, nothing to dispose.
        },
      );
    },
  };
  cores.add(core);
  runtime.catch((error: unknown) => {
    log.warn('[dot.li page-core] wallet core failed to boot:', error);
    core.faulted = true;
  });
  return core;
}

async function connect(
  core: Core,
  runtime: WorkerPairingHostRuntime,
  executionKind: ProductExecutionKind = 'App',
  media?: ConnectionMedia,
): Promise<CoreConnection> {
  if (!cores.has(core)) {
    throw new Error('Page core is closed');
  }
  const productId = productIdOf(core.product);
  const storage = core.permissionStorage();
  const callbacks = core.openCallbacks(media);
  let provider: TrUApiProductProvider;
  try {
    provider = await runtime.createProvider({ productId, executionKind }, callbacks.callbacks);
  } catch (error) {
    log.warn('[dot.li page-core] wallet core refused a connection:', error);
    callbacks.dispose();
    core.faulted = true;
    throw error;
  }
  let unregisterRefresh: () => void;
  try {
    if (!cores.has(core)) {
      throw new Error('Page core closed while connecting the product');
    }
    unregisterRefresh = await registerCoreStoragePermissionProvider(storage, productId, provider);
    if (!cores.has(core)) {
      unregisterRefresh();
      throw new Error('Page core closed while connecting the product');
    }
  } catch (error) {
    callbacks.dispose();
    provider.dispose();
    throw error;
  }
  let closing = false;
  // A deliberate close also fires close listeners. Any other close is the core going down.
  provider.subscribeClose?.(() => {
    unregisterRefresh();
    callbacks.dispose();
    if (!closing) {
      log.event('wallet core went down under a connection', { flow: 'wallet' });
      core.faulted = true;
    }
  });
  return {
    provider,
    productId,
    waitForPermissionRefresh: request => waitForCoreStoragePermissionRefresh(storage, productId, request),
    close() {
      if (closing) {
        return;
      }
      closing = true;
      unregisterRefresh();
      callbacks.dispose();
      provider.dispose();
    },
  };
}
