// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one refcounted TrUAPI core, under its product's label. The core outlives its last lease by the destroy
// delay, so a lease taken soon after keeps it. A faulted one is never handed out again, and one that goes down while it
// is the page's core is replaced at once when it is held. One nobody holds just goes, and the next request dials.

import type { ProductExecutionKind, TrUApiProductProvider } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  log,
  realTimers,
  type AsyncTaskPool,
  type ListenerSet,
  type Timers,
} from '@dotli/shared';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import type { BootCoreRuntime, BootedCoreRuntime } from './core-runtime.js';
import { createPhoneRequestTracker, type PhoneRequestTracker } from './phone-requests.js';
import { labelToProductId } from './runtime-config.js';

export type PageProduct = {
  label: string;
  /** Overrides the id the label derives, such as for the local debug routes or the account a site names. */
  productId?: string | undefined;
  /** How pairing presents itself, when not as the product. */
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
};

/** Close it through `close`, never the provider, or the core is marked faulted. */
export type CoreConnection = {
  provider: TrUApiProductProvider;
  productId: string;
  close(): void;
};

export type CoreLease = {
  runtime: WorkerPairingHostRuntime;
  connect(executionKind?: ProductExecutionKind): Promise<CoreConnection>;
  /**
   * Hears once that this core went down, was refused or turned stale, when its replacement is already the one a
   * request gets. Called at once for a core that is already down. Returns the unsubscribe.
   */
  subscribeDown(listener: () => void): () => void;
  /** Idempotent. Drops the down listeners subscribed through this lease. */
  release(): void;
};

/**
 * What took a core out of service, a closed set so the metric's `reason` tag stays bounded. `stale` is a pairing core
 * booted before the local wallet could be read.
 */
export type CoreDownReason = 'refused' | 'closed' | 'stale';

/** A replacement core that could not boot, already reported by the page core. */
export class CoreRedialError extends Error {
  override name = 'CoreRedialError';

  constructor(error: unknown) {
    super('The replacement wallet core could not boot', { cause: error });
  }
}

export type PageCoreDeps = {
  bootRuntime: BootCoreRuntime;
  /** Returns the unsubscribe. */
  onStoredSessionChanged: (listener: () => void) => () => void;
  coordinator: BlockingModalCoordinator;
  /** Boots replacement cores, with the retries a redial gets. */
  redials?: AsyncTaskPool;
  /** Makes the tracker of each dialed core, which its connections' frames feed. Default: {@link createPhoneRequestTracker}. */
  createPhoneRequests?: () => PhoneRequestTracker;
  /**
   * Told each time the page's last core goes, so what that core reported about the session is no longer anyone's to
   * keep. A core dialed later reports again.
   */
  onCoresGone?: () => void;
  /** How long a core outlives its last lease. Default {@link CORE_DESTROY_DELAY_MS}. 0 or less disposes at once. */
  destroyDelay?: number;
  /** The timers the destroy delay runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

export type PageCore = {
  /** Called as soon as the page knows it, so a core booted by an early login is already the product's. */
  setProduct(product: PageProduct): void;
  /** A request made while the core redials waits for the replacement. */
  acquire(): Promise<CoreLease>;
  cancelPairing(): void;
  /** Resets the session of every core already dialed, booting none, for a session that ended elsewhere. */
  resetSession(): Promise<void>;
};

type Core = {
  product: PageProduct;
  runtime: Promise<BootedCoreRuntime>;
  leases: number;
  faulted: boolean;
  downListeners: ListenerSet<undefined>;
  phoneRequests: PhoneRequestTracker;
  /** Runs while the core outlives its last lease. */
  destroyTimer: { handle: unknown } | null;
  dispose(): void;
};

/** What a page core serves until the page names its product. A page that never names one keeps it. */
export const LANDING_PRODUCT: PageProduct = {
  label: 'dotli',
  pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
};

/** How long a core in service outlives its last lease, so a lease taken soon after keeps the same core. */
const CORE_DESTROY_DELAY_MS = 5_000;
const REDIAL_RETRIES = 2;
const REDIAL_FIRST_DELAY_MS = 1_000;

function productIdOf(product: PageProduct): string {
  return product.productId ?? labelToProductId(product.label);
}

export function createPageCore(deps: PageCoreDeps): PageCore {
  const redials =
    deps.redials ??
    createAsyncTaskPool({
      poolSize: 1,
      retryCount: REDIAL_RETRIES,
      retryDelay: retry => REDIAL_FIRST_DELAY_MS * 2 ** retry,
    });
  const destroyDelay = deps.destroyDelay ?? CORE_DESTROY_DELAY_MS;
  const timers = deps.timers ?? realTimers;
  let pageProduct = LANDING_PRODUCT;
  let current: Core | null = null;
  // Also holds cores a product change or fault replaced while they still had leases.
  const cores = new Set<Core>();

  function clearDestroyTimer(core: Core): void {
    if (core.destroyTimer !== null) {
      timers.clearTimeout(core.destroyTimer.handle);
      core.destroyTimer = null;
    }
  }

  function isPageProduct(core: Core): boolean {
    return core.product.label === pageProduct.label && productIdOf(core.product) === productIdOf(pageProduct);
  }

  /** `redial` names why the core before it went down. A first dial has none. */
  function dial(product: PageProduct, redial?: CoreDownReason): Core {
    log.event(redial === undefined ? 'wallet core create' : 'wallet core redial', {
      flow: 'wallet',
      landing: product === LANDING_PRODUCT,
      ...(redial === undefined ? {} : { reason: redial }),
    });
    const blockingModalScope = deps.coordinator.createScope();
    const phoneRequests = (deps.createPhoneRequests ?? createPhoneRequestTracker)();
    const dropped = new AbortController();
    let unsubscribeStore: (() => void) | null = null;
    const request = {
      product,
      blockingModalScope,
      phoneRequests,
      isLive: () => cores.has(core),
      inService: () => cores.has(core) && !core.faulted,
    };
    const attempt = async (): Promise<BootedCoreRuntime> => {
      const booted = await deps.bootRuntime(request);
      // The signal owns the runtime from here, so a drop at any later point disposes it exactly once.
      if (dropped.signal.aborted) {
        booted.runtime.dispose();
        throw dropped.signal.reason;
      }
      dropped.signal.addEventListener(
        'abort',
        () => {
          booted.runtime.dispose();
        },
        { once: true },
      );
      return booted;
    };
    const booting = redial === undefined ? attempt() : redials.call(attempt, { signal: dropped.signal });
    // Settled here first, so whoever awaits the runtime sees the fault already recorded.
    const runtime = booting.then(
      booted => {
        // The pool can resolve a boot that was dropped in the same turn. Its runtime is already disposed.
        if (dropped.signal.aborted) {
          if (redial !== undefined) {
            m.count(S.WALLET_CORE_REDIAL, { outcome: 'aborted', reason: redial });
          }
          throw dropped.signal.reason;
        }
        // A local wallet core has no phone. Leases are handed out only after this runs, so no frame is tapped first.
        if (booted.local) {
          phoneRequests.dispose();
        }
        // A local wallet core holds its session in memory, so the stored one is not its to follow.
        if (!booted.local) {
          const followStore = (): void => {
            booted.runtime.notifySessionStoreChanged();
            // The store coming back can answer a wallet read that failed when this core booted.
            void booted.stale().then(stale => {
              if (stale) {
                wentDown(core, 'stale');
              }
            });
          };
          // Other tabs' logins land in the shared session store. Once now too, for a session stored or a store that
          // came back before this core subscribed, which no store event reports.
          unsubscribeStore = deps.onStoredSessionChanged(followStore);
          queueMicrotask(() => {
            if (cores.has(core)) {
              followStore();
            }
          });
        }
        if (redial !== undefined) {
          m.count(S.WALLET_CORE_REDIAL, { outcome: 'ok', reason: redial });
        }
        return booted;
      },
      (error: unknown) => {
        if (dropped.signal.aborted) {
          if (redial !== undefined) {
            m.count(S.WALLET_CORE_REDIAL, { outcome: 'aborted', reason: redial });
          }
          throw error;
        }
        core.faulted = true;
        if (redial === undefined) {
          // The caller that asked for this core gets the error and reports it.
          log.warn('[dot.li page-core] wallet core failed to boot:', error);
        } else {
          // Nobody asked for a redial, so the page core is the only one to report that it gave up.
          log.error('[dot.li page-core] wallet core redial failed:', error);
          captureException(error, { flow: 'wallet', step: 'core_redial', tags: { reason: redial } });
          m.count(S.WALLET_CORE_REDIAL, { outcome: 'error', reason: redial });
          // The page core has reported it, so a caller that hears of it must not report it again.
          throw new CoreRedialError(error);
        }
        throw error;
      },
    );
    runtime.catch(() => {
      // Logged above, and a redial nobody has asked for yet has no caller to tell.
    });
    const core: Core = {
      product,
      runtime,
      leases: 0,
      faulted: false,
      destroyTimer: null,
      phoneRequests,
      downListeners: createListenerSet<undefined>({ onListenerError: reportListener('wallet', 'page_core.down') }),
      dispose() {
        if (!cores.delete(core)) {
          return;
        }
        clearDestroyTimer(core);
        if (current === core) {
          current = null;
        }
        log.event('wallet core disposed', { flow: 'wallet', faulted: core.faulted });
        dropped.abort(new Error('The page core was disposed'));
        unsubscribeStore?.();
        blockingModalScope.dispose();
        phoneRequests.dispose();
        if (cores.size === 0) {
          deps.onCoresGone?.();
        }
      },
    };
    cores.add(core);
    const previous = current;
    current = core;
    // Only a redialed or lingering core can be current without a lease, and nobody waits on it once it is replaced.
    if (previous !== null && previous.leases === 0) {
      previous.dispose();
    }
    return core;
  }

  /** Idempotent, so a refused connection and the close that follows it, or two stale checks, take the core down once. */
  function wentDown(core: Core, reason: CoreDownReason): void {
    if (core.faulted) {
      return;
    }
    core.faulted = true;
    if (current === core) {
      if (core.leases > 0) {
        // A holder waits on the replacement, for the page's product, which a product change may have moved on from.
        dial(pageProduct, reason);
      } else {
        // Redialing a core nobody holds would boot a crashing one forever, so the next request dials instead.
        core.dispose();
      }
    }
    // Once only, as the guard above holds, and a holder that subscribes after this hears it at once instead.
    core.downListeners.emit(undefined);
  }

  async function connect(
    core: Core,
    runtime: WorkerPairingHostRuntime,
    executionKind: ProductExecutionKind = 'App',
  ): Promise<CoreConnection> {
    const productId = productIdOf(core.product);
    let provider: TrUApiProductProvider;
    try {
      provider = await runtime.createProvider({ productId, executionKind });
    } catch (error) {
      log.warn('[dot.li page-core] wallet core refused a connection:', error);
      wentDown(core, 'refused');
      throw error;
    }
    let closing = false;
    const tap = core.phoneRequests.connect();
    // The tracker only infers what it can, so a tap that fails is reported and the frame goes on as if untapped.
    const tapped = (side: 'product' | 'core', message: Uint8Array): void => {
      try {
        if (side === 'product') {
          tap.fromProduct(message);
        } else {
          tap.fromCore(message);
        }
      } catch (error) {
        captureException(error, { flow: 'wallet', step: 'phone_request_tap', tags: { side } });
        log.error(`[dot.li page-core] phone request tap failed on a frame from the ${side}:`, error);
      }
    };
    const unsubscribeTap = provider.subscribe(message => {
      tapped('core', message);
    });
    // A deliberate close also fires close listeners. Any other close is the core going down.
    provider.subscribeClose?.(() => {
      tap.close();
      if (!closing) {
        log.event('wallet core went down under a connection', { flow: 'wallet' });
        wentDown(core, 'closed');
      }
    });
    return {
      provider: {
        ...provider,
        postMessage(message) {
          provider.postMessage(message);
          tapped('product', message);
        },
      },
      productId,
      close() {
        closing = true;
        unsubscribeTap();
        tap.close();
        provider.dispose();
      },
    };
  }

  return {
    setProduct(product) {
      pageProduct = product;
      // Only a redialed or lingering core is current with no lease. It serves the product the page left, so it goes
      // now rather than with the next request.
      if (current !== null && current.leases === 0 && !isPageProduct(current)) {
        current.dispose();
      }
    },

    async acquire() {
      let core = current;
      if (core === null || core.faulted || !isPageProduct(core)) {
        core = dial(pageProduct);
      }
      // A lingering core is leased again, so it stays.
      clearDestroyTimer(core);
      core.leases++;
      let released = false;
      // A core outliving a lease must not call back a holder that let it go.
      const leaseUnsubscribes = new Set<() => void>();
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        for (const unsubscribe of leaseUnsubscribes) {
          unsubscribe();
        }
        leaseUnsubscribes.clear();
        core.leases--;
        if (core.leases === 0) {
          const lingers =
            destroyDelay > 0 && cores.has(core) && core === current && !core.faulted && isPageProduct(core);
          if (lingers) {
            core.destroyTimer = {
              handle: timers.setTimeout(() => {
                core.destroyTimer = null;
                core.dispose();
              }, destroyDelay),
            };
          } else {
            core.dispose();
          }
        }
      };
      let booted: BootedCoreRuntime;
      try {
        booted = await core.runtime;
      } catch (error) {
        release();
        throw error;
      }
      const { runtime } = booted;
      return {
        runtime,
        connect: executionKind => connect(core, runtime, executionKind),
        subscribeDown(listener) {
          if (released) {
            return () => undefined;
          }
          if (core.faulted) {
            listener();
            return () => undefined;
          }
          const unsubscribe = core.downListeners.subscribe(listener);
          leaseUnsubscribes.add(unsubscribe);
          return () => {
            leaseUnsubscribes.delete(unsubscribe);
            unsubscribe();
          };
        },
        release,
      };
    },

    cancelPairing() {
      for (const core of cores) {
        core.runtime.then(
          booted => {
            // A signing runtime has no pairing to cancel.
            if (!booted.local) {
              booted.runtime.cancelPairing();
            }
          },
          () => {
            // A core that never booted has no pairing to cancel.
          },
        );
      }
    },

    async resetSession() {
      await Promise.all(
        [...cores].map(async core => {
          let booted: BootedCoreRuntime;
          try {
            booted = await core.runtime;
          } catch {
            // A core that never booted holds no session, and its boot failure was reported as it failed.
            return;
          }
          await booted.runtime.resetSessionState();
        }),
      );
    },
  };
}
