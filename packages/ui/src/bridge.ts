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
  encodeWireMessage,
  HostRequestLoginError,
  HostRequestLoginResponse,
  scale,
  VersionedHostRequestLoginRequest,
  type HostRequestLoginResponse as LoginResponse,
  type Provider,
  createMessagePortProvider,
} from "@parity/truapi";
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
import { emitDotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-bus";
import { buildAllowAttribute } from "./permissions";
import { createHostCallbacks } from "./host-callbacks/handlers";
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

let currentHost: ActiveHost | null = null;
let currentPanelDispose: (() => void) | null = null;

// Track current product state for permission-grant reloads
let currentRenderMode: "iframe" | "subdomain" | null = null;
let currentLabel: string | null = null;
let currentUrl: string | null = null;
let currentCid: string | null = null;

// Listen for device permission grants — reload the iframe so the
// updated `allow` attribute takes effect.
window.addEventListener("dotli:device-permission-changed", () => {
  if (
    currentRenderMode === "iframe" &&
    currentUrl !== null &&
    currentLabel !== null
  ) {
    void renderIframe(currentUrl, currentLabel);
  } else if (
    currentRenderMode === "subdomain" &&
    currentCid !== null &&
    currentLabel !== null
  ) {
    void renderAppSubdomain(currentCid, currentLabel);
  }
});

window.addEventListener("dotli:truapi-disconnect-request", () => {
  void currentHost?.disconnect();
});

window.addEventListener("dotli:truapi-login-request", (event: Event) => {
  const detail = (event as CustomEvent<{ reason?: string }>).detail;
  const host = currentHost;
  if (!host) {
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-login-error", {
        detail: { message: "No active product runtime" },
      }),
    );
    return;
  }
  void host.requestLogin(detail.reason).catch((error: unknown) => {
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-login-error", {
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  });
});

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

/** Read once at boot — flipping the flag while a runtime is alive
 * doesn't reach the worker. The user must reload after toggling. */
function isDebugEnabled(): boolean {
  try {
    return (
      window.sessionStorage.getItem("dotli:truapi-debug") === "1" ||
      window.localStorage.getItem("truapi:debug") === "1"
    );
  } catch {
    return false;
  }
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

function requestCoreLogin(
  core: Provider,
  reason?: string,
): Promise<LoginResponse> {
  const requestId = `dotli:topbar-login:${String(++topbarLoginRequestSeq)}`;
  const responseCodec = scale.indexedTaggedUnion({
    V1: [
      0,
      scale.Result(HostRequestLoginResponse, HostRequestLoginError),
    ] as const,
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
        const result = responseCodec.dec(decoded.value.payload.value).value;
        if (result.success) {
          resolve(result.value);
        } else {
          reject(new Error(JSON.stringify(result.value)));
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const cleanup = (): void => {
      unsubscribe();
    };

    try {
      core.postMessage(frame.value);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function createHost(args: {
  iframeUrl: string;
  allowedOrigin: string;
  sandbox: string;
  label: string;
  container: HTMLElement;
  debugFlowId: string;
}): Promise<ActiveHost> {
  const { createWebWorkerProvider, createIframeHost, HostWorker } =
    await runtimeChunkPromise;
  const coreProvider = await createWebWorkerProvider(
    new HostWorker(),
    createWasmRawCallbacks(
      createHostCallbacks({
        label: args.label,
        storagePrefix: `dotli:${args.label}:`,
      }),
    ),
    {
      debug: isDebugEnabled(),
      runtimeConfig: createTruapiRuntimeConfig(args.label),
    },
  );
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
        productId: args.label,
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

/**
 * Render a dApp iframe backed by the TrUAPI host bridge.
 */
export async function renderIframe(url: string, label: string): Promise<void> {
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_begin",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: "iframe" },
  });
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();

  currentRenderMode = "iframe";
  currentLabel = label;
  currentUrl = url;
  currentCid = null;

  app.innerHTML = "";

  const hasTopbar = document.getElementById("topbar") !== null;
  const iframeUrl = new URL(url, window.location.href);
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  const host = await createHost({
    iframeUrl: iframeUrl.href,
    allowedOrigin: iframeUrl.origin,
    // TODO: Review sandbox default permissions
    sandbox: "allow-scripts allow-same-origin allow-forms allow-pointer-lock",
    label,
    container: app,
    debugFlowId: bridgeFlowId,
  });
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
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
        payload: { label, productId: label, mode: "iframe" },
      });
    },
    { once: true },
  );

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
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
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();

  currentRenderMode = "subdomain";
  currentLabel = label;
  currentCid = cid;
  currentUrl = null;

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
