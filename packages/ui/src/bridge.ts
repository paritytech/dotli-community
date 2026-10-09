// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Connects the page's TrUAPI core to the product iframe and to the topbar's login and logout. Nested
// products are not modeled separately, so any nested traffic must share the top-level core.

import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginRequest,
  VersionedHostRequestLoginResponse,
  type HostRequestLoginResponse as LoginResponse,
  type WireProvider as Provider,
  createMessagePortProvider,
} from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import {
  BASE_DOMAIN,
  DEV_SANDBOX_PORT,
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
  getBackend,
  getNetwork,
  withActiveTld,
} from '@dotli/config';

import { captureException, getResolutionId, m, recordExpected, spans as S } from '@dotli/metrics';
import { chatCapabilityFor, log } from '@dotli/shared';

import { emitDotliDebugEvent, hasDotliDebugListeners } from '@dotli/truapi-debug';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { buildAllowAttribute, registerPermissionAuthorizationProvider } from './permissions.js';
import { dispatchAuthState } from './host-callbacks/AuthState.js';
import { LoginRequestError } from './login-request-error.js';
import { attachProductFrame } from './product-frame-layout.js';
import { labelToProductId } from './runtime-config.js';
import { acquireCore, cancelPairing, initPageCore, setPageProduct, type CoreConnection } from './page-core.js';

export { setPageProduct } from './page-core.js';
// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/Chain.js';
import { setProductLoaded } from './state/product.js';
import { getWalletMode } from './state/wallet-mode.js';
import { reportLocalWalletFailure } from './wallet-boot.js';
import { switchToPolkadotApp } from './wallet-switch.js';
import { describeWireFrame } from './debug-wire-describe.js';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { registerChatConnection } from './chat/service.js';
import { showNotification } from './notification.js';
import { ERRORS } from './errors.js';
import { disposeAppRoot, disposeAppRoots } from './mount/app-roots.js';

const noop = (): void => undefined;

// Preloaded so they are ready when the first product renders.
const chunkLoadStart = performance.now();
const runtimeChunkPromise = Promise.all([
  import('@parity/truapi-host/web'),
  import('@parity/truapi-host/worker-runtime?worker'),
]).then(([web]) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return { createIframeHost: web.createIframeHost };
});
void runtimeChunkPromise.catch(() => {
  // The render that awaits it reports the failure.
});

const app = document.getElementById('app') ?? document.body;

interface ActiveHost {
  iframe: HTMLIFrameElement;
  dispose: () => void;
}

type CoreProviderBase = Provider &
  Pick<
    TrUApiProductProvider,
    'getPermissionAuthorizationStatus' | 'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
  >;
type CurrentProduct =
  | {
      mode: 'iframe';
      label: string;
      url: string;
      productId?: string | undefined;
    }
  | {
      mode: 'subdomain';
      label: string;
      cid: string;
    };

let currentHost: ActiveHost | null = null;
let currentPanelDispose: (() => void) | null = null;
let currentProduct: CurrentProduct | null = null;
let renderGeneration = 0;

function rerenderProduct(product: CurrentProduct): void {
  const expectedGeneration = renderGeneration + 1;
  const render =
    product.mode === 'iframe'
      ? renderIframe(product.url, product.label, {
          productId: product.productId,
        })
      : renderAppSubdomain(product.cid, product.label);
  void render.catch((error: unknown) => {
    // A newer render owns the UI now.
    if (renderGeneration !== expectedGeneration) {
      return;
    }
    log.error('[dot.li] Product iframe reload failed:', error);
    showNotification({
      label: 'dot.li',
      text: 'The app could not be reloaded.',
      browserNotification: false,
      dismissMs: 0,
      action: {
        label: 'Reload',
        onClick: () => {
          window.location.reload();
        },
      },
    });
  });
}

// A new `allow` attribute only takes effect in a fresh iframe.
window.addEventListener('dotli:device-permission-changed', () => {
  const product = currentProduct;
  if (product !== null) {
    rerenderProduct(product);
  }
});

// The sandbox strips its contract params after boot, so a reloaded sandbox asks the host to rebuild it.
// The interval stops a reload-looping product from pinning the host in endless re-renders.
const RECOVER_MIN_INTERVAL_MS = 5_000;
let lastRecoverAt = 0;
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object' || data['type'] !== 'dotli:sandbox-recover') {
    return;
  }
  const product = currentProduct;
  if (product?.mode !== 'subdomain' || event.origin !== getAppOrigin(product.label)) {
    return;
  }
  const now = Date.now();
  if (now - lastRecoverAt < RECOVER_MIN_INTERVAL_MS) {
    return;
  }
  lastRecoverAt = now;
  rerenderProduct(product);
});

let bridgeEventListenersInitialized = false;

export function initBridgeEventListeners(modalCoordinator: BlockingModalCoordinator): void {
  if (bridgeEventListenersInitialized) {
    return;
  }
  initPageCore(modalCoordinator);
  bridgeEventListenersInitialized = true;
  (window as typeof window & { __dotliTruapiBridgeReady?: boolean }).__dotliTruapiBridgeReady = true;
  window.addEventListener('dotli:truapi-disconnect-request', () => {
    log.event('logout requested', { flow: 'wallet' });
    if (getWalletMode() === 'local') {
      // A local session lives only in memory, so logging out means leaving local mode.
      switchToPolkadotApp().catch((error: unknown) => {
        reportLocalWalletFailure(error, 'forget');
      });
      return;
    }
    void disconnectSession();
  });

  window.addEventListener('dotli:truapi-cancel-login', () => {
    log.event('pairing cancelled', { flow: 'wallet' });
    cancelPairing();
  });

  window.addEventListener('dotli:truapi-login-request', (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    log.event('login requested', { flow: 'wallet' });
    void topbarLogin(detail.reason).then(
      () => {
        log.event('login completed', { flow: 'wallet' });
      },
      (error: unknown) => {
        reportLoginFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        // The core already rendered a `LoginRequestError`, or stayed silent on purpose. Synthesize a
        // state only for failures it never saw.
        if (!(error instanceof LoginRequestError)) {
          dispatchAuthState({
            tag: 'LoginFailed',
            kind: 'Other',
            reason: message,
          });
        }
      },
    );
  });
}

/** A cancelled or denied login is an outcome, not a fault. The core's other refusals are still reported. */
function reportLoginFailure(error: unknown): void {
  if (error instanceof LoginRequestError && (error.error.tag === 'Cancelled' || error.error.tag === 'Denied')) {
    recordExpected(error, { flow: 'wallet', step: 'login' });
    return;
  }
  captureException(error, {
    flow: 'wallet',
    step: 'login',
    ...(error instanceof LoginRequestError ? { tags: { login_error: error.error.tag } } : {}),
  });
}

/** Over a connection of its own, since the product's connection forwards every frame to the product. */
async function topbarLogin(reason: string | undefined): Promise<void> {
  const lease = await acquireCore();
  try {
    const core = wrapCoreProviderForDebug(await lease.connect());
    try {
      await requestCoreLogin(core, reason);
    } finally {
      core.dispose();
    }
  } finally {
    lease.release();
  }
}

async function disconnectSession(): Promise<void> {
  let lease;
  try {
    lease = await acquireCore();
  } catch (err) {
    // Keep the UI responsive even though the persisted session could not be cleared.
    log.warn('[dot.li] disconnect skipped, the wallet core did not boot:', err);
    dispatchAuthState({ tag: 'Disconnected' });
    return;
  }
  try {
    await lease.runtime.disconnectSession();
  } catch (err) {
    log.warn('[dot.li] disconnect failed:', err);
  } finally {
    lease.release();
  }
}

function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== '/' && p.startsWith(base)) {
    p = '/' + p.slice(base.length);
  }
  const isRoot = p === '' || p === '/';
  if (isRoot) {
    return search || hash ? search + hash : '';
  }
  return p + search + hash;
}

function applyIframeStyling(iframe: HTMLIFrameElement): void {
  attachProductFrame(iframe);
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
}

function pipeProviders(
  product: Provider,
  core: Provider,
  args: { flowId: string; label: string; productId: string },
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
        window.dispatchEvent(new Event('dotli:debug:bridge-ready'));
      }
      product.postMessage(message);
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

function emitWireFrameDebug(direction: 'incoming' | 'outgoing', productId: string, message: Uint8Array): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  try {
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return;
    }
    emitDotliDebugEvent({
      kind: 'truapi',
      direction,
      productId,
      requestId: decoded.value.requestId,
      payload: describeWireFrame(decoded.value.payload, decoded.value.payload.value),
    });
    // eslint-disable-next-line no-restricted-syntax -- this runs synchronously on the transport path and nanoevents does not isolate listener exceptions, so a debug listener must never be able to break message delivery.
  } catch {
    // Debug tap failures must not affect the transport.
  }
}

function wrapCoreProviderForDebug(connection: CoreConnection): CoreProviderBase {
  const { provider, productId } = connection;
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;
  const unsubscribeCore = provider.subscribe(message => {
    if (disposed) {
      return;
    }
    emitWireFrameDebug('outgoing', productId, message);
    for (const listener of [...listeners]) {
      listener(message);
    }
  });

  return {
    postMessage(message: Uint8Array): void {
      if (disposed) {
        return;
      }
      emitWireFrameDebug('incoming', productId, message);
      provider.postMessage(message);
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    subscribeClose(callback) {
      return provider.subscribeClose?.(callback) ?? noop;
    },
    getPermissionAuthorizationStatus(request) {
      return provider.getPermissionAuthorizationStatus(request);
    },
    getPermissionAuthorizationStatuses(requests) {
      return provider.getPermissionAuthorizationStatuses(requests);
    },
    setPermissionAuthorizationStatus(request, status) {
      return provider.setPermissionAuthorizationStatus(request, status);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeCore();
      listeners.clear();
      connection.close();
    },
  };
}

let topbarLoginRequestSeq = 0;

export function requestCoreLogin(core: Provider, reason?: string): Promise<LoginResponse> {
  const requestId = `dotli:topbar-login:${String(++topbarLoginRequestSeq)}`;
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
  const frame = encodeWireMessage({
    requestId,
    payload: {
      traitId: ACCOUNT_REQUEST_LOGIN.trait,
      methodId: ACCOUNT_REQUEST_LOGIN.method,
      messageType: MESSAGE_TYPE_REQUEST,
      value: VersionedHostRequestLoginRequest.enc({
        tag: 'V1',
        value: reason === undefined ? {} : { reason },
      }),
    },
  });
  if (frame.isErr()) {
    return Promise.reject(frame.error);
  }

  return new Promise<LoginResponse>((resolve, reject) => {
    let settled = false;
    let cleanupRequested = false;
    let unsubscribeMessage: (() => void) | undefined;
    let unsubscribeClose: (() => void) | undefined;
    const cleanup = (): void => {
      cleanupRequested = true;
      unsubscribeMessage?.();
      unsubscribeMessage = undefined;
      unsubscribeClose?.();
      unsubscribeClose = undefined;
    };
    const registerCleanup = (
      unsubscribe: (() => void) | undefined,
      retain: (value: (() => void) | undefined) => void,
    ): void => {
      if (cleanupRequested) {
        unsubscribe?.();
      } else {
        retain(unsubscribe);
      }
    };
    const rejectRequest = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveRequest = (response: LoginResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };

    registerCleanup(
      core.subscribe(message => {
        const decoded = decodeWireMessage(message);
        if (decoded.isErr()) {
          rejectRequest(decoded.error);
          return;
        }
        const { payload } = decoded.value;
        if (
          decoded.value.requestId !== requestId ||
          payload.traitId !== ACCOUNT_REQUEST_LOGIN.trait ||
          payload.methodId !== ACCOUNT_REQUEST_LOGIN.method ||
          payload.messageType !== MESSAGE_TYPE_RESPONSE
        ) {
          return;
        }
        cleanup();
        try {
          const result = responseCodec.dec(payload.value);
          if (result.success) {
            resolveRequest(result.value.value);
          } else {
            const error = new LoginRequestError(result.value);
            rejectRequest(error);
          }
        } catch (error) {
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
        }
      }),
      unsubscribe => {
        unsubscribeMessage = unsubscribe;
      },
    );

    registerCleanup(
      core.subscribeClose?.(error => {
        rejectRequest(error);
      }),
      unsubscribe => {
        unsubscribeClose = unsubscribe;
      },
    );

    try {
      core.postMessage(frame.value);
    } catch (error) {
      rejectRequest(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function createHost(args: {
  iframeUrl: string;
  allowedOrigin: string;
  sandbox: string;
  label: string;
  productId?: string | undefined;
  container: HTMLElement;
  debugFlowId: string;
}): Promise<ActiveHost> {
  const lease = await acquireCore();
  let connection: CoreConnection;
  let chatCapable: boolean;
  try {
    // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
    chatCapable = await chatCapabilityFor(args.label);
    log.event('chat capability resolved', { flow: 'chat', capable: chatCapable });
    connection = await lease.connect(chatCapable ? 'Worker' : 'App');
    log.event('product connected to wallet core', { flow: 'wallet', kind: chatCapable ? 'Worker' : 'App' });
  } catch (error) {
    lease.release();
    throw error;
  }
  const coreProvider = wrapCoreProviderForDebug(connection);
  const unregisterChat = chatCapable ? registerProductChat(connection) : noop;
  const unregisterPermissions = registerPermissionAuthorizationProvider(args.label, coreProvider);
  const { createIframeHost } = await runtimeChunkPromise;
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  const pipeArgs = {
    flowId: args.debugFlowId,
    label: args.label,
    productId: connection.productId,
  };
  const cleanupProductSide = (): void => {
    disposePipe?.();
    productProvider?.dispose();
    disposePipe = null;
    productProvider = null;
  };
  const cleanupCoreSide = (): void => {
    unregisterPermissions();
    unregisterChat();
    cleanupProductSide();
    coreProvider.dispose();
    lease.release();
  };
  try {
    const allow = `${await buildAllowAttribute(args.label)}; cross-origin-isolated`;
    const host = createIframeHost({
      iframeUrl: args.iframeUrl,
      allowedOrigin: args.allowedOrigin,
      allow,
      sandbox: args.sandbox,
      container: args.container,
      onPort: port => {
        productProvider = createMessagePortProvider(port);
        disposePipe = pipeProviders(productProvider, coreProvider, pipeArgs);
      },
    });

    return {
      iframe: host.iframe,
      dispose() {
        cleanupCoreSide();
        host.dispose();
      },
    };
  } catch (error) {
    cleanupCoreSide();
    throw error;
  }
}

function registerProductChat({ provider, productId }: CoreConnection): () => void {
  return registerChatConnection(productId, {
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

export async function renderIframe(
  url: string,
  label: string,
  options: { productId?: string | undefined } = {},
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId('render');
  const bridgeFlowId = newFlowId('bridge');
  const productId = options.productId ?? label;
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_begin',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: 'iframe' },
  });
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Keep the current product visible while its replacement connects, which can take seconds.
  const previousHost = currentHost;
  if (previousHost === null) {
    // This path has no loading overlay to keep.
    disposeAppRoots();
    app.innerHTML = '';
  }
  setPageProduct({ label, productId: options.productId });

  currentProduct = {
    mode: 'iframe',
    label,
    url,
    productId: options.productId,
  };

  const iframeUrl = new URL(url, window.location.href);
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_begin',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  const host = await createHost({
    iframeUrl: iframeUrl.href,
    allowedOrigin: iframeUrl.origin,
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
    label,
    productId: options.productId,
    container: app,
    debugFlowId: bridgeFlowId,
  });
  if (myRenderGeneration !== renderGeneration) {
    host.dispose();
    stopSetup();
    return;
  }
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_ready',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  applyIframeStyling(host.iframe);
  activateHost(host, previousHost);
  host.iframe.addEventListener(
    'load',
    () => {
      emitDotliDebugEvent({
        layer: 'bridge',
        event: 'iframe_load',
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId, mode: 'iframe' },
      });
    },
    { once: true },
  );

  if (import.meta.env.VITE_SANDBOX_CHECKER !== undefined) {
    const { mountViolationPanel } = await import('./components/sandbox-checker/mount.js');
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = mountViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = `${label} · dot.li`;

  // The runtime productId, so chat data is keyed like storage when the debug path overrides it.
  setProductLoaded(label, options.productId ?? labelToProductId(label));
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_ready',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: 'iframe' },
  });
}

/** Only the app subdomain joins the TrUAPI channel. Any nested iframe it loads is opaque to the host. */
export async function renderAppSubdomain(cid: string, label: string): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId('render');
  const bridgeFlowId = newFlowId('bridge');
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Keep the current product visible until its replacement connects.
  const previousHost = currentHost;
  setPageProduct({ label });

  currentProduct = {
    mode: 'subdomain',
    label,
    cid,
  };

  // The sandbox validator rejects unknown params.
  const chainBackend = getBackend();
  const network = getNetwork();
  const appOrigin = getAppOrigin(label);
  const deepPath = getDeepPath();
  // One-shot, so later navigations such as a permission reload do not reset again.
  let fullReset = false;
  try {
    if (sessionStorage.getItem('dotli:pending-reset:sandbox') === '1') {
      fullReset = true;
      sessionStorage.removeItem('dotli:pending-reset:sandbox');
    }
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, so the reset flag defaults to false which is the safe state.
  } catch {
    // No pending reset.
  }
  const parsedUrl = new URL(deepPath ? `${appOrigin}${deepPath}` : appOrigin);
  if (parsedUrl.origin !== appOrigin) {
    throw new Error(ERRORS.CROSS_ORIGIN_APP_URL);
  }
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.cid, cid);
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.v, String(SANDBOX_SCHEMA_VERSION));
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.chainBackend, chainBackend);
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.network, network);
  if (fullReset) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, '1');
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.resolutionId, resolutionId);
  }
  const url = parsedUrl.toString();

  // On the initial render the sandbox dismisses the overlay itself, with `dotli:loading-status`.
  const keepLoading = previousHost === null;

  const iframeUrl = new URL(url);
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_begin',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_begin',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: 'subdomain' },
  });
  const host = await createHost({
    iframeUrl: url,
    allowedOrigin: iframeUrl.origin,
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups',
    label,
    container: app,
    debugFlowId: bridgeFlowId,
  });
  if (myRenderGeneration !== renderGeneration) {
    host.dispose();
    stopSetup();
    return;
  }
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_ready',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  applyIframeStyling(host.iframe);
  activateHost(host, previousHost, keepLoading);
  host.iframe.addEventListener(
    'load',
    () => {
      emitDotliDebugEvent({
        layer: 'bridge',
        event: 'iframe_load',
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId: label, mode: 'subdomain' },
      });
    },
    { once: true },
  );

  if (import.meta.env.VITE_SANDBOX_CHECKER !== undefined) {
    const { mountViolationPanel } = await import('./components/sandbox-checker/mount.js');
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = mountViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = withActiveTld(label);

  setProductLoaded(label, labelToProductId(label), cid);
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_ready',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: 'subdomain' },
  });
}

function getAppOrigin(label: string): string {
  const hostname = window.location.hostname;
  if (hostname.endsWith('.localhost') || hostname === 'localhost') {
    const port = import.meta.env.DEV ? DEV_SANDBOX_PORT : window.location.port;
    return `http://${label}.app.localhost:${port}`;
  }
  return `https://${label}.app.${BASE_DOMAIN}`;
}

function activateHost(host: ActiveHost, previousHost: ActiveHost | null, keepLoading = false): void {
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  previousHost?.dispose();
  disposeAppRoot('page');
  if (!keepLoading) {
    disposeAppRoot('loading');
  }
  // An error page written after an earlier `activateHost` is the one untracked child a rebuild must clear.
  for (const stray of app.querySelectorAll(':scope > [data-error-page]')) {
    stray.remove();
  }
  currentHost = host;
}

function newFlowId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}
