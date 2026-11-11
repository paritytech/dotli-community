// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Takes a `.dot` label to a product on screen, or to the screen that says why not. What sits in another frame or
// origin, and what reloads or writes the page, is passed in. The page's own state is imported.

import { getActiveTldSuffix, isVerifiedSession } from '@dotli/config';
import type { BitswapClient } from '@dotli/bitswap';
import { createReporter, defineCount, m } from '@dotli/metrics';
import type { ProtocolClient } from '@dotli/protocol';
import type { ResolvePhase } from '@dotli/resolver';
import { isLoadedOutcome } from '@dotli/sandbox-wire';
import {
  createStateMachine,
  markHandled,
  noop,
  toError,
  type HandlerOf,
  type HandlersOf,
  type MachineTypes,
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
import { createLoadTelemetry, type LoadEffect, type LoadTelemetryParams } from './createLoadTelemetry.js';
import type { PageCidCache } from './createPageCidCache.js';
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
 * render, then holds the product in its frame, which is on screen once the handoff's side work is done. A failure
 * shows its screen before the load ends.
 */
type LoadState =
  | { kind: 'idle'; params: Params }
  | { kind: 'starting'; label: string; params: Params }
  | { kind: 'readingCache'; run: LoadRun }
  | { kind: 'resolvingName'; run: LoadRun; manifestsRead: Promise<ProductManifests> }
  | { kind: 'readingManifests'; run: LoadRun; cid: string }
  | { kind: 'rendering'; run: LoadRun; path: LoadPath; cid: string; manifests: ProductManifests }
  | {
      kind: 'handingOff';
      run: LoadRun;
      path: LoadPath;
      cid: string;
      manifests: ProductManifests;
      stopListening: () => void;
    }
  | { kind: 'onScreen'; run: LoadRun; stopListening: () => void }
  | { kind: 'failing'; run: LoadRun; error: unknown; description: ErrorDescription }
  | { kind: 'failingOnScreen'; run: LoadRun; error: unknown; description: ErrorDescription; failure: string }
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
  | { kind: 'render' }
  | { kind: 'rendered' }
  | { kind: 'stepFailed'; error: unknown }
  | { kind: 'handOff' }
  | {
      kind: 'productFailed';
      error: unknown;
      /** What failed, for the failure screen's own report. */
      failure: string;
    }
  | { kind: 'contentOutcome'; report: SandboxLoadReport }
  | { kind: 'showFailure' };

type LoadMachine = MachineTypes<LoadState, LoadEvent, LoadEffect>;

type Params = LoadTelemetryParams & {
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
  const machine = createStateMachine<LoadMachine>({
    initial: { kind: 'idle', params },
    handlers: {
      idle,
      starting,
      readingCache,
      resolvingName,
      readingManifests,
      rendering,
      handingOff,
      onScreen,
      failing,
      failingOnScreen: failing,
      ended: null,
    },
    onEffect: createLoadTelemetry(params).report,
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
}

const idle: HandlersOf<LoadMachine, 'idle'> = {
  load({ params }, { label }, { emitState, emitSideEffect, update }) {
    // The setup waits for the next transition, so the attempt and the journey's defaults are set before its calls log
    // anything.
    emitSideEffect({ kind: 'started', label });
    emitState({ kind: 'starting', label, params });
    update({ kind: 'start' });
  },
};

const starting: HandlersOf<LoadMachine, 'starting'> = {
  start({ label, params }, _event, { emitState, emitSideEffect, update }) {
    let run: LoadRun;
    try {
      run = startLoadRun({ label, params, update });
    } catch (error) {
      emitState({ kind: 'ended', error: toError(error) });
      return;
    }
    emitSideEffect({ kind: 'setUp' });
    emitState({ kind: 'readingCache', run });
    update(
      (params.skipCidCache ? Promise.resolve(null) : params.cidCache.get(label)).then(
        cached => ({ kind: 'cacheRead', cached }),
        (error: unknown) => ({ kind: 'stepFailed', error }),
      ),
    );
  },
};

/** Fails a load whose product is not on screen yet, and queues its failure screen. */
const failLoad: HandlerOf<
  LoadMachine,
  'readingCache' | 'resolvingName' | 'readingManifests' | 'rendering',
  'stepFailed'
> = ({ run }, { error }, { emitState, emitSideEffect, update }) => {
  releaseCore(run);
  // One verdict drives both the report and the error page, so `error_kind` counts exactly the screens shown.
  const description = describeError(error, { readBackend: () => run.params.backend });
  emitSideEffect({ kind: 'failed', error, description });
  emitState({ kind: 'failing', run, error, description });
  // Queued behind the failure's report, so a screen that throws cannot lose it.
  update({ kind: 'showFailure' });
};

const readingCache: HandlersOf<LoadMachine, 'readingCache'> = {
  stepFailed: failLoad,
  cacheRead({ run }, { cached }, { emitState, emitSideEffect, update }) {
    const { label, params } = run;
    emitSideEffect({ kind: 'cacheChecked', cid: cached?.cid ?? null });
    if (cached === null) {
      // In parallel with the CID, and awaited before anything renders, so a refused product is never downloaded. A
      // CID failure first leaves its failure to the load's outcome.
      const manifestsRead = markHandled(params.names.readManifests(label));
      emitSideEffect({ kind: 'resolvingName' });
      emitState({ kind: 'resolvingName', run, manifestsRead });
      update(
        params.names
          .resolveProduct(label, {
            onPhase: phase => {
              update({ kind: 'namePhase', phase });
            },
          })
          .then(
            cid => ({ kind: 'nameResolved', cid }),
            (error: unknown) => ({ kind: 'stepFailed', error }),
          ),
      );
      return;
    }
    // A copy that no longer passes is refused but kept: only a cleanup or a redeploy drops cached manifests.
    const manifests = fromCachedManifest(cached.manifests);
    try {
      assertLaunchable(manifests.root, manifests.app);
    } catch (error) {
      params.cidCache.revalidateLater({ label, servedCid: cached.cid, onScreen: false });
      update({ kind: 'stepFailed', error });
      return;
    }
    emitState({ kind: 'rendering', run, path: 'fast', cid: cached.cid, manifests });
    update({ kind: 'render' });
  },
};

const resolvingName: HandlersOf<LoadMachine, 'resolvingName'> = {
  stepFailed: failLoad,
  namePhase(_state, { phase }, { emitSideEffect }) {
    emitSideEffect({ kind: 'namePhase', phase });
  },
  nameResolved({ run, manifestsRead }, { cid }, { emitState, emitSideEffect, update }) {
    emitSideEffect({ kind: 'nameResolved', cid });
    // Nothing to launch whatever the manifests say, so it does not wait on them.
    if (cid === null) {
      try {
        // Its recent pill stays: the name may still resolve on another network.
        showNoContentError(run.label);
        productState.setError();
      } catch (error) {
        update({ kind: 'stepFailed', error });
        return;
      }
      releaseCore(run);
      emitSideEffect({ kind: 'noContent' });
      emitState({ kind: 'ended', error: null });
      return;
    }
    emitState({ kind: 'readingManifests', run, cid });
    update(
      manifestsRead.then(
        manifests => ({ kind: 'manifestsRead', manifests }),
        (error: unknown) => ({ kind: 'stepFailed', error }),
      ),
    );
  },
};

const readingManifests: HandlersOf<LoadMachine, 'readingManifests'> = {
  stepFailed: failLoad,
  manifestsRead({ run, cid }, { manifests }, { emitState, emitSideEffect, update }) {
    const { label, params } = run;
    emitSideEffect({ kind: 'manifestsRead', manifests });
    try {
      assertLaunchable(manifests.root, manifests.app);
    } catch (error) {
      update({ kind: 'stepFailed', error });
      return;
    }
    if (!params.skipCidCache) {
      params.cidCache.storeLater({ label, cid, manifests: toCachedManifest(manifests) });
    }
    emitState({ kind: 'rendering', run, path: 'slow', cid, manifests });
    update({ kind: 'render' });
  },
};

const rendering: HandlersOf<LoadMachine, 'rendering'> = {
  stepFailed: failLoad,
  render({ run, path, cid, manifests }, _event, { emitSideEffect, update }) {
    const { label, params } = run;
    emitSideEffect({ kind: 'rendering' });
    update(
      (path === 'fast' ? m.span('e2e.fast_path', renderProduct) : renderProduct()).then(
        () => ({ kind: 'rendered' }),
        (error: unknown) => ({ kind: 'stepFailed', error }),
      ),
    );

    /** Hands the product to its frame. Rejects when the core cannot boot or the render fails. */
    async function renderProduct(): Promise<void> {
      // The shield shows how the content was checked, and the topbar may fold from then on.
      urlPillState.setVerificationShield(isVerifiedSession(params.backend) ? 'verified' : 'trusted');
      run.autoHide.settle();
      await run.coreHold;
      try {
        await params.productFrame.render({
          mode: 'subdomain',
          label,
          cid,
          base: params.base,
          chat: run.chat,
          facts: getProductFacts(manifests),
        });
      } catch (error) {
        // A render that failed after it mounted the product leaves it holding its core under the failure screen.
        params.productFrame.halt();
        throw error;
      }
    }
  },
  rendered(state, _event, { emitState, update }) {
    let stopListening: () => void;
    try {
      stopListening = listenToProduct(state.run);
    } catch (error) {
      update({ kind: 'stepFailed', error });
      return;
    }
    releaseCore(state.run);
    emitState({ ...state, kind: 'handingOff', stopListening });
    // Queued behind what the listeners heard as they subscribed, so a failure or a content outcome heard then is
    // handled before the side work.
    update({ kind: 'handOff' });
  },
};

/** Fails a load whose product is in its frame, and queues its failure screen. */
const failProduct: HandlerOf<LoadMachine, 'handingOff' | 'onScreen', 'productFailed'> = (
  { run, stopListening },
  { error, failure },
  { emitState, emitSideEffect, update },
) => {
  const { params } = run;
  stopListening();
  // Only a reload brings back a product that was on screen, so the frame stops showing it.
  params.productFrame.halt();
  const description = describeError(error, { readBackend: () => params.backend });
  emitSideEffect({ kind: 'failed', error, description });
  emitState({ kind: 'failingOnScreen', run, error, description, failure });
  update({ kind: 'showFailure' });
};

/** Lets the topbar fold once the product's content shows. */
const settleContent: HandlerOf<LoadMachine, 'handingOff' | 'onScreen', 'contentOutcome'> = (
  _state,
  { report },
  { emitSideEffect },
) => {
  pageTopbarAutoHide.setContentShown(isLoadedOutcome(report.outcome));
  emitSideEffect({ kind: 'contentSettled', report });
};

const onScreen: HandlersOf<LoadMachine, 'onScreen'> = {
  productFailed: failProduct,
  contentOutcome: settleContent,
};

const handingOff: HandlersOf<LoadMachine, 'handingOff'> = {
  productFailed: failProduct,
  contentOutcome: settleContent,
  handOff({ run, path, cid, manifests, stopListening }, _event, { emitState, emitSideEffect }) {
    const { label, params } = run;
    params.failureScreen.forget();
    void params.recents.record(label);
    void applyProductBranding({ label, manifests, fetchBlock: params.bitswap.get, timers: params.timers });
    switch (path) {
      case 'fast':
        // Keeps the cache honest without blocking the render.
        params.cidCache.revalidateLater({ label, servedCid: cid, onScreen: true });
        break;
      case 'slow':
        break;
    }
    emitSideEffect({ kind: 'handedOff' });
    emitState({ kind: 'onScreen', run, stopListening });
  },
};

/** Shows a failed load's screen, then ends the load. */
const failing: HandlersOf<LoadMachine, 'failing' | 'failingOnScreen'> = {
  showFailure(state, _event, { emitState, emitSideEffect }) {
    const { run, error, description } = state;
    try {
      // Once for the failed load, however many times the user moves between its error screens.
      productState.setError();
      run.params.failureScreen.show({
        error: description,
        cause: error,
        label: run.label,
        backend: run.params.backend,
      });
    } catch (screenError) {
      switch (state.kind) {
        case 'failing':
          emitState({ kind: 'ended', error: toError(screenError) });
          return;
        case 'failingOnScreen':
          // Nothing waits on a load whose product was on screen, so the screen's failure is reported here.
          emitSideEffect({ kind: 'screenFailed', error: screenError, failure: state.failure });
          emitState({ kind: 'ended', error: null });
          return;
      }
    }
    emitState({ kind: 'ended', error: null });
  },
};

/** Sets up one load and returns what it holds. Throws what the setup throws. */
function startLoadRun({
  label,
  params,
  update,
}: {
  label: string;
  params: Params;
  update: (event: LoadEvent) => void;
}) {
  params.bridge.setPageProduct({ label });
  // In parallel with the CID.
  const chat = readChatCapability(label, async () => {
    const result = await params.names.readWorkerManifest(label);
    return result.kind === 'ok' && result.value.kind === 'worker' && result.value.includes.chat === true;
  });
  urlPillState.showProduct(label, getActiveTldSuffix());
  // A page loads one product, so the bar folds for the page's life and the cleanup goes unused.
  const autoHide = startShieldAutoHide({ loggedIn: authState.loggedInStore, arm: pageTopbarAutoHide.arm });
  return {
    label,
    params,
    update,
    chat,
    autoHide,
    // The core boots while the name resolves, so its boot can fail before anything awaits it.
    coreHold: markHandled(params.bridge.acquirePageCore()),
  };
}

/** Listens for what can still fail the product, and for its content's outcomes. Returns what stops listening. */
function listenToProduct({ params, update }: LoadRun): () => void {
  // A protocol frame rebuilt while the app is open can come from a newer release. It refuses this page for good, and
  // the app would sit there with no chain or store, so the reload screen replaces it.
  const stopHearingMismatch = params.onProtocolVersionMismatch(error => {
    update({ kind: 'productFailed', error, failure: 'a protocol version mismatch' });
  });
  // From the handoff, since the render before it can wait on the shared store for as long as the protocol frame is
  // down.
  void params.sandboxLoad.expectHeardWithin().catch((error: unknown) => {
    update({ kind: 'productFailed', error, failure: 'a silent sandbox' });
  });
  const stopFollowingContent = params.sandboxLoad.subscribeOutcomes(report => {
    update({ kind: 'contentOutcome', report });
  });
  return () => {
    stopHearingMismatch();
    stopFollowingContent();
  };
}

/** Lets the core lease go once it is held. Safe to call again. */
function releaseCore({ coreHold }: LoadRun): void {
  void coreHold.then(lease => lease.release(), noop);
}
