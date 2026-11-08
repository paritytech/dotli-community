// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product on screen, in a frame piped to the page core. One render runs at a time: a newer one supersedes a render
// still connecting, and the product on screen stays up until its replacement has connected. Only the app subdomain
// joins the TrUAPI channel, so any nested iframe it loads is opaque to the host.

import { createMessagePortProvider, type ProductId, type WireProvider as Provider } from '@parity/truapi';
import type { IframeHost, IframeHostOptions } from '@parity/truapi-host/web';
import { BASE_DOMAIN, DEV_SANDBOX_PORT, getBackend, getNetwork, getLocalRoot } from '@dotli/config';
import { getSandboxLabel } from '@dotli/resolver';
import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION, type SandboxChannel } from '@dotli/sandbox-wire';
import { captureException, getResolutionId, m, reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log, noop, createRandomId, realTimers, sleep, type Timers } from '@dotli/shared';
import { debugBus } from '@dotli/truapi-debug';
import { chatConnections } from './chat/createChatConnections.js';
import { ownCoreConnection } from './ownCoreConnection.js';
import { ERRORS } from './errors.js';
import { CoreRedialError } from './coreRedialError.js';
import type { CoreConnection, CoreLease, PageCore } from './createPageCore.js';
import { pendingResets } from './createPendingResets.js';
import { createPermissionResponseGate } from './createPermissionResponseGate.js';
import type { PermissionAuthorizations } from './createPermissionAuthorizations.js';
import { toProductId } from './createTruapiRuntimeConfig.js';
import { productState } from './state/productState.js';
import type { PermissionsChange } from './state/productPermissions.js';
import type { ShowNotification } from '@dotli/ui';
import type { ProductFacts } from '../getProductFacts.js';

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

type ConnectHostParams = {
  iframeUrl: string;
  allowedOrigin: string;
  sandbox: string;
  label: string;
  /** Whether the product declares chat, once its manifest tells. */
  chat: Promise<boolean>;
  debugFlowId: string;
  /** Called each time the core under the product goes down, is refused or turns stale. */
  onCoreDown: () => void;
};

type PipeProvidersParams = {
  product: Provider;
  core: Provider;
  flowId: string;
  label: string;
  productId: string;
  /** Is shown each core frame once it was forwarded to the product. */
  noteForwarded: (message: Uint8Array) => void;
  /** The clock the debug events are stamped with. */
  timers: Pick<Timers, 'now'>;
};

type MountedHost = {
  iframe: HTMLIFrameElement;
  /** The id the core parsed for the product, which its connection runs under. */
  productId: ProductId;
  /** Whether the product declares chat, as its connection was opened. */
  chat: boolean;
  /** Runs `run` once the product's pending permission answer has reached it. */
  runAfterPermissionResponse: (run: () => void) => void;
  /**
   * Lets go of the core under the product, which stays on screen until a render replaces it. Idempotent, and `dispose`
   * after it only removes the frame.
   */
  releaseCore: () => void;
  /**
   * Removes the frame, lets go of the core under it and ends the wait for a permission answer. Throws when the core
   * connection's or the frame's own dispose throws.
   */
  dispose: () => void;
};

/** Why the frame rendered the product again on its own. */
type RerenderReason = 'replacement' | 'permission' | 'recover';

type PageLocation = ReturnType<ProductFramePage['location']>;

// Spaces the rebuilds a reloaded sandbox asks for and the renders after a core death, so a product that keeps reloading
// or keeps taking its core down cannot pin the host.
const RECOVER_MIN_INTERVAL_MS = 5_000;
// A core that dies this soon after the render on it began counts toward the budget below.
const CORE_DEATH_WINDOW_MS = 60_000;
// Consecutive quick core deaths after which the frame stops rendering the product again and reports it failed.
const CORE_DEATH_BUDGET = 3;
// How long a rebuild after a device grant waits for the prompt's answer to reach the product.
const PERMISSION_ANSWER_WAIT_MS = 3_000;

const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';
const SUBDOMAIN_SANDBOX = `${IFRAME_SANDBOX} allow-popups`;

const BROWSER_PAGE: ProductFramePage = {
  location: () => window.location,
  reload: () => {
    window.location.reload();
  },
};

/** The core under a render went down before the product's connection was open, so its replacement is worth a try. */
class CoreWentDownError extends Error {}

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
  // A newer render aborts the one before it, which frees the slot at once. The aborted render still runs to its next
  // check and takes down what it built.
  const renders = createAsyncTaskPool({ poolSize: 1 });
  // A recover holds the slot past its rebuild, so the next one waits out the interval.
  const recovers = createAsyncTaskPool({ poolSize: 1 });
  // A render on a replacement core holds its slot the same way.
  const replacements = createAsyncTaskPool({ poolSize: 1 });
  // Each render names its own pool, so a superseded render still connecting never holds up a newer one.
  const attaches = createAsyncTaskPool({
    poolSize: 1,
    retryCount: 1,
    retryIf: error => error instanceof CoreWentDownError,
    timers,
  });
  // Aborts on dispose, after which no wait of the frame's runs on.
  const frameLifetime = new AbortController();
  let rendering = new AbortController();
  // The recover ask queued behind the running one. A newer ask takes its place, so at most one waits.
  let waitingRecover: AbortController | null = null;
  let target: FrameProduct | null = null;
  let mounted: MountedHost | null = null;
  let panelDispose: (() => void) | null = null;
  // Quick core deaths in a row, and when the render on the latest replacement core began.
  let coreDeaths = 0;
  let replacedAt: number | null = null;

  // On the page as state that browser tests read, and read here to tell what the frame is doing.
  let status: ProductFrameStatus = 'idle';
  view.showStatus(status);

  function setStatus(next: ProductFrameStatus): void {
    if (next !== status) {
      status = next;
      view.showStatus(next);
    }
  }

  async function render(product: FrameProduct): Promise<void> {
    // A render asked from above starts afresh, so the cores that died before it no longer count.
    coreDeaths = 0;
    replacedAt = null;
    await start(product);
  }

  /** Resolves true when this render put the product on screen, false when a newer render or a core loss took over. */
  function start(product: FrameProduct): Promise<boolean> {
    // A disposed frame mounts nothing again.
    if (frameLifetime.signal.aborted) {
      return Promise.resolve(false);
    }
    rendering.abort(new Error('A newer render superseded this one'));
    const controller = new AbortController();
    rendering = controller;
    target = product;
    return renders
      .call(() => mount(product, controller.signal), { signal: controller.signal })
      .then(
        () => !controller.signal.aborted && status === 'connected',
        (error: unknown) => {
          // The newer render owns the frame now.
          if (controller.signal.aborted) {
            return false;
          }
          setStatus('failed');
          throw error;
        },
      );
  }

  /** A render the frame starts on its own has no caller to report to, so it counts its own outcome. */
  function rerender(reason: RerenderReason): Promise<void> {
    const product = target;
    if (product === null) {
      return Promise.resolve();
    }
    return start(product).then(
      shown => {
        m.count(S.PRODUCT_RERENDER, { outcome: shown ? 'ok' : 'aborted', reason });
      },
      (error: unknown) => {
        reportRerenderFailure(error, reason);
        showReloadNotice(notify, page);
      },
    );
  }

  /**
   * Shows the product again on the core that replaced the one under it, at most once per interval, and gives up once
   * its cores keep dying soon after it is rendered on them.
   */
  function renderOnReplacement(): void {
    if (replacedAt === null || timers.now() - replacedAt > CORE_DEATH_WINDOW_MS) {
      coreDeaths = 0;
    }
    coreDeaths += 1;
    if (coreDeaths >= CORE_DEATH_BUDGET) {
      setStatus('failed');
      // The product stays on screen under the reload notice, but its core is down for good, so its lease goes.
      mounted?.releaseCore();
      reportRerenderFailure(
        new Error(`The wallet core went down ${String(coreDeaths)} times in a row under the product`),
        'core_deaths',
      );
      showReloadNotice(notify, page);
      return;
    }
    setStatus('lost');
    const lost = mounted;
    replacements
      .call(async () => {
        // A render since the death already answered it.
        if (mounted !== lost || status !== 'lost') {
          return;
        }
        replacedAt = timers.now();
        await rerender('replacement');
        await sleep(RECOVER_MIN_INTERVAL_MS, { signal: frameLifetime.signal, timers });
      })
      .catch((error: unknown) => {
        // A disposed frame ended the wait.
        if (frameLifetime.signal.aborted) {
          return;
        }
        reportRerenderFailure(error, 'replacement');
      });
  }

  async function mount(product: FrameProduct, signal: AbortSignal): Promise<void> {
    // Read after each wait, since a newer render can abort this one at any of them.
    const isSuperseded = (): boolean => signal.aborted;
    setStatus('connecting');
    // Written by the core's down report, which can arrive during any wait below.
    const heard = { coreDown: false };
    let shown: MountedHost | null = null;
    const renderFlowId = createRandomId();
    const bridgeFlowId = createRandomId();
    const productId = getFrameProductId(product);
    const stopSetup = m.timer(S.BRIDGE_SETUP);
    // Keep the product on screen while its replacement connects, which can take seconds.
    const previous = mounted;
    switch (product.mode) {
      case 'iframe':
        debugBus.emit({
          layer: 'render',
          event: 'iframe_begin',
          flowId: renderFlowId,
          timestamp: timers.now(),
          payload: { label: product.label, url: product.url, mode: 'iframe' },
        });
        if (previous === null) {
          // This path has no loading overlay to keep.
          view.clearScreens({ loading: true });
          view.clearMount();
        }
        core.setProduct({ label: product.label, productId: product.productId });
        break;
      case 'subdomain':
        core.setProduct({ label: product.label });
        break;
    }
    const iframeUrl = buildFrameUrl(product, page.location());
    debugBus.emit({
      layer: 'bridge',
      event: 'setup_begin',
      flowId: bridgeFlowId,
      timestamp: timers.now(),
      payload: { label: product.label, productId },
    });
    if (product.mode === 'subdomain') {
      debugBus.emit({
        layer: 'render',
        event: 'iframe_begin',
        flowId: renderFlowId,
        timestamp: timers.now(),
        payload: { label: product.label, url: iframeUrl.toString(), mode: 'subdomain' },
      });
    }
    const host = await connectHost({
      iframeUrl: iframeUrl.href,
      allowedOrigin: iframeUrl.origin,
      sandbox: getSandbox(product),
      label: product.label,
      chat: product.chat,
      debugFlowId: bridgeFlowId,
      // A core that goes down closes the product's connection with it, and one refused or turned stale (another tab
      // logged in with another wallet) no longer serves it, so the product is shown again on the replacement. A frame
      // still being built does that once it is up. A newer render in flight holds a lease of its own and answers for
      // itself. A replacement that cannot boot fails the render that asked for it, and cores that keep dying use up a
      // budget, so this never loops.
      onCoreDown: () => {
        heard.coreDown = true;
        if (shown !== null && shown === mounted && status === 'connected') {
          renderOnReplacement();
        }
      },
    });
    if (isSuperseded()) {
      host.dispose();
      stopSetup();
      return;
    }
    debugBus.emit({
      layer: 'bridge',
      event: 'setup_ready',
      flowId: bridgeFlowId,
      timestamp: timers.now(),
      payload: { label: product.label, productId },
    });
    view.attachFrame(host.iframe);
    // On the initial app subdomain render the sandbox dismisses the overlay itself, with `dotli:loading-status`.
    activate(host, product.mode === 'subdomain' && previous === null);
    shown = host;
    host.iframe.addEventListener(
      'load',
      () => {
        debugBus.emit({
          layer: 'bridge',
          event: 'iframe_load',
          flowId: bridgeFlowId,
          timestamp: timers.now(),
          payload: { label: product.label, productId, mode: product.mode },
        });
      },
      { once: true },
    );

    if (view.loadCheckerPanel !== undefined) {
      const mountPanel = await view.loadCheckerPanel();
      if (isSuperseded()) {
        stopSetup();
        return;
      }
      panelDispose = mountPanel(host.iframe);
    }

    stopSetup();
    view.showTitle(toTitledProduct(product));
    productState.setLoaded(toLoadedProduct(product, host));
    debugBus.emit({
      layer: 'render',
      event: 'iframe_ready',
      flowId: renderFlowId,
      timestamp: timers.now(),
      payload: { label: product.label, mode: product.mode },
    });
    if (heard.coreDown) {
      renderOnReplacement();
      return;
    }
    setStatus('connected');
  }

  async function connectHost({
    iframeUrl,
    allowedOrigin,
    sandbox,
    label,
    chat,
    debugFlowId,
    onCoreDown,
  }: ConnectHostParams): Promise<MountedHost> {
    const { lease, connection, chatCapable } = await attaches.call(() => attach(chat), {
      pool: debugFlowId,
    });
    const unsubscribeDown = lease.subscribeDown(onCoreDown);
    const coreProvider = ownCoreConnection(connection);
    const unregisterChat = chatCapable ? registerProductChat(connection) : noop;
    const unregisterPermissions = permissions.register(label, coreProvider);
    let productProvider: Provider | null = null;
    let disposePipe: (() => void) | null = null;
    const lifetime = new AbortController();
    const responses = createPermissionResponseGate({
      signal: lifetime.signal,
      timeoutMs: PERMISSION_ANSWER_WAIT_MS,
      timers,
    });
    let coreSideHeld = true;

    function disposeProductSide(): void {
      disposePipe?.();
      productProvider?.dispose();
      disposePipe = null;
      productProvider = null;
    }

    /** Runs once, from a dispose, a failed build or a frame that gave up on its core. */
    function releaseCoreSide(): void {
      if (!coreSideHeld) {
        return;
      }
      coreSideHeld = false;
      unsubscribeDown();
      unregisterPermissions();
      unregisterChat();
      disposeProductSide();
      coreProvider.dispose();
      lease.release();
    }

    try {
      const allow = `${await permissions.getAllowAttribute(label)}; cross-origin-isolated`;
      const host = await createIframeHost({
        iframeUrl,
        allowedOrigin,
        allow,
        sandbox,
        onPort: port => {
          productProvider = createMessagePortProvider(port);
          disposePipe = pipeProviders({
            product: productProvider,
            core: coreProvider,
            flowId: debugFlowId,
            label,
            productId: connection.productId,
            noteForwarded: responses.noteForwarded,
            timers,
          });
        },
      });
      return {
        iframe: host.iframe,
        productId: connection.productId,
        chat: chatCapable,
        runAfterPermissionResponse: responses.runAfterResponse,
        // The frame's lifetime runs on, so a device grant still waiting for its answer when the frame gives up still
        // rebuilds it.
        releaseCore: releaseCoreSide,
        dispose() {
          lifetime.abort();
          releaseCoreSide();
          host.dispose();
        },
      };
    } catch (error) {
      lifetime.abort();
      releaseCoreSide();
      throw error;
    }
  }

  /** A lease on the page core with the product's connection open on it. */
  async function attach(
    chat: Promise<boolean>,
  ): Promise<{ lease: CoreLease; connection: CoreConnection; chatCapable: boolean }> {
    const lease = await core.acquire();
    // Written by the core's down report, which can arrive during either wait below.
    const heard = { coreDown: false };
    const unsubscribeDown = lease.subscribeDown(() => {
      heard.coreDown = true;
    });
    try {
      // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
      const chatCapable = await chat;
      log.event('chat capability resolved', { flow: 'chat', capable: chatCapable });
      const connection = await lease.connect({ executionKind: chatCapable ? 'Worker' : 'App' });
      log.event('product connected to wallet core', { flow: 'wallet', kind: chatCapable ? 'Worker' : 'App' });
      return { lease, connection, chatCapable };
    } catch (error) {
      lease.release();
      throw heard.coreDown
        ? new CoreWentDownError('The wallet core went down before the product connected', { cause: error })
        : error;
    } finally {
      unsubscribeDown();
    }
  }

  function activate(host: MountedHost, keepLoading: boolean): void {
    takeDown();
    view.clearScreens({ loading: !keepLoading });
    mounted = host;
  }

  /** Takes down the product on screen and the panel watching it. Throws when the product's own dispose throws. */
  function takeDown(): void {
    const stopPanel = panelDispose;
    const taken = mounted;
    // Cleared first, so a dispose that throws is not repeated by a second take down.
    panelDispose = null;
    mounted = null;
    stopPanel?.();
    taken?.dispose();
  }

  // A new `allow` attribute only takes effect in a fresh iframe. A frame still being built may have read its policy
  // before the change, so it is built again at once rather than after an answer for the frame it replaces.
  const stopPermissionChanges = subscribePermissionChanges(change => {
    if (!change.allowChanged || change.label !== target?.label) {
      return;
    }
    const host = mounted;
    if (change.fromPrompt && host !== null && status !== 'connecting') {
      host.runAfterPermissionResponse(() => {
        void rerender('permission');
      });
    } else {
      void rerender('permission');
    }
  });

  // The sandbox strips its contract params after boot, so a reloaded sandbox asks the host to rebuild it.
  const stopRecoverAsks = channel.on('dotli:sandbox-recover', (_message, { origin, source }) => {
    const product = target;
    const asking = mounted;
    // The exact origin of the product on screen, so one product's sandbox cannot rebuild another, and the frame on
    // screen itself, so a frame nested inside the product on its own origin cannot either. A reloaded sandbox keeps its
    // window.
    if (
      product?.mode !== 'subdomain' ||
      origin !== getAppOrigin(product.label, page.location()) ||
      source !== asking?.iframe.contentWindow
    ) {
      return;
    }
    // The newer ask wins, since a frame rebuilt meanwhile asks with itself as the frame on screen.
    waitingRecover?.abort(new Error('A newer recover ask replaced this one'));
    const ask = new AbortController();
    waitingRecover = ask;
    const signal = AbortSignal.any([ask.signal, frameLifetime.signal]);
    recovers
      .call(
        async () => {
          if (waitingRecover === ask) {
            waitingRecover = null;
          }
          // A rebuild since the ask already answered it.
          if (mounted !== asking) {
            return;
          }
          await rerender('recover');
          await sleep(RECOVER_MIN_INTERVAL_MS, { signal, timers });
        },
        { signal },
      )
      .catch((error: unknown) => {
        // A newer ask took the place of this one while it waited, or a disposed frame ended the wait.
        if (!signal.aborted) {
          reportRerenderFailure(error, 'recover');
        }
      });
  });

  function halt(): void {
    rendering.abort(new Error('The product failed for good'));
    // Every render the frame starts on its own reads the product from here.
    target = null;
    setStatus('failed');
    // The product stays on screen under the failure, but nothing serves it again, so its connection and lease go.
    mounted?.releaseCore();
  }

  function dispose(): void {
    frameLifetime.abort(new Error('The product frame was disposed'));
    rendering.abort(new Error('The product frame was disposed'));
    waitingRecover?.abort(new Error('The product frame was disposed'));
    waitingRecover = null;
    // Every render the frame starts on its own reads the product from here.
    target = null;
    stopPermissionChanges();
    stopRecoverAsks();
    takeDown();
  }

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
     * mounts anything, is safe to call twice or after a failed render, and throws only when the product on screen's
     * own dispose throws.
     */
    dispose,
  };
}

/** Nobody asked for a render the frame starts on its own, so the frame is the one to report it. */
function reportRerenderFailure(error: unknown, reason: RerenderReason | 'core_deaths'): void {
  log.error('[dot.li] Product iframe reload failed:', error);
  if (error instanceof CoreRedialError) {
    // A redial failure is captured where it happens, so the frame only records that its render fell with it.
    reportExpected(error, { flow: 'ui', step: 'product_rerender', metric: S.PRODUCT_RERENDER, reason });
    return;
  }
  captureException(error, { flow: 'ui', step: 'product_rerender', tags: { reason } });
  m.count(S.PRODUCT_RERENDER, { outcome: 'error', reason });
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

/** The URL the frame loads `product` from. Throws when an app subdomain's deep path leaves its origin. */
function buildFrameUrl(product: FrameProduct, location: PageLocation): URL {
  switch (product.mode) {
    case 'iframe':
      return new URL(product.url, location.href);
    case 'subdomain':
      return buildSandboxUrl(product, location);
  }
}

/** The product id `product` asks the core for. */
function getFrameProductId(product: FrameProduct): string {
  switch (product.mode) {
    case 'iframe':
      return product.productId ?? toProductId(product.label);
    case 'subdomain':
      return toProductId(product.label);
  }
}

function getSandbox(product: FrameProduct): string {
  switch (product.mode) {
    case 'iframe':
      return IFRAME_SANDBOX;
    case 'subdomain':
      return SUBDOMAIN_SANDBOX;
  }
}

/** The sandbox validator rejects unknown params. */
function buildSandboxUrl(product: Extract<FrameProduct, { mode: 'subdomain' }>, location: PageLocation): URL {
  const origin = getAppOrigin(product.label, location);
  const deepPath = getDeepPath(location, product.base ?? '');
  const url = new URL(deepPath ? `${origin}${deepPath}` : origin);
  if (url.origin !== origin) {
    throw new Error(ERRORS.CROSS_ORIGIN_APP_URL);
  }
  // Only the host writes the sandbox's params. A visitor's link that carried them could purge the sandbox origin or
  // name a resolution.
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    url.searchParams.delete(key);
  }
  url.searchParams.set(SANDBOX_CONTRACT_PARAMS.cid, product.cid);
  url.searchParams.set(SANDBOX_CONTRACT_PARAMS.v, String(SANDBOX_SCHEMA_VERSION));
  url.searchParams.set(SANDBOX_CONTRACT_PARAMS.chainBackend, getBackend());
  url.searchParams.set(SANDBOX_CONTRACT_PARAMS.network, getNetwork());
  if (pendingResets.take('sandbox')) {
    url.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, '1');
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    url.searchParams.set(SANDBOX_CONTRACT_PARAMS.resolutionId, resolutionId);
  }
  return url;
}

function getAppOrigin(label: string, location: PageLocation): string {
  const root = getLocalRoot(location.hostname);
  if (root !== null) {
    const port = import.meta.env.DEV ? DEV_SANDBOX_PORT : location.port;
    return `${location.protocol}//${getSandboxLabel(label)}.app.${root}:${port}`;
  }
  return `https://${getSandboxLabel(label)}.app.${BASE_DOMAIN}`;
}

function getDeepPath(location: PageLocation, productBase: string): string {
  const { pathname, search, hash } = location;
  let path = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== '/' && path.startsWith(base)) {
    path = '/' + path.slice(base.length);
  }
  if (productBase !== '' && path.startsWith(productBase)) {
    path = path.slice(productBase.length);
  }
  const isRoot = path === '' || path === '/';
  if (isRoot) {
    return search || hash ? search + hash : '';
  }
  return path + search + hash;
}

function pipeProviders({
  product,
  core,
  flowId,
  label,
  productId,
  noteForwarded,
  timers,
}: PipeProvidersParams): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  const unsubscribes = [
    product.subscribe(message => {
      if (!sawInbound) {
        sawInbound = true;
        debugBus.emit({
          layer: 'bridge',
          event: 'first_inbound',
          flowId,
          timestamp: timers.now(),
          payload: { label, productId },
        });
      }
      core.postMessage(message);
    }),
    core.subscribe(message => {
      if (!sawOutbound) {
        sawOutbound = true;
        debugBus.emit({
          layer: 'bridge',
          event: 'first_outbound',
          flowId,
          timestamp: timers.now(),
          payload: { label, productId },
        });
      }
      product.postMessage(message);
      noteForwarded(message);
    }),
    product.subscribeClose?.(() => {
      core.dispose();
    }),
    core.subscribeClose?.(() => {
      product.dispose();
    }),
  ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === 'function');

  function disposePipe(): void {
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
        // eslint-disable-next-line no-restricted-syntax -- provider teardown is best-effort. Stale MessagePorts can already be closed while the next cleanup still must run.
      } catch {
        // Teardown race.
      }
    }
  }

  return disposePipe;
}

function registerProductChat({ provider, productId }: CoreConnection): () => void {
  return chatConnections.register(productId, {
    publish: action =>
      provider.publishChatAction === undefined
        ? Promise.reject(new Error('chat publishing unavailable'))
        : provider.publishChatAction(action),
    publishRendererAction: item =>
      provider.publishRendererAction === undefined
        ? Promise.reject(new Error('renderer actions unavailable'))
        : provider.publishRendererAction(item),
    render(request, sink) {
      if (provider.render === undefined) {
        sink.onError?.(new Error('rendering unavailable'));
        return noop;
      }
      return provider.render(request, sink);
    },
  });
}

/**
 * What the page records of `product` once it is on `host`, with whether its connection serves chat. The id the core
 * parsed, so chat data is keyed as the core keys it.
 */
function toLoadedProduct(
  product: FrameProduct,
  { productId, chat }: MountedHost,
): Parameters<typeof productState.setLoaded>[0] {
  switch (product.mode) {
    case 'iframe':
      return {
        label: product.label,
        productId,
        details: { chat },
      };
    case 'subdomain':
      return {
        label: product.label,
        productId,
        details: { cid: product.cid, chat, facts: product.facts },
      };
  }
}

/** The tab's view of a product: a local or preview URL has no root manifest to name it. */
function toTitledProduct(product: FrameProduct): TitledProduct {
  return product.mode === 'subdomain' && product.facts.displayName !== undefined
    ? { mode: product.mode, label: product.label, displayName: product.facts.displayName }
    : { mode: product.mode, label: product.label };
}
