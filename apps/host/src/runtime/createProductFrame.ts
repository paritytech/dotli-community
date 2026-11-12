// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product on screen, in a frame piped to the page core. One render runs at a time: a newer one supersedes a render
// still connecting, and the product on screen stays up until its replacement has connected. Only the app subdomain
// joins the TrUAPI channel, so any nested iframe it loads is opaque to the host.

import { createMessagePortProvider, type ProductId } from '@parity/truapi';
import type { IframeHost, IframeHostOptions } from '@parity/truapi-host/web';
import type { SandboxChannel, SandboxRecoverAcceptedMessage } from '@dotli/sandbox-wire';
import { createReporter, defineCount, m } from '@dotli/metrics';
import {
  createRandomId,
  createStateMachine,
  log,
  nest,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import { ownCoreConnection, type CoreProvider } from './ownCoreConnection.js';
import { CoreRedialError } from './coreRedialError.js';
import type { CoreConnection, CoreLease, PageCore, PageProduct } from './createPageCore.js';
import { createPermissionResponseGate } from './createPermissionResponseGate.js';
import type { PermissionAuthorizations } from './createPermissionAuthorizations.js';
import { createSide, type Side } from './createSide.js';
import { toLoadedProduct, toTitledProduct } from './describeShownProduct.js';
import { pipeProviders } from './pipeProviders.js';
import { buildFrameUrl, getAppOrigin, getFrameSandbox } from './productFrameUrl.js';
import { registerProductChat } from './registerProductChat.js';
import { traceProductRender, type RenderTrace } from './traceProductRender.js';
import { productState } from './state/productState.js';
import type { PermissionsChange } from './state/productPermissions.js';
import type { ShowNotification } from '@dotli/ui';
import type { ProductFacts } from '../getProductFacts.js';

const chatReport = createReporter({ flow: 'chat' });
const walletReport = createReporter({ flow: 'wallet' });
const uiReport = createReporter({ flow: 'ui' });

/**
 * A render the product frame started on its own: on a replacement core, after a device permission change or at a
 * reloaded sandbox's ask. Tagged `outcome` (ok, error, or aborted when a newer render or a core loss took over) and
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
  /**
   * The clock and timers the frame stamps its events with, spaces its renders on and waits for a permission answer on.
   * The page's own by default.
   */
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
  /** The page gives its viewport to this frame and lays it out from now on. Never throws. */
  attachFrame: (iframe: HTMLIFrameElement) => void;
  /** The tab title for the product on screen. Never throws. */
  showTitle: (product: TitledProduct) => void;
  /** Takes down the page's own screens over the frame, the loading screen too when `loading`. Never throws. */
  clearScreens: (options: { loading: boolean }) => void;
  /** The frame's status on the page, as state that browser tests read. Never throws. */
  showStatus: (status: ProductFrameStatus) => void;
  /** Empties the frame's mount, for a direct iframe, which has no loading screen to keep. Never throws. */
  clearMount: () => void;
  /**
   * Only in sandbox checker builds: loads the panel that watches the frame, as a mount that returns its dispose.
   * Rejects when the panel fails to load.
   */
  loadCheckerPanel?: (() => Promise<(iframe: HTMLIFrameElement) => () => void>) | undefined;
};

/** What the frame reads and writes of the browser page. */
export type ProductFramePage = {
  /** Where the host page is, which the app's origin and deep path follow. Never throws. */
  location: () => Pick<Location, 'href' | 'protocol' | 'hostname' | 'port' | 'pathname' | 'search' | 'hash'>;
  /** Reloads the host page. Never throws. */
  reload: () => void;
};

export type ProductFrame = ReturnType<typeof createProductFrame>;

/** Why the frame rendered the product again on its own. */
type RerenderReason = 'replacement' | 'permission' | 'recover';

type Reply<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

/**
 * One try at leasing and connecting. Ending `core` lets go of the pipe, the routes, the connection and the lease, in
 * that order. Ending `frame` ends the wait for a permission answer and removes the panel and the iframe, which outlive a
 * released core, so a device grant still waiting for its answer when the frame gives up on its core still rebuilds it.
 */
type Attempt = { n: 1 | 2; core: Side; frame: Side };

/** The product's connection, as its frame is built on it. */
type Link = {
  coreProvider: CoreProvider;
  /** The id the core parsed for the product, which its connection runs under. */
  productId: ProductId;
  /** Whether the product declares chat, as its connection was opened. */
  chat: boolean;
  /** Holds a rebuild back until the product's pending permission answer has reached it. */
  responses: ReturnType<typeof createPermissionResponseGate>;
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
  | { kind: 'loadingPanel'; attempt: Attempt; iframe: HTMLIFrameElement };

/** Who a render's outcome is told to: the caller that asked for it, or the frame's own report. */
type RunOrigin = { kind: 'asked'; reply: Reply<void> } | { kind: 'rerender'; reason: RerenderReason };

type RunParts = {
  product: FrameProduct;
  origin: RunOrigin;
  /** Built once as the run starts, since building it takes a scheduled sandbox reset. */
  url: URL;
  flows: { render: string; bridge: string };
  /** When the run began, which its `bridge.setup` time counts from. */
  setupStartedAt: number;
};

/** One render, nested in `connecting`. Its kind is the step it is at. */
type Run = RunParts & Step;

/** The product on screen. `attempt` is the key a recover ask and a core-down event match it by. */
type Shown = { attempt: Attempt; link: Link; iframeHost: IframeHost; core: CoreSide };

/** What the frame holds from its first render until it halts. */
type Lively = {
  /** The product the frame renders, which every render it starts on its own reads. */
  target: FrameProduct;
  shown: Shown | null;
  /** Quick core deaths in a row, and when the render on the latest replacement core began. */
  deaths: { count: number; replacedAt: number | null };
  /** Spaces the rebuilds a reloaded sandbox asks for. `waiting` is the one newer ask, by the product it came from. */
  recover:
    | { kind: 'ready' }
    | { kind: 'running'; waiting: { asking: Attempt } | null }
    | { kind: 'spacing'; timer: unknown; waiting: { asking: Attempt } | null };
  /** Spaces the renders on a replacement core. */
  replacement: { kind: 'ready' } | { kind: 'running' } | { kind: 'spacing'; timer: unknown };
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
  | { kind: 'panelLoaded'; attempt: Attempt; mountPanel: (iframe: HTMLIFrameElement) => () => void }
  | { kind: 'stepFailed'; attempt: Attempt; error: unknown }
  | { kind: 'renderAsked'; product: FrameProduct; reply: Reply<void> }
  | { kind: 'rerenderAsked'; reason: RerenderReason }
  | { kind: 'permissionsChanged'; change: PermissionsChange }
  | { kind: 'recoverAsked'; asking: Attempt }
  | { kind: 'recoverSpaced'; timer: unknown }
  | { kind: 'replacementSpaced'; timer: unknown }
  | { kind: 'halted' }
  | { kind: 'disposed' };

type FrameEffect =
  | { kind: 'statusShown'; status: ProductFrameStatus }
  /** Asks the page core for a lease on `attempt`, once the core was told the product. */
  | { kind: 'leaseAsked'; attempt: Attempt }
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
  | { kind: 'gaveUp'; deaths: number };

type FrameMachine = MachineTypes<FrameState, FrameEvent, FrameEffect>;

type RunMachine = MachineTypes<Run, FrameEvent, FrameEffect>;

// Spaces the rebuilds a reloaded sandbox asks for and the renders after a core death, so a product that keeps reloading
// or keeps taking its core down cannot pin the host.
const RECOVER_MIN_INTERVAL_MS = 5_000;
// A core that dies this soon after the render on it began counts toward the budget below.
const CORE_DEATH_WINDOW_MS = 60_000;
// Consecutive quick core deaths after which the frame stops rendering the product again and reports it failed.
const CORE_DEATH_BUDGET = 3;
// How long a rebuild after a device grant waits for the prompt's answer to reach the product.
const PERMISSION_ANSWER_WAIT_MS = 3_000;

const BROWSER_PAGE: ProductFramePage = {
  location: () => window.location,
  reload: () => {
    window.location.reload();
  },
};

/** Builds the frame that shows the product. Building it never throws. */
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
    transition.emitSideEffect({ kind: 'leaseAsked', attempt });
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
          const { attempt, lease, core: coreSide } = run;
          emitState({ ...getRunParts(run), kind: 'connecting', attempt, chat: chatCapable, core: coreSide });
          emitSideEffect({ kind: 'chatResolved', capable: chatCapable });
          update(
            runStepWork(
              attempt,
              // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
              () => lease.connect({ executionKind: chatCapable ? 'Worker' : 'App' }),
              connection => {
                const coreProvider = ownCoreConnection(connection);
                attempt.core.hold(() => {
                  coreProvider.dispose();
                });
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
          const link: Link = {
            coreProvider,
            productId: connection.productId,
            chat,
            responses: createPermissionResponseGate({
              signal: attempt.frame.signal,
              timeoutMs: PERMISSION_ANSWER_WAIT_MS,
              timers,
            }),
          };
          emitState({ ...getRunParts(run), kind: 'readingAllow', attempt, link, core: coreSide });
          emitSideEffect({ kind: 'walletConnected', chat });
          attempt.core.hold(permissions.register(product.label, coreProvider));
          if (chat) {
            attempt.core.hold(registerProductChat(connection));
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
                  onPort: port => {
                    const productProvider = createMessagePortProvider(port);
                    attempt.core.hold(() => {
                      productProvider.dispose();
                    });
                    attempt.core.hold(
                      pipeProviders({
                        product: productProvider,
                        core: link.coreProvider,
                        flowId: flows.bridge,
                        label: product.label,
                        productId: link.productId,
                        noteForwarded: link.responses.noteForwarded,
                        timers,
                      }),
                    );
                  },
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
        recover: { kind: 'ready' },
        replacement: { kind: 'ready' },
      },
      { previous: null, origin: { kind: 'asked', reply } },
      transition,
    );
  };

  // A render asked from above starts afresh, so the cores that died before it no longer count.
  const renderAgain: HandlerOf<FrameMachine, LivelyKind, 'renderAsked'> = (state, { product, reply }, transition) => {
    startRun(
      { ...state, target: product, deaths: { count: 0, replacedAt: null } },
      { previous: getRun(state), origin: { kind: 'asked', reply } },
      transition,
    );
  };

  const rerender: HandlerOf<FrameMachine, LivelyKind, 'rerenderAsked'> = (state, { reason }, transition) => {
    startRun(state, { previous: getRun(state), origin: { kind: 'rerender', reason } }, transition);
  };

  // A new `allow` attribute only takes effect in a fresh iframe. A frame still being built may have read its policy
  // before the change, so it is built again at once rather than after an answer for the frame it replaces.
  const changePermissions: HandlerOf<FrameMachine, LivelyKind, 'permissionsChanged'> = (
    state,
    { change },
    transition,
  ) => {
    if (!change.allowChanged || change.label !== state.target.label) {
      return;
    }
    if (change.fromPrompt && state.shown !== null && state.kind !== 'connecting') {
      state.shown.link.responses.runAfterResponse(() => {
        transition.update({ kind: 'rerenderAsked', reason: 'permission' });
      });
      return;
    }
    startRun(state, { previous: getRun(state), origin: { kind: 'rerender', reason: 'permission' } }, transition);
  };

  // The newer ask wins, since a frame rebuilt meanwhile asks with itself as the frame on screen.
  const askRecover: HandlerOf<FrameMachine, LivelyKind, 'recoverAsked'> = (state, { asking }, transition) => {
    const { recover } = state;
    if (recover.kind === 'ready') {
      startRun(
        { ...state, recover: { kind: 'running', waiting: null } },
        { previous: getRun(state), origin: { kind: 'rerender', reason: 'recover' } },
        transition,
      );
      return;
    }
    moveTo(state, { ...state, recover: { ...recover, waiting: { asking } } }, transition);
  };

  const spaceRecover: HandlerOf<FrameMachine, LivelyKind, 'recoverSpaced'> = (state, { timer }, transition) => {
    const { recover } = state;
    if (recover.kind !== 'spacing' || recover.timer !== timer) {
      return;
    }
    // A rebuild since the ask already answered it.
    if (state.shown === null || recover.waiting?.asking !== state.shown.attempt) {
      moveTo(state, { ...state, recover: { kind: 'ready' } }, transition);
      return;
    }
    startRun(
      { ...state, recover: { kind: 'running', waiting: null } },
      { previous: getRun(state), origin: { kind: 'rerender', reason: 'recover' } },
      transition,
    );
  };

  const spaceReplacement: HandlerOf<FrameMachine, LivelyKind, 'replacementSpaced'> = (state, { timer }, transition) => {
    const { replacement } = state;
    if (replacement.kind !== 'spacing' || replacement.timer !== timer) {
      return;
    }
    // A render since the death already answered it.
    if (state.kind !== 'lost') {
      moveTo(state, { ...state, replacement: { kind: 'ready' } }, transition);
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
    loseCore({ ...getLively(state), kind: state.kind, shown }, transition);
  };

  // The frame starts no render of its own again, so a run in flight is told it was superseded and spaces nothing.
  const stopRendering: HandlerOf<FrameMachine, LivelyKind, 'halted'> = (state, _event, transition) => {
    const { shown } = state;
    moveTo(state, { kind: 'halted', shown }, transition);
    if (state.kind === 'connecting') {
      transition.emitSideEffect({
        kind: 'runSettled',
        origin: state.run.origin,
        outcome: { kind: 'superseded', setupStartedAt: state.run.setupStartedAt },
      });
      dropRun(state.run, shown, transition);
    }
    clearSpacers(state, transition);
    // The product stays on screen under the failure, but nothing serves it again, so its connection and lease go.
    if (shown !== null) {
      transition.emitSideEffect({ kind: 'coreReleased', attempt: shown.attempt });
    }
  };

  const endFrame: HandlerOf<FrameMachine, 'idle' | LivelyKind | 'halted', 'disposed'> = (state, _event, transition) => {
    moveTo(state, { kind: 'disposed' }, transition);
    transition.emitSideEffect({ kind: 'unsubscribed' });
    switch (state.kind) {
      case 'idle':
        return;
      case 'halted':
        break;
      case 'connecting':
        transition.emitSideEffect({
          kind: 'runSettled',
          origin: state.run.origin,
          outcome: { kind: 'superseded', setupStartedAt: state.run.setupStartedAt },
        });
        clearSpacers(state, transition);
        transition.emitSideEffect({ kind: 'attemptEnded', attempt: state.run.attempt });
        break;
      case 'connected':
      case 'lost':
      case 'failed':
        clearSpacers(state, transition);
        break;
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
        rerenderAsked: rerender,
        permissionsChanged: changePermissions,
        recoverAsked: askRecover,
        recoverSpaced: spaceRecover,
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
          const shown: Shown = { attempt, link: run.link, iframeHost, core: run.core };
          const { iframe } = iframeHost;
          const next: Run =
            loadCheckerPanel === undefined ? run : { ...getRunParts(run), kind: 'loadingPanel', attempt, iframe };
          moveTo(state, { ...state, shown, run: next }, transition);
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
          transition.update(
            runStepWork(attempt, loadCheckerPanel, mountPanel => ({ kind: 'panelLoaded', attempt, mountPanel })),
          );
        },
        panelLoaded(state, { attempt, mountPanel }, transition) {
          const { run, shown } = state;
          if (run.attempt !== attempt || run.kind !== 'loadingPanel' || shown === null) {
            return;
          }
          try {
            attempt.frame.hold(mountPanel(run.iframe));
          } catch (error) {
            failRun(state, error, transition);
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
          failRun(state, error, transition);
          if (run.kind !== 'loadingPanel') {
            transition.emitSideEffect({ kind: 'attemptEnded', attempt });
          }
        },
        halted: stopRendering,
        disposed: endFrame,
      },
      connected: {
        renderAsked: renderAgain,
        rerenderAsked: rerender,
        permissionsChanged: changePermissions,
        recoverAsked: askRecover,
        recoverSpaced: spaceRecover,
        replacementSpaced: spaceReplacement,
        coreDown: hearCoreDown,
        halted: stopRendering,
        disposed: endFrame,
      },
      lost: {
        renderAsked: renderAgain,
        rerenderAsked: rerender,
        permissionsChanged: changePermissions,
        recoverAsked: askRecover,
        recoverSpaced: spaceRecover,
        replacementSpaced: spaceReplacement,
        halted: stopRendering,
        disposed: endFrame,
      },
      failed: {
        renderAsked: renderAgain,
        rerenderAsked: rerender,
        permissionsChanged: changePermissions,
        recoverAsked: askRecover,
        recoverSpaced: spaceRecover,
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
        case 'leaseAsked':
          acquireLease(effect.attempt);
          return;
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
          stopRecoverAsks();
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

  // The sandbox strips its contract params after boot, so a reloaded sandbox asks the host to rebuild it.
  const stopRecoverAsks = channel.on('dotli:sandbox-recover', (_message, { origin, source }) => {
    const state = machine.state.get();
    if (state.kind === 'idle' || state.kind === 'halted' || state.kind === 'disposed') {
      return;
    }
    const { target, shown } = state;
    // The exact origin of the product on screen, so one product's sandbox cannot rebuild another, and the frame on
    // screen itself, so a frame nested inside the product on its own origin cannot either. A reloaded sandbox keeps its
    // window.
    if (
      target.mode !== 'subdomain' ||
      origin !== getAppOrigin(target.label, page.location()) ||
      source !== shown?.iframeHost.iframe.contentWindow
    ) {
      return;
    }
    machine.update({ kind: 'recoverAsked', asking: shown.attempt });
    // Told before the rebuild, which can wait a long time for a core. A post that throws reaches the channel's report.
    const accepted = { type: 'dotli:sandbox-recover-accepted' } satisfies SandboxRecoverAcceptedMessage;
    shown.iframeHost.iframe.contentWindow?.postMessage(accepted, { targetOrigin: origin });
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
     * it without its core, and a render asked from above starts afresh. Never throws.
     */
    halt,
    /**
     * Stops hearing permission changes and recover asks, takes down the product on screen with its core and ends every
     * render and wait in flight, so a render asked from above resolves as superseded and neither it nor a later render
     * mounts anything. Safe to call twice or after a failed render. Never throws.
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

  function dispose(): void {
    machine.update({ kind: 'disposed' });
  }

  /**
   * Starts a render of `from.target`, superseding the run in flight, whose attempt ends unless its product is already
   * on screen. A product whose frame URL cannot be built fails at once.
   */
  function startRun(
    from: Lively & Pick<FrameState, 'kind'>,
    { previous, origin }: { previous: Run | null; origin: RunOrigin },
    transition: Transition<FrameMachine>,
  ): void {
    const lively =
      previous === null
        ? getLively(from)
        : settleRun(
            { ...from, run: previous },
            { kind: 'superseded', setupStartedAt: previous.setupStartedAt },
            transition,
          );
    const product = lively.target;
    const setupStartedAt = timers.now();
    let url: URL;
    try {
      url = buildFrameUrl(product, page.location());
    } catch (error) {
      failRun({ ...lively, kind: from.kind, run: { origin } }, error, transition);
      if (previous !== null) {
        dropRun(previous, lively.shown, transition);
      }
      return;
    }
    const flows = { render: createRandomId(), bridge: createRandomId() };
    const run: Run = { product, origin, url, flows, setupStartedAt, kind: 'leasing', attempt: createAttempt(1) };
    moveTo(from, { ...lively, kind: 'connecting', run }, transition);
    if (previous !== null) {
      dropRun(previous, lively.shown, transition);
    }
    transition.emitSideEffect({ kind: 'traced', milestone: 'begun', run });
    switch (product.mode) {
      case 'iframe':
        if (lively.shown === null) {
          // This path has no loading overlay to keep.
          transition.emitSideEffect({ kind: 'screensCleared', loading: true });
          transition.emitSideEffect({ kind: 'mountCleared' });
        }
        transition.emitSideEffect({
          kind: 'productNamed',
          product: { label: product.label, productId: product.productId },
        });
        break;
      case 'subdomain':
        transition.emitSideEffect({ kind: 'productNamed', product: { label: product.label } });
        break;
    }
    transition.emitSideEffect({ kind: 'leaseAsked', attempt: run.attempt });
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
    if (shown.core === 'down') {
      const lively = settleRun(state, { kind: 'superseded', setupStartedAt: run.setupStartedAt }, transition);
      loseCore({ ...lively, kind: state.kind, shown }, transition);
    } else {
      const lively = settleRun(state, { kind: 'shown', setupStartedAt: run.setupStartedAt }, transition);
      moveTo(state, { ...lively, kind: 'connected', shown }, transition);
    }
    transition.emitSideEffect({ kind: 'productShown', product: run.product, link: shown.link });
    transition.emitSideEffect({ kind: 'traced', milestone: 'ready', run });
  }

  /** Leases the page core for `attempt`. The lease goes as the attempt's core side ends, at once when it already has. */
  function acquireLease(attempt: Attempt): void {
    machine.update(
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
   * Tells the run's origin its outcome. A recover or a replacement then spaces the next one. Returns `state`'s lively
   * part with that spacer moved.
   */
  function settleRun(
    state: Lively & { run: Pick<RunParts, 'origin'> },
    outcome: RunOutcome,
    { emitSideEffect, update }: Transition<FrameMachine>,
  ): Lively {
    const { origin } = state.run;
    const lively = getLively(state);
    emitSideEffect({ kind: 'runSettled', origin, outcome });
    if (origin.kind === 'asked') {
      return lively;
    }
    switch (origin.reason) {
      case 'permission':
        return lively;
      case 'recover': {
        const timer = timers.setTimeout(() => {
          update({ kind: 'recoverSpaced', timer });
        }, RECOVER_MIN_INTERVAL_MS);
        const waiting = lively.recover.kind === 'ready' ? null : lively.recover.waiting;
        return { ...lively, recover: { kind: 'spacing', timer, waiting } };
      }
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
    state: Lively & Pick<FrameState, 'kind'> & { run: Pick<RunParts, 'origin'> },
    error: unknown,
    transition: Transition<FrameMachine>,
  ): void {
    const lively = settleRun(state, { kind: 'failed', error }, transition);
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
      { ...lost, deaths: { ...lost.deaths, replacedAt: timers.now() }, replacement: { kind: 'running' } },
      { previous: null, origin: { kind: 'rerender', reason: 'replacement' } },
      transition,
    );
  }

  /** Clears the timers of the spacers that wait, as the frame starts no render of its own again. */
  function clearSpacers({ recover, replacement }: Lively, { emitSideEffect }: Transition<FrameMachine>): void {
    if (recover.kind === 'spacing') {
      emitSideEffect({ kind: 'spacerCleared', timer: recover.timer });
    }
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

/** The run `state` waits on, none when it waits on no run. */
function getRun(state: Extract<FrameState, { kind: LivelyKind }>): Run | null {
  return state.kind === 'connecting' ? state.run : null;
}

/** `state`'s lively part, so a state that moves on carries no field of the kind it left. */
function getLively({ target, shown, deaths, recover, replacement }: Lively): Lively {
  return { target, shown, deaths, recover, replacement };
}

/** The parts every step of `run` keeps, so a run that steps on carries no field of the step it left. */
function getRunParts({ product, origin, url, flows, setupStartedAt }: Run): RunParts {
  return { product, origin, url, flows, setupStartedAt };
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

/** Nobody asked for a render the frame starts on its own, so the frame is the one to report it. */
function reportRerenderFailure(error: unknown, reason: RerenderReason | 'core_deaths'): void {
  log.error('[dot.li] Product iframe reload failed:', error);
  if (error instanceof CoreRedialError) {
    // A redial failure is captured where it happens, so the frame only records that its render fell with it.
    uiReport.expected(error, { step: 'product_rerender', metric: productRerenderMetric, reason });
    return;
  }
  uiReport.capture(error, { step: 'product_rerender', tags: { reason } });
  productRerenderMetric.count({ outcome: 'error', reason });
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
