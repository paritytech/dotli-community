// dot.li — TrUAPI host bridge
//
// Boots a WASM TrUAPI core instance and connects it to a sandboxed
// product iframe via `@parity/truapi-host-wasm`. Each render swaps the running
// runtime, so disposing the last host tears down both the iframe and
// the core.
//
// Nested dApp-in-dApp composition (old `setupNestedBridgeDetector`) is
// dropped: `createIframeHost` uses a dedicated `MessageChannel`, so
// inner iframes have no host port. Tracked in §6.1 of the refactor plan
// as a known regression; a future nested-port API in the TrUAPI host bridge
// will restore it.

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
  getChainBackend,
  getContentBackend,
  getCacheSettings,
} from "@dotli/config/mode";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { buildAllowAttribute } from "./permissions";
import { createHostCallbacks } from "./host-callbacks/handlers";

// Re-export sandbox-safe rendering functions
export { renderContent, renderArchive, prepareIframe } from "./render";

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
    HostWorker: workerMod.default as new () => Worker,
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
  void host.requestLogin(detail?.reason).catch((error: unknown) => {
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
    ? "position:fixed;top:40px;left:0;width:100%;height:calc(100vh - 40px);border:none;margin:0;padding:0;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
}

/** Read once at boot — flipping the flag while a runtime is alive
 * doesn't reach the worker. The user must reload after toggling. */
function isDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("truapi:debug") === "1";
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (Safari private mode); fall through to disabled.
  } catch {
    return false;
  }
}

function pipeProviders(product: Provider, core: Provider): () => void {
  const unsubs = [
    product.subscribe((message) => core.postMessage(message)),
    core.subscribe((message) => product.postMessage(message)),
    product.subscribeClose?.(() => core.dispose()),
    core.subscribeClose?.(() => product.dispose()),
  ].filter((fn): fn is () => void => typeof fn === "function");

  return () => {
    for (const unsub of unsubs) {
      try {
        unsub();
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
  const requestId = `dotli:topbar-login:${++topbarLoginRequestSeq}`;
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
          resolve(result.value as LoginResponse);
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
      runtimeConfig: {
        productId: args.label.startsWith("localhost:")
          ? args.label
          : `${args.label}.dot`,
        productLabel: args.label,
        siteId: window.location.origin,
      },
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
      disposePipe = pipeProviders(productProvider, coreProvider);
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
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();

  currentRenderMode = "iframe";
  currentLabel = label;
  currentUrl = url;
  currentCid = null;

  app.innerHTML = "";

  const hasTopbar = document.getElementById("topbar") !== null;
  const iframeUrl = new URL(url, window.location.href);
  const host = await createHost({
    iframeUrl: iframeUrl.href,
    allowedOrigin: iframeUrl.origin,
    // TODO: Review sandbox default permissions
    sandbox: "allow-scripts allow-same-origin allow-forms allow-pointer-lock",
    label,
    container: app,
  });
  applyIframeStyling(host.iframe, label, { topbarOffset: hasTopbar });
  currentHost = host;

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
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  cleanup();

  currentRenderMode = "subdomain";
  currentLabel = label;
  currentCid = cid;
  currentUrl = null;

  // Propagate the two independent backend axes. The legacy `?mode=`
  // preset param is no longer sent — host and sandbox deploy together,
  // there are no old sandbox builds in the wild, and the sandbox
  // validator rejects unknown params so keeping it would guarantee a
  // boot failure on the next deploy.
  //
  // The sandbox reads its own curated endpoint defaults from
  // `@dotli/config/endpoints` (same package, built into its bundle), so
  // the host no longer threads RPC/gateway URLs across the origin —
  // there are no user-overridable endpoints to preserve.
  const chainBackend = getChainBackend();
  const contentBackend = getContentBackend();
  const cache = getCacheSettings();
  const appOrigin = getAppOrigin(cid);
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
    parsed.searchParams.set("chainBackend", chainBackend);
    parsed.searchParams.set("contentBackend", contentBackend);
    if (cache.skipArchiveCache) {
      parsed.searchParams.set("skipArchiveCache", "1");
    }
    if (fullReset) {
      parsed.searchParams.set("fullReset", "1");
    }
    url = parsed.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}chainBackend=${chainBackend}&contentBackend=${contentBackend}`;
    if (cache.skipArchiveCache) {
      url += "&skipArchiveCache=1";
    }
    if (fullReset) {
      url += "&fullReset=1";
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
  const host = await createHost({
    iframeUrl: url,
    allowedOrigin: iframeUrl.origin,
    sandbox:
      "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups",
    label,
    container: app,
  });
  applyIframeStyling(host.iframe, label, { topbarOffset: true });
  currentHost = host;

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
}

function getAppOrigin(cid: string): string {
  const hostname = window.location.hostname;
  if (hostname.endsWith(".localhost") || hostname === "localhost") {
    const port = import.meta.env.DEV ? "5174" : window.location.port;
    return `http://${cid}.app.localhost:${port}`;
  }
  return `https://${cid}.app.${BASE_DOMAIN}`;
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
