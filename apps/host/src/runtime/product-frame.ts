// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product on screen, in a frame piped to the page core. One render runs at a time: a newer one supersedes a render
// still connecting, and the product on screen stays up until its replacement has connected. Only the app subdomain
// joins the TrUAPI channel, so any nested iframe it loads is opaque to the host.

import { createMessagePortProvider, type WireProvider as Provider } from '@parity/truapi';
import type { IframeHost, IframeHostOptions } from '@parity/truapi-host/web';
import { BASE_DOMAIN, DEV_SANDBOX_PORT, getBackend, getNetwork } from '@dotli/config';
import { sandboxLabel } from '@dotli/resolver';
import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION, type SandboxChannel } from '@dotli/sandbox-wire';
import { captureException, getResolutionId, m, reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log, noop, randomId, sleep } from '@dotli/shared';
import { emitDotliDebugEvent } from '@dotli/truapi-debug';
import { chatConnections } from './chat/chat-store.js';
import { ownCoreConnection } from './core-connection.js';
import { ERRORS } from './errors.js';
import { CoreRedialError, type CoreConnection, type CoreLease, type PageCore } from './page-core.js';
import { takePendingReset } from './pending-reset.js';
import { createPermissionResponseGate } from './permission-response-gate.js';
import type { PermissionAuthorizations } from './permissions.js';
import type { PhoneRequestTap } from './phone-requests.js';
import { labelToProductId } from './runtime-config.js';
import { setProductLoaded } from './state/product.js';
import type { PermissionsChange } from './state/product-permissions.js';
import type { ShowNotification } from '@dotli/ui';
import type { ManifestFacts } from './manifest-facts.js';

/**
 * A product the host loads from a URL it was given, or from its content id on the app subdomain. `chat` says whether it
 * declares chat, which picks its connection's execution kind, so the frame awaits it before it connects the product.
 * `base` is the page path ahead of the product's own, which its frame does not get.
 */
export type FrameProduct =
  | { mode: 'iframe'; label: string; url: string; productId?: string | undefined; chat: Promise<boolean> }
  | ({
      mode: 'subdomain';
      label: string;
      cid: string;
      base?: string | undefined;
      chat: Promise<boolean>;
    } & ManifestFacts);

/** `lost` is a product whose core went down, was refused or turned stale, until its render on a replacement begins. */
export type ProductFrameStatus = 'idle' | 'connecting' | 'connected' | 'lost' | 'failed';

/** What the frame asks of its iframe host. The page decides where the frame mounts. */
export type FrameHostOptions = Omit<IframeHostOptions, 'container'>;

export interface ProductFrameDeps {
  core: Pick<PageCore, 'acquire' | 'setProduct'>;
  createIframeHost: (options: FrameHostOptions) => Promise<IframeHost>;
  /** Where a reloaded sandbox asks to be rebuilt. */
  channel: SandboxChannel;
  onPermissionsChanged: (listener: (change: PermissionsChange) => void) => () => void;
  /** Where the frame routes each product connection's permissions, and reads the `allow` attribute from. */
  permissions: Pick<PermissionAuthorizations, 'register' | 'allowAttribute'>;
  view: ProductFrameView;
  /** The page's notifications, for a reload the frame could not do itself. */
  notify: ShowNotification;
  /** The host page around the frame. Without one, the browser's. */
  page?: ProductFramePage | undefined;
}

/** `iframe` is a local or preview URL, which has no root manifest to name it. */
export interface TitledProduct {
  mode: 'subdomain' | 'iframe';
  label: string;
  /** The name its root manifest publishes. */
  displayName?: string;
}

/** What the page shows around the frame. The runtime asks through this seam so its specs run under Node. */
export interface ProductFrameView {
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
  /** Only in sandbox checker builds: loads the panel that watches the frame, as a mount that returns its dispose. */
  loadCheckerPanel?: (() => Promise<(iframe: HTMLIFrameElement) => () => void>) | undefined;
}

/** What the frame reads and writes of the browser page. */
export interface ProductFramePage {
  /** Where the host page is, which the app's origin and deep path follow. */
  location: () => Pick<Location, 'href' | 'hostname' | 'port' | 'pathname' | 'search' | 'hash'>;
  reload: () => void;
}

const browserPage: ProductFramePage = {
  location: () => window.location,
  reload: () => {
    window.location.reload();
  },
};

export interface ProductFrame {
  /**
   * Replaces the product on screen once the new one has connected. Resolves when it is on screen or a newer render
   * superseded it, and rejects when it could not be shown.
   */
  render(product: FrameProduct): Promise<void>;
  /**
   * Takes the product down for good under a failure screen the page shows: a render in flight is dropped, and the frame
   * starts no render of its own again, so nothing it does clears that screen. The product stays mounted under it
   * without its core, and a render asked from above starts afresh.
   */
  halt(): void;
}

interface MountedHost {
  iframe: HTMLIFrameElement;
  /** Whether the product declares chat, as its connection was opened. */
  chat: boolean;
  /** Runs `run` once the product's pending permission answer has reached it. */
  afterPermissionResponse: (run: () => void) => void;
  /**
   * Lets go of the core under the product, which stays on screen until a render replaces it. Idempotent, and `dispose`
   * after it only removes the frame.
   */
  releaseCore: () => void;
  dispose: () => void;
}

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

/** Why the frame rendered the product again on its own. */
type RerenderReason = 'replacement' | 'permission' | 'recover';

/** The core under a render went down before the product's connection was open, so its replacement is worth a try. */
class CoreWentDownError extends Error {}

/** The tab's view of a product: a local or preview URL has no root manifest to name it. */
function titledProduct(product: FrameProduct): TitledProduct {
  return product.mode === 'subdomain' && product.displayName !== undefined
    ? { mode: product.mode, label: product.label, displayName: product.displayName }
    : { mode: product.mode, label: product.label };
}

/** The facts a product carries, without the keys it lacks. */
function manifestFactsOf({ displayName, manifestVersion, appVersion }: ManifestFacts): ManifestFacts {
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(manifestVersion !== undefined ? { manifestVersion } : {}),
    ...(appVersion !== undefined ? { appVersion } : {}),
  };
}

export function createProductFrame(deps: ProductFrameDeps): ProductFrame {
  const page = deps.page ?? browserPage;
  const { view } = deps;
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
  });
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
  const setStatus = (next: ProductFrameStatus): void => {
    if (next !== status) {
      status = next;
      view.showStatus(next);
    }
  };

  async function render(product: FrameProduct): Promise<void> {
    // A render asked from above starts afresh, so the cores that died before it no longer count.
    coreDeaths = 0;
    replacedAt = null;
    await start(product);
  }

  /** Resolves true when this render put the product on screen, false when a newer render or a core loss took over. */
  function start(product: FrameProduct): Promise<boolean> {
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
        showReloadNotice(deps.notify, page);
      },
    );
  }

  /**
   * Shows the product again on the core that replaced the one under it, at most once per interval, and gives up once
   * its cores keep dying soon after it is rendered on them.
   */
  function renderOnReplacement(): void {
    if (replacedAt === null || Date.now() - replacedAt > CORE_DEATH_WINDOW_MS) {
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
      showReloadNotice(deps.notify, page);
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
        replacedAt = Date.now();
        await rerender('replacement');
        await sleep(RECOVER_MIN_INTERVAL_MS);
      })
      .catch((error: unknown) => {
        reportRerenderFailure(error, 'replacement');
      });
  }

  async function mount(product: FrameProduct, signal: AbortSignal): Promise<void> {
    // Read after each wait, since a newer render can abort this one at any of them.
    const superseded = (): boolean => signal.aborted;
    setStatus('connecting');
    // Written by the core's down report, which can arrive during any wait below.
    const heard = { coreDown: false };
    let shown: MountedHost | null = null;
    const renderFlowId = randomId();
    const bridgeFlowId = randomId();
    const productId = product.mode === 'iframe' ? (product.productId ?? product.label) : product.label;
    const stopSetup = m.timer(S.BRIDGE_SETUP);
    // Keep the product on screen while its replacement connects, which can take seconds.
    const previous = mounted;
    if (product.mode === 'iframe') {
      emitDotliDebugEvent({
        layer: 'render',
        event: 'iframe_begin',
        flowId: renderFlowId,
        timestamp: Date.now(),
        payload: { label: product.label, url: product.url, mode: 'iframe' },
      });
      if (previous === null) {
        // This path has no loading overlay to keep.
        view.clearScreens({ loading: true });
        view.clearMount();
      }
      deps.core.setProduct({ label: product.label, productId: product.productId });
    } else {
      deps.core.setProduct({ label: product.label });
    }
    const iframeUrl =
      product.mode === 'iframe' ? new URL(product.url, page.location().href) : sandboxUrl(product, page.location());
    emitDotliDebugEvent({
      layer: 'bridge',
      event: 'setup_begin',
      flowId: bridgeFlowId,
      timestamp: Date.now(),
      payload: { label: product.label, productId },
    });
    if (product.mode === 'subdomain') {
      emitDotliDebugEvent({
        layer: 'render',
        event: 'iframe_begin',
        flowId: renderFlowId,
        timestamp: Date.now(),
        payload: { label: product.label, url: iframeUrl.toString(), mode: 'subdomain' },
      });
    }
    const host = await connectHost({
      iframeUrl: iframeUrl.href,
      allowedOrigin: iframeUrl.origin,
      sandbox: product.mode === 'iframe' ? IFRAME_SANDBOX : SUBDOMAIN_SANDBOX,
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
    if (superseded()) {
      host.dispose();
      stopSetup();
      return;
    }
    emitDotliDebugEvent({
      layer: 'bridge',
      event: 'setup_ready',
      flowId: bridgeFlowId,
      timestamp: Date.now(),
      payload: { label: product.label, productId },
    });
    view.attachFrame(host.iframe);
    // On the initial app subdomain render the sandbox dismisses the overlay itself, with `dotli:loading-status`.
    activate(host, product.mode === 'subdomain' && previous === null);
    shown = host;
    host.iframe.addEventListener(
      'load',
      () => {
        emitDotliDebugEvent({
          layer: 'bridge',
          event: 'iframe_load',
          flowId: bridgeFlowId,
          timestamp: Date.now(),
          payload: { label: product.label, productId, mode: product.mode },
        });
      },
      { once: true },
    );

    if (view.loadCheckerPanel !== undefined) {
      const mountPanel = await view.loadCheckerPanel();
      if (superseded()) {
        stopSetup();
        return;
      }
      panelDispose = mountPanel(host.iframe);
    }

    stopSetup();
    view.showTitle(titledProduct(product));
    // The runtime productId, so chat data is keyed like storage when the debug path overrides it.
    if (product.mode === 'iframe') {
      setProductLoaded(product.label, product.productId ?? labelToProductId(product.label), { chat: host.chat });
    } else {
      setProductLoaded(product.label, labelToProductId(product.label), {
        cid: product.cid,
        chat: host.chat,
        ...manifestFactsOf(product),
      });
    }
    emitDotliDebugEvent({
      layer: 'render',
      event: 'iframe_ready',
      flowId: renderFlowId,
      timestamp: Date.now(),
      payload: { label: product.label, mode: product.mode },
    });
    if (heard.coreDown) {
      renderOnReplacement();
      return;
    }
    setStatus('connected');
  }

  async function connectHost(args: {
    iframeUrl: string;
    allowedOrigin: string;
    sandbox: string;
    label: string;
    chat: Promise<boolean>;
    debugFlowId: string;
    onCoreDown: () => void;
  }): Promise<MountedHost> {
    const { lease, connection, chatCapable } = await attaches.call(() => attach(args.chat), {
      pool: args.debugFlowId,
    });
    const unsubscribeDown = lease.subscribeDown(args.onCoreDown);
    const coreProvider = ownCoreConnection(connection);
    const unregisterChat = chatCapable ? registerProductChat(connection) : noop;
    const unregisterPermissions = deps.permissions.register(args.label, coreProvider);
    let productProvider: Provider | null = null;
    let disposePipe: (() => void) | null = null;
    let phoneTap: PhoneRequestTap | null = null;
    const lifetime = new AbortController();
    const responses = createPermissionResponseGate({
      signal: lifetime.signal,
      timeoutMs: PERMISSION_ANSWER_WAIT_MS,
    });
    const pipeArgs = { flowId: args.debugFlowId, label: args.label, productId: connection.productId };
    const cleanupProductSide = (): void => {
      disposePipe?.();
      phoneTap?.close();
      productProvider?.dispose();
      disposePipe = null;
      phoneTap = null;
      productProvider = null;
    };
    // Runs once, from a dispose, a failed build or a frame that gave up on its core.
    let coreSideHeld = true;
    const cleanupCoreSide = (): void => {
      if (!coreSideHeld) {
        return;
      }
      coreSideHeld = false;
      unsubscribeDown();
      unregisterPermissions();
      unregisterChat();
      cleanupProductSide();
      coreProvider.dispose();
      lease.release();
    };
    try {
      const allow = `${await deps.permissions.allowAttribute(args.label)}; cross-origin-isolated`;
      const host = await deps.createIframeHost({
        iframeUrl: args.iframeUrl,
        allowedOrigin: args.allowedOrigin,
        allow,
        sandbox: args.sandbox,
        onPort: port => {
          // A new port is a product that loaded again, so what the old one had in flight is gone.
          phoneTap?.close();
          phoneTap = lease.phoneRequests.connect();
          productProvider = createMessagePortProvider(port);
          disposePipe = pipeProviders(productProvider, coreProvider, pipeArgs, responses.forwarded, phoneTap);
        },
      });
      return {
        iframe: host.iframe,
        chat: chatCapable,
        afterPermissionResponse: responses.afterResponse,
        // The frame's lifetime runs on, so a device grant still waiting for its answer when the frame gives up still
        // rebuilds it.
        releaseCore: cleanupCoreSide,
        dispose() {
          lifetime.abort();
          cleanupCoreSide();
          host.dispose();
        },
      };
    } catch (error) {
      lifetime.abort();
      cleanupCoreSide();
      throw error;
    }
  }

  /** A lease on the page core with the product's connection open on it. */
  async function attach(
    chat: Promise<boolean>,
  ): Promise<{ lease: CoreLease; connection: CoreConnection; chatCapable: boolean }> {
    const lease = await deps.core.acquire();
    // Written by the core's down report, which can arrive during either wait below.
    const heard = { coreDown: false };
    const unsubscribeDown = lease.subscribeDown(() => {
      heard.coreDown = true;
    });
    try {
      // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
      const chatCapable = await chat;
      log.event('chat capability resolved', { flow: 'chat', capable: chatCapable });
      const connection = await lease.connect(chatCapable ? 'Worker' : 'App');
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
    panelDispose?.();
    panelDispose = null;
    mounted?.dispose();
    view.clearScreens({ loading: !keepLoading });
    mounted = host;
  }

  // The frame lives as long as the page, so it never unsubscribes from either source below.

  // A new `allow` attribute only takes effect in a fresh iframe. A frame still being built may have read its policy
  // before the change, so it is built again at once rather than after an answer for the frame it replaces.
  deps.onPermissionsChanged(change => {
    if (!change.allowChanged || change.label !== target?.label) {
      return;
    }
    const host = mounted;
    if (change.fromPrompt && host !== null && status !== 'connecting') {
      host.afterPermissionResponse(() => {
        void rerender('permission');
      });
    } else {
      void rerender('permission');
    }
  });

  // The sandbox strips its contract params after boot, so a reloaded sandbox asks the host to rebuild it.
  deps.channel.on('dotli:sandbox-recover', (_message, { origin, source }) => {
    const product = target;
    const asking = mounted;
    // The exact origin of the product on screen, so one product's sandbox cannot rebuild another, and the frame on
    // screen itself, so a frame nested inside the product on its own origin cannot either. A reloaded sandbox keeps its
    // window.
    if (
      product?.mode !== 'subdomain' ||
      origin !== appOrigin(product.label, page.location()) ||
      source !== asking?.iframe.contentWindow
    ) {
      return;
    }
    // The newer ask wins, since a frame rebuilt meanwhile asks with itself as the frame on screen.
    waitingRecover?.abort(new Error('A newer recover ask replaced this one'));
    const ask = new AbortController();
    waitingRecover = ask;
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
          await sleep(RECOVER_MIN_INTERVAL_MS, ask.signal);
        },
        { signal: ask.signal },
      )
      .catch((error: unknown) => {
        // A newer ask took the place of this one while it waited.
        if (!ask.signal.aborted) {
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

  return {
    render,
    halt,
  };
}

/** Nobody asked for a render the frame starts on its own, so the frame is the one to report it. */
function reportRerenderFailure(error: unknown, reason: RerenderReason | 'core_deaths'): void {
  log.error('[dot.li] Product iframe reload failed:', error);
  if (error instanceof CoreRedialError) {
    // The page core captured the redial, so the frame only records that its render fell with it.
    reportExpected(error, { flow: 'ui', step: 'product_rerender', metric: S.PRODUCT_RERENDER, reason });
    return;
  }
  captureException(error, { flow: 'ui', step: 'product_rerender', tags: { reason } });
  m.count(S.PRODUCT_RERENDER, { outcome: 'error', reason });
}

function showReloadNotice(notify: ProductFrameDeps['notify'], page: ProductFramePage): void {
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

/** The sandbox validator rejects unknown params. */
type PageLocation = ReturnType<ProductFramePage['location']>;

function sandboxUrl(product: Extract<FrameProduct, { mode: 'subdomain' }>, location: PageLocation): URL {
  const origin = appOrigin(product.label, location);
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
  if (takePendingReset('sandbox')) {
    url.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, '1');
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    url.searchParams.set(SANDBOX_CONTRACT_PARAMS.resolutionId, resolutionId);
  }
  return url;
}

function appOrigin(label: string, location: PageLocation): string {
  const { hostname } = location;
  if (hostname.endsWith('.localhost') || hostname === 'localhost') {
    const port = import.meta.env.DEV ? DEV_SANDBOX_PORT : location.port;
    return `http://${sandboxLabel(label)}.app.localhost:${port}`;
  }
  return `https://${sandboxLabel(label)}.app.${BASE_DOMAIN}`;
}

function getDeepPath(location: PageLocation, productBase: string): string {
  const { pathname, search, hash } = location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== '/' && p.startsWith(base)) {
    p = '/' + p.slice(base.length);
  }
  if (productBase !== '' && p.startsWith(productBase)) {
    p = p.slice(productBase.length);
  }
  const isRoot = p === '' || p === '/';
  if (isRoot) {
    return search || hash ? search + hash : '';
  }
  return p + search + hash;
}

function pipeProviders(
  product: Provider,
  core: Provider,
  args: { flowId: string; label: string; productId: string },
  forwarded: (message: Uint8Array) => void,
  tap: PhoneRequestTap,
): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  const unsubs = [
    product.subscribe(message => {
      if (!sawInbound) {
        sawInbound = true;
        emitDotliDebugEvent({
          layer: 'bridge',
          event: 'first_inbound',
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
      }
      core.postMessage(message);
      tap.fromProduct(message);
    }),
    core.subscribe(message => {
      if (!sawOutbound) {
        sawOutbound = true;
        emitDotliDebugEvent({
          layer: 'bridge',
          event: 'first_outbound',
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
      }
      product.postMessage(message);
      tap.fromCore(message);
      forwarded(message);
    }),
    product.subscribeClose?.(() => {
      core.dispose();
    }),
    core.subscribeClose?.(() => {
      product.dispose();
    }),
  ].filter((fn): fn is () => void => typeof fn === 'function');

  return () => {
    for (const unsub of unsubs) {
      try {
        unsub();
        // eslint-disable-next-line no-restricted-syntax -- provider teardown is best-effort. Stale MessagePorts can already be closed while the next cleanup still must run.
      } catch {
        // Teardown race.
      }
    }
  };
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
    render: (request, sink) => {
      if (provider.render === undefined) {
        sink.onError?.(new Error('rendering unavailable'));
        return noop;
      }
      return provider.render(request, sink);
    },
  });
}
