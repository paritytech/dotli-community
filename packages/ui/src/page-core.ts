// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one refcounted TrUAPI core, under its product's label. The core goes with its last lease,
// and a faulted one is never handed out again.

import type {
  ContactsPlatform,
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
import { onStoredSessionChanged } from './host-callbacks/SessionStore.js';
import { createTruapiRuntimeConfig, labelToProductId } from './runtime-config.js';
import { getWalletMode } from './state/wallet-mode.js';
import { readWalletBoot } from './wallet-boot.js';
import type { ContactAvatarOverlay } from './profile/avatar-overlay.js';
import type { ContactLabelOverlay } from './contacts/label-overlay.js';
import { setReceivingAccount } from './receiving.js';
import { createReceivingExecution, type ReceivingExecution } from './receiving-execution.js';

/** The product frame's host-drawn layers a connection paints Profile avatars and contact names on. */
export interface CoreConnectionOptions {
  contactAvatars?: ContactAvatarOverlay;
  contactLabels?: ContactLabelOverlay;
  archiveCid?: string | undefined;
  isCurrentExecution?: () => boolean;
}

export interface PageProduct {
  label: string;
  /** Overrides the label-derived product id, for the local debug routes. */
  productId?: string | undefined;
  /** How pairing presents itself, when not as the product. */
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
}

/** Close it through `close`, never the provider, or the core is marked faulted. */
export interface CoreConnection {
  provider: TrUApiProductProvider;
  productId: string;
  receiving: ReceivingExecution;
  close(): void;
}

export interface CoreLease {
  runtime: WorkerPairingHostRuntime;
  connect(executionKind?: ProductExecutionKind, options?: CoreConnectionOptions): Promise<CoreConnection>;
  /** Idempotent. */
  release(): void;
}

interface Core {
  product: PageProduct;
  runtime: Promise<WorkerPairingHostRuntime>;
  leases: number;
  faulted: boolean;
  /** Callbacks scoped to one product connection, so its prompts end with it. */
  openCallbacks(options: CoreConnectionOptions): { callbacks: RequiredHostCallbacks; dispose(): void };
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
    connect: (executionKind, options) => connect(core, runtime, executionKind, options),
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
  // Native Chat runs only beside the local signer; a Polkadot App session leaves Chat on the phone.
  let chat: LocalWalletChat | null = null;
  const connectionDisposers = new Set<() => void>();
  // Profile presentations end with the session that opened them.
  let profileLifetime = new AbortController();
  let profileAccount: string | undefined;
  const profileInvalidators = new Set<() => void>();
  const invalidateProfiles = (): void => {
    profileLifetime.abort();
    profileLifetime = new AbortController();
    for (const invalidate of profileInvalidators) {
      invalidate();
    }
  };
  const callbacksFor = (local: boolean, contacts?: Required<ContactsPlatform>): RequiredHostCallbacks => {
    coreCallbacks = createHostCallbacks({
      label: product.label,
      pairingLabel: product.pairing?.label,
      pairingDotSuffix: product.pairing?.dotSuffix,
      pairingHostGlobal: product.pairing?.hostGlobal,
      blockingModalScope,
      local,
      contacts,
      profileSignal: () => profileLifetime.signal,
      contactsDirectory: chat?.contactsDirectory,
    });
    const presentAuth = coreCallbacks.auth.authStateChanged;
    coreCallbacks.auth.authStateChanged = state => {
      const profileSession =
        state.tag === 'Connected' ? `${state.value.publicKey}:${state.value.identityAccountId ?? ''}` : undefined;
      if (profileSession !== profileAccount) {
        profileAccount = profileSession;
        invalidateProfiles();
      }
      if (isPageProduct(core) && state.tag === 'Connected') {
        setReceivingAccount(state.value.identityAccountId);
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
      // Hints can reload an unchanged session; only native auth transitions change notification authority.
      invalidateProfiles();
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
    openCallbacks(options) {
      const shared = coreCallbacks;
      if (shared === null || !cores.has(core)) {
        throw new Error('Page core callbacks are unavailable');
      }
      const scope = coordinator.createScope();
      const contacts = chat?.openContacts(scope, options.contactLabels);
      let connectionLifetime = new AbortController();
      const invalidateProfile = (): void => {
        connectionLifetime.abort();
        connectionLifetime = new AbortController();
        options.contactAvatars?.clear();
      };
      const callbacks = createHostCallbacks({
        label: product.label,
        blockingModalScope: scope,
        contacts: contacts?.callbacks,
        contactAvatars: options.contactAvatars,
        profileSignal: () => connectionLifetime.signal,
        contactsDirectory: chat?.contactsDirectory,
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
      if (shared.nativeChatFiles !== undefined) {
        callbacks.nativeChatFiles = shared.nativeChatFiles;
      }
      const dispose = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        connectionLifetime.abort();
        options.contactAvatars?.dispose();
        options.contactLabels?.dispose();
        connectionDisposers.delete(dispose);
        profileInvalidators.delete(invalidateProfile);
        contacts?.dispose();
        scope.dispose();
      };
      connectionDisposers.add(dispose);
      profileInvalidators.add(invalidateProfile);
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
      profileLifetime.abort();
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
  options: CoreConnectionOptions = {},
): Promise<CoreConnection> {
  const productId = productIdOf(core.product);
  const callbacks = core.openCallbacks(options);
  const receiving = createReceivingExecution(productId, options.archiveCid, options.isCurrentExecution);
  callbacks.callbacks.notifications.receiverCommand = (product, action, payload) =>
    receiving.command(product, action, payload);
  let provider: TrUApiProductProvider;
  try {
    provider = await runtime.createProvider({ productId, executionKind }, callbacks.callbacks);
  } catch (error) {
    log.warn('[dot.li page-core] wallet core refused a connection:', error);
    receiving.close();
    callbacks.dispose();
    core.faulted = true;
    throw error;
  }
  let closing = false;
  // A deliberate close also fires close listeners. Any other close is the core going down.
  provider.subscribeClose?.(() => {
    receiving.close();
    callbacks.dispose();
    if (!closing) {
      log.event('wallet core went down under a connection', { flow: 'wallet' });
      core.faulted = true;
    }
  });
  return {
    provider,
    productId,
    receiving,
    close() {
      closing = true;
      receiving.close();
      callbacks.dispose();
      provider.dispose();
    },
  };
}
