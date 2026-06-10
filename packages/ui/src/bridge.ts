// dot.li — TrUAPI host bridge
//
// Boots a WASM TrUAPI core instance and connects it to a sandboxed
// product iframe via `@parity/truapi-host-wasm`. Each render swaps the running
// runtime, so disposing the last host tears down both the iframe and
// the core.
//
// Nested dApp-in-dApp composition is not modeled as separate Rust runtimes,
// sessions, product identities, or storage namespaces. Any future nested
// traffic must share the top-level core/provider context.

import {
  decodeWireMessage,
  describeWireId,
  encodeWireMessage,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginRequest,
  VersionedHostRequestLoginResponse,
  type VersionedHostRequestLoginError as LoginErrorEnvelope,
  type HostRequestLoginResponse as LoginResponse,
  type Provider,
  type VersionedHostRequestLoginResponse as LoginResponseEnvelope,
  createMessagePortProvider,
} from "@parity/truapi";
import type { ResultPayload } from "@parity/truapi/scale";
import { ACCOUNT_REQUEST_LOGIN } from "@parity/truapi/wire-table";
import { createWasmRawCallbacks } from "@parity/truapi-host-wasm";
import { BASE_DOMAIN } from "@dotli/config/config";
import {
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
} from "@dotli/config/host-sandbox-contract";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import { getNetwork } from "@dotli/config/network";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import {
  emitDotliDebugEvent,
  hasDotliDebugListeners,
} from "@dotli/truapi-debug/dotli-debug-bus";
import { buildAllowAttribute } from "./permissions";
import { createHostCallbacks } from "./host-callbacks/handlers";
import { emitSessionConnectionState } from "./host-callbacks/SessionStore";
import { LoginRequestError, isLoginCancellation } from "./login-request-error";
import {
  emitSsoPairingFailed,
  emitSsoSessionEstablished,
} from "./host-callbacks/SsoDebug";
import { createTruapiRuntimeConfig } from "./runtime-config";

// Eagerly load the iframe host chunk + worker constructor so they're ready
// by the time we need them. The wasm core lives inside the worker; the host
// shell only owns the postMessage bridge, keeping smoldot's CPU off the
// main thread (no more `[Violation] 'message' handler took 150ms+`).
const chunkLoadStart = performance.now();
const runtimeChunkPromise = Promise.all([
  import("@parity/truapi-host-wasm/web"),
  import("@parity/truapi-host-wasm/worker-runtime?worker"),
]).then(([web, workerMod]) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return {
    createWebWorkerProvider: web.createWebWorkerProvider,
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
  disconnect: () => Promise<void>;
  dispose: () => void;
}

type CoreProvider = Provider & { disconnect: () => Promise<void> };
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

let bridgeEventListenersInitialized = false;

export function initBridgeEventListeners(): void {
  if (bridgeEventListenersInitialized) {
    return;
  }
  bridgeEventListenersInitialized = true;
  (
    window as typeof window & { __dotliTruapiBridgeReady?: boolean }
  ).__dotliTruapiBridgeReady = true;
  emitDotliDebugEvent({
    layer: "bridge",
    event: "sso_listeners_ready",
    flowId: "bridge-sso-listeners",
    timestamp: Date.now(),
    payload: {},
  });

  window.addEventListener("dotli:truapi-disconnect-request", () => {
    void disconnectTruapiHosts();
  });

  window.addEventListener("dotli:truapi-login-request", (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    const flowId = newFlowId("login");
    emitDotliDebugEvent({
      layer: "sso",
      event: "login_event_received",
      flowId,
      timestamp: Date.now(),
      payload: {},
    });
    void (async () => {
      const host = await getLandingAuthHost();
      emitDotliDebugEvent({
        layer: "sso",
        event: "login_host_ready",
        flowId,
        timestamp: Date.now(),
        payload: { host: "landing" },
      });
      const result = await host.requestLogin(detail.reason);
      if (result === "Success" || result === "AlreadyConnected") {
        emitSsoSessionEstablished(result);
      } else {
        emitSsoPairingFailed(result);
      }
      emitSessionConnectionState(
        result === "Success" || result === "AlreadyConnected",
      );
    })().catch((error: unknown) => {
      emitSsoPairingFailed(
        error instanceof Error ? error.message : String(error),
      );
      if (isLoginCancellation(error)) {
        emitSessionConnectionState(false);
        return;
      }
      dispatchLoginError(error);
    });
  });
}

initBridgeEventListeners();

async function disconnectTruapiHosts(): Promise<void> {
  emitSessionConnectionState(false);

  const hosts = new Set<CoreHost | ActiveHost>();
  if (currentHost !== null) {
    hosts.add(currentHost);
  }
  if (landingAuthHostPromise !== null) {
    try {
      hosts.add(await landingAuthHostPromise);
    } catch {
      /* a failed pending login host should not block product logout */
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
  label: string,
  opts: { topbarOffset: boolean },
): void {
  iframe.allow = `${buildAllowAttribute(label)}; cross-origin-isolated`;
  iframe.style.cssText = opts.topbarOffset
    ? "position:fixed;top:56px;left:0;width:100%;height:calc(100vh - 56px);border:none;margin:0;padding:0;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
}

type CoreLogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

const CORE_LOG_LEVELS: readonly CoreLogLevel[] = [
  "off",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/** Read once at boot — changing the level while a runtime is alive doesn't
 * reach the worker, so the user must reload after setting it (or call
 * `window.__truapi.setLogLevel(...)` to retune live). `truapi:logLevel`
 * selects the level; the legacy `truapi:debug`/`dotli:truapi-debug` "1"
 * flags map to `debug`. */
function readLogLevel(): CoreLogLevel {
  try {
    const level = window.localStorage.getItem("truapi:logLevel");
    if (level && (CORE_LOG_LEVELS as readonly string[]).includes(level)) {
      return level as CoreLogLevel;
    }
    if (
      window.sessionStorage.getItem("dotli:truapi-debug") === "1" ||
      window.localStorage.getItem("truapi:debug") === "1"
    ) {
      return "debug";
    }
  } catch {
    // ignore storage access errors
  }
  return "off";
}

function dispatchLoginError(error: unknown): void {
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-login-error", {
      detail: {
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
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

function emitWireFrameDebug(
  direction: "incoming" | "outgoing",
  productId: string,
  message: Uint8Array,
): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    return;
  }
  const wireId = decoded.value.payload.id;
  emitDotliDebugEvent({
    kind: "truapi",
    direction,
    productId,
    requestId: decoded.value.requestId,
    payload: {
      tag: describeWireId(wireId),
      value: {
        wireId,
        bytes: decoded.value.payload.value,
      },
    },
  });
}

function wrapCoreProviderForDebug(
  provider: CoreProvider,
  productId: string,
): CoreProvider {
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
      return provider.subscribeClose?.(callback) ?? (() => {});
    },
    async disconnect() {
      await provider.disconnect();
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
  const flowId = newFlowId("login");
  emitDotliDebugEvent({
    layer: "sso",
    event: "login_request_start",
    flowId,
    timestamp: Date.now(),
    payload: { requestId },
  });
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
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
    emitDotliDebugEvent({
      layer: "sso",
      event: "login_request_encode_failed",
      flowId,
      timestamp: Date.now(),
      payload: { requestId, reason: frame.error.message },
    });
    return Promise.reject(frame.error);
  }

  return new Promise<LoginResponse>((resolve, reject) => {
    const unsubscribe = core.subscribe((message) => {
      const decoded = decodeWireMessage(message);
      if (decoded.isErr()) {
        cleanup();
        reject(decoded.error);
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
        const result = responseCodec.dec(
          decoded.value.payload.value,
        ) as unknown as ResultPayload<
          LoginResponseEnvelope,
          LoginErrorEnvelope
        >;
        if (result.success) {
          emitDotliDebugEvent({
            layer: "sso",
            event: "login_request_response",
            flowId,
            timestamp: Date.now(),
            payload: { requestId, result: result.value.value },
          });
          resolve(result.value.value);
        } else {
          emitDotliDebugEvent({
            layer: "sso",
            event: "login_request_failed",
            flowId,
            timestamp: Date.now(),
            payload: { requestId },
          });
          reject(new LoginRequestError(result.value));
        }
      } catch (error) {
        emitDotliDebugEvent({
          layer: "sso",
          event: "login_request_decode_failed",
          flowId,
          timestamp: Date.now(),
          payload: {
            requestId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const cleanup = (): void => {
      unsubscribe();
    };

    try {
      core.postMessage(frame.value);
      emitDotliDebugEvent({
        layer: "sso",
        event: "login_request_sent",
        flowId,
        timestamp: Date.now(),
        payload: { requestId },
      });
    } catch (error) {
      cleanup();
      emitDotliDebugEvent({
        layer: "sso",
        event: "login_request_send_failed",
        flowId,
        timestamp: Date.now(),
        payload: {
          requestId,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      reject(error instanceof Error ? error : new Error(String(error)));
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
  const { createIframeHost } = await runtimeChunkPromise;
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  const host = createIframeHost({
    iframeUrl: args.iframeUrl,
    allowedOrigin: args.allowedOrigin,
    sandbox: args.sandbox,
    container: args.container,
    onPort: (port) => {
      productProvider = createMessagePortProvider(port);
      disposePipe = pipeProviders(productProvider, coreProvider, {
        flowId: args.debugFlowId,
        label: args.label,
        productId: args.productId ?? args.label,
      });
    },
  });
  return {
    iframe: host.iframe,
    requestLogin(reason) {
      return requestCoreLogin(coreProvider, reason);
    },
    disconnect() {
      return coreProvider.disconnect();
    },
    dispose() {
      disposePipe?.();
      productProvider?.dispose();
      coreProvider.dispose();
      host.dispose();
    },
  };
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
  const { createWebWorkerProvider, HostWorker } = await runtimeChunkPromise;
  const provider = await createWebWorkerProvider(
    new HostWorker(),
    createWasmRawCallbacks(
      createHostCallbacks({
        label,
        pairingLabel: options.pairingLabel,
        pairingDotSuffix: options.pairingDotSuffix,
        pairingHostGlobal: options.pairingHostGlobal,
        storagePrefix: `dotli:${label}:`,
      }),
    ),
    {
      logLevel: readLogLevel(),
      runtimeConfig: createTruapiRuntimeConfig(
        label,
        window.location,
        undefined,
        options.productId,
      ),
    },
  );
  return wrapCoreProviderForDebug(provider, options.productId ?? label);
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
    disconnect() {
      return coreProvider.disconnect();
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
  applyIframeStyling(host.iframe, label, { topbarOffset: hasTopbar });
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
  applyIframeStyling(host.iframe, label, { topbarOffset: true });
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
