// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Host-container bridge
//
// Connects embedded dApps to host services (accounts, signing, chain
// connections, scoped storage) via postMessage protocol.
// Only imported by the host build, keeps smoldot and auth out of the
// sandbox bundle.

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

function newFlowId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}

// Eagerly load the container bridge chunk. Starts downloading when
// this module is imported, so it's ready by the time we need it.
const chunkLoadStart = performance.now();
const containerChunkPromise = import("./container").then((mod) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return mod;
});
void containerChunkPromise.catch(() => {
  /* fire-and-forget */
});

const app = document.getElementById("app") ?? document.body;

let currentDispose: (() => void) | null = null;
let currentPanelDispose: (() => void) | null = null;

// Track current product state for permission-grant reloads
let currentRenderMode: "iframe" | "subdomain" | null = null;
let currentLabel: string | null = null;
let currentUrl: string | null = null;
let currentCid: string | null = null;

// Listen for device permission grants and reload the iframe so the
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
  if (
    currentRenderMode !== "subdomain" ||
    currentCid === null ||
    currentLabel === null ||
    event.origin !== getAppOrigin(currentLabel)
  ) {
    return;
  }
  const now = Date.now();
  if (now - lastRecoverAt < RECOVER_MIN_INTERVAL_MS) {
    return;
  }
  lastRecoverAt = now;
  void renderAppSubdomain(currentCid, currentLabel);
});

/**
 * Capture deep link path (pathname + search + hash) to forward into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  // Strip the deploy base path (e.g. a subpath deploy at /dotli/) so only the
  // in-app route is forwarded to the iframe.
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
 * Render an iframe with the host-container bridge.
 *
 * Unlike the base renderIframe, this sets up the postMessage bridge
 * between the host and the embedded dApp, enabling accounts, signing,
 * chain connections, and scoped storage.
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

  const hasTopbar = document.getElementById("topbar") !== null;
  const iframeStyle = hasTopbar
    ? "position:fixed;top:56px;left:0;width:100%;height:calc(100vh - 56px);border:none;margin:0;padding:0;"
    : "position:fixed;top:0;left:0;width:100%;height:100vh;border:none;margin:0;padding:0;";

  app.innerHTML = "";
  const iframe = document.createElement("iframe");
  // TODO: Review sandbox default permissions
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
  );
  iframe.allow = `${buildAllowAttribute(label)}; cross-origin-isolated`;
  iframe.style.cssText = iframeStyle;
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  app.appendChild(iframe);
  iframe.addEventListener(
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

  const { setupContainer, setupNestedBridgeDetector } =
    await containerChunkPromise;
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  const disposePrimary = setupContainer(iframe, url, label, bridgeFlowId);
  const disposeNested = setupNestedBridgeDetector(iframe, label);
  currentDispose = () => {
    disposePrimary();
    disposeNested();
  };
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    currentPanelDispose = setupViolationPanel(iframe);
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
 * Render content in a cross-origin app subdomain iframe at
 * `<label>.app.dot.li`.
 *
 * The host build delegates content fetching and rendering to the app
 * context. The origin is the human dotns label. The host owns dotns
 * resolution and threads the resolved CID through the URL contract
 * (`?cid=`), since it is no longer in the origin. The sandbox does
 * not re-resolve.
 *
 * Sets up the container bridge targeting the app iframe. The app context
 * acts as a transparent postMessage relay between the host and the dApp
 * iframe.
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

  // Propagate the two independent backend axes. The legacy `?mode=`
  // preset param is no longer sent. Host and sandbox deploy together,
  // there are no old sandbox builds in the wild, and the sandbox
  // validator rejects unknown params so keeping it would guarantee a
  // boot failure on the next deploy.
  //
  // The sandbox reads its own curated endpoint defaults from
  // `@dotli/config/network` (same package, built into its bundle), so
  // the host no longer threads RPC/gateway URLs across the origin.
  // There are no user-overridable endpoints to preserve.
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
    /* sessionStorage unavailable: skip pending reset */
  }
  let url = deepPath ? `${appOrigin}${deepPath}` : appOrigin;
  try {
    const parsed = new URL(url);
    // CID is no longer in the origin, so the host hands the resolved CID to
    // the sandbox here. `v` lets a stale sandbox reject a mismatched build.
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

  const iframe = document.createElement("iframe");
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-forms",
    "allow-pointer-lock",
    "allow-popups",
  );
  iframe.allow = buildAllowAttribute(label);
  iframe.style.cssText =
    "position:fixed;top:56px;left:0;width:100%;height:calc(100vh - 56px);border:none;margin:0;padding:0;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  // Keep the loading overlay visible. The sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only remove non-loading children from #app before appending the iframe.
  const loading = app.querySelector(".loading");
  app.innerHTML = "";
  if (loading) {
    app.appendChild(loading);
  }
  app.appendChild(iframe);
  iframe.addEventListener(
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

  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_begin",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: "subdomain" },
  });

  const { setupContainer, setupNestedBridgeDetector } =
    await containerChunkPromise;
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  const disposePrimary = setupContainer(iframe, url, label, bridgeFlowId);
  const disposeNested = setupNestedBridgeDetector(iframe, label);
  currentDispose = () => {
    disposePrimary();
    disposeNested();
  };
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    currentPanelDispose = setupViolationPanel(iframe);
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

// Origin is the human dotns label (`<label>.app.<root>`), not the CID. Storage
// and permissions stay stable across content (CID) updates of the same name.
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
  if (currentDispose) {
    currentDispose();
    currentDispose = null;
  }
}
