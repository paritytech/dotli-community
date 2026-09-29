// dot.li TrUAPI host bridge
//
// Boots a WASM TrUAPI core instance and connects it to a sandboxed
// product iframe via `@parity/truapi-host`. Each render swaps the running
// runtime, so disposing the last host tears down both the iframe and
// the core.
//
// Nested dApp-in-dApp composition is not modeled as separate Rust runtimes,
// sessions, product identities, or storage namespaces. Any future nested
// traffic must share the top-level core/provider context.

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
} from "@parity/truapi";
import { ACCOUNT_REQUEST_LOGIN } from "@parity/truapi/wire-table";
import {
  BASE_DOMAIN,
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
  getBackend,
  getNetwork,
  withActiveTld,
} from "@dotli/config";

import { getResolutionId, m, spans as S } from "@dotli/metrics";
import { chatCapabilityFor, log } from "@dotli/shared";

import {
  emitDotliDebugEvent,
  hasDotliDebugListeners,
} from "@dotli/truapi-debug";
import type { TrUApiProductProvider } from "@parity/truapi-host";
import type { PairingHostAdmin } from "@parity/truapi-host";
import {
  buildAllowAttribute,
  registerPermissionAuthorizationProvider,
} from "./permissions.js";
import { createHostCallbacks } from "./host-callbacks/handlers.js";
import { dispatchAuthState } from "./host-callbacks/AuthState.js";
import { onStoredSessionChanged } from "./host-callbacks/SessionStore.js";
import { LoginRequestError } from "./login-request-error.js";
import { attachProductFrame } from "./product-frame-layout.js";
import {
  createTruapiRuntimeConfig,
  labelToProductId,
} from "./runtime-config.js";
import { setProductLoaded } from "./state/product.js";
import { describeWireFrame } from "./debug-wire-describe.js";
import type { BlockingModalCoordinator } from "./blocking-modal-queue.js";
import { registerChatConnection } from "./chat/service.js";
import { showNotification } from "./notification.js";
import { ERRORS } from "./errors.js";
import { disposeAppRoot, disposeAppRoots } from "./mount/app-roots.js";

const noop = (): void => undefined;

// Eagerly load the iframe host chunk and the worker constructor so they're
// ready by the time we need them. The wasm core lives inside the worker. The host
// shell only owns the postMessage bridge, keeping smoldot's CPU off the
// main thread (no more `[Violation] 'message' handler took 150ms+`).
const chunkLoadStart = performance.now();
const runtimeChunkPromise = Promise.all([
  import("@parity/truapi-host/web"),
  import("@parity/truapi-host/worker-runtime?worker"),
]).then(([web, workerMod]) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return {
    createWebWorkerPairingHostRuntime: web.createWebWorkerPairingHostRuntime,
    createIframeHost: web.createIframeHost,
    HostWorker: workerMod.default,
  };
});
void runtimeChunkPromise.catch(() => {
  /* fire-and-forget */
});

const app = document.getElementById("app") ?? document.body;

interface ActiveHost {
  iframe: HTMLIFrameElement;
  requestLogin: (reason?: string) => Promise<LoginResponse>;
  cancelLogin: () => void;
  disconnect: () => Promise<void>;
  dispose: () => void;
}

interface CoreHost {
  requestLogin: (reason?: string) => Promise<LoginResponse>;
  cancelLogin: () => void;
  disconnect: () => Promise<void>;
  dispose: () => void;
}

type CoreProviderBase = Provider &
  Pick<
    TrUApiProductProvider,
    | "disconnectSession"
    | "getPermissionAuthorizationStatus"
    | "getPermissionAuthorizationStatuses"
    | "setPermissionAuthorizationStatus"
  >;
type CoreProvider = CoreProviderBase & PairingHostAdmin;
type PairingRuntimeControls = PairingHostAdmin & {
  dispose(): void;
};
type CurrentProduct =
  | {
      mode: "iframe";
      label: string;
      url: string;
      productId?: string | undefined;
    }
  | {
      mode: "subdomain";
      label: string;
      cid: string;
    };

const LANDING_AUTH_LABEL = "dotli";
const LANDING_AUTH_DISPLAY_LABEL = "Polkadot Web";

let currentHost: ActiveHost | null = null;
let landingAuthHostPromise: Promise<CoreHost> | null = null;
let landingAuthGeneration = 0;
let currentPanelDispose: (() => void) | null = null;
let currentProduct: CurrentProduct | null = null;
let renderGeneration = 0;
const liveCoreProviders = new Set<CoreProvider>();
let unsubscribeSessionStoreChanges: (() => void) | null = null;
let blockingModalCoordinator: BlockingModalCoordinator | null = null;

function ensureStoredSessionForwarder(): void {
  if (unsubscribeSessionStoreChanges !== null) {
    return;
  }
  unsubscribeSessionStoreChanges = onStoredSessionChanged(() => {
    notifyLiveCoreProvidersSessionStoreChanged();
  });
}

function trackCoreProvider(
  provider: CoreProviderBase,
  pairing: PairingRuntimeControls,
  disposeModalScope: () => void,
): CoreProvider {
  const tracked: CoreProvider = {
    postMessage(message: Uint8Array): void {
      provider.postMessage(message);
    },
    subscribe(callback) {
      return provider.subscribe(callback);
    },
    subscribeClose(callback) {
      return provider.subscribeClose?.(callback) ?? noop;
    },
    async disconnectSession() {
      await provider.disconnectSession();
    },
    cancelPairing() {
      pairing.cancelPairing();
    },
    notifySessionStoreChanged() {
      pairing.notifySessionStoreChanged();
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
      disposeModalScope();
      provider.dispose();
      pairing.dispose();
    },
  };
  liveCoreProviders.add(tracked);
  ensureStoredSessionForwarder();
  let disposed = false;
  queueMicrotask(() => {
    if (!disposed) {
      tracked.notifySessionStoreChanged();
    }
  });
  return {
    postMessage(message: Uint8Array): void {
      tracked.postMessage(message);
    },
    subscribe(callback) {
      return tracked.subscribe(callback);
    },
    subscribeClose(callback) {
      return tracked.subscribeClose?.(callback) ?? noop;
    },
    async disconnectSession() {
      await tracked.disconnectSession();
    },
    cancelPairing() {
      tracked.cancelPairing();
    },
    notifySessionStoreChanged() {
      tracked.notifySessionStoreChanged();
    },
    getPermissionAuthorizationStatus(request) {
      return tracked.getPermissionAuthorizationStatus(request);
    },
    getPermissionAuthorizationStatuses(requests) {
      return tracked.getPermissionAuthorizationStatuses(requests);
    },
    setPermissionAuthorizationStatus(request, status) {
      return tracked.setPermissionAuthorizationStatus(request, status);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      liveCoreProviders.delete(tracked);
      if (
        liveCoreProviders.size === 0 &&
        unsubscribeSessionStoreChanges !== null
      ) {
        unsubscribeSessionStoreChanges();
        unsubscribeSessionStoreChanges = null;
      }
      tracked.dispose();
    },
  };
}

function notifyLiveCoreProvidersSessionStoreChanged(): void {
  for (const provider of [...liveCoreProviders]) {
    provider.notifySessionStoreChanged();
  }
}

function rerenderProduct(product: CurrentProduct): void {
  const expectedGeneration = renderGeneration + 1;
  const render =
    product.mode === "iframe"
      ? renderIframe(product.url, product.label, {
          productId: product.productId,
        })
      : renderAppSubdomain(product.cid, product.label);
  void render.catch((error: unknown) => {
    // A newer render superseded this one, so its result owns the UI now.
    if (renderGeneration !== expectedGeneration) {
      return;
    }
    log.error("[dot.li] Product iframe reload failed:", error);
    showNotification({
      label: "dot.li",
      text: "The app could not be reloaded.",
      browserNotification: false,
      dismissMs: 0,
      action: {
        label: "Reload",
        onClick: () => {
          window.location.reload();
        },
      },
    });
  });
}

// Listen for device permission grants. Reload the iframe so the updated
// `allow` attribute takes effect. Keep the current iframe visible and surface
// a retry if replacement host startup fails.
window.addEventListener("dotli:device-permission-changed", () => {
  const product = currentProduct;
  if (product !== null) {
    rerenderProduct(product);
  }
});

// The sandbox strips its contract params after a successful boot, so a
// reload of the sandbox window (a dApp calling `location.reload()`, a
// browser restoring a crashed frame) boots without `?cid=` and cannot
// recover on its own. It posts a recover request and the host rebuilds
// the iframe from the tracked product state. The origin gate restricts
// the request to the product currently rendered. The interval guard stops
// a reload-looping product from pinning the host in endless re-renders.
// A rate-limited sandbox shows its own contract error once its
// `TIMEOUTS.SANDBOX_RECOVER` grace expires.
const RECOVER_MIN_INTERVAL_MS = 5_000;
let lastRecoverAt = 0;
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  if (
    data === null ||
    typeof data !== "object" ||
    data["type"] !== "dotli:sandbox-recover"
  ) {
    return;
  }
  const product = currentProduct;
  if (
    product?.mode !== "subdomain" ||
    event.origin !== getAppOrigin(product.label)
  ) {
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

export function initBridgeEventListeners(
  modalCoordinator: BlockingModalCoordinator,
): void {
  if (bridgeEventListenersInitialized) {
    return;
  }
  blockingModalCoordinator = modalCoordinator;
  bridgeEventListenersInitialized = true;
  (
    window as typeof window & { __dotliTruapiBridgeReady?: boolean }
  ).__dotliTruapiBridgeReady = true;
  window.addEventListener("dotli:truapi-disconnect-request", () => {
    void disconnectTruapiHosts();
  });

  // User closed the pairing modal: cancel whichever core initiated it. A
  // product can request login directly, while the topbar uses the landing
  // auth host.
  window.addEventListener("dotli:truapi-cancel-login", () => {
    currentHost?.cancelLogin();
    void landingAuthHostPromise?.then(
      (host) => {
        host.cancelLogin();
      },
      () => {
        /* a failed pending host has no login to cancel */
      },
    );
  });

  window.addEventListener("dotli:truapi-login-request", (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    void (async () => {
      const host = await getLandingAuthHost();
      const result = await host.requestLogin(detail.reason);
      if (result === "Success" || result === "AlreadyConnected") {
        notifyLiveCoreProvidersSessionStoreChanged();
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // A `LoginRequestError` came back over the wire, so the core already
      // rendered its own `LoginFailed` (or deliberately stayed silent, e.g.
      // a second login while one is pairing). Synthesize a state only for
      // failures the core never saw: host boot, encode, transport errors.
      if (!(error instanceof LoginRequestError)) {
        dispatchAuthState({
          tag: "LoginFailed",
          kind: "Other",
          reason: message,
        });
      }
    });
  });
}

async function disconnectTruapiHosts(): Promise<void> {
  const hosts = new Set<CoreHost | ActiveHost>();
  if (currentHost !== null) {
    hosts.add(currentHost);
  }
  if (landingAuthHostPromise !== null) {
    try {
      hosts.add(await landingAuthHostPromise);
    } catch (err) {
      log.warn("[dot.li] pending login host cleanup failed:", err);
    }
  }

  if (hosts.size === 0) {
    try {
      hosts.add(await getLandingAuthHost());
    } catch {
      // If the auth runtime cannot boot, keep the UI responsive even though
      // persisted core session state could not be cleared.
      dispatchAuthState({ tag: "Disconnected" });
      return;
    }
  }
  await Promise.allSettled([...hosts].map((host) => host.disconnect()));
}

/**
 * Capture the deep link path, meaning pathname, search and hash, to forward
 * into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== "/" && p.startsWith(base)) {
    p = "/" + p.slice(base.length);
  }
  const isRoot = p === "" || p === "/";
  if (isRoot) {
    return search || hash ? search + hash : "";
  }
  return p + search + hash;
}

/**
 * Pin the product iframe to the area the host chrome and the insets leave.
 * product-frame-layout owns its geometry from here on.
 */
function applyIframeStyling(iframe: HTMLIFrameElement): void {
  attachProductFrame(iframe);
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
}

function pipeProviders(
  product: Provider,
  core: Provider,
  args: { flowId: string; label: string; productId: string },
): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  const unsubs = [
    product.subscribe((message) => {
      if (!sawInbound) {
        sawInbound = true;
        emitDotliDebugEvent({
          layer: "bridge",
          event: "first_inbound",
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
      }
      core.postMessage(message);
    }),
    core.subscribe((message) => {
      if (!sawOutbound) {
        sawOutbound = true;
        emitDotliDebugEvent({
          layer: "bridge",
          event: "first_outbound",
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
        window.dispatchEvent(new Event("dotli:debug:bridge-ready"));
      }
      product.postMessage(message);
    }),
    product.subscribeClose?.(() => {
      core.dispose();
    }),
    core.subscribeClose?.(() => {
      product.dispose();
    }),
  ].filter((fn): fn is () => void => typeof fn === "function");

  return () => {
    for (const unsub of unsubs) {
      try {
        unsub();
        // eslint-disable-next-line no-restricted-syntax -- provider teardown is best-effort. Stale MessagePorts can already be closed while the next cleanup still must run.
      } catch {
        /* ignore teardown races */
      }
    }
  };
}

function emitWireFrameDebug(
  direction: "incoming" | "outgoing",
  productId: string,
  message: Uint8Array,
): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  try {
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return;
    }
    emitDotliDebugEvent({
      kind: "truapi",
      direction,
      productId,
      requestId: decoded.value.requestId,
      payload: describeWireFrame(
        decoded.value.payload,
        decoded.value.payload.value,
      ),
    });
    // eslint-disable-next-line no-restricted-syntax -- this runs synchronously on the transport path and nanoevents does not isolate listener exceptions, so a debug listener must never be able to break message delivery.
  } catch {
    /* ignore, debug tap failures must not affect the transport */
  }
}

function wrapCoreProviderForDebug(
  provider: CoreProviderBase,
  productId: string,
): CoreProviderBase {
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;
  const unsubscribeCore = provider.subscribe((message) => {
    if (disposed) {
      return;
    }
    emitWireFrameDebug("outgoing", productId, message);
    for (const listener of [...listeners]) {
      listener(message);
    }
  });

  return {
    postMessage(message: Uint8Array): void {
      if (disposed) {
        return;
      }
      emitWireFrameDebug("incoming", productId, message);
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
    async disconnectSession() {
      await provider.disconnectSession();
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
      provider.dispose();
    },
  };
}

let topbarLoginRequestSeq = 0;

export function requestCoreLogin(
  core: Provider,
  reason?: string,
): Promise<LoginResponse> {
  const requestId = `dotli:topbar-login:${String(++topbarLoginRequestSeq)}`;
  // Codec 2 legs carry Result outside and the version wrapper inside.
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
        tag: "V1",
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
      core.subscribe((message) => {
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
          rejectRequest(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }),
      (unsubscribe) => {
        unsubscribeMessage = unsubscribe;
      },
    );

    registerCleanup(
      core.subscribeClose?.((error) => {
        rejectRequest(error);
      }),
      (unsubscribe) => {
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
  const coreProvider = await createCoreProvider(args.label, {
    productId: args.productId,
  });
  const unregisterPermissions = registerPermissionAuthorizationProvider(
    args.label,
    coreProvider,
  );
  const { createIframeHost } = await runtimeChunkPromise;
  const productId = args.productId ?? labelToProductId(args.label);
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  const pipeArgs = {
    flowId: args.debugFlowId,
    label: args.label,
    productId,
  };
  const cleanupProductSide = (): void => {
    disposePipe?.();
    productProvider?.dispose();
    disposePipe = null;
    productProvider = null;
  };
  try {
    const allow = `${await buildAllowAttribute(args.label)}; cross-origin-isolated`;
    const host = createIframeHost({
      iframeUrl: args.iframeUrl,
      allowedOrigin: args.allowedOrigin,
      allow,
      sandbox: args.sandbox,
      container: args.container,
      onPort: (port) => {
        productProvider = createMessagePortProvider(port);
        disposePipe = pipeProviders(productProvider, coreProvider, pipeArgs);
      },
    });

    return {
      iframe: host.iframe,
      requestLogin(reason) {
        return requestCoreLogin(coreProvider, reason);
      },
      cancelLogin() {
        coreProvider.cancelPairing();
      },
      disconnect() {
        return coreProvider.disconnectSession();
      },
      dispose() {
        unregisterPermissions();
        cleanupProductSide();
        coreProvider.dispose();
        host.dispose();
      },
    };
  } catch (error) {
    unregisterPermissions();
    cleanupProductSide();
    coreProvider.dispose();
    throw error;
  }
}

async function createCoreProvider(
  label: string,
  options: {
    pairingLabel?: string | undefined;
    pairingDotSuffix?: boolean | undefined;
    pairingHostGlobal?: boolean | undefined;
    productId?: string | undefined;
  } = {},
): Promise<CoreProvider> {
  if (blockingModalCoordinator === null) {
    throw new Error(
      "TrUAPI bridge initialized without a blocking modal coordinator",
    );
  }
  const blockingModalScope = blockingModalCoordinator.createScope();
  try {
    const { createWebWorkerPairingHostRuntime, HostWorker } =
      await runtimeChunkPromise;
    const runtimeConfig = createTruapiRuntimeConfig(label, options.productId);
    const { productId, ...hostConfig } = runtimeConfig;
    // Chat-capable products get a Worker-kind execution so the core serves
    // their chat calls; everything an App connection can do still works.
    // The capability is primed by the host shell before rendering, so
    // this await settles from cache or the in-flight manifest read.
    const chatCapable = await chatCapabilityFor(label);
    const runtime = await createWebWorkerPairingHostRuntime(
      new HostWorker(),
      createHostCallbacks({
        label,
        pairingLabel: options.pairingLabel,
        pairingDotSuffix: options.pairingDotSuffix,
        pairingHostGlobal: options.pairingHostGlobal,
        blockingModalScope,
      }),
      {
        hostConfig,
      },
    );
    const provider = await runtime.createProvider({
      productId,
      executionKind: chatCapable ? "Worker" : "App",
    });
    const unregisterChat = chatCapable
      ? registerChatConnection(productId, {
          publish: (action) =>
            provider.publishChatAction === undefined
              ? Promise.reject(new Error("chat publishing unavailable"))
              : provider.publishChatAction(action),
          publishRendererAction: (item) =>
            provider.publishRendererAction === undefined
              ? Promise.reject(new Error("renderer actions unavailable"))
              : provider.publishRendererAction(item),
          render: (request, sink) => {
            if (provider.render === undefined) {
              sink.onError?.(new Error("rendering unavailable"));
              return noop;
            }
            return provider.render(request, sink);
          },
        })
      : noop;
    return trackCoreProvider(
      wrapCoreProviderForDebug(provider, options.productId ?? label),
      runtime,
      () => {
        unregisterChat();
        blockingModalScope.dispose();
      },
    );
  } catch (error) {
    blockingModalScope.dispose();
    throw error;
  }
}

async function getLandingAuthHost(): Promise<CoreHost> {
  if (landingAuthHostPromise !== null) {
    return landingAuthHostPromise;
  }
  const generation = landingAuthGeneration;
  const promise = createLandingAuthHost()
    .then((host) => {
      if (
        generation !== landingAuthGeneration ||
        landingAuthHostPromise !== promise
      ) {
        host.dispose();
        throw new Error(
          "Landing auth host was disposed before it became ready",
        );
      }
      return host;
    })
    .catch((error: unknown) => {
      if (landingAuthHostPromise === promise) {
        landingAuthHostPromise = null;
      }
      throw error;
    });
  landingAuthHostPromise = promise;
  return promise;
}

async function createLandingAuthHost(): Promise<CoreHost> {
  const coreProvider = await createCoreProvider(LANDING_AUTH_LABEL, {
    pairingLabel: LANDING_AUTH_DISPLAY_LABEL,
    pairingDotSuffix: false,
    pairingHostGlobal: true,
  });
  return {
    requestLogin(reason) {
      return requestCoreLogin(coreProvider, reason);
    },
    cancelLogin() {
      coreProvider.cancelPairing();
    },
    disconnect() {
      return coreProvider.disconnectSession();
    },
    dispose() {
      coreProvider.dispose();
    },
  };
}

function disposeLandingAuthHost(): void {
  landingAuthGeneration++;
  const pending = landingAuthHostPromise;
  landingAuthHostPromise = null;
  void pending?.then(
    (host) => {
      host.dispose();
    },
    () => {
      /* failed pending host has nothing to dispose */
    },
  );
}

/**
 * Render a dApp iframe backed by the TrUAPI host bridge.
 */
export async function renderIframe(
  url: string,
  label: string,
  options: { productId?: string | undefined } = {},
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  const productId = options.productId ?? label;
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_begin",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: "iframe" },
  });
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Keep the current product visible while the replacement core initializes.
  // Core startup can take several seconds. Removing the old iframe first made
  // permission-triggered reloads look like a permanently blank application.
  const previousHost = currentHost;
  if (previousHost === null) {
    // This path has no loading overlay to keep, so the tracked roots go first
    // and whatever else the page left in `#app` goes with them.
    disposeAppRoots();
    app.innerHTML = "";
  }
  disposeLandingAuthHost();

  currentProduct = {
    mode: "iframe",
    label,
    url,
    productId: options.productId,
  };

  const iframeUrl = new URL(url, window.location.href);
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  const host = await createHost({
    iframeUrl: iframeUrl.href,
    allowedOrigin: iframeUrl.origin,
    // Keep parity with the current dotli product sandbox permissions.
    sandbox: "allow-scripts allow-same-origin allow-forms allow-pointer-lock",
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
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  applyIframeStyling(host.iframe);
  activateHost(host, previousHost);
  host.iframe.addEventListener(
    "load",
    () => {
      emitDotliDebugEvent({
        layer: "bridge",
        event: "iframe_load",
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId, mode: "iframe" },
      });
    },
    { once: true },
  );

  if (import.meta.env.VITE_SANDBOX_CHECKER !== undefined) {
    const { mountViolationPanel } =
      await import("./components/sandbox-checker/mount.js");
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = mountViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = `${label} · dot.li`;

  // Carry the runtime productId so listeners key chat data the same way
  // storage does when the debug path overrides the label-derived id.
  setProductLoaded(label, options.productId ?? labelToProductId(label));
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_ready",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: "iframe" },
  });
}

/**
 * Render content in a cross-origin app subdomain iframe (cid.app.dot.li).
 * Used by the host build to delegate content fetching+rendering to the app context.
 *
 * The app context acts as a transparent relay between the host and the dApp
 * iframe. Only the app subdomain itself participates in the TrUAPI
 * MessageChannel. Any nested dApp iframe it loads is opaque to the host.
 */
export async function renderAppSubdomain(
  cid: string,
  label: string,
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Permission changes rebuild this host so the iframe receives a refreshed
  // `allow` attribute. Keep the current product visible until its replacement
  // core and iframe are ready, just like the direct-iframe render path.
  const previousHost = currentHost;
  disposeLandingAuthHost();

  currentProduct = {
    mode: "subdomain",
    label,
    cid,
  };

  // Propagate the current sandbox contract. The `?mode=` preset param is no
  // longer sent. Host and sandbox deploy together, and the sandbox validator
  // rejects unknown params.
  const chainBackend = getBackend();
  const network = getNetwork();
  const appOrigin = getAppOrigin(label);
  const deepPath = getDeepPath();
  // One-shot: the settings popover sets this flag right before reloading so
  // the first sandbox boot after "Save & Apply" wipes its own origin too.
  // Consume and clear so subsequent navigations (permission reload, etc.)
  // don't keep triggering resets.
  let fullReset = false;
  try {
    if (sessionStorage.getItem("dotli:pending-reset:sandbox") === "1") {
      fullReset = true;
      sessionStorage.removeItem("dotli:pending-reset:sandbox");
    }
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, so the reset flag defaults to false which is the safe state.
  } catch {
    /* sessionStorage unavailable, skip pending reset */
  }
  const parsedUrl = new URL(deepPath ? `${appOrigin}${deepPath}` : appOrigin);
  if (parsedUrl.origin !== appOrigin) {
    throw new Error(ERRORS.CROSS_ORIGIN_APP_URL);
  }
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.cid, cid);
  parsedUrl.searchParams.set(
    SANDBOX_CONTRACT_PARAMS.v,
    String(SANDBOX_SCHEMA_VERSION),
  );
  parsedUrl.searchParams.set(
    SANDBOX_CONTRACT_PARAMS.chainBackend,
    chainBackend,
  );
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.network, network);
  if (fullReset) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, "1");
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    parsedUrl.searchParams.set(
      SANDBOX_CONTRACT_PARAMS.resolutionId,
      resolutionId,
    );
  }
  const url = parsedUrl.toString();

  // Keep the loading overlay visible. The sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only on the initial render: `activateHost` keeps it as a retained child.
  // During a permission refresh the current iframe remains visible until the
  // replacement is ready, and the overlay, if still up, is disposed then.
  const loading =
    previousHost === null ? app.querySelector<HTMLElement>(".loading") : null;

  const iframeUrl = new URL(url);
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_begin",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: "subdomain" },
  });
  const host = await createHost({
    iframeUrl: url,
    allowedOrigin: iframeUrl.origin,
    sandbox:
      "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups",
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
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  applyIframeStyling(host.iframe);
  activateHost(host, previousHost, loading === null ? [] : [loading]);
  host.iframe.addEventListener(
    "load",
    () => {
      emitDotliDebugEvent({
        layer: "bridge",
        event: "iframe_load",
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId: label, mode: "subdomain" },
      });
    },
    { once: true },
  );

  if (import.meta.env.VITE_SANDBOX_CHECKER !== undefined) {
    const { mountViolationPanel } =
      await import("./components/sandbox-checker/mount.js");
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = mountViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = withActiveTld(label);

  setProductLoaded(label, labelToProductId(label));
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_ready",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: "subdomain" },
  });
}

function getAppOrigin(label: string): string {
  const hostname = window.location.hostname;
  if (hostname.endsWith(".localhost") || hostname === "localhost") {
    const port = import.meta.env.DEV ? "5174" : window.location.port;
    return `http://${label}.app.localhost:${port}`;
  }
  return `https://${label}.app.${BASE_DOMAIN}`;
}

function activateHost(
  host: ActiveHost,
  previousHost: ActiveHost | null,
  retainedChildren: readonly HTMLElement[] = [],
): void {
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  // The previous frame leaves with its host.
  previousHost?.dispose();
  disposeAppRoot("page");
  if (!retainedChildren.some((child) => child.classList.contains("loading"))) {
    disposeAppRoot("loading");
  }
  // The one untracked child: an error page written over a product whose frame
  // was already up (a failure after `activateHost`), which a later rebuild of
  // that product has to clear.
  for (const stray of app.querySelectorAll(":scope > .error-page")) {
    stray.remove();
  }
  currentHost = host;
}

function newFlowId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}
