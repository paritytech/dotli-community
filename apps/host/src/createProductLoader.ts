// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes a `.dot` label to a product on screen, or to the screen that says why not. What sits in another frame or
// origin, and what reloads or writes the page, is passed in. The page's own state is imported.

import { getActiveTldSuffix, isVerifiedSession, type Backend } from '@dotli/config';
import type { BitswapClient } from '@dotli/bitswap';
import { createReporter, defineCount } from '@dotli/metrics';
import type { ProtocolClient } from '@dotli/protocol';
import type { ResolvePhase } from '@dotli/resolver';
import { isLoadedOutcome } from '@dotli/sandbox-wire';
import {
  createStateMachine,
  markHandled,
  noop,
  toError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { CachedCid } from '@dotli/storage';
import { readChatCapability } from './readChatCapability.js';
import { describeError, type ErrorDescription } from './describeError.js';
import { assertLaunchable } from './assertLaunchable.js';
import { fromCachedManifest, toCachedManifest, type ProductManifests } from './cachedManifest.js';
import { getProductFacts } from './getProductFacts.js';
import type { NameSource } from './createNameSource.js';
import { showNoContentError } from './showNoContentError.js';
import type { SandboxLoad, SandboxLoadReport } from './watchSandboxLoad.js';
import { applyProductBranding } from './applyProductBranding.js';
import type { RecentLabels } from './createRecentLabels.js';
import type { LoadEffect, LoadTelemetry } from './createLoadTelemetry.js';
import type { PageCidCache } from './createPageCidCache.js';
import type { CachedCopy, ServedCopy } from './revalidateCachedCopy.js';
import type { loadFailureScreen } from './loadFailureScreen.js';
import type { HostBridge } from './runtime/bridge.js';
import type { CoreLease } from './runtime/createPageCore.js';
import type { ProductFrame } from './runtime/createProductFrame.js';
import { authState } from './runtime/state/authState.js';
import { productState } from './runtime/state/productState.js';
import { startShieldAutoHide } from './startShieldAutoHide.js';
import { urlPillState } from './state/urlPillState.js';
import { pageTopbarAutoHide } from './createTopbarAutoHide.js';

const resolveReport = createReporter({ flow: 'resolve' });

/** Count. A transition of the page's load threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const loadTransitionMetric = defineCount<'error'>('resolve.load_transition');

type LoadRun = ReturnType<typeof startLoadRun>;

/** How the product reaches the screen: from the CID cache, or through the name. */
type LoadPath = 'fast' | 'slow';

/**
 * Where the page's load is. It starts idle and ends once. Between them it steps from the CID cache or the name to the
 * product's core and then the render, then holds the product in its frame, which is on screen once the handoff's side
 * work is done. A failure before that shows its screen before the load ends, since the first load rejects with what
 * the screen threw. A failure once on screen ends the load and shows its screen after.
 */
type LoadState =
  | { kind: 'idle' }
  | { kind: 'starting'; label: string }
  | { kind: 'readingCache'; run: LoadRun }
  | { kind: 'resolvingName'; run: LoadRun; manifestsRead: Promise<ProductManifests> }
  | { kind: 'readingManifests'; run: LoadRun; cid: string }
  | { kind: 'holdingCore'; run: LoadRun; path: LoadPath; cid: string; manifests: ProductManifests }
  | { kind: 'rendering'; run: LoadRun; path: LoadPath; cid: string; manifests: ProductManifests }
  | {
      kind: 'handingOff';
      run: LoadRun;
      path: LoadPath;
      cid: string;
      manifests: ProductManifests;
      stopListening: () => void;
      /** The content's outcome the sandbox had already reported, told once the handoff is. */
      outcome: SandboxLoadReport | null;
    }
  | { kind: 'onScreen'; run: LoadRun; stopListening: () => void }
  | { kind: 'failing'; label: string; error: unknown; description: ErrorDescription }
  | {
      kind: 'ended';
      /** What the first load rejects with: the setup's error, or what the failure screen threw. */
      error: Error | null;
    };

type LoadEvent =
  | { kind: 'load'; label: string }
  | { kind: 'start' }
  | { kind: 'cacheRead'; cached: CachedCid | null }
  | { kind: 'namePhase'; phase: ResolvePhase }
  | { kind: 'nameResolved'; cid: string | null }
  | { kind: 'manifestsRead'; manifests: ProductManifests }
  | { kind: 'coreHeld' }
  | { kind: 'rendered' }
  | { kind: 'stepFailed'; error: unknown }
  | { kind: 'handOff' }
  | { kind: 'productFailed'; error: unknown; failure: string }
  | { kind: 'contentOutcome'; report: SandboxLoadReport }
  | { kind: 'showFailure' };

/** The load's reports, and the side work it leaves behind as it moves. */
type LoaderEffect =
  | LoadEffect
  | { kind: 'shieldSettled'; autoHide: LoadRun['autoHide'] }
  | { kind: 'coreReleased'; coreHold: LoadRun['coreHold'] }
  | { kind: 'frameHalted' }
  | { kind: 'cidStored'; copy: CachedCopy }
  | { kind: 'cidRevalidated'; copy: ServedCopy }
  | { kind: 'productShown'; label: string; manifests: ProductManifests }
  | { kind: 'noContentShown'; label: string }
  | {
      kind: 'failureShown';
      label: string;
      error: unknown;
      description: ErrorDescription;
      /** What failed, for the failure screen's own report. */
      failure: string;
    };

type LoadMachine = MachineTypes<LoadState, LoadEvent, LoaderEffect>;

type Params = {
  /** How the page reaches the chains, which the failure screen names and the shield's verdict follows. */
  backend: Backend;
  /** True when the settings skip the CID cache, so the load neither reads nor writes it. */
  skipCidCache: boolean;
  /** The timers the product's icon budget runs on. The page's own by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Makes the reports of each of the load's effects. */
  report: LoadTelemetry['report'];
  /** Where names and manifests are read. */
  names: NameSource;
  productFrame: Pick<ProductFrame, 'render' | 'halt'>;
  bridge: Pick<HostBridge, 'setPageProduct'> & {
    /** Leases the page product's core. The load only lets the lease go. */
    acquirePageCore: () => Promise<Pick<CoreLease, 'release'>>;
  };
  sandboxLoad: Pick<SandboxLoad, 'subscribeOutcomes' | 'expectHeardWithin'>;
  cidCache: PageCidCache;
  recents: Pick<RecentLabels, 'record'>;
  failureScreen: typeof loadFailureScreen;
  onProtocolVersionMismatch: ProtocolClient['frame']['subscribeVersionMismatch'];
  /** Reads the product's icon. */
  bitswap: Pick<BitswapClient, 'get'>;
  /** The page path ahead of the product's own, which its frame does not get. */
  base?: string | undefined;
};

/** Builds the page's loader. Never throws. */
export function createProductLoader(params: Params) {
  /** Fails a load whose product is not on screen yet, and queues its failure screen. */
  const failLoad: HandlerOf<
    LoadMachine,
    'readingCache' | 'resolvingName' | 'readingManifests' | 'holdingCore' | 'rendering',
    'stepFailed'
  > = (state, { error }, { emitState, emitSideEffect, update }) => {
    const { run } = state;
    const description = describe(error);
    emitState({ kind: 'failing', label: run.label, error, description });
    emitSideEffect({ kind: 'failed', error, description });
    emitSideEffect({ kind: 'coreReleased', coreHold: run.coreHold });
    // A render that failed after it mounted the product leaves it holding its core under the failure screen.
    if (state.kind === 'rendering') {
      emitSideEffect({ kind: 'frameHalted' });
    }
    // Its own transition after these effects, so the report, the error state and the halt land before the screen shows.
    update({ kind: 'showFailure' });
  };
  const machine = createStateMachine<LoadMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        load(_state, { label }, { emitState, emitSideEffect, update }) {
          // The setup waits for the next transition, so the attempt and the journey's defaults are set before its
          // calls log anything.
          emitState({ kind: 'starting', label });
          emitSideEffect({ kind: 'started', label });
          update({ kind: 'start' });
        },
      },
      starting: {
        start({ label }, _event, { emitState, emitSideEffect, update }) {
          let run: LoadRun;
          try {
            run = startLoadRun(label, params);
          } catch (error) {
            emitState({ kind: 'ended', error: toError(error) });
            return;
          }
          emitState({ kind: 'readingCache', run });
          emitSideEffect({ kind: 'setUp' });
          update(
            runStep(
              () => (params.skipCidCache ? null : params.cidCache.get(label)),
              cached => ({ kind: 'cacheRead', cached }),
            ),
          );
        },
      },
      readingCache: {
        stepFailed: failLoad,
        cacheRead(state, { cached }, transition) {
          const { run } = state;
          const { label } = run;
          transition.emitSideEffect({ kind: 'cacheChecked', cid: cached?.cid ?? null });
          if (cached === null) {
            // In parallel with the CID, and awaited before anything renders, so a refused product is never
            // downloaded. A CID failure first leaves its failure to the load's outcome.
            const manifestsRead = markHandled(params.names.readManifests(label));
            transition.emitState({ kind: 'resolvingName', run, manifestsRead });
            const onPhase = (phase: ResolvePhase) => {
              transition.update({ kind: 'namePhase', phase });
            };
            transition.update(
              runStep(
                () => params.names.resolveProduct(label, { onPhase }),
                cid => ({ kind: 'nameResolved', cid }),
              ),
            );
            return;
          }
          // A copy that no longer passes is refused but kept: only a cleanup or a redeploy drops cached manifests.
          const manifests = fromCachedManifest(cached.manifests);
          try {
            assertLaunchable(manifests.root, manifests.app);
          } catch (error) {
            transition.emitSideEffect({
              kind: 'cidRevalidated',
              copy: { label, servedCid: cached.cid, onScreen: false },
            });
            transition.update({ kind: 'stepFailed', error });
            return;
          }
          holdCore({ kind: 'holdingCore', run, path: 'fast', cid: cached.cid, manifests }, transition);
        },
      },
      resolvingName: {
        stepFailed: failLoad,
        namePhase(_state, { phase }, { emitSideEffect }) {
          emitSideEffect({ kind: 'namePhase', phase });
        },
        nameResolved({ run, manifestsRead }, { cid }, { emitState, emitSideEffect, update }) {
          // Nothing to launch whatever the manifests say, so it does not wait on them.
          if (cid === null) {
            emitState({ kind: 'ended', error: null });
            emitSideEffect({ kind: 'noContent' });
            emitSideEffect({ kind: 'coreReleased', coreHold: run.coreHold });
            emitSideEffect({ kind: 'noContentShown', label: run.label });
            return;
          }
          emitState({ kind: 'readingManifests', run, cid });
          emitSideEffect({ kind: 'nameResolved', cid });
          update(
            runStep(
              () => manifestsRead,
              manifests => ({ kind: 'manifestsRead', manifests }),
            ),
          );
        },
      },
      readingManifests: {
        stepFailed: failLoad,
        manifestsRead(state, { manifests }, transition) {
          const { run, cid } = state;
          const { label } = run;
          transition.emitSideEffect({ kind: 'manifestsRead', manifests });
          try {
            assertLaunchable(manifests.root, manifests.app);
          } catch (error) {
            transition.update({ kind: 'stepFailed', error });
            return;
          }
          if (!params.skipCidCache) {
            transition.emitSideEffect({
              kind: 'cidStored',
              copy: { label, cid, manifests: toCachedManifest(manifests) },
            });
          }
          holdCore({ kind: 'holdingCore', run, path: 'slow', cid, manifests }, transition);
        },
      },
      holdingCore: {
        stepFailed: failLoad,
        coreHeld(state, _event, { emitState, update }) {
          const { run, cid, manifests } = state;
          emitState({ ...state, kind: 'rendering' });
          update(
            runStep(
              () =>
                params.productFrame.render({
                  mode: 'subdomain',
                  label: run.label,
                  cid,
                  base: params.base,
                  chat: run.chat,
                  facts: getProductFacts(manifests),
                }),
              () => ({ kind: 'rendered' }),
            ),
          );
        },
      },
      rendering: {
        stepFailed: failLoad,
        rendered(state, _event, { emitState, emitSideEffect, update }) {
          let stopListening: () => void;
          try {
            stopListening = listenToProduct(params, update);
          } catch (error) {
            update({ kind: 'stepFailed', error });
            return;
          }
          emitState({ ...state, kind: 'handingOff', stopListening, outcome: null });
          emitSideEffect({ kind: 'coreReleased', coreHold: state.run.coreHold });
          // Queued behind what the listeners heard as they subscribed, so a failure heard then ends the load before
          // the side work, and an outcome heard then waits in the state until the handoff is reported.
          update({ kind: 'handOff' });
        },
      },
      handingOff: {
        productFailed({ run, stopListening }, { error }, { emitState, emitSideEffect, update }) {
          const description = describe(error);
          // The first load still waits, so it ends as one that failed before the product reached the screen.
          emitState({ kind: 'failing', label: run.label, error, description });
          emitSideEffect({ kind: 'failed', error, description });
          emitSideEffect({ kind: 'frameHalted' });
          update({ kind: 'showFailure' });
          // Last, so a stop that throws cannot drop the failure's report, the halt or the screen.
          stopListening();
        },
        contentOutcome(state, { report }, { emitState }) {
          emitState({ ...state, outcome: report });
        },
        handOff({ run, path, cid, manifests, stopListening, outcome }, _event, { emitState, emitSideEffect }) {
          const { label } = run;
          emitState({ kind: 'onScreen', run, stopListening });
          emitSideEffect({ kind: 'handedOff' });
          if (outcome !== null) {
            emitSideEffect({ kind: 'contentSettled', report: outcome });
          }
          emitSideEffect({ kind: 'productShown', label, manifests });
          if (path === 'fast') {
            // Keeps the cache honest without blocking the render.
            emitSideEffect({ kind: 'cidRevalidated', copy: { label, servedCid: cid, onScreen: true } });
          }
        },
      },
      onScreen: {
        productFailed({ run, stopListening }, { error, failure }, { emitState, emitSideEffect }) {
          const description = describe(error);
          // Nothing waits on a load whose product reached the screen, so it ends here and its screen is an effect.
          emitState({ kind: 'ended', error: null });
          emitSideEffect({ kind: 'failed', error, description });
          // Only a reload brings back a product that was on screen, so the frame stops showing it.
          emitSideEffect({ kind: 'frameHalted' });
          emitSideEffect({ kind: 'failureShown', label: run.label, error, description, failure });
          // Last, so a stop that throws cannot drop the failure's report, the halt or the screen.
          stopListening();
        },
        contentOutcome(_state, { report }, { emitSideEffect }) {
          emitSideEffect({ kind: 'contentSettled', report });
        },
      },
      failing: {
        showFailure({ label, error, description }, _event, { emitState }) {
          try {
            showFailureScreen(label, error, description);
            emitState({ kind: 'ended', error: null });
          } catch (screenError) {
            // The first load rejects with it.
            emitState({ kind: 'ended', error: toError(screenError) });
          }
        },
      },
      ended: null,
    },
    onEffect: effect => {
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- the default sends the other reports to telemetry as they are
      switch (effect.kind) {
        case 'shieldSettled':
          // The shield shows how the content was checked, and the topbar may fold from then on.
          urlPillState.setVerificationShield(isVerifiedSession(params.backend) ? 'verified' : 'trusted');
          effect.autoHide.settle();
          return;
        case 'coreReleased':
          // A boot's failure is the render step's to report, and a load that ended before the render reports its own
          // outcome only.
          void effect.coreHold.then(lease => lease.release(), noop);
          return;
        case 'frameHalted':
          params.productFrame.halt();
          return;
        case 'cidStored':
          params.cidCache.storeLater(effect.copy);
          return;
        case 'cidRevalidated':
          params.cidCache.revalidateLater(effect.copy);
          return;
        case 'productShown':
          params.failureScreen.forget();
          void params.recents.record(effect.label);
          void applyProductBranding({
            label: effect.label,
            manifests: effect.manifests,
            fetchBlock: params.bitswap.get,
            timers: params.timers,
          });
          return;
        case 'failed':
        case 'noContent':
          params.report(effect);
          // Once for the failed load, however many times the user moves between its error screens.
          productState.setError();
          return;
        case 'noContentShown':
          // Its recent pill stays: the name may still resolve on another network.
          showNoContentError(effect.label);
          return;
        case 'failureShown': {
          const { label, error, description, failure } = effect;
          try {
            showFailureScreen(label, error, description);
          } catch (screenError) {
            params.report({ kind: 'screenFailed', error: screenError, failure });
          }
          return;
        }
        case 'contentSettled':
          // The topbar may fold once the product's content shows.
          pageTopbarAutoHide.setContentShown(isLoadedOutcome(effect.report.outcome));
          params.report(effect);
          return;
        default:
          params.report(effect);
      }
    },
    onError: error => {
      resolveReport.defect(error, {
        step: 'load_transition',
        metric: loadTransitionMetric,
        message: '[dot.li] A transition of the page load failed:',
      });
    },
  });
  return {
    /**
     * Loads the page's product. A later call waits for that load and does nothing more. A failed load shows its
     * screen, and rejects with what that screen threw. Rejects with the setup's error, and shows no screen, when the
     * load's setup throws, such as a page core not yet set up.
     */
    async load(label: string): Promise<void> {
      const first = machine.state.get().kind === 'idle';
      machine.update({ kind: 'load', label });
      await machine.await();
      const settled = machine.state.get();
      if (first && settled.kind === 'ended' && settled.error !== null) {
        throw settled.error;
      }
    },
  };

  /** One verdict drives both the report and the error page, so `error_kind` counts exactly the screens shown. */
  function describe(error: unknown): ErrorDescription {
    return describeError(error, { readBackend: () => params.backend });
  }

  /** Shows the failure screen for `label`. Throws what the screen throws. */
  function showFailureScreen(label: string, error: unknown, description: ErrorDescription): void {
    params.failureScreen.show({ error: description, cause: error, label, backend: params.backend });
  }
}

/** Moves to `next`, settles the shield as the render begins, and waits for the product's core. */
function holdCore(
  next: Extract<LoadState, { kind: 'holdingCore' }>,
  { emitState, emitSideEffect, update }: Transition<LoadMachine>,
): void {
  emitState(next);
  emitSideEffect({ kind: 'rendering' });
  emitSideEffect({ kind: 'shieldSettled', autoHide: next.run.autoHide });
  update(
    runStep(
      () => next.run.coreHold,
      () => ({ kind: 'coreHeld' }),
    ),
  );
}

/** Runs `work` and makes `toEvent`'s event of its value, or a step failure of its failure, a throw included. */
function runStep<Value>(work: () => Value | Promise<Value>, toEvent: (value: Value) => LoadEvent): Promise<LoadEvent> {
  return new Promise<Value>(resolve => {
    resolve(work());
  }).then(toEvent, (error: unknown) => ({ kind: 'stepFailed', error }));
}

/** Sets up one load and returns what it holds. Throws what the setup throws. */
function startLoadRun(label: string, params: Pick<Params, 'bridge' | 'names'>) {
  params.bridge.setPageProduct({ label });
  // In parallel with the CID.
  const chat = readChatCapability(label, params.names.readWorkerManifest);
  urlPillState.showProduct(label, getActiveTldSuffix());
  // A page loads one product, so the bar folds for the page's life and the cleanup goes unused.
  const autoHide = startShieldAutoHide({ loggedIn: authState.loggedInStore, arm: pageTopbarAutoHide.arm });
  return {
    label,
    chat,
    autoHide,
    // The core boots while the name resolves, so its boot can fail before anything awaits it.
    coreHold: markHandled(params.bridge.acquirePageCore()),
  };
}

/**
 * Listens for what can still fail the product, and for its content's outcomes. Returns what stops listening. Throws
 * what a subscribe throws, once the subscriptions made before it are stopped.
 */
function listenToProduct(
  params: Pick<Params, 'onProtocolVersionMismatch' | 'sandboxLoad'>,
  update: Transition<LoadMachine>['update'],
): () => void {
  const stops: (() => void)[] = [];
  const stopListening = () => {
    for (const stop of stops) {
      stop();
    }
  };
  try {
    // A protocol frame rebuilt while the app is open can come from a newer release. It refuses this page for good, and
    // the app would sit there with no chain or store, so the reload screen replaces it.
    stops.push(
      params.onProtocolVersionMismatch(error => {
        update({ kind: 'productFailed', error, failure: 'a protocol version mismatch' });
      }),
    );
    // From the handoff, since the render before it can wait on the shared store for as long as the protocol frame is
    // down.
    stops.push(
      params.sandboxLoad.expectHeardWithin(error => {
        update({ kind: 'productFailed', error, failure: 'a silent sandbox' });
      }),
    );
    stops.push(
      params.sandboxLoad.subscribeOutcomes(report => {
        update({ kind: 'contentOutcome', report });
      }),
    );
  } catch (error) {
    stopListening();
    throw error;
  }
  return stopListening;
}
