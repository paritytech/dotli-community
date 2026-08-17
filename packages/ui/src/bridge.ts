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
  HostRequestLoginResponse,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginRequest,
  type HostRequestLoginResponse as LoginResponse,
  type WireProvider as Provider,
  createMessagePortProvider,
} from "@parity/truapi";
import { ACCOUNT_REQUEST_LOGIN } from "@parity/truapi/wire-table";
import { BASE_DOMAIN } from "@dotli/config/config";
import {
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
} from "@dotli/config/host-sandbox-contract";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import { getNetwork, withActiveTld } from "@dotli/config/network";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { log } from "@dotli/shared/log";
import {
  emitDotliDebugEvent,
  hasDotliDebugListeners,
} from "@dotli/truapi-debug/dotli-debug-bus";
import type { TrUApiProductProvider } from "@parity/truapi-host";
import type { PairingHostAdmin } from "@parity/truapi-host";
import {
  buildAllowAttribute,
  registerPermissionAuthorizationProvider,
} from "./permissions";
import { createHostCallbacks } from "./host-callbacks/handlers";
import { dispatchAuthState } from "./host-callbacks/AuthState";
import { onStoredSessionChanged } from "./host-callbacks/SessionStore";
import { LoginRequestError } from "./login-request-error";
import { productIframeBox } from "./product-iframe-box";
import { createTruapiRuntimeConfig, labelToProductId } from "./runtime-config";
import { describeWireFrame } from "./debug-wire-describe";
// TODO(remove-legacy-nova): import used only by the legacy probe tagged below.
import {
  createLegacyNovaChainHeadProvider,
  createWindowMessageProvider,
} from "./legacy-host-bridge";
import type { BlockingModalCoordinator } from "./blocking-modal-queue";
import { showNotification } from "./notification";

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
      productId?: string;
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
    data.type !== "dotli:sandbox-recover"
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
        dispatchAuthState({ tag: "LoginFailed", reason: message });
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

/** Pin the product iframe to the area the host chrome and the insets leave. */
function applyIframeStyling(
  iframe: HTMLIFrameElement,
  opts: { topbarOffset: boolean },
): void {
  const box = productIframeBox(opts);
  iframe.style.cssText = `position:fixed;top:${box.top};left:${box.left};width:${box.width};height:${box.height};border:none;margin:0;padding:0;`;
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
        decoded.value.payload.id,
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
  const responseCodec = scale.indexedTaggedUnion({
    V1: [
      0,
      scale.Result(
        HostRequestLoginResponse,
        scale.CallError(VersionedHostRequestLoginError),
      ),
    ],
  });
  const frame = encodeWireMessage({
    requestId,
    payload: {
      id: ACCOUNT_REQUEST_LOGIN.request,
      value: VersionedHostRequestLoginRequest.enc({
        tag: "V1",
        value: { reason },
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
        if (
          decoded.value.requestId !== requestId ||
          decoded.value.payload.id !== ACCOUNT_REQUEST_LOGIN.response
        ) {
          return;
        }
        cleanup();
        try {
          const envelope = responseCodec.dec(decoded.value.payload.value);
          const result = envelope.value;
          if (result.success) {
            resolveRequest(result.value);
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
  productId?: string;
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
  // TODO(remove-legacy-nova): `legacyProbeCleanup` (including its two `?.()`
  // call sites in `dispose()` and the catch block below) exists only for the
  // legacy probe block tagged further down.
  let legacyProbeCleanup: (() => void) | null = null;
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

    // DEPRECATED legacy host-API support. Modern products announce themselves
    // with `{type:"truapi-ready"}` and use the MessagePort wired above. Products
    // still on the Nova host-api SDK instead post raw SCALE frames (Uint8Array)
    // to `window.parent`. Detect that first frame and re-pipe the core over a
    // window-postMessage provider.
    //
    // TODO(remove-legacy-nova): once the last legacy Nova product migrates to
    // `@parity/truapi`, delete this probe block (through the
    // `legacyProbeCleanup` assignment below), the `legacyProbeCleanup`
    // declaration and call sites tagged above, the `legacy-host-bridge`
    // import at the top of this file, and the tagged `legacy-host-bridge.ts`
    // module itself. Modern products need no probe: the MessagePort from
    // `onPort` is the only wiring.
    let probeMode: "pending" | "modern" | "legacy" = "pending";
    const onProbe = (event: MessageEvent): void => {
      if (probeMode !== "pending") {
        return;
      }
      const targetWindow = host.iframe.contentWindow;
      if (
        !targetWindow ||
        event.source !== targetWindow ||
        event.origin !== args.allowedOrigin
      ) {
        return;
      }
      if (event.data instanceof Uint8Array) {
        probeMode = "legacy";
        legacyProbeCleanup?.();
        // Drop the unused modern MessagePort pipe before rewiring.
        cleanupProductSide();
        const windowProvider = createWindowMessageProvider(
          targetWindow,
          args.allowedOrigin,
        );
        const legacyProvider = createLegacyNovaChainHeadProvider(
          windowProvider,
          productId,
        );
        productProvider = legacyProvider;
        disposePipe = pipeProviders(legacyProvider, coreProvider, pipeArgs);
        // Replay the handshake frame the probe just consumed.
        windowProvider.injectInbound(event.data);
      } else if (
        (event.data as { type?: unknown } | null)?.type === "truapi-ready"
      ) {
        probeMode = "modern";
        legacyProbeCleanup?.();
      }
    };
    window.addEventListener("message", onProbe);
    legacyProbeCleanup = () => {
      window.removeEventListener("message", onProbe);
      legacyProbeCleanup = null;
    };

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
        legacyProbeCleanup?.();
        cleanupProductSide();
        coreProvider.dispose();
        host.dispose();
      },
    };
  } catch (error) {
    unregisterPermissions();
    legacyProbeCleanup?.();
    cleanupProductSide();
    coreProvider.dispose();
    throw error;
  }
}

async function createCoreProvider(
  label: string,
  options: {
    pairingLabel?: string;
    pairingDotSuffix?: boolean;
    pairingHostGlobal?: boolean;
    productId?: string;
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
    const provider = await runtime.createProvider({ productId });
    return trackCoreProvider(
      wrapCoreProviderForDebug(provider, options.productId ?? label),
      runtime,
      () => {
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
  options: { productId?: string } = {},
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
    app.innerHTML = "";
  }
  disposeLandingAuthHost();

  currentProduct = {
    mode: "iframe",
    label,
    url,
    productId: options.productId,
  };

  const hasTopbar = document.getElementById("topbar") !== null;
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
  applyIframeStyling(host.iframe, { topbarOffset: hasTopbar });
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

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = setupViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = `${label} · dot.li`;

  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label } }),
  );
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
  const cache = getCacheSettings();
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
    throw new Error("Refusing to render an app URL outside its sandbox origin");
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
  if (cache.skipArchiveCache) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.skipArchiveCache, "1");
  }
  if (fullReset) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, "1");
  }
  const url = parsedUrl.toString();

  // Keep the loading overlay visible. The sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only prepare it on the initial render. During a permission refresh the
  // current iframe remains visible until the replacement is ready.
  const loading =
    previousHost === null ? app.querySelector<HTMLElement>(".loading") : null;
  if (previousHost === null) {
    app.innerHTML = "";
    if (loading) {
      app.appendChild(loading);
    }
  }

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
  applyIframeStyling(host.iframe, { topbarOffset: true });
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

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = setupViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = withActiveTld(label);

  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label } }),
  );
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
  previousHost?.dispose();
  const retained = new Set<HTMLElement>([host.iframe, ...retainedChildren]);
  for (const child of [...app.children]) {
    if (!retained.has(child as HTMLElement)) {
      child.remove();
    }
  }
  currentHost = host;
}

function newFlowId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}
