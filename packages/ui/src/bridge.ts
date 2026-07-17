// dot.li — TrUAPI host bridge
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
import { getNetwork } from "@dotli/config/network";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { log } from "@dotli/shared/log";
import { emitDotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-bus";
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
import { createTruapiRuntimeConfig } from "./runtime-config";
import {
  createLegacyNovaChainHeadProvider,
  createWindowMessageProvider,
} from "./legacy-host-bridge";

// DEPRECATED: enables the legacy Nova host-api transport shim for products that
// have not yet migrated to `@parity/truapi`. Remove once they have.
const noop = (): void => undefined;

// Eagerly load the iframe host chunk + worker constructor so they're ready
// by the time we need them. The wasm core lives inside the worker; the host
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

// Listen for device permission grants — reload the iframe so the
// updated `allow` attribute takes effect.
window.addEventListener("dotli:device-permission-changed", () => {
  const product = currentProduct;
  if (product?.mode === "iframe") {
    void renderIframe(product.url, product.label, {
      productId: product.productId,
    });
  } else if (product?.mode === "subdomain") {
    void renderAppSubdomain(product.cid, product.label);
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
  void renderAppSubdomain(product.cid, product.label);
});

let bridgeEventListenersInitialized = false;

export function initBridgeEventListeners(): void {
  if (bridgeEventListenersInitialized) {
    return;
  }
  bridgeEventListenersInitialized = true;
  (
    window as typeof window & { __dotliTruapiBridgeReady?: boolean }
  ).__dotliTruapiBridgeReady = true;
  window.addEventListener("dotli:truapi-disconnect-request", () => {
    void disconnectTruapiHosts();
  });

  // User closed the pairing modal: cancel the in-flight login on the auth
  // host. Only an already-booted host can have a login in flight.
  window.addEventListener("dotli:truapi-cancel-login", () => {
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

initBridgeEventListeners();

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
 * Capture deep link path (pathname + search + hash) to forward into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== "/" && p.startsWith(base)) {
    p = "/" + p.slice(base.length);
  }
  const stripped = p.replace(/^\/[^/]+\.dot/, "");
  const isRoot = stripped === "" || stripped === "/";
  if (isRoot) {
    return search || hash ? search + hash : "";
  }
  return stripped + search + hash;
}

function applyIframeStyling(
  iframe: HTMLIFrameElement,
  opts: { topbarOffset: boolean },
): void {
  iframe.style.cssText = opts.topbarOffset
    ? "position:fixed;top:56px;left:0;width:100%;height:calc(100vh - 56px);border:none;margin:0;padding:0;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";
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
        // eslint-disable-next-line no-restricted-syntax -- provider teardown is best-effort; stale MessagePorts can already be closed while the next cleanup still must run.
      } catch {
        /* ignore teardown races */
      }
    }
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
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  let legacyProbeCleanup: (() => void) | null = null;
  const pipeArgs = {
    flowId: args.debugFlowId,
    label: args.label,
    productId: args.productId ?? args.label,
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
    // window-postMessage provider. Remove once products migrate.
    let probeMode: "pending" | "modern" | "legacy" = "pending";
    const onProbe = (event: MessageEvent): void => {
      if (probeMode !== "pending") {
        return;
      }
      const targetWindow = host.iframe.contentWindow;
      if (!targetWindow || event.source !== targetWindow) {
        return;
      }
      if (event.data instanceof Uint8Array) {
        probeMode = "legacy";
        legacyProbeCleanup?.();
        // Drop the unused modern MessagePort pipe before rewiring.
        cleanupProductSide();
        const windowProvider = createWindowMessageProvider(targetWindow);
        const legacyProvider =
          createLegacyNovaChainHeadProvider(windowProvider);
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
  const { createWebWorkerPairingHostRuntime, HostWorker } =
    await runtimeChunkPromise;
  const runtimeConfig = createTruapiRuntimeConfig(
    label,
    window.location,
    options.productId,
  );
  const { productId, ...hostConfig } = runtimeConfig;
  const runtime = await createWebWorkerPairingHostRuntime(
    new HostWorker(),
    createHostCallbacks({
      label,
      pairingLabel: options.pairingLabel,
      pairingDotSuffix: options.pairingDotSuffix,
      pairingHostGlobal: options.pairingHostGlobal,
    }),
    {
      hostConfig,
    },
  );
  const provider = await runtime.createProvider({ productId });
  return trackCoreProvider(provider, runtime);
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
  cleanup();
  disposeLandingAuthHost();

  currentProduct = {
    mode: "iframe",
    label,
    url,
    productId: options.productId,
  };

  app.innerHTML = "";

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
  currentHost = host;
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
  document.title = `${label} — dot.li`;

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
 * MessageChannel; any nested dApp iframe it loads is opaque to the host.
 */
export async function renderAppSubdomain(
  cid: string,
  label: string,
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();
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
  // Consume + clear so subsequent navigations (permission reload, etc.)
  // don't keep triggering resets.
  let fullReset = false;
  try {
    if (sessionStorage.getItem("dotli:pending-reset:sandbox") === "1") {
      fullReset = true;
      sessionStorage.removeItem("dotli:pending-reset:sandbox");
    }
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); reset flag defaults to false which is the safe state.
  } catch {
    /* sessionStorage unavailable — skip pending reset */
  }
  let url = deepPath ? `${appOrigin}${deepPath}` : appOrigin;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(SANDBOX_CONTRACT_PARAMS.cid, cid);
    parsed.searchParams.set(
      SANDBOX_CONTRACT_PARAMS.v,
      String(SANDBOX_SCHEMA_VERSION),
    );
    parsed.searchParams.set(SANDBOX_CONTRACT_PARAMS.chainBackend, chainBackend);
    parsed.searchParams.set(SANDBOX_CONTRACT_PARAMS.network, network);
    if (cache.skipArchiveCache) {
      parsed.searchParams.set(SANDBOX_CONTRACT_PARAMS.skipArchiveCache, "1");
    }
    if (fullReset) {
      parsed.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, "1");
    }
    url = parsed.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}${SANDBOX_CONTRACT_PARAMS.cid}=${cid}&${SANDBOX_CONTRACT_PARAMS.v}=${String(SANDBOX_SCHEMA_VERSION)}&${SANDBOX_CONTRACT_PARAMS.chainBackend}=${chainBackend}&${SANDBOX_CONTRACT_PARAMS.network}=${network}`;
    if (cache.skipArchiveCache) {
      url += `&${SANDBOX_CONTRACT_PARAMS.skipArchiveCache}=1`;
    }
    if (fullReset) {
      url += `&${SANDBOX_CONTRACT_PARAMS.fullReset}=1`;
    }
  }

  // Keep the loading overlay visible — the sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only remove non-loading children from #app before handing it off.
  const loading = app.querySelector(".loading");
  app.innerHTML = "";
  if (loading) {
    app.appendChild(loading);
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
  currentHost = host;
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
  document.title = `${label}.dot`;

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

function cleanup(): void {
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  if (currentHost) {
    currentHost.dispose();
    currentHost = null;
  }
}

function newFlowId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}
