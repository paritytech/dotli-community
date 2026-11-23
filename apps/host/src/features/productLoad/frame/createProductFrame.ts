// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product on screen, in a frame piped to the page core. One render runs at a time: a newer one supersedes a render
// still connecting, and the product on screen stays up until its replacement has connected. Only the app subdomain
// joins the TrUAPI channel, so any nested iframe it loads is opaque to the host.

import { createMessagePortProvider, type ProductId } from '@parity/truapi';
import type { IframeHost, IframeHostOptions } from '@parity/truapi-host/web';
import type { SandboxChannel, SandboxContractMessage, SandboxSender } from '@dotli/sandbox-wire';
import { createReporter, defineCount, m } from '@dotli/metrics';
import {
  createRandomId,
  createStateMachine,
  nest,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import type { CoreProvider } from '../../productRuntime/index.js';
import { CoreRedialError } from '../../../kit/coreRedialError.js';
import type { CoreConnection, CoreLease, PageCore, PageProduct } from '../../productRuntime/index.js';
import type { PermissionAuthorizations } from '../../permissions/index.js';
import { createSide, type Side } from './createSide.js';
import { toLoadedProduct, toTitledProduct } from './describeShownProduct.js';
import { pipeProviders, type PipeProvidersParams } from './pipeProviders.js';
import { buildFrameUrl, getAppOrigin, getFrameSandbox, type FrameTarget } from './productFrameUrl.js';
import { ImageUnavailableError, registerProductChat, type FetchedImageSource } from '../../chat/index.js';
import { traceProductRender, type RenderTrace } from './traceProductRender.js';
import { productState } from '../../page/index.js';
import type { PermissionsChange } from '../../permissions/index.js';
import type { ShowNotification } from '@dotli/ui';
import type { ProductFacts } from '../resolve/getProductFacts.js';
import { openLanding } from '../../../kit/getLandingUrl.js';
import { markAndReload } from '../../../kit/createContinuation.js';

const chatReport = createReporter({ flow: 'chat' });
const walletReport = createReporter({ flow: 'wallet' });
const uiReport = createReporter({ flow: 'ui' });

/**
 * A render the product frame started on its own: on a replacement core or after a device permission change. Tagged
 * `outcome` (ok, error, or aborted when a newer render or a core loss took over) and
 * `reason` (which of those, or `core_deaths` once the frame stopped rendering on cores that kept dying), as no caller
 * is there to report it.
 */
const productRerenderMetric = defineCount<'aborted' | 'error' | 'ok'>('product.rerender');

/** Count. A product frame handler or effect threw. Tagged `outcome` (error) and `reason` (the error's name). */
const productFrameTransitionMetric = defineCount<'error'>('product_frame.transition');

const BRIDGE_SETUP = 'bridge.setup';

/**
 * A product the host loads from a URL it was given, or from its content id on the app subdomain. `chat` says whether it
 * declares chat, which picks its connection's execution kind, so the frame awaits it before it connects the product.
 * `base` is the page path ahead of the product's own, which its frame does not get.
 */
export type FrameProduct =
  | { mode: 'iframe'; label: string; url: string; productId?: string | undefined; chat: Promise<boolean> }
  | {
      mode: 'subdomain';
      label: string;
      cid: string;
      base?: string | undefined;
      chat: Promise<boolean>;
      facts: ProductFacts;
    };

/** `lost` is a product whose core went down, was refused or turned stale, until its render on a replacement begins. */
export type ProductFrameStatus = 'idle' | 'connecting' | 'connected' | 'lost' | 'failed';

/** What the frame asks of its iframe host. The page decides where the frame mounts. */
export type FrameHostParams = Omit<IframeHostOptions, 'container'>;

export type ProductFrameParams = {
  /** The page core the product's connections lease. */
  core: Pick<PageCore, 'acquire' | 'setProduct'>;
  /** Builds the iframe host of one render. Rejects when the frame cannot be built, which fails that render. */
  createIframeHost: (params: FrameHostParams) => Promise<IframeHost>;
  /** Where a reloaded sandbox asks to be rebuilt. */
  channel: SandboxChannel;
  /** Subscribes to each change of the product's permissions and returns the unsubscribe. */
  subscribePermissionChanges: (listener: (change: PermissionsChange) => void) => () => void;
  /** Where the frame routes each product connection's permissions, and reads the `allow` attribute from. */
  permissions: Pick<PermissionAuthorizations, 'register' | 'getAllowAttribute'>;
  view: ProductFrameView;
  /** The page's notifications, for a reload the frame could not do itself. */
  notify: ShowNotification;
  /** The host page around the frame. Without one, the browser's. */
  page?: ProductFramePage | undefined;
  /** The clock and timers the frame stamps its events with and spaces its renders on. The page's own by default. */
  timers?: Timers;
};

/** `iframe` is a local or preview URL, which has no root manifest to name it. */
export type TitledProduct = {
  mode: 'subdomain' | 'iframe';
  label: string;
  /** The name its root manifest publishes. */
  displayName?: string;
};

/** What the page shows around the frame. The runtime asks through this seam so its specs run under Node. */
export type ProductFrameView = {
  /** The page gives its viewport to this frame and lays it out from now on. */
  attachFrame: (iframe: HTMLIFrameElement) => void;
  /** The tab title for the product on screen. */
  showTitle: (product: TitledProduct) => void;
  /** Takes down the page's own screens over the frame, the loading screen too when `loading`. */
  clearScreens: (options: { loading: boolean }) => void;
  /** The frame's status on the page, as state that browser tests read. */
  showStatus: (status: ProductFrameStatus) => void;
  /** Empties the frame's mount, for a direct iframe, which has no loading screen to keep. */
  clearMount: () => void;
  /**
   * Only in sandbox checker builds: loads the panel that watches the frame, as a mount that returns its dispose.
   * Rejects when the panel fails to load.
   */
  loadCheckerPanel?: (() => Promise<(iframe: HTMLIFrameElement) => () => void>) | undefined;
};

/** What the frame reads and writes of the browser page. */
export type ProductFramePage = {
  /** Where the host page is, which the app's origin and deep path follow. */
  location: () => Pick<Location, 'href' | 'protocol' | 'hostname' | 'port' | 'pathname' | 'search' | 'hash'>;
  /** Reloads the host page. */
  reload: () => void;
  /** Opens the landing page. */
  goHome: () => void;
};

export type ProductFrame = ReturnType<typeof createProductFrame>;

/** Why the frame rendered the product again on its own. */
type RerenderReason = 'replacement' | 'permission';

type Reply<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

/**
 * One try at leasing and connecting. Ending `core` lets go of the pipe, the routes, the connection and the lease, in
 * that order. Ending `frame` removes the panel and the iframe, which outlive a released core, so the product stays on
 * screen once the frame gives up on its core.
 */
type Attempt = { n: 1 | 2; core: Side; frame: Side };

/** The product's connection, as its frame is built on it. */
type Link = {
  coreProvider: CoreProvider;
  /** The id the core parsed for the product, which its connection runs under. */
  productId: ProductId;
  /** Whether the product declares chat, as its connection was opened. */
  chat: boolean;
};

/** Whether the core under an attempt reported itself down, refused or stale. */
type CoreSide = 'live' | 'down';

/** A render's steps. The frame itself takes the product on screen from `building` and ends the run. */
type Step =
  | { kind: 'leasing'; attempt: Attempt }
  | { kind: 'readingChat'; attempt: Attempt; lease: CoreLease; core: CoreSide }
  | { kind: 'connecting'; attempt: Attempt; chat: boolean; core: CoreSide }
  | { kind: 'readingAllow'; attempt: Attempt; link: Link; core: CoreSide }
  | { kind: 'building'; attempt: Attempt; link: Link; core: CoreSide }
  | { kind: 'loadingPanel'; attempt: Attempt };

/** Who a render's outcome is told to: the caller that asked for it, or the frame's own report. */
type RunOrigin = { kind: 'asked'; reply: Reply<void> } | { kind: 'rerender'; reason: RerenderReason };

type RunParts = {
  product: FrameProduct;
  origin: RunOrigin;
  /** Built once as the run starts, since building it takes a scheduled sandbox reset. */
  url: URL;
  /** The contract the host wrote for a subdomain product, which that frame asks back for, or null for an iframe. */
  contract: SandboxContractMessage | null;
  flows: { render: string; bridge: string };
  /** When the run began, which its `bridge.setup` time counts from. */
  setupStartedAt: number;
};

/** One render, nested in `connecting`. Its kind is the step it is at. */
type Run = RunParts & Step;

/** The product on screen. `attempt` is the key a core-down event matches it by. */
type Shown = {
  attempt: Attempt;
  link: Link;
  iframeHost: IframeHost;
  core: CoreSide;
  /** The contract the frame loaded, which it is answered with when it asks, or null for an iframe product. */
  contract: SandboxContractMessage | null;
};

/** What the frame holds from its first render until it halts. */
type Lively = {
  /** The product the frame renders, which every render it starts on its own reads. */
  target: FrameProduct;
  shown: Shown | null;
  /** Quick core deaths in a row, and when the render on the latest replacement core began. */
  deaths: { count: number; replacedAt: number | null };
  /** Spaces the renders on a replacement core. */
  replacement: { kind: 'ready' } | { kind: 'spacing'; timer: unknown };
};

/** `halted` keeps the product on screen without its core, under a failure screen the page shows. */
type FrameState =
  | { kind: 'idle' }
  | (Lively & { kind: 'connecting'; run: Run })
  | (Lively & { kind: 'connected'; shown: Shown })
  | (Lively & { kind: 'lost'; shown: Shown })
  | (Lively & { kind: 'failed' })
  | { kind: 'halted'; shown: Shown | null }
  | { kind: 'disposed' };

type LivelyKind = 'connecting' | 'connected' | 'lost' | 'failed';

/** A run that did not fail carries when it began, so its `bridge.setup` time is recorded. */
type RunOutcome =
  | { kind: 'shown'; setupStartedAt: number }
  | { kind: 'superseded'; setupStartedAt: number }
  | { kind: 'failed'; error: unknown };

/** The events of a render's steps, which its nested value handles. */
type StepEvent =
  | { kind: 'leased'; attempt: Attempt; lease: CoreLease }
  | { kind: 'chatRead'; attempt: Attempt; chatCapable: boolean }
  | { kind: 'opened'; attempt: Attempt; connection: CoreConnection; coreProvider: CoreProvider }
  | { kind: 'allowRead'; attempt: Attempt; allow: string }
  | { kind: 'coreDown'; attempt: Attempt };

type FrameEvent =
  | StepEvent
  | { kind: 'frameBuilt'; attempt: Attempt; iframeHost: IframeHost }
  | { kind: 'panelMounted'; attempt: Attempt }
  | { kind: 'stepFailed'; attempt: Attempt; error: unknown }
  | { kind: 'renderAsked'; product: FrameProduct; reply: Reply<void> }
  | { kind: 'permissionsChanged'; change: PermissionsChange }
  | { kind: 'replacementSpaced'; timer: unknown }
  | { kind: 'halted' }
  | { kind: 'disposed' };

type FrameEffect =
  | { kind: 'statusShown'; status: ProductFrameStatus }
  | { kind: 'productNamed'; product: PageProduct }
  | { kind: 'attemptEnded'; attempt: Attempt }
  /** Ends only the core side of `attempt`: the product stays on screen without its core. */
  | { kind: 'coreReleased'; attempt: Attempt }
  | { kind: 'spacerCleared'; timer: unknown }
  | { kind: 'frameAttached'; iframe: HTMLIFrameElement }
  | ({ kind: 'screensCleared' } & Parameters<ProductFrameView['clearScreens']>[0])
  | { kind: 'mountCleared' }
  | { kind: 'productShown'; product: FrameProduct; link: Link }
  | { kind: 'unsubscribed' }
  | { kind: 'runSettled'; origin: RunOrigin; outcome: RunOutcome }
  | ({ kind: 'traced' } & RenderTrace)
  | { kind: 'chatResolved'; capable: boolean }
  | { kind: 'walletConnected'; chat: boolean }
  /** Routes the page's chat for the product to `connection` until the core side of `attempt` ends. */
  | { kind: 'chatRegistered'; attempt: Attempt; connection: CoreConnection }
  | { kind: 'gaveUp'; deaths: number };

type FrameMachine = MachineTypes<FrameState, FrameEvent, FrameEffect>;

type RunMachine = MachineTypes<Run, FrameEvent, FrameEffect>;

// Spaces the renders after a core death, so a product that keeps taking its core down cannot pin the host.
const RECOVER_MIN_INTERVAL_MS = 5_000;
// A core that dies this soon after the render on it began counts toward the budget below.
const CORE_DEATH_WINDOW_MS = 60_000;
// Consecutive quick core deaths after which the frame stops rendering the product again and reports it failed.
const CORE_DEATH_BUDGET = 3;

const BROWSER_PAGE: ProductFramePage = {
  location: () => window.location,
  reload: () => {
    markAndReload('reload_button');
  },
  goHome: openLanding,
};

/** Builds the frame that shows the product. */
export function createProductFrame({
  core,
  createIframeHost,
  channel,
  subscribePermissionChanges,
  permissions,
  view,
  notify,
  page = BROWSER_PAGE,
  timers = realTimers,
}: ProductFrameParams) {
  // A core that goes down before the product's connection is open closes that connection with it, so the attempt
  // leases the replacement instead, once.
  const retryOnCoreDown: HandlerOf<RunMachine, 'readingChat' | 'connecting', 'coreDown'> = (run, event, transition) => {
    if (run.attempt.n === 2) {
      markCoreDown(run, event, transition);
      return;
    }
    const attempt = createAttempt(2);
    transition.emitState({ ...getRunParts(run), kind: 'leasing', attempt });
    transition.emitSideEffect({ kind: 'attemptEnded', attempt: run.attempt });
    transition.update(leaseCore(attempt));
  };

  /** Hands each event of the run's steps to its step, while the event's attempt is the run's. */
  const runStep = nest<FrameMachine, 'connecting', RunMachine, StepEvent['kind']>({
    find: ({ run }, { attempt }) => (run.attempt === attempt ? run : null),
    store: (state, _event, run) => ({ ...state, run }),
    handlers: {
      leasing: {
        leased(run, { lease }, { emitState, update }) {
          const { attempt, product } = run;
          emitState({ ...getRunParts(run), kind: 'readingChat', attempt, lease, core: 'live' });
          attempt.core.hold(
            lease.subscribeDown(() => {
              update({ kind: 'coreDown', attempt });
            }),
          );
          update(
            runStepWork(
              attempt,
              () => product.chat,
              chatCapable => ({ kind: 'chatRead', attempt, chatCapable }),
            ),
          );
        },
      },
      readingChat: {
        chatRead(run, { chatCapable }, { emitState, emitSideEffect, update }) {
          const { attempt, product, lease, core: coreSide } = run;
          emitState({ ...getRunParts(run), kind: 'connecting', attempt, chat: chatCapable, core: coreSide });
          emitSideEffect({ kind: 'chatResolved', capable: chatCapable });
          update(
            runStepWork(
              attempt,
              // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
              () => lease.connect({ executionKind: chatCapable ? 'Worker' : 'App' }),
              connection => {
                const coreProvider = lease.own(connection);
                attempt.core.hold(() => {
                  coreProvider.dispose();
                });
                // Registered before the allow attribute is read, which reads the newest registration.
                attempt.core.hold(permissions.register(product.label, coreProvider));
                return { kind: 'opened', attempt, connection, coreProvider };
              },
            ),
          );
        },
        coreDown: retryOnCoreDown,
      },
      connecting: {
        opened(run, { connection, coreProvider }, { emitState, emitSideEffect, update }) {
          const { attempt, product, chat, core: coreSide } = run;
          const link: Link = { coreProvider, productId: connection.productId, chat };
          emitState({ ...getRunParts(run), kind: 'readingAllow', attempt, link, core: coreSide });
          emitSideEffect({ kind: 'walletConnected', chat });
          // Only the run's own connection, since a chat view waiting for the product takes the first one registered.
          if (chat) {
            emitSideEffect({ kind: 'chatRegistered', attempt, connection });
          }
          update(
            runStepWork(
              attempt,
              () => permissions.getAllowAttribute(product.label),
              allow => ({ kind: 'allowRead', attempt, allow }),
            ),
          );
        },
        coreDown: retryOnCoreDown,
      },
      readingAllow: {
        allowRead(run, { allow }, { emitState, update }) {
          const { attempt, product, url, flows, link } = run;
          emitState({ ...run, kind: 'building' });
          update(
            runStepWork(
              attempt,
              () =>
                createIframeHost({
                  iframeUrl: url.href,
                  allowedOrigin: url.origin,
                  allow: `${allow}; cross-origin-isolated`,
                  sandbox: getFrameSandbox(product),
                  onPort: port =>
                    pipeProductPort(port, attempt, {
                      core: link.coreProvider,
                      flowId: flows.bridge,
                      label: product.label,
                      productId: link.productId,
                      timers,
                    }),
                }),
              iframeHost => {
                attempt.frame.hold(() => {
                  iframeHost.dispose();
                });
                return { kind: 'frameBuilt', attempt, iframeHost };
              },
            ),
          );
        },
        coreDown: markCoreDown,
      },
      building: {
        coreDown: markCoreDown,
      },
      // Its attempt is the product on screen's, whose core-down event the frame hears itself.
      loadingPanel: null,
    },
  });

  const renderAfresh: HandlerOf<FrameMachine, 'idle' | 'halted', 'renderAsked'> = (
    state,
    { product, reply },
    transition,
  ) => {
    startRun(
      {
        kind: state.kind,
        target: product,
        shown: state.kind === 'halted' ? state.shown : null,
        deaths: { count: 0, replacedAt: null },
        replacement: { kind: 'ready' },
      },
      { kind: 'asked', reply },
      transition,
    );
  };

  // A render asked from above starts afresh, so the cores that died before it no longer count.
  const renderAgain: HandlerOf<FrameMachine, LivelyKind, 'renderAsked'> = (state, { product, reply }, transition) => {
    startRun(
      { ...state, target: product, deaths: { count: 0, replacedAt: null } },
      { kind: 'asked', reply },
      transition,
    );
  };

  // A new `allow` attribute only takes effect in a fresh iframe. A frame still being built may have read its policy
  // before the change, so it is built again too.
  const changePermissions: HandlerOf<FrameMachine, LivelyKind, 'permissionsChanged'> = (
    state,
    { change },
    transition,
  ) => {
    if (!change.allowChanged || change.label !== state.target.label) {
      return;
    }
    startRun(state, { kind: 'rerender', reason: 'permission' }, transition);
  };

  // A render since the death already answered it.
  const spaceReplacement: HandlerOf<FrameMachine, 'connecting' | 'connected' | 'failed', 'replacementSpaced'> = (
    state,
    { timer },
    transition,
  ) => {
    const { replacement } = state;
    if (replacement.kind !== 'spacing' || replacement.timer !== timer) {
      return;
    }
    moveTo(state, { ...state, replacement: { kind: 'ready' } }, transition);
  };

  const renderOnSpacedReplacement: HandlerOf<FrameMachine, 'lost', 'replacementSpaced'> = (
    state,
    { timer },
    transition,
  ) => {
    const { replacement } = state;
    if (replacement.kind !== 'spacing' || replacement.timer !== timer) {
      return;
    }
    renderOnReplacement(state, transition);
  };

  // A frame that still hears its core while failed keeps a product whose last render failed, so it is rendered again as
  // a connected one is. A replacement that cannot boot fails the render that asked for it, and cores that keep dying use
  // up a budget, so this never loops.
  const hearCoreDown: HandlerOf<FrameMachine, 'connected' | 'failed', 'coreDown'> = (
    state,
    { attempt },
    transition,
  ) => {
    const { shown } = state;
    if (shown?.attempt !== attempt) {
      return;
    }
    loseCore({ ...state, shown }, transition);
  };

  // The frame starts no render of its own again, so a run in flight is told it was superseded and spaces nothing.
  const stopRendering: HandlerOf<FrameMachine, LivelyKind, 'halted'> = (state, _event, transition) => {
    const { shown } = state;
    moveTo(state, { kind: 'halted', shown }, transition);
    stopInFlight(state, transition);
    // The product stays on screen under the failure, but nothing serves it again, so its connection and lease go.
    if (shown !== null) {
      transition.emitSideEffect({ kind: 'coreReleased', attempt: shown.attempt });
    }
  };

  const endFrame: HandlerOf<FrameMachine, 'idle' | LivelyKind | 'halted', 'disposed'> = (state, _event, transition) => {
    moveTo(state, { kind: 'disposed' }, transition);
    transition.emitSideEffect({ kind: 'unsubscribed' });
    if (state.kind === 'idle') {
      return;
    }
    if (state.kind !== 'halted') {
      stopInFlight(state, transition);
    }
    if (state.shown !== null) {
      transition.emitSideEffect({ kind: 'attemptEnded', attempt: state.shown.attempt });
    }
  };

  const machine = createStateMachine<FrameMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        renderAsked: renderAfresh,
        halted(state, _event, transition) {
          moveTo(state, { kind: 'halted', shown: null }, transition);
        },
        disposed: endFrame,
      },
      connecting: {
        renderAsked: renderAgain,
        permissionsChanged: changePermissions,
        replacementSpaced: spaceReplacement,
        coreDown(state, event, transition) {
          const { shown } = state;
          // The product on screen hears its own core. A newer render in flight holds a lease of its own and answers for
          // itself.
          if (shown?.attempt === event.attempt) {
            moveTo(state, { ...state, shown: { ...shown, core: 'down' } }, transition);
            return;
          }
          runStep(state, event, transition);
        },
        leased: runStep,
        chatRead: runStep,
        opened: runStep,
        allowRead: runStep,
        // The frame takes the product on screen, then ends the run at once or once the checker panel is mounted.
        frameBuilt(state, { attempt, iframeHost }, transition) {
          const { run, shown: previous } = state;
          if (run.attempt !== attempt || run.kind !== 'building') {
            return;
          }
          const { loadCheckerPanel } = view;
          const shown: Shown = { attempt, link: run.link, iframeHost, core: run.core, contract: run.contract };
          const { iframe } = iframeHost;
          transition.emitSideEffect({ kind: 'frameAttached', iframe });
          if (previous !== null) {
            transition.emitSideEffect({ kind: 'attemptEnded', attempt: previous.attempt });
          }
          // On the initial app subdomain render the sandbox dismisses the overlay itself, with `dotli:loading-status`.
          transition.emitSideEffect({
            kind: 'screensCleared',
            loading: run.product.mode !== 'subdomain' || previous !== null,
          });
          transition.emitSideEffect({ kind: 'traced', milestone: 'setupReady', run, iframe });
          if (loadCheckerPanel === undefined) {
            endRun({ ...state, shown }, transition);
            return;
          }
          moveTo(state, { ...state, shown, run: { ...getRunParts(run), kind: 'loadingPanel', attempt } }, transition);
          transition.update(
            runStepWork(
              attempt,
              async () => (await loadCheckerPanel())(iframe),
              stopPanel => {
                attempt.frame.hold(stopPanel);
                return { kind: 'panelMounted', attempt };
              },
            ),
          );
        },
        panelMounted(state, { attempt }, transition) {
          const { run, shown } = state;
          if (run.attempt !== attempt || run.kind !== 'loadingPanel' || shown === null) {
            return;
          }
          endRun({ ...state, shown }, transition);
        },
        // A failed step's attempt ends with the run, unless its product is already on screen.
        stepFailed(state, { attempt, error }, transition) {
          const { run } = state;
          if (run.attempt !== attempt) {
            return;
          }
          failRun(state, { origin: run.origin, error }, transition);
          if (run.kind !== 'loadingPanel') {
            transition.emitSideEffect({ kind: 'attemptEnded', attempt });
          }
        },
        halted: stopRendering,
        disposed: endFrame,
      },
      connected: {
        renderAsked: renderAgain,
        permissionsChanged: changePermissions,
        replacementSpaced: spaceReplacement,
        coreDown: hearCoreDown,
        halted: stopRendering,
        disposed: endFrame,
      },
      lost: {
        renderAsked: renderAgain,
        permissionsChanged: changePermissions,
        replacementSpaced: renderOnSpacedReplacement,
        halted: stopRendering,
        disposed: endFrame,
      },
      failed: {
        renderAsked: renderAgain,
        permissionsChanged: changePermissions,
        replacementSpaced: spaceReplacement,
        coreDown: hearCoreDown,
        halted: stopRendering,
        disposed: endFrame,
      },
      halted: {
        renderAsked: renderAfresh,
        disposed: endFrame,
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'productNamed':
          core.setProduct(effect.product);
          return;
        case 'attemptEnded':
          effect.attempt.core.end();
          effect.attempt.frame.end();
          return;
        case 'coreReleased':
          effect.attempt.core.end();
          return;
        case 'spacerCleared':
          timers.clearTimeout(effect.timer);
          return;
        case 'frameAttached':
          view.attachFrame(effect.iframe);
          return;
        case 'screensCleared':
          view.clearScreens({ loading: effect.loading });
          return;
        case 'mountCleared':
          view.clearMount();
          return;
        case 'productShown':
          view.showTitle(toTitledProduct(effect.product));
          productState.setLoaded(toLoadedProduct(effect.product, effect.link));
          return;
        case 'unsubscribed':
          stopPermissionChanges();
          stopContractAsks();
          stopNavigateAsks();
          return;
        case 'statusShown':
          view.showStatus(effect.status);
          return;
        case 'runSettled':
          tellOutcome(effect.origin, effect.outcome);
          // A render that failed records no `bridge.setup`.
          if (effect.outcome.kind !== 'failed') {
            const setupMs = timers.now() - effect.outcome.setupStartedAt;
            m.measure(BRIDGE_SETUP, setupMs);
            m.distribution(BRIDGE_SETUP, setupMs);
          }
          return;
        case 'traced':
          traceProductRender(effect, timers);
          return;
        case 'chatResolved':
          chatReport.log.event('chat capability resolved', { capable: effect.capable });
          return;
        case 'chatRegistered':
          effect.attempt.core.hold(registerProductChat(effect.connection, readNoImage));
          return;
        case 'walletConnected':
          walletReport.log.event('product connected to wallet core', { kind: effect.chat ? 'Worker' : 'App' });
          return;
        case 'gaveUp':
          reportRerenderFailure(
            new Error(`The wallet core went down ${String(effect.deaths)} times in a row under the product`),
            'core_deaths',
          );
          showReloadNotice(notify, page);
          return;
      }
    },
    onError: error => {
      uiReport.defect(error, {
        step: 'transition',
        metric: productFrameTransitionMetric,
        message: '[dot.li] A product frame transition threw',
      });
    },
  });

  // On the page as state that browser tests read.
  view.showStatus('idle');

  const stopPermissionChanges = subscribePermissionChanges(change => {
    machine.update({ kind: 'permissionsChanged', change });
  });

  // The sandbox asks its direct parent for its contract at boot and on reload. Only the authenticated frame on screen
  // is answered, at its own origin, so one product's embedder cannot read or forge another's contract. A post that
  // throws reaches the channel's report.
  const stopContractAsks = channel.on('dotli:sandbox-contract-request', (_message, sender) => {
    const shown = findAskingFrame(sender);
    if (shown === null) {
      return;
    }
    const { contract } = shown;
    // A subdomain frame on screen always carries a contract; this only satisfies the type for the iframe case, which
    // findAskingFrame never returns.
    if (contract === null) {
      return;
    }
    shown.iframeHost.iframe.contentWindow?.postMessage(contract, { targetOrigin: sender.origin });
  });

  // An error page in the sandbox offers the visitor a way on, which only the host page can take.
  const stopNavigateAsks = channel.on('dotli:sandbox-navigate', ({ to }, sender) => {
    if (findAskingFrame(sender) === null) {
      return;
    }
    uiReport.log.event('The sandbox asked the page to navigate', { to });
    switch (to) {
      case 'landing':
        page.goHome();
        return;
      case 'reload':
        page.reload();
        return;
    }
  });

  return {
    /**
     * Replaces the product on screen once the new one has connected. Resolves when it is on screen or a newer render
     * superseded it, and rejects when it could not be shown.
     */
    render,
    /**
     * Takes the product down for good under a failure screen the page shows: a render in flight is dropped, and the
     * frame starts no render of its own again, so nothing it does clears that screen. The product stays mounted under
     * it without its core, and a render asked from above starts afresh.
     */
    halt,
    /**
     * Stops hearing permission changes and the sandbox's contract and navigate asks, takes down the product on screen
     * with its core and ends every render and wait in flight, so a render asked from above resolves as superseded and
     * neither it nor a later render mounts anything. Safe to call twice or after a failed render.
     */
    dispose,
  };

  /** Its promise stays pending for a render queued behind the frame's disposal and for one whose handler throws. */
  function render(product: FrameProduct): Promise<void> {
    // A disposed frame mounts nothing again.
    if (machine.state.get().kind === 'disposed') {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      machine.update({ kind: 'renderAsked', product, reply: { resolve, reject } });
    });
  }

  function halt(): void {
    machine.update({ kind: 'halted' });
  }

  /** Returns the product on screen when its own frame is the sender of a sandbox ask, or null. */
  function findAskingFrame({ origin, source }: SandboxSender): Shown | null {
    const state = machine.state.get();
    if (state.kind === 'idle' || state.kind === 'halted' || state.kind === 'disposed') {
      return null;
    }
    const { target, shown } = state;
    // The exact origin of the product on screen, so one product's sandbox cannot act on another, and the frame on
    // screen itself, so a frame nested inside the product on its own origin cannot either. A reloaded sandbox keeps its
    // window.
    if (
      target.mode !== 'subdomain' ||
      origin !== getAppOrigin(target.label, page.location()) ||
      source !== shown?.iframeHost.iframe.contentWindow
    ) {
      return null;
    }
    return shown;
  }

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }

  /**
   * Starts a render of `from.target`, superseding the run in flight, whose attempt ends unless its product is already
   * on screen. A product whose frame URL cannot be built fails at once.
   */
  function startRun(
    from: Lively & ({ kind: 'idle' | 'halted' | 'connected' | 'lost' | 'failed' } | { kind: 'connecting'; run: Run }),
    origin: RunOrigin,
    transition: Transition<FrameMachine>,
  ): void {
    const previous = from.kind === 'connecting' ? from.run : null;
    const lively =
      previous === null
        ? getLively(from)
        : settleRun(
            from,
            {
              origin: previous.origin,
              outcome: { kind: 'superseded', setupStartedAt: previous.setupStartedAt },
            },
            transition,
          );
    if (previous !== null) {
      dropRun(previous, lively.shown, transition);
    }
    const product = lively.target;
    const setupStartedAt = timers.now();
    let built: FrameTarget;
    try {
      built = buildFrameUrl(product, page.location());
    } catch (error) {
      failRun({ ...lively, kind: from.kind }, { origin, error }, transition);
      return;
    }
    const { url, contract } = built;
    const flows = { render: createRandomId(), bridge: createRandomId() };
    const run: Run = {
      product,
      origin,
      url,
      contract,
      flows,
      setupStartedAt,
      kind: 'leasing',
      attempt: createAttempt(1),
    };
    moveTo(from, { ...lively, kind: 'connecting', run }, transition);
    transition.emitSideEffect({ kind: 'traced', milestone: 'begun', run });
    // A direct iframe has no loading overlay to keep.
    if (product.mode === 'iframe' && lively.shown === null) {
      transition.emitSideEffect({ kind: 'screensCleared', loading: true });
      transition.emitSideEffect({ kind: 'mountCleared' });
    }
    transition.emitSideEffect({
      kind: 'productNamed',
      product: { label: product.label, productId: product.mode === 'iframe' ? product.productId : undefined },
    });
    transition.update(leaseCore(run.attempt));
  }

  /**
   * Ends the run with the product it built on screen. A core that went down under it before the end sends the product
   * on to the replacement.
   */
  function endRun(
    state: Extract<FrameState, { kind: 'connecting' }> & { shown: Shown },
    transition: Transition<FrameMachine>,
  ): void {
    const { run, shown } = state;
    const down = shown.core === 'down';
    const lively = settleRun(
      state,
      { origin: run.origin, outcome: { kind: down ? 'superseded' : 'shown', setupStartedAt: run.setupStartedAt } },
      transition,
    );
    if (down) {
      loseCore({ ...lively, kind: state.kind, shown }, transition);
    } else {
      moveTo(state, { ...lively, kind: 'connected', shown }, transition);
    }
    transition.emitSideEffect({ kind: 'productShown', product: run.product, link: shown.link });
    transition.emitSideEffect({ kind: 'traced', milestone: 'ready', run });
  }

  /**
   * Leases the page core for `attempt`, once the transition's effects have told the core the product and let go of the
   * lease of the run it superseded. The lease goes as the attempt's core side ends, at once when it already has.
   */
  function leaseCore(attempt: Attempt): Promise<FrameEvent> {
    return Promise.resolve().then(() =>
      runStepWork(
        attempt,
        () => core.acquire(),
        lease => {
          attempt.core.hold(() => {
            lease.release();
          });
          return { kind: 'leased', attempt, lease };
        },
      ),
    );
  }

  /**
   * Tells a run's origin its outcome. A replacement then spaces the next one. Returns `state`'s lively part with that
   * spacer moved.
   */
  function settleRun(
    state: Lively,
    { origin, outcome }: { origin: RunOrigin; outcome: RunOutcome },
    { emitSideEffect, update }: Transition<FrameMachine>,
  ): Lively {
    const lively = getLively(state);
    emitSideEffect({ kind: 'runSettled', origin, outcome });
    if (origin.kind === 'asked') {
      return lively;
    }
    switch (origin.reason) {
      case 'permission':
        return lively;
      case 'replacement': {
        const timer = timers.setTimeout(() => {
          update({ kind: 'replacementSpaced', timer });
        }, RECOVER_MIN_INTERVAL_MS);
        return { ...lively, replacement: { kind: 'spacing', timer } };
      }
    }
  }

  /**
   * Moves to `failed` with the run settled as failed. A product on screen whose core went down holds that core only
   * while a render to replace it is in flight, so its core goes.
   */
  function failRun(
    state: Lively & Pick<FrameState, 'kind'>,
    { origin, error }: { origin: RunOrigin; error: unknown },
    transition: Transition<FrameMachine>,
  ): void {
    const lively = settleRun(state, { origin, outcome: { kind: 'failed', error } }, transition);
    moveTo(state, { ...lively, kind: 'failed' }, transition);
    if (lively.shown?.core === 'down') {
      transition.emitSideEffect({ kind: 'coreReleased', attempt: lively.shown.attempt });
    }
  }

  /**
   * The core under the product on screen went down, was refused or turned stale. The product is shown again on the
   * replacement, at most once per interval, and the frame gives up once its cores keep dying soon after it is rendered
   * on them.
   */
  function loseCore(
    lively: Lively & Pick<FrameState, 'kind'> & { shown: Shown },
    transition: Transition<FrameMachine>,
  ): void {
    const shown: Shown = { ...lively.shown, core: 'down' };
    const { count, replacedAt } = lively.deaths;
    const recent = replacedAt !== null && timers.now() - replacedAt <= CORE_DEATH_WINDOW_MS;
    const deaths = { count: (recent ? count : 0) + 1, replacedAt };
    if (deaths.count >= CORE_DEATH_BUDGET) {
      moveTo(lively, { ...lively, kind: 'failed', shown, deaths }, transition);
      // The product stays on screen under the reload notice, but its core is down for good, so its lease goes.
      transition.emitSideEffect({ kind: 'coreReleased', attempt: shown.attempt });
      transition.emitSideEffect({ kind: 'gaveUp', deaths: deaths.count });
      return;
    }
    const lost: Extract<FrameState, { kind: 'lost' }> = { ...lively, kind: 'lost', shown, deaths };
    moveTo(lively, lost, transition);
    if (lively.replacement.kind === 'ready') {
      renderOnReplacement(lost, transition);
    }
  }

  function renderOnReplacement(
    lost: Extract<FrameState, { kind: 'lost' }>,
    transition: Transition<FrameMachine>,
  ): void {
    startRun(
      { ...lost, deaths: { ...lost.deaths, replacedAt: timers.now() }, replacement: { kind: 'ready' } },
      { kind: 'rerender', reason: 'replacement' },
      transition,
    );
  }

  /**
   * Ends what the frame has in flight as it starts no render of its own again: a run, told it was superseded, and the
   * spacers that wait.
   */
  function stopInFlight(state: Extract<FrameState, { kind: LivelyKind }>, transition: Transition<FrameMachine>): void {
    if (state.kind === 'connecting') {
      const { run, shown } = state;
      transition.emitSideEffect({
        kind: 'runSettled',
        origin: run.origin,
        outcome: { kind: 'superseded', setupStartedAt: run.setupStartedAt },
      });
      dropRun(run, shown, transition);
    }
    clearSpacers(state, transition);
  }

  function clearSpacers({ replacement }: Lively, { emitSideEffect }: Transition<FrameMachine>): void {
    if (replacement.kind === 'spacing') {
      emitSideEffect({ kind: 'spacerCleared', timer: replacement.timer });
    }
  }

  /** Emits `next`, and its status when that differs from the status of `from`, the state the move starts from. */
  function moveTo(
    from: Pick<FrameState, 'kind'>,
    next: FrameState,
    { emitState, emitSideEffect }: Transition<FrameMachine>,
  ): void {
    const before = getStatus(from);
    emitState(next);
    const status = getStatus(next);
    if (status !== null && status !== before) {
      emitSideEffect({ kind: 'statusShown', status });
    }
  }

  /** A render the frame starts on its own has no caller to report to, so it counts its own outcome. */
  function tellOutcome(origin: RunOrigin, outcome: RunOutcome): void {
    if (origin.kind === 'asked') {
      if (outcome.kind === 'failed') {
        origin.reply.reject(outcome.error);
      } else {
        origin.reply.resolve();
      }
      return;
    }
    switch (outcome.kind) {
      case 'shown':
        productRerenderMetric.count({ outcome: 'ok', reason: origin.reason });
        return;
      case 'superseded':
        productRerenderMetric.count({ outcome: 'aborted', reason: origin.reason });
        return;
      case 'failed':
        reportRerenderFailure(outcome.error, origin.reason);
        showReloadNotice(notify, page);
        return;
    }
  }
}

/** The status the page shows for `state`, none once the frame is disposed. */
function getStatus({ kind }: Pick<FrameState, 'kind'>): ProductFrameStatus | null {
  switch (kind) {
    case 'halted':
      return 'failed';
    case 'disposed':
      return null;
    case 'idle':
    case 'connecting':
    case 'connected':
    case 'lost':
    case 'failed':
      return kind;
  }
}

/** `state`'s lively part, so a state that moves on carries no field of the kind it left. */
function getLively({ target, shown, deaths, replacement }: Lively): Lively {
  return { target, shown, deaths, replacement };
}

/** The parts every step of `run` keeps, so a run that steps on carries no field of the step it left. */
function getRunParts({ product, origin, url, contract, flows, setupStartedAt }: Run): RunParts {
  return { product, origin, url, contract, flows, setupStartedAt };
}

/** Marks the core under the run down, so the product goes on to the replacement once it is on screen. */
const markCoreDown: HandlerOf<RunMachine, 'readingChat' | 'connecting' | 'readingAllow' | 'building', 'coreDown'> = (
  run,
  _event,
  { emitState },
) => {
  emitState({ ...run, core: 'down' });
};

function createAttempt(n: Attempt['n']): Attempt {
  return { n, core: createSide(), frame: createSide() };
}

/** Ends the attempt of `run`, a run the frame no longer waits on, unless its product is the one on screen. */
function dropRun(run: Run, shown: Shown | null, { emitSideEffect }: Transition<FrameMachine>): void {
  if (run.attempt !== shown?.attempt) {
    emitSideEffect({ kind: 'attemptEnded', attempt: run.attempt });
  }
}

/** Maps `work`'s value to an event of `attempt`, and its failure, a throw before it returns too, to `stepFailed`. */
function runStepWork<T>(
  attempt: Attempt,
  work: () => T | PromiseLike<T>,
  toEvent: (value: T) => FrameEvent,
): Promise<FrameEvent> {
  return new Promise<T>(resolve => {
    resolve(work());
  }).then(toEvent, (error: unknown): FrameEvent => ({ kind: 'stepFailed', attempt, error }));
}

/**
 * Pipes a product document's port to the core under `attempt`, until the attempt's core side ends or the returned stop
 * runs as a newer document takes over.
 */
function pipeProductPort(port: MessagePort, attempt: Attempt, pipe: Omit<PipeProvidersParams, 'product'>): () => void {
  const product = createMessagePortProvider(port);
  const unpipe = pipeProviders({ ...pipe, product });
  return attempt.core.hold(() => {
    // Unpiped first, since the pipe disposes the core once the product closes, and a newer document's pipe shares it.
    unpipe();
    product.dispose();
  });
}

/** Nobody asked for a render the frame starts on its own, so the frame is the one to report it. */
function reportRerenderFailure(error: unknown, reason: RerenderReason | 'core_deaths'): void {
  if (error instanceof CoreRedialError) {
    // A redial failure is reported where it happens, so the frame only records that its render fell with it.
    uiReport.expected(error, { step: 'product_rerender', metric: productRerenderMetric, reason });
    return;
  }
  uiReport.defect(error, {
    step: 'product_rerender',
    tags: { reason },
    metric: productRerenderMetric,
    reason,
    message: '[dot.li] Product iframe reload failed:',
  });
}

function showReloadNotice(notify: ShowNotification, page: ProductFramePage): void {
  notify({
    label: 'dot.li',
    text: 'The app could not be reloaded.',
    browserNotification: false,
    dismissMs: 0,
    action: {
      label: 'Reload',
      onClick: page.reload,
    },
  });
}

/** The frame reads no Bulletin or archive image yet, so each draws as unavailable. */
function readNoImage(source: FetchedImageSource): Promise<Uint8Array> {
  return Promise.reject(new ImageUnavailableError('fetch', `The host reads no ${source.tag} image yet`));
}
