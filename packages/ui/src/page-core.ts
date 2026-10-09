// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One native core per page product. Product frames and host controls open
// connections to that same core. Mobile is lease-owned; the opt-in wallet
// also retains the page core while no product is visible.

import { DEBUG, getActiveServicesConfig } from '@dotli/config';
import { requestWalletOwner, subscribeWalletOwnerRevoked, WALLET_OWNER_REVOKED_EVENT } from '@dotli/protocol';
import { log } from '@dotli/shared';
import type {
  AuthState,
  ProductExecutionKind,
  RequiredHostCallbacks,
  TrUApiProductProvider,
} from '@parity/truapi-host';
import type { LocalIdentity, WorkerPairingHostRuntime, WorkerSigningHostRuntime } from '@parity/truapi-host/web';
import { createWebWorkerPairingHostRuntime, createWebWorkerSigningHostRuntime } from '@parity/truapi-host/web';
import HostWorker from '@parity/truapi-host/worker-runtime?worker';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createHostCallbacks } from './host-callbacks/handlers.js';
import { dispatchAuthState } from './host-callbacks/AuthState.js';
import {
  initializeLocalWalletState,
  initializeSessionMode,
  isExperimentalWalletActive,
  isCurrentLocalWallet,
  localWalletContext,
  onStoredSessionChanged,
  onVerifiedLocalIdentityChanged,
  readLocalWalletSecret,
  readVerifiedLocalIdentity,
  writeVerifiedLocalIdentity,
  type LocalWalletIdentityBinding,
} from './host-callbacks/SessionStore.js';
import { createTruapiRuntimeConfig, labelToProductId } from './runtime-config.js';
import { showNotification } from './notification.js';
import { setNotificationAccount } from './notification-activation.js';

export interface PageProduct {
  label: string;
  /** Overrides the label-derived product id, for the local debug routes. */
  productId?: string | undefined;
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
}

export interface LiveLocalWallet {
  runtime: WorkerSigningHostRuntime;
  binding: LocalWalletIdentityBinding;
  identity: LocalIdentity;
  usernameVerified: boolean;
  nativeSessionUiInfo?: { publicKey?: string | undefined; fullUsername?: string | undefined } | undefined;
}

type PageRuntime = WorkerPairingHostRuntime | WorkerSigningHostRuntime;

/** Close through `close`, never the provider, so expected closes stay local. */
export interface CoreConnection {
  provider: TrUApiProductProvider;
  productId: string;
  wallet: LiveLocalWallet | undefined;
  close(): void;
}

export interface CoreLease {
  runtime: PageRuntime;
  wallet: LiveLocalWallet | undefined;
  connect(executionKind?: ProductExecutionKind): Promise<CoreConnection>;
  release(): void;
}

interface Core {
  product: PageProduct;
  runtime: Promise<PageRuntime>;
  wallet: LiveLocalWallet | undefined;
  leases: number;
  persistent: boolean;
  faulted: boolean;
  openCallbacks(): { callbacks: RequiredHostCallbacks; dispose(): void };
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
let generation = 0;
let walletOwnerLease: Promise<string | undefined> | undefined;
let ownerRevocationBound = false;
let walletHandedOver = false;
let localIdentityUpdateQueue: Promise<unknown> = Promise.resolve();
const noop = (): void => undefined;

/** Serializes native restoration, explicit claims, and shared metadata hints. */
export function withLocalIdentityUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = localIdentityUpdateQueue.then(operation);
  localIdentityUpdateQueue = result.catch(noop);
  return result;
}

export function initPageCore(coordinator: BlockingModalCoordinator): void {
  modalCoordinator = coordinator;
}

/** Called as soon as the page knows it, so a core booted by an early login is already the product's. */
export function setPageProduct(product: PageProduct): void {
  pageProduct = product;
  if (current !== null && !isPageProduct(current)) {
    // A navigation must not retain a second signing authority under the old
    // product. Same-product iframe replacements keep their existing core.
    if (current.persistent) {
      current.dispose();
    }
  }
}

function productIdOf(product: PageProduct): string {
  return product.productId ?? labelToProductId(product.label);
}

function isPageProduct(core: Core): boolean {
  return core.product.label === pageProduct.label && productIdOf(core.product) === productIdOf(pageProduct);
}

export function disposePageCores(): void {
  generation++;
  for (const core of cores) {
    core.dispose();
  }
}

function retireWalletOwner(lease?: string): void {
  if (walletOwnerLease === undefined) {
    return;
  }
  walletOwnerLease = undefined;
  disposePageCores();
  dispatchAuthState({
    tag: 'WalletUnavailable',
    reason:
      lease === undefined
        ? 'The test wallet owner frame closed. Retry wallet verification.'
        : 'The test wallet moved to another tab. Reload to use it here.',
  });
  if (lease !== undefined) {
    walletHandedOver = true;
    window.dispatchEvent(new Event(WALLET_OWNER_REVOKED_EVENT));
    void requestWalletOwner({ action: 'release', lease }).catch(noop);
  }
}

async function ensureWalletOwner(): Promise<void> {
  if (walletHandedOver) {
    throw new Error('The test wallet moved to another tab. Reload to use it here.');
  }
  if (!ownerRevocationBound) {
    ownerRevocationBound = true;
    subscribeWalletOwnerRevoked(retireWalletOwner);
  }
  if (walletOwnerLease === undefined) {
    const pending = requestWalletOwner({ action: 'acquire' }).catch((error: unknown) => {
      if (walletOwnerLease === pending) {
        walletOwnerLease = undefined;
      }
      throw error;
    });
    walletOwnerLease = pending;
  }
  const pending = walletOwnerLease;
  const lease = await pending;
  if (walletOwnerLease !== pending) {
    throw new Error('The test wallet lost exclusive signing ownership.');
  }
  if (lease === undefined) {
    walletOwnerLease = undefined;
    throw new Error('The test wallet could not acquire exclusive signing ownership.');
  }
}
export async function acquireCore(): Promise<CoreLease> {
  const requestedGeneration = generation;
  await initializeSessionMode();
  if (requestedGeneration !== generation) {
    throw new Error('Page core retired while loading wallet state');
  }
  if (current?.wallet !== undefined && !isCurrentLocalWallet(current.wallet.binding)) {
    disposePageCores();
    throw new Error('The test wallet or network changed. Reopen the Wallet tab.');
  }
  if (current === null || current.faulted || !isPageProduct(current)) {
    if (current?.persistent === true) {
      current.dispose();
    }
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
    if (core.leases === 0 && !core.persistent) {
      core.dispose();
    }
  };
  try {
    const runtime = await core.runtime;
    if (!cores.has(core)) {
      throw new Error('Page core retired before it became ready');
    }
    return { runtime, wallet: core.wallet, connect: kind => connect(core, runtime, kind), release };
  } catch (error) {
    release();
    throw error;
  }
}

export async function activeLocalWallet(): Promise<LiveLocalWallet> {
  await initializeLocalWalletState();
  if (!isExperimentalWalletActive()) {
    throw new Error('Enable the debug test wallet before checking its username.');
  }
  const lease = await acquireCore();
  try {
    if (lease.wallet === undefined) {
      throw new Error('The current test wallet is not ready.');
    }
    assertLocalWallet(lease.wallet);
    return lease.wallet;
  } finally {
    lease.release();
  }
}

export function assertLocalWallet(wallet: LiveLocalWallet): void {
  if (
    !DEBUG ||
    !isCurrentLocalWallet(wallet.binding) ||
    current?.wallet !== wallet ||
    !cores.has(current) ||
    current.faulted ||
    wallet.identity.identityAccountId !== wallet.binding.identityAccountId
  ) {
    throw new Error('The test identity changed. Reopen the Wallet tab.');
  }
}
export function cancelPairing(): void {
  for (const core of cores) {
    void core.runtime.then(runtime => {
      if (cores.has(core) && 'cancelPairing' in runtime) {
        runtime.cancelPairing();
      }
    }, noop);
  }
}

function createCore(product: PageProduct): Core {
  if (modalCoordinator === null) {
    throw new Error('TrUAPI page core used before initPageCore');
  }
  log.event('wallet core create', { flow: 'wallet', landing: product === LANDING_PRODUCT });
  const coordinator = modalCoordinator;
  const blockingModalScope = coordinator.createScope();
  const connectionDisposers = new Set<() => void>();
  const context = isExperimentalWalletActive() ? localWalletContext() : undefined;
  const { productId: _productId, ...hostConfig } = createTruapiRuntimeConfig(product.label, product.productId);
  let booted: PageRuntime | undefined;
  let worker: Worker | undefined;
  let disposed = false;
  let unsubscribeStore: (() => void) | undefined;
  let unsubscribeIdentity: (() => void) | undefined;
  let unsubscribeClose: (() => void) | undefined;
  let monitor: TrUApiProductProvider | undefined;
  let activatedIdentity: LocalIdentity | undefined;
  let nativeSessionUiInfo: LiveLocalWallet['nativeSessionUiInfo'];
  let walletAuthReady = false;
  let pendingWalletAuthState: AuthState | undefined;
  const assertCurrent = (): void => {
    if (disposed || (context === undefined ? isExperimentalWalletActive() : !isCurrentLocalWallet(context))) {
      throw new Error('Wallet or network changed while the page core was starting.');
    }
  };
  const callbacks = createHostCallbacks({
    label: product.label,
    pairingLabel: product.pairing?.label,
    pairingDotSuffix: product.pairing?.dotSuffix,
    pairingHostGlobal: product.pairing?.hostGlobal,
    blockingModalScope,
  });
  const forwardAuthState = callbacks.auth.authStateChanged;
  callbacks.auth.authStateChanged = state => {
    if (disposed || (context === undefined ? isExperimentalWalletActive() : !isCurrentLocalWallet(context))) {
      return;
    }
    if (context === undefined) {
      forwardAuthState(state);
      return;
    }
    if (state.tag === 'Connected') {
      const account = state.value.identityAccountId;
      if (account === undefined || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(account)) {
        return;
      }
      const identityAccountId = `0x${account.replace(/^0x/, '').toLowerCase()}`;
      if (core.wallet !== undefined && identityAccountId !== core.wallet.binding.identityAccountId) {
        return;
      }
      const liteUsername = state.value.liteUsername;
      activatedIdentity = {
        identityAccountId,
        ...(liteUsername !== undefined && liteUsername !== '' ? { liteUsername } : {}),
      };
      nativeSessionUiInfo = { publicKey: state.value.publicKey, fullUsername: state.value.fullUsername };
      if (core.wallet !== undefined) {
        core.wallet.identity = activatedIdentity;
        core.wallet.nativeSessionUiInfo = nativeSessionUiInfo;
      }
    }
    if (walletAuthReady) {
      forwardAuthState(state);
    } else {
      pendingWalletAuthState = state;
    }
  };
  const runtime = Promise.resolve().then(async (): Promise<PageRuntime> => {
    assertCurrent();
    if (context === undefined) {
      worker = new HostWorker();
      booted = await createWebWorkerPairingHostRuntime(worker, callbacks, { hostConfig });
      assertCurrent();
      const pairing = booted;
      log.event('wallet core booted', { flow: 'wallet' });
      // Other tabs' logins land in the shared session store. Once now too, for a session stored before boot.
      unsubscribeStore = onStoredSessionChanged(() => {
        // Fence both local and cross-tab changes before the worker reloads auth.
        setNotificationAccount(product.label, undefined);
        pairing.notifySessionStoreChanged();
      });
      queueMicrotask(() => {
        if (!disposed) {
          pairing.notifySessionStoreChanged();
        }
      });
      return pairing;
    }
    await ensureWalletOwner();
    assertCurrent();
    const secret = await readLocalWalletSecret();
    if (secret === undefined) {
      throw new Error('Experimental wallet is unavailable. Disconnect it in the debug bar.');
    }
    try {
      assertCurrent();
      worker = new HostWorker();
      const signing = await createWebWorkerSigningHostRuntime(worker, callbacks, {
        hostConfig: { ...hostConfig, networkSuffix: getActiveServicesConfig().dotns.TLD },
      });
      booted = signing;
      assertCurrent();
      await signing.activateLocalSession(secret);
      assertCurrent();
      if (activatedIdentity === undefined) {
        throw new Error('Native activation did not report its identity.');
      }
      const binding: LocalWalletIdentityBinding = {
        ...context,
        identityAccountId: activatedIdentity.identityAccountId,
      };
      await withLocalIdentityUpdate(async () => {
        const hint = await readVerifiedLocalIdentity(binding);
        assertCurrent();
        let usernameVerified = false;
        try {
          const identity = await signing.refreshLocalIdentity();
          assertCurrent();
          if (identity.identityAccountId !== binding.identityAccountId) {
            throw new Error('Restored username did not match the active wallet.');
          }
          activatedIdentity = identity;
          usernameVerified = true;
          await writeVerifiedLocalIdentity(binding, identity);
        } catch (error) {
          // A known username must be reverified before publishing Connected.
          // No cached username is a hint, not proof of chain absence; failure
          // there leaves the native bare identity usable for Check username.
          assertCurrent();
          if (hint?.liteUsername !== undefined || usernameVerified) {
            throw error;
          }
          log.warn('[dot.li] automatic test-wallet username lookup failed:', error);
        }
        assertCurrent();
        if (activatedIdentity?.identityAccountId !== binding.identityAccountId) {
          throw new Error('Native identity did not match the active wallet.');
        }
        core.wallet = { runtime: signing, binding, identity: activatedIdentity, usernameVerified, nativeSessionUiInfo };
      });
      // The runtime has no close subscription; one host connection observes
      // worker death even when no product frame is mounted. It is not a core.
      monitor = await signing.createProvider({ productId: productIdOf(product) });
      assertCurrent();
      let closeError: Error | undefined;
      unsubscribeClose = monitor.subscribeClose?.(error => {
        if (disposed) {
          return;
        }
        closeError = error;
        core.faulted = true;
        core.dispose();
        dispatchAuthState({ tag: 'WalletUnavailable', reason: error.message });
      });
      if (closeError !== undefined) {
        throw closeError;
      }
      unsubscribeIdentity = onVerifiedLocalIdentityChanged(() => {
        void withLocalIdentityUpdate(async () => {
          const wallet = core.wallet;
          if (wallet === undefined || disposed || !isCurrentLocalWallet(binding)) {
            return;
          }
          const cached = await readVerifiedLocalIdentity(binding);
          assertCurrent();
          if (cached === undefined || cached.liteUsername === wallet.identity.liteUsername) {
            return;
          }
          const identity = await signing.refreshLocalIdentity();
          assertCurrent();
          if (identity.identityAccountId !== binding.identityAccountId) {
            throw new Error('Shared username belongs to another identity.');
          }
          wallet.identity = identity;
          wallet.usernameVerified = true;
        }).catch((error: unknown) => {
          if (disposed) {
            return;
          }
          log.warn('[dot.li] shared test-wallet username refresh failed:', error);
          showNotification({
            text: 'A shared test-wallet username changed, but this app could not refresh it. Use Wallet tab → Check username.',
            label: 'Test wallet',
            browserNotification: false,
          });
        });
      });
      log.event('wallet core booted', { flow: 'wallet', experimental: true });
      walletAuthReady = true;
      if (pendingWalletAuthState !== undefined) {
        forwardAuthState(pendingWalletAuthState);
      }
      return signing;
    } finally {
      secret.fill(0);
    }
  });
  const core: Core = {
    product,
    runtime,
    wallet: undefined,
    leases: 0,
    persistent: context !== undefined,
    faulted: false,
    openCallbacks() {
      if (disposed) {
        throw new Error('Page core callbacks are unavailable');
      }
      const scope = coordinator.createScope();
      const connectionCallbacks = createHostCallbacks({
        label: product.label,
        blockingModalScope: scope,
      });
      // Authentication and session storage stay core-owned; interactive
      // product prompts cannot outlive the connection that requested them.
      let closed = false;
      connectionCallbacks.auth = {
        authStateChanged: state => {
          if (!closed) {
            callbacks.auth.authStateChanged(state);
          }
        },
      };
      connectionCallbacks.coreStorage = callbacks.coreStorage;
      const dispose = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        connectionDisposers.delete(dispose);
        scope.dispose();
      };
      connectionDisposers.add(dispose);
      return { callbacks: connectionCallbacks, dispose };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      cores.delete(core);
      if (current === core) {
        current = null;
      }
      log.event('wallet core disposed', { flow: 'wallet', faulted: core.faulted });
      unsubscribeStore?.();
      unsubscribeIdentity?.();
      unsubscribeClose?.();
      for (const dispose of connectionDisposers) {
        dispose();
      }
      blockingModalScope.dispose();
      monitor?.dispose();
      booted?.dispose();
      // Revocation/replacement must stop signing before releasing ownership,
      // including a worker still booting or holding a native operation open.
      if (context !== undefined) {
        worker?.terminate();
      }
    },
  };
  cores.add(core);
  void runtime.catch((error: unknown) => {
    const report = !disposed && context !== undefined && isCurrentLocalWallet(context);
    log.warn('[dot.li page-core] wallet core failed to boot:', error);
    core.faulted = true;
    core.dispose();
    // A runtime factory may resolve after an early dispose. Retire it too.
    booted?.dispose();
    if (report) {
      dispatchAuthState({ tag: 'WalletUnavailable', reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return core;
}

async function connect(
  core: Core,
  runtime: PageRuntime,
  executionKind: ProductExecutionKind = 'App',
): Promise<CoreConnection> {
  if (!cores.has(core)) {
    throw new Error('Page core is closed');
  }
  const productId = productIdOf(core.product);
  const callbacks = core.openCallbacks();
  let provider: TrUApiProductProvider;
  try {
    provider = await runtime.createProvider({ productId, executionKind }, callbacks.callbacks);
  } catch (error) {
    log.warn('[dot.li page-core] wallet core refused a connection:', error);
    callbacks.dispose();
    core.faulted = true;
    throw error;
  }
  if (!cores.has(core)) {
    callbacks.dispose();
    provider.dispose();
    throw new Error('Page core closed while connecting the product');
  }
  let closing = false;
  // A deliberate close also fires close listeners. Any other close is the core going down.
  provider.subscribeClose?.(() => {
    callbacks.dispose();
    if (!closing) {
      log.event('wallet core went down under a connection', { flow: 'wallet' });
      core.faulted = true;
    }
  });
  return {
    provider,
    productId,
    wallet: core.wallet,
    close() {
      if (closing) {
        return;
      }
      closing = true;
      callbacks.dispose();
      provider.dispose();
    },
  };
}
