// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one refcounted TrUAPI core, under its product's label. The core outlives its last lease by the destroy
// delay, so a lease taken soon after keeps it. A faulted one is never handed out again, and one that goes down while it
// is the page's core is replaced at once when it is held. One nobody holds just goes, and the next request dials. A
// replacement that fails to boot while nobody holds it goes too.

import type { ProductId } from '@parity/truapi';
import type { ExecutableKind, TrUApiProductProvider } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createStateMachine,
  log,
  noop,
  realTimers,
  type AsyncTaskPool,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { BlockingModalCoordinator, BlockingModalScope } from './createBlockingModalCoordinator.js';
import type { BootCoreRuntime, BootedCoreRuntime } from './createCoreRuntimeBoot.js';
import { CoreRedialError } from './coreRedialError.js';
import { createPhoneRequestTracker, type PhoneRequestTracker } from './createPhoneRequestTracker.js';
import { toProductId } from './createTruapiRuntimeConfig.js';
import { tapPhoneRequests } from './tapPhoneRequests.js';

const report = createReporter({ flow: 'wallet' });
const hearDownFailed = report.listener('page_core.down');

/**
 * One redial of the page's wallet core after the core was taken out of service. Tagged `outcome` (ok, error or aborted,
 * when a product change dropped it) and `reason`, what took the core out, as a failed one leaves the page without a
 * core.
 */
const walletCoreRedialMetric = defineCount<'aborted' | 'error' | 'ok'>('wallet.core_redial');

/**
 * Count. Telling a pairing core that the stored session changed threw, so the core may miss a login from another tab.
 * Tagged `outcome` (error) and `reason` (the error's name).
 */
const pageCoreSessionFollowMetric = defineCount<'error'>('page_core.session_follow');

/**
 * Count. A pairing core's check for the local wallet rejected, so the core stays in service though the wallet may be
 * back. Tagged `outcome` (error) and `reason` (the error's name).
 */
const pageCoreStaleReadMetric = defineCount<'error'>('page_core.stale_read');

/** Count. A page core handler or effect threw. Tagged `outcome` (error) and `reason` (the error's name). */
const pageCoreTransitionMetric = defineCount<'error'>('page_core.transition');

export type PageProduct = {
  label: string;
  /** Overrides the id the label derives, such as for the local debug routes or the account a site names. */
  productId?: string | undefined;
  /** How pairing presents itself, when not as the product. */
  pairing?: { label: string; dotSuffix: boolean; hostGlobal: boolean };
};

/** One core's own collaborators, built when the core is dialed and handed on whole. */
export type CoreContext = {
  product: PageProduct;
  /** Where the core's prompts queue, on the page's one coordinator. */
  blockingModalScope: BlockingModalScope;
  /** What the core's frames report phone requests to, and its confirmations claim from. */
  phoneRequests: PhoneRequestTracker;
  /** False once the core is gone, so a late step of its boot stands down. Never throws. */
  isLive: () => boolean;
  /**
   * False once the core went down or turned stale. Leases can keep a retired core running, and only the core in
   * service speaks for the session. Never throws.
   */
  isInService: () => boolean;
  /** Keeps the core's session slot in memory, for a core that must never write the stored session or the flag. */
  sessionInMemory: boolean;
};

/** Close it through `close`, never the provider, or the core is marked faulted. */
export type CoreConnection = {
  provider: TrUApiProductProvider;
  productId: ProductId;
  /** Closes the connection without taking the core down. Throws when the provider's own dispose throws. */
  close(): void;
};

export type CoreLease = {
  runtime: WorkerPairingHostRuntime;
  /**
   * Resolves with a connection to the core for a product that runs as `executionKind`, an app by default. Rejects when
   * the core refuses the connection, which takes the core down.
   */
  connect(params?: ConnectParams): Promise<CoreConnection>;
  /**
   * Hears once that this core went down, was refused or turned stale, when its replacement is already the one a
   * request gets. Called at once for a core that is already down. Returns the unsubscribe. Never throws.
   */
  subscribeDown(listener: () => void): () => void;
  /**
   * Idempotent. Drops the down listeners subscribed through this lease. Never throws. A release queued while the page
   * core drains can still hear a down queued ahead of it.
   */
  release(): void;
};

/**
 * What took a core out of service, a closed set so the metric's `reason` tag stays bounded. `stale` is a pairing core
 * booted before the local wallet could be read.
 */
export type CoreDownReason = 'refused' | 'closed' | 'stale';

type Params = {
  /** Boots one core's runtime. Rejects when a step of the boot fails. */
  bootRuntime: BootCoreRuntime;
  /** Calls `listener` each time the page's stored session changes. Returns the unsubscribe. */
  subscribeStoredSession: (listener: () => void) => () => void;
  /** Where each core's prompts queue, one scope per core. */
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

type ConnectParams = {
  /** What the product runs as. An app by default. */
  executionKind?: ExecutableKind | undefined;
};

export type PageCore = ReturnType<typeof createPageCore>;

type Reply<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

type CoreParts = {
  id: symbol;
  product: PageProduct;
  /** Why the core before it went down. A first dial has none. */
  redial: CoreDownReason | undefined;
  blockingModalScope: BlockingModalScope;
  phoneRequests: PhoneRequestTracker;
};

/**
 * `lingering` is a core in service that outlives its last lease. `down` is one out of service that leases still hold.
 * A core is in the page's table from its dial until it leaves.
 */
type Core =
  | (CoreParts & {
      kind: 'booting';
      /** Aborted as the core leaves before it booted, which cancels the boot and its redial. */
      dropped: AbortController;
      waiting: ReadonlyMap<symbol, Reply<CoreLease>>;
      /** Whether the page cancelled pairing while the core booted, so a pairing core cancels it once booted. */
      pairingCancelled: boolean;
    })
  | (CoreParts & { kind: 'live'; booted: BootedCoreRuntime; stopFollowing: () => void; leases: ReadonlySet<symbol> })
  | (CoreParts & { kind: 'lingering'; booted: BootedCoreRuntime; stopFollowing: () => void; timer: unknown })
  | (CoreParts & {
      kind: 'down';
      booted: BootedCoreRuntime;
      stopFollowing: () => void;
      reason: CoreDownReason;
      leases: ReadonlySet<symbol>;
    });

type LiveCore = Extract<Core, { kind: 'live' }>;

/** `current` is the core a request gets while it serves `product`. */
type PageCoreState = {
  kind: 'serving';
  product: PageProduct;
  current: symbol | null;
  cores: ReadonlyMap<symbol, Core>;
};

type PageCoreEvent =
  | { kind: 'productSet'; product: PageProduct }
  | { kind: 'leaseAsked'; leaseId: symbol; reply: Reply<CoreLease> }
  | { kind: 'booted'; coreId: symbol; booted: BootedCoreRuntime }
  | { kind: 'bootFailed'; coreId: symbol; error: unknown }
  | { kind: 'leaseReleased'; coreId: symbol; leaseId: symbol }
  | { kind: 'lingerEnded'; coreId: symbol; timer: unknown }
  | { kind: 'wentDown'; coreId: symbol; reason: CoreDownReason }
  | { kind: 'storeChanged'; coreId: symbol }
  | { kind: 'staleRead'; coreId: symbol; stale: boolean }
  | { kind: 'staleReadFailed'; error: unknown }
  | { kind: 'pairingCancelled' };

type PageCoreEffect =
  | { kind: 'leaseGranted'; reply: Reply<CoreLease>; core: LiveCore; leaseId: symbol }
  | { kind: 'leaseRefused'; reply: Reply<CoreLease>; error: unknown }
  | { kind: 'dialed'; product: PageProduct; redial: CoreDownReason | undefined }
  | { kind: 'redialed'; outcome: 'ok' | 'aborted'; reason: CoreDownReason }
  | { kind: 'bootFailed'; redial: CoreDownReason | undefined; error: unknown }
  | { kind: 'disposed'; core: Core }
  | { kind: 'lingerCancelled'; timer: unknown }
  | { kind: 'orphaned'; runtime: WorkerPairingHostRuntime }
  /** A local wallet core has no phone. */
  | { kind: 'phoneDropped'; phoneRequests: PhoneRequestTracker }
  | { kind: 'sessionStoreChanged'; runtime: WorkerPairingHostRuntime }
  | { kind: 'staleReadFailed'; error: unknown }
  | { kind: 'pairingCancelled'; runtime: WorkerPairingHostRuntime }
  | { kind: 'coresGone' };

type PageCoreMachine = MachineTypes<PageCoreState, PageCoreEvent, PageCoreEffect>;

/** What a page core serves until the page names its product. A page that never names one keeps it. */
export const LANDING_PRODUCT: PageProduct = {
  label: 'dotli',
  pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
};

/** How long a core in service outlives its last lease, so a lease taken soon after keeps the same core. */
const CORE_DESTROY_DELAY_MS = 5_000;
const REDIAL_RETRIES = 2;
const REDIAL_FIRST_DELAY_MS = 1_000;

/** Returns the page's one refcounted core, which dials on its first request. */
export function createPageCore({
  bootRuntime,
  subscribeStoredSession,
  coordinator,
  redials = createAsyncTaskPool({
    poolSize: 1,
    retryCount: REDIAL_RETRIES,
    retryDelay: retry => REDIAL_FIRST_DELAY_MS * 2 ** retry,
  }),
  createPhoneRequests = createPhoneRequestTracker,
  onCoresGone,
  destroyDelay = CORE_DESTROY_DELAY_MS,
  timers = realTimers,
}: Params) {
  /**
   * Moves a live or lingering core out of service. A held core that is the page's has its replacement dialed in the
   * same state, so a lease that hears the core go finds the replacement current. One nobody holds leaves.
   */
  function takeOutOfService(
    state: PageCoreState,
    { coreId, reason }: { coreId: symbol; reason: CoreDownReason },
    transition: Transition<PageCoreMachine>,
  ): void {
    const core = state.cores.get(coreId);
    if (core?.kind === 'lingering') {
      transition.emitState(leave(state, core, transition));
      return;
    }
    if (core?.kind !== 'live') {
      return;
    }
    const down: Core = { ...core, kind: 'down', reason };
    const next = withCore(state, down);
    if (down.leases.size === 0) {
      transition.emitState(leave(next, down, transition));
    } else if (state.current === coreId) {
      // A holder waits on the replacement, for the page's product, which a product change may have moved on from.
      transition.emitState(dial(next, { redial: reason, waiting: new Map() }, transition));
    } else {
      transition.emitState(next);
    }
  }

  const machine = createStateMachine<PageCoreMachine>({
    initial: { kind: 'serving', product: LANDING_PRODUCT, current: null, cores: new Map() },
    handlers: {
      serving: {
        productSet(state, { product }, transition) {
          const next = { ...state, product };
          const core = getCurrentCore(state);
          // Only a redialed or lingering core is current with no lease. It serves the product the page left, so it
          // goes now rather than with the next request.
          if (core === null || servesProduct(core, product)) {
            transition.emitState(next);
            return;
          }
          transition.emitState(dropIfUnheld(next, core, transition));
        },
        leaseAsked(state, { leaseId, reply }, transition) {
          const core = getCurrentCore(state);
          if (core === null || core.kind === 'down' || !servesProduct(core, state.product)) {
            transition.emitState(dial(state, { redial: undefined, waiting: new Map([[leaseId, reply]]) }, transition));
            return;
          }
          switch (core.kind) {
            case 'booting':
              transition.emitState(withCore(state, { ...core, waiting: new Map([...core.waiting, [leaseId, reply]]) }));
              return;
            case 'live': {
              const live: LiveCore = { ...core, leases: new Set([...core.leases, leaseId]) };
              transition.emitState(withCore(state, live));
              transition.emitSideEffect({ kind: 'leaseGranted', reply, core: live, leaseId });
              return;
            }
            case 'lingering': {
              const live: LiveCore = { ...getBootedParts(core), kind: 'live', leases: new Set([leaseId]) };
              transition.emitState(withCore(state, live));
              transition.emitSideEffect({ kind: 'lingerCancelled', timer: core.timer });
              transition.emitSideEffect({ kind: 'leaseGranted', reply, core: live, leaseId });
              return;
            }
          }
        },
        booted(state, { coreId, booted }, { emitState, emitSideEffect, update }) {
          const core = state.cores.get(coreId);
          // A core dropped after its boot resolved holds no runtime, so the runtime this event carries goes.
          if (core?.kind !== 'booting') {
            emitSideEffect({ kind: 'orphaned', runtime: booted.runtime });
            return;
          }
          // A local wallet core holds its session in memory, so the stored one is not its to follow. Other tabs' logins
          // land in the shared session store.
          const stopFollowing = booted.local
            ? noop
            : subscribeStoredSession(() => {
                update({ kind: 'storeChanged', coreId });
              });
          const live: LiveCore = {
            ...getParts(core),
            kind: 'live',
            booted,
            stopFollowing,
            leases: new Set(core.waiting.keys()),
          };
          emitState(withCore(state, live));
          if (booted.local) {
            // Its leases are handed out after this, so no frame is tapped first.
            emitSideEffect({ kind: 'phoneDropped', phoneRequests: core.phoneRequests });
          } else {
            // A session stored or a store that came back before the core followed it is no store event.
            update({ kind: 'storeChanged', coreId });
            if (core.pairingCancelled) {
              emitSideEffect({ kind: 'pairingCancelled', runtime: booted.runtime });
            }
          }
          for (const [leaseId, reply] of core.waiting) {
            emitSideEffect({ kind: 'leaseGranted', reply, core: live, leaseId });
          }
          if (core.redial !== undefined) {
            emitSideEffect({ kind: 'redialed', outcome: 'ok', reason: core.redial });
          }
        },
        bootFailed(state, { coreId, error }, transition) {
          const core = state.cores.get(coreId);
          if (core?.kind !== 'booting') {
            return;
          }
          transition.emitSideEffect({ kind: 'bootFailed', redial: core.redial, error });
          transition.emitState(leave(state, core, transition));
          // The page core reports a redial that failed, so a caller that hears of it must not report it again.
          const refusal = core.redial === undefined ? error : new CoreRedialError(error);
          for (const reply of core.waiting.values()) {
            transition.emitSideEffect({ kind: 'leaseRefused', reply, error: refusal });
          }
        },
        leaseReleased(state, { coreId, leaseId }, transition) {
          const core = state.cores.get(coreId);
          if ((core?.kind !== 'live' && core?.kind !== 'down') || !core.leases.has(leaseId)) {
            return;
          }
          const leases = new Set(core.leases);
          leases.delete(leaseId);
          if (leases.size > 0) {
            transition.emitState(withCore(state, { ...core, leases }));
            return;
          }
          const lingers =
            core.kind === 'live' && destroyDelay > 0 && state.current === coreId && servesProduct(core, state.product);
          if (!lingers) {
            transition.emitState(leave(state, core, transition));
            return;
          }
          const timer = timers.setTimeout(() => {
            transition.update({ kind: 'lingerEnded', coreId, timer });
          }, destroyDelay);
          transition.emitState(withCore(state, { ...getBootedParts(core), kind: 'lingering', timer }));
        },
        lingerEnded(state, { coreId, timer }, transition) {
          const core = state.cores.get(coreId);
          if (core?.kind !== 'lingering' || core.timer !== timer) {
            return;
          }
          transition.emitState(leave(state, core, transition));
        },
        wentDown: takeOutOfService,
        storeChanged(state, { coreId }, { emitSideEffect, update }) {
          const core = state.cores.get(coreId);
          if (core === undefined || core.kind === 'booting') {
            return;
          }
          emitSideEffect({ kind: 'sessionStoreChanged', runtime: core.booted.runtime });
          // The store coming back can answer a wallet read that failed when this core booted.
          update(
            new Promise<boolean>(resolve => {
              resolve(core.booted.isStale());
            }).then(
              (stale): PageCoreEvent => ({ kind: 'staleRead', coreId, stale }),
              (error: unknown): PageCoreEvent => ({ kind: 'staleReadFailed', error }),
            ),
          );
        },
        staleRead(state, { coreId, stale }, transition) {
          if (!stale) {
            return;
          }
          takeOutOfService(state, { coreId, reason: 'stale' }, transition);
        },
        staleReadFailed(_state, { error }, { emitSideEffect }) {
          emitSideEffect({ kind: 'staleReadFailed', error });
        },
        pairingCancelled(state, _event, { emitState, emitSideEffect }) {
          const cores = new Map(state.cores);
          for (const core of state.cores.values()) {
            if (core.kind === 'booting') {
              cores.set(core.id, { ...core, pairingCancelled: true });
            } else if (!core.booted.local) {
              // A signing runtime has no pairing to cancel.
              emitSideEffect({ kind: 'pairingCancelled', runtime: core.booted.runtime });
            }
          }
          emitState({ ...state, cores });
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'leaseGranted':
          effect.reply.resolve(createLease(effect.core, effect.leaseId));
          return;
        case 'leaseRefused':
          effect.reply.reject(effect.error);
          return;
        case 'dialed':
          report.log.event(effect.redial === undefined ? 'wallet core create' : 'wallet core redial', {
            landing: effect.product === LANDING_PRODUCT,
            ...(effect.redial === undefined ? {} : { reason: effect.redial }),
          });
          return;
        case 'redialed':
          walletCoreRedialMetric.count({ outcome: effect.outcome, reason: effect.reason });
          return;
        case 'bootFailed':
          if (effect.redial === undefined) {
            // The caller that asked for this core gets the error and reports it.
            log.warn('[dot.li page-core] wallet core failed to boot:', effect.error);
            return;
          }
          // Nobody asked for a redial, so the page core is the only one to report that it gave up.
          report.defect(effect.error, {
            step: 'core_redial',
            tags: { reason: effect.redial },
            metric: walletCoreRedialMetric,
            reason: effect.redial,
            message: '[dot.li page-core] wallet core redial failed:',
          });
          return;
        case 'disposed':
          disposeCore(effect.core);
          return;
        case 'lingerCancelled':
          timers.clearTimeout(effect.timer);
          return;
        case 'orphaned':
          effect.runtime.dispose();
          return;
        case 'phoneDropped':
          effect.phoneRequests.dispose();
          return;
        case 'sessionStoreChanged':
          try {
            effect.runtime.notifySessionStoreChanged();
          } catch (error) {
            report.defect(error, {
              step: 'session_follow',
              metric: pageCoreSessionFollowMetric,
              message: '[dot.li page-core] telling the core the stored session changed failed:',
            });
          }
          return;
        case 'staleReadFailed':
          report.defect(effect.error, {
            step: 'stale_read',
            metric: pageCoreStaleReadMetric,
            message: '[dot.li page-core] reading whether the core turned stale failed:',
          });
          return;
        case 'pairingCancelled':
          effect.runtime.cancelPairing();
          return;
        case 'coresGone':
          onCoresGone?.();
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: pageCoreTransitionMetric,
        message: '[dot.li page-core] A page core transition threw',
      });
    },
  });

  return {
    /**
     * Called as soon as the page knows it, so a core booted by an early login is already the product's. Never
     * throws.
     */
    setProduct(product: PageProduct): void {
      machine.update({ kind: 'productSet', product });
    },

    /**
     * Resolves with a lease on the page's core, dialing one when none serves the page's product. A request made while
     * the core redials waits for the replacement. Rejects when the core fails to boot.
     */
    acquire(): Promise<CoreLease> {
      return new Promise((resolve, reject) => {
        machine.update({ kind: 'leaseAsked', leaseId: Symbol('lease'), reply: { resolve, reject } });
      });
    },

    /** Cancels the pairing of every pairing core dialed, at once or, for one still booting, once it boots. Never throws. */
    cancelPairing(): void {
      machine.update({ kind: 'pairingCancelled' });
    },

    /**
     * Resets the session of every core already dialed, once the boots and reads in flight have settled, booting none,
     * for a session that ended elsewhere. Rejects when a booted core fails to reset.
     */
    async resetSession(): Promise<void> {
      await machine.await();
      // A core that never booted holds no session, and its boot failure was reported as it failed.
      await Promise.all(
        [...machine.state.get().cores.values()].flatMap(core =>
          core.kind === 'booting' ? [] : [core.booted.runtime.resetSessionState()],
        ),
      );
    },
  };

  /**
   * Returns `state` with a core booting for the page's product, as the page's current core. A previous current core
   * nobody holds leaves in it.
   */
  function dial(
    state: PageCoreState,
    { redial, waiting }: Pick<Extract<Core, { kind: 'booting' }>, 'redial' | 'waiting'>,
    transition: Transition<PageCoreMachine>,
  ): PageCoreState {
    const { product } = state;
    const id = Symbol('core');
    const blockingModalScope = coordinator.createScope();
    const phoneRequests = createPhoneRequests();
    const dropped = new AbortController();
    const context: CoreContext = {
      product,
      blockingModalScope,
      phoneRequests,
      isLive: () => machine.state.get().cores.has(id),
      isInService: () => (machine.state.get().cores.get(id)?.kind ?? 'down') !== 'down',
      sessionInMemory: false,
    };
    transition.update(
      new Promise<PageCoreEvent>(resolve => {
        // A booted runtime is told as the boot ends, since a drop just after rejects the redial pool's call without it.
        function boot(): Promise<void> {
          return bootCore(context, dropped.signal).then(booted => {
            resolve({ kind: 'booted', coreId: id, booted });
          });
        }
        (redial === undefined ? boot() : redials.call(boot, { signal: dropped.signal })).catch((error: unknown) => {
          resolve({ kind: 'bootFailed', coreId: id, error });
        });
      }),
    );
    transition.emitSideEffect({ kind: 'dialed', product, redial });
    const previous = getCurrentCore(state);
    const next = withCore(
      { ...state, current: id },
      {
        id,
        product,
        redial,
        blockingModalScope,
        phoneRequests,
        dropped,
        kind: 'booting',
        waiting,
        pairingCancelled: false,
      },
    );
    return previous === null ? next : dropIfUnheld(next, previous, transition);
  }

  /**
   * Resolves with the booted runtime. Rejects when the boot fails, or when the core was dropped while it booted, after
   * disposing the runtime.
   */
  async function bootCore(context: CoreContext, dropped: AbortSignal): Promise<BootedCoreRuntime> {
    const booted = await bootRuntime(context);
    // A boot that ends after the drop has no core left to take its runtime.
    if (dropped.aborted) {
      booted.runtime.dispose();
      throw dropped.reason;
    }
    return booted;
  }

  /** Returns `state` without `core` when nothing holds it. A redial dropped before it booted is counted as aborted. */
  function dropIfUnheld(state: PageCoreState, core: Core, transition: Transition<PageCoreMachine>): PageCoreState {
    switch (core.kind) {
      case 'booting':
        if (core.waiting.size > 0) {
          return state;
        }
        if (core.redial !== undefined) {
          transition.emitSideEffect({ kind: 'redialed', outcome: 'aborted', reason: core.redial });
        }
        return leave(state, core, transition);
      case 'live':
        return core.leases.size > 0 ? state : leave(state, core, transition);
      case 'lingering':
        return leave(state, core, transition);
      case 'down':
        return state;
    }
  }

  /** Returns `state` without `core`, whose resources go once the state is emitted. */
  function leave(state: PageCoreState, core: Core, { emitSideEffect }: Transition<PageCoreMachine>): PageCoreState {
    const cores = new Map(state.cores);
    cores.delete(core.id);
    emitSideEffect({ kind: 'disposed', core });
    if (cores.size === 0) {
      emitSideEffect({ kind: 'coresGone' });
    }
    return { ...state, current: state.current === core.id ? null : state.current, cores };
  }

  /** Drops the runtime, prompts, phone claims and store following of a core that left the page. */
  function disposeCore(core: Core): void {
    report.log.event('wallet core disposed', { faulted: core.kind === 'down' });
    if (core.kind === 'booting') {
      core.dropped.abort(new Error('The page core was disposed'));
    } else {
      if (core.kind === 'lingering') {
        timers.clearTimeout(core.timer);
      }
      core.booted.runtime.dispose();
      core.stopFollowing();
    }
    core.blockingModalScope.dispose();
    core.phoneRequests.dispose();
  }

  function createLease(core: LiveCore, leaseId: symbol): CoreLease {
    /** Whether the lease is still held, and whether its core went down. */
    function readLease(state: PageCoreState): 'held' | 'down' | 'released' {
      const leased = state.cores.get(core.id);
      if ((leased?.kind !== 'live' && leased?.kind !== 'down') || !leased.leases.has(leaseId)) {
        return 'released';
      }
      return leased.kind === 'down' ? 'down' : 'held';
    }

    return {
      runtime: core.booted.runtime,
      connect: params => connect(core, params),
      subscribeDown(listener) {
        // A listener runs inside the state's write, which a throw would reach.
        function hearDown(): void {
          try {
            listener();
          } catch (error) {
            hearDownFailed(error);
          }
        }
        switch (readLease(machine.state.get())) {
          case 'released':
            return noop;
          case 'down':
            hearDown();
            return noop;
          case 'held':
            break;
        }
        const stop = machine.state.listen(state => {
          const lease = readLease(state);
          if (lease === 'held') {
            return;
          }
          stop();
          if (lease === 'down') {
            hearDown();
          }
        });
        return stop;
      },
      release() {
        machine.update({ kind: 'leaseReleased', coreId: core.id, leaseId });
      },
    };
  }

  async function connect(core: LiveCore, { executionKind = 'App' }: ConnectParams = {}): Promise<CoreConnection> {
    const { runtime, productId } = core.booted;
    let provider: TrUApiProductProvider;
    try {
      provider = await runtime.createProvider({ productId, executionKind });
    } catch (error) {
      log.warn('[dot.li page-core] wallet core refused a connection:', error);
      machine.update({ kind: 'wentDown', coreId: core.id, reason: 'refused' });
      throw error;
    }
    const tapped = tapPhoneRequests(provider, core.phoneRequests);
    let closing = false;
    // A deliberate close also fires close listeners. Any other close is the core going down.
    provider.subscribeClose?.(() => {
      tapped.untap();
      if (!closing) {
        report.log.event('wallet core went down under a connection');
        machine.update({ kind: 'wentDown', coreId: core.id, reason: 'closed' });
      }
    });
    return {
      provider: tapped.provider,
      productId,
      close() {
        closing = true;
        tapped.untap();
        provider.dispose();
      },
    };
  }

  function getCurrentCore(state: PageCoreState): Core | null {
    return state.current === null ? null : (state.cores.get(state.current) ?? null);
  }

  function withCore(state: PageCoreState, core: Core): PageCoreState {
    return { ...state, cores: new Map(state.cores).set(core.id, core) };
  }
}

/** The parts every phase of `core` keeps, so a core that moves on carries no field of the phase it left. */
function getParts({ id, product, redial, blockingModalScope, phoneRequests }: Core): CoreParts {
  return { id, product, redial, blockingModalScope, phoneRequests };
}

/** The parts every booted phase of `core` keeps. */
function getBootedParts(
  core: Exclude<Core, { kind: 'booting' }>,
): CoreParts & Pick<LiveCore, 'booted' | 'stopFollowing'> {
  return { ...getParts(core), booted: core.booted, stopFollowing: core.stopFollowing };
}

function servesProduct(core: Core, product: PageProduct): boolean {
  return core.product.label === product.label && getProductId(core.product) === getProductId(product);
}

function getProductId(product: PageProduct): string {
  return product.productId ?? toProductId(product.label);
}
