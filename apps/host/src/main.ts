// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host entry point.
//
// Parses the URL, then either renders a direct preview or local target, or
// resolves the `.dot` name via smoldot and iframes the sandbox at
// `<label>.app.dot.li` with the resolved CID threaded through the URL contract.

// Polyfill for Safari < 18.4 which lacks requestIdleCallback
if (typeof globalThis.requestIdleCallback !== "function") {
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number =>
    setTimeout(() => {
      cb({ didTimeout: false, timeRemaining: () => 50 });
    }, 1) as unknown as number;
}

import "./pwa";
import "./offline";
import "@dotli/ui/styles.css";
import * as Sentry from "@sentry/browser";
import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
} from "@dotli/metrics/sentry";
import {
  showStatus,
  showError,
  showNoContentError,
  showLanding,
  initPhases,
  advancePhase,
  stopStatusTick,
  listenForSandboxStatus,
  showGatewayEscape,
} from "@dotli/ui/ui";
import { initTopBar, wipeOriginState } from "@dotli/ui/topbar";
import {
  bitswapGet,
  listenForSandboxBitswap,
} from "@dotli/ui/bulletin-bitswap";
import {
  getCachedCid,
  setCachedCid,
  recordRevalidateOutcome,
} from "@dotli/storage/cid-cache";
import { dur, elapsed } from "@dotli/shared/perf";
import {
  setActiveAppManifest,
  setActiveRootManifest,
} from "@dotli/shared/active-manifest";
import type {
  ExecutableManifest,
  ManifestResult,
  RootManifest,
} from "@dotli/resolver/manifest";
import { BASE_DOMAIN, DEBUG, SITE_ID } from "@dotli/config/config";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import { escapeHtml, isValidDotLabel } from "@dotli/shared/html";
import { showNotification } from "@dotli/ui/notification";
import { initScheduledNotifications } from "@dotli/ui/scheduled-notifications";
import {
  BACKEND_KEY,
  CACHE_KEY,
  getBackend,
  setBackend,
  isSharedWorkerAvailable,
  isVerifiedSession,
  getCacheSettings,
  setCacheSettings,
  type Backend,
} from "@dotli/config/mode";
import { NETWORK_KEY, getNetwork, setNetwork } from "@dotli/config/network";
import {
  parseSettingsFromSearch,
  writeSettingsToSearch,
} from "@dotli/config/url-settings";
import type { DotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-types";
import {
  describeError,
  FAILOVER_BTN_LABELS,
  REFRESH_BTN_LABEL,
} from "./errors";
import { parsePreviewTargetUrl } from "./preview-route";

// Surface chunk-load failures explicitly: capture the original cause to
// Sentry and let the user opt into a reload, instead of reloading silently.
window.addEventListener("vite:preloadError", (event) => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error("vite:preloadError"), {
    kind: "chunk_preload_error",
  });
  showNotification({
    label: "Asset failed to load",
    text: "A new version may have been deployed. Reload to get the latest.",
    dismissMs: 0,
    action: {
      label: "Reload",
      onClick: () => {
        window.location.reload();
      },
    },
  });
});

// Respect the user's dismissal unconditionally. Once dismissed, never
// resurface unless the dismissal flag is cleared from localStorage.
if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  const dismissed = localStorage.getItem("desktop-banner-dismissed");
  if (dismissed === null) {
    showNotification({
      label: "Get Polkadot Desktop",
      text: "Full experience with native performance",
      deeplink:
        (import.meta.env.VITE_DESKTOP_DOWNLOAD_URL as string | undefined) ??
        "https://polkadot.com/get-started/polkadot-for-desktop",
      icon:
        '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>' +
        '<line x1="8" y1="21" x2="16" y2="21"/>' +
        '<line x1="12" y1="17" x2="12" y2="21"/></svg>',
      iconBackground: "#000",
      dismissMs: 0,
      browserNotification: false,
      onDismiss: () => {
        localStorage.setItem("desktop-banner-dismissed", "1");
      },
    });
  }
}

initSentry("host");
installGlobalErrorHandlers("host");

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// Track WASM module load times via resource timing
if (m.enabled && typeof PerformanceObserver !== "undefined") {
  const wasmObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.endsWith(".wasm")) {
        const name = entry.name.split("/").pop() ?? "unknown";
        m.distribution(S.WASM_LOAD, entry.duration, "millisecond", {
          module: name,
        });
      }
    }
  });
  wasmObserver.observe({ type: "resource", buffered: true });
}

const T0 = performance.now();

/**
 * Parse a localhost proxy URL from the path.
 *
 * Debug-build-only affordance: proxying a visitor's localhost services into the
 * trusted host origin is dangerous on a production deploy, so it is gated behind
 * the build-time `VITE_APP_DEBUG` flag (`DEBUG`). Production builds (flag unset)
 * always return null; only debug builds — local `bun run preview:debug` and the
 * `*.dev` staging deploys — honour a `/localhost:<port>` path. The flag is a
 * compile-time constant, so production never even ships this code path.
 *
 * Examples (only in debug builds):
 *   "/localhost:5000"          yields "http://localhost:5000"
 *   "/localhost:5000/foo/bar"  yields "http://localhost:5000/foo/bar"
 *   "/localhost"               yields "http://localhost"
 *   "/starter-template.dot"    yields null (not a localhost URL)
 */
function parseLocalhostUrl(): string | null {
  if (!DEBUG) {
    return null;
  }
  const path = window.location.pathname;
  const match = /^\/(localhost(?::\d+)?)(.*)$/.exec(path);
  if (match === null) {
    return null;
  }
  const host = match[1];
  const rest = match[2] || "";
  // Strip every reserved host-URL param so they do not leak into the
  // proxied product. Covers the five settings axes, the sandbox contract's
  // host-only signals (`fullReset`, `v`), and the Playwright auth hook.
  const productSearch = new URLSearchParams(window.location.search);
  for (const k of RESERVED_HOST_PARAMS) {
    productSearch.delete(k);
  }
  const query = productSearch.toString();
  return `http://${host}${rest}${query ? `?${query}` : ""}${window.location.hash}`;
}

const RESERVED_HOST_PARAMS = [
  "network",
  "chainBackend",
  "skipArchiveCache",
  "skipCidCache",
  "skipWorkerCache",
  "fullReset",
  "v",
  "initAuthSubscribe",
] as const;

/**
 * Extract the `.dot` label from the current hostname.
 *
 * Returns `"myapp"` for `myapp.dot.li` or `myapp.localhost`. Returns `null`
 * for the bare landing pages (`dot.li`, `localhost`) and for sandbox origins
 * (`*.app.dot.li`, `*.app.localhost`), which are handled by `app-main.ts`.
 *
 * The parsed label is validated against the closed `.dot` label charset as
 * defense-in-depth before it is threaded into key derivation, origin
 * construction (`<label>.app.<root>`), and host-shell sinks. A malformed
 * label can never be a registered `.dot` name, so returning `null` (which
 * routes to the landing/preview path) is the safe outcome.
 */
function parseDotLabel(): string | null {
  const hostname = window.location.hostname;

  // Production: name.{BASE_DOMAIN} (but NOT *.app.{BASE_DOMAIN})
  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    if (hostname.endsWith(`.app.${BASE_DOMAIN}`)) {
      return null;
    }
    const label = hostname.slice(0, -(BASE_DOMAIN.length + 1));
    return isValidDotLabel(label) ? label : null;
  }

  // Local dev: name.localhost (but NOT *.app.localhost)
  if (hostname.endsWith(".localhost")) {
    if (hostname.endsWith(".app.localhost")) {
      return null;
    }
    const label = hostname.slice(0, -".localhost".length);
    return isValidDotLabel(label) ? label : null;
  }

  return null;
}

/**
 * Set the verification shield state in the URL pill.
 *
 *   "verified": green, P2P mode, data independently verified by light client.
 *   "validating": yellow, gateway mode, data from trusted source.
 */
let topbarHideTimer: ReturnType<typeof setTimeout> | null = null;
let topbarHoverBound = false;
let shieldVerified = false;

function isLoggedIn(): boolean {
  return document.querySelector(".user-badge") !== null;
}

function setTopbarVisible(visible: boolean): void {
  const topbar = document.getElementById("topbar");
  if (!topbar) {
    return;
  }
  const iframe = document.querySelector("iframe");
  topbar.style.transform = visible ? "translateY(0)" : "translateY(-100%)";
  if (iframe) {
    iframe.style.top = visible ? "56px" : "0";
    iframe.style.height = visible ? "calc(100vh - 56px)" : "100vh";
  }
  window.dispatchEvent(
    new CustomEvent<boolean>("topbar:visibility", { detail: visible }),
  );
}

function scheduleTopbarHide(): void {
  if (topbarHideTimer !== null) {
    clearTimeout(topbarHideTimer);
  }
  if (!isLoggedIn()) {
    return;
  }
  topbarHideTimer = setTimeout(() => {
    setTopbarVisible(false);
  }, 5000);
}

function setupTopbarAutoHide(): void {
  const topbar = document.getElementById("topbar");
  if (!topbar) {
    return;
  }

  topbar.style.transition = "transform 0.3s ease";
  const iframe = document.querySelector("iframe");
  if (iframe) {
    iframe.style.transition = "top 0.3s ease, height 0.3s ease";
  }

  scheduleTopbarHide();

  if (!topbarHoverBound) {
    topbarHoverBound = true;

    // Invisible trigger zone at the very top. Catches hover even over the iframe.
    const trigger = document.createElement("div");
    trigger.style.cssText =
      "position:fixed;top:0;left:0;right:0;height:6px;z-index:999;";
    document.body.appendChild(trigger);

    trigger.addEventListener("mouseenter", () => {
      if (topbarHideTimer !== null) {
        clearTimeout(topbarHideTimer);
        topbarHideTimer = null;
      }
      setTopbarVisible(true);
    });
    topbar.addEventListener("mouseenter", () => {
      if (topbarHideTimer !== null) {
        clearTimeout(topbarHideTimer);
        topbarHideTimer = null;
      }
      setTopbarVisible(true);
    });
    topbar.addEventListener("mouseleave", () => {
      scheduleTopbarHide();
    });
  }
}

// Wire auth-state changes to topbar auto-hide. Login starts the hide timer
// once the shield is verified, logout pins the topbar visible.
function bindTopbarAutoHide(): void {
  window.addEventListener("dotli:authenticated", () => {
    if (shieldVerified) {
      setupTopbarAutoHide();
    }
  });
  window.addEventListener("dotli:logged-out", () => {
    if (topbarHideTimer !== null) {
      clearTimeout(topbarHideTimer);
      topbarHideTimer = null;
    }
    setTopbarVisible(true);
  });
}

function setShieldState(state: "validating" | "verified"): void {
  const shield = document.getElementById("verification-shield");
  if (shield !== null) {
    shield.classList.remove("validating", "verified");
    shield.classList.add(state);
    shield.setAttribute(
      "title",
      state === "verified"
        ? "Verified via light client"
        : "Loaded from trusted source",
    );
  }

  shieldVerified = true;
  setupTopbarAutoHide();
}

/**
 * Apply the product's branding from the root manifest at `<label>.dot`.
 *
 * Runs after the app iframe is rendered so a slow or absent manifest never
 * blocks first paint. The manifest itself is read through the user's
 * selected backend (smoldot or RPC). The icon bytes flow through the same
 * backend via `bitswapGet`, which dispatches through the protocol bridge.
 */
async function applyProductBranding(
  label: string,
  chainBackend: Backend,
): Promise<void> {
  let rootResult: ManifestResult<RootManifest>;
  let appResult: ManifestResult<ExecutableManifest>;
  if (chainBackend === "rpc-gateway") {
    const mod = await import("@dotli/resolver/rpc-resolve");
    [rootResult, appResult] = await Promise.all([
      mod.resolveRootManifestViaRpc(label),
      mod.resolveExecutableManifestViaRpc(label, "app"),
    ]);
  } else {
    const mod = await import("@dotli/protocol/client");
    [rootResult, appResult] = await Promise.all([
      mod.resolveRootManifestRemote(label),
      mod.resolveExecutableManifestRemote(label, "app"),
    ]);
  }
  if (rootResult.kind === "ok") {
    const root = rootResult.value;
    document.title = root.displayName;
    setActiveRootManifest({
      schemaVersion: root.$v,
      displayName: root.displayName,
      description: root.description,
      icon: root.icon,
    });
    try {
      const bytes = await bitswapGet(root.icon.cid);
      const blob = new Blob([new Uint8Array(bytes)], {
        type: `image/${root.icon.format}`,
      });
      setFavicon(URL.createObjectURL(blob), root.icon.format);
      // Favicon fetch is cosmetic. A failure must not affect the tab title or
      // the loaded app, and is logged so it stays observable in diagnostics.
    } catch (err: unknown) {
      log.warn(
        `[dot.li manifest] icon fetch failed for ${label}.dot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (appResult.kind === "ok" && appResult.value.kind === "app") {
    setActiveAppManifest({
      schemaVersion: appResult.value.$v,
      appVersion: appResult.value.appVersion,
    });
  }
}

function setFavicon(href: string, format: "jpeg" | "png"): void {
  const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  const link = existing ?? document.createElement("link");
  link.rel = "icon";
  link.type = `image/${format}`;
  link.href = href;
  if (existing === null) {
    document.head.appendChild(link);
  }
}

import type * as RenderModule from "@dotli/ui/bridge";
type RenderChunk = typeof RenderModule;

/**
 * Resolve the TrUAPI debug panel mode for this page load.
 *
 *   - `enabled`: whether to mount the panel.
 *   - `explicit`: whether the user opted in (URL or sessionStorage).
 *     Drives the initial collapsed state. Explicit opt-ins start
 *     expanded, dev-environment auto-enables start collapsed so the
 *     panel doesn't cover content unsolicited.
 *
 * Precedence, from highest to lowest:
 *   1. `?debug=true` / `?debug=off` in the URL. Persisted to
 *      sessionStorage and stripped from `history` (so the param doesn't
 *      leak into the sandbox iframe's strict URL validator).
 *   2. Existing `sessionStorage["dotli:truapi-debug"]`. `"1"` enables,
 *      `"0"` disables.
 *   3. Build-time `DEBUG` (from `VITE_APP_DEBUG`). On in `dev-paseo` /
 *      `dev-polkadot` / `bun run preview:debug`, off in staging / prod.
 */
function resolveTruapiDebugMode(): { enabled: boolean; explicit: boolean } {
  try {
    const url = new URL(window.location.href);
    const param = url.searchParams.get("debug");
    if (param === "true" || param === "off") {
      sessionStorage.setItem("dotli:truapi-debug", param === "off" ? "0" : "1");
      url.searchParams.delete("debug");
      const rewritten =
        url.pathname +
        (url.searchParams.toString() === ""
          ? ""
          : `?${url.searchParams.toString()}`) +
        url.hash;
      history.replaceState(null, "", rewritten);
    }
    const persisted = sessionStorage.getItem("dotli:truapi-debug");
    if (persisted === "1") {
      return { enabled: true, explicit: true };
    }
    if (persisted === "0") {
      return { enabled: false, explicit: true };
    }
    return { enabled: DEBUG, explicit: false };
    // eslint-disable-next-line no-restricted-syntax -- URL/sessionStorage may be unavailable in exotic environments (Safari private mode); fall through to the build-time default.
  } catch {
    /* ignore */
  }
  return { enabled: DEBUG, explicit: false };
}

// Tracks two things the system swimlane would otherwise miss.
//
//   1. Stalls. setInterval fires every TICK_MS. When the actual delta
//      to the previous tick exceeds TICK_MS + STALL_THRESHOLD_MS the
//      event loop was blocked for the excess. Emits
//      `main:stall_detected` with the stall duration, one event
//      per stall regardless of how long the thread was frozen.
//
//   2. Heartbeats. Every HEARTBEAT_INTERVAL_MS we emit a low-cost
//      `main:heartbeat` marker so the swimlane shows a steady
//      rhythm ("host is alive"). Gaps in the rhythm are visible
//      even without the stall_detected event.
//
// Scope: only runs while debug is enabled, and only for the first
// MAX_MONITOR_MS (120 s by default) or until the primary bridge
// has exchanged traffic in both directions, whichever comes first.
// After that the monitor emits `main:monitor_stopped` and clears
// itself so it doesn't burn cycles for the rest of the session.
type EmitFn = (e: DotliDebugEvent) => void;

function startMainThreadMonitor(flowId: string, emit: EmitFn): void {
  const TICK_MS = 50;
  const STALL_THRESHOLD_MS = 150; // alert when loop was blocked > 150ms extra
  const HEARTBEAT_INTERVAL_MS = 2_000;
  const MAX_MONITOR_MS = 120_000;

  const startedAt = performance.now();
  let lastTick = performance.now();
  let lastHeartbeat = startedAt;

  const handle = setInterval(() => {
    const now = performance.now();
    const delta = now - lastTick;
    const lag = delta - TICK_MS;

    if (lag > STALL_THRESHOLD_MS) {
      emit({
        layer: "main",
        event: "stall_detected",
        flowId,
        timestamp: Date.now(),
        payload: { durationMs: Math.round(lag) },
      });
    }

    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      emit({
        layer: "main",
        event: "heartbeat",
        flowId,
        timestamp: Date.now(),
        payload: {
          uptimeSec: Math.round((now - startedAt) / 1000),
        },
      });
    }

    lastTick = now;

    if (now - startedAt > MAX_MONITOR_MS) {
      clearInterval(handle);
      window.removeEventListener("dotli:debug:bridge-ready", onBridgeReady);
      emit({
        layer: "main",
        event: "monitor_stopped",
        flowId,
        timestamp: Date.now(),
        payload: { reason: "max_duration" },
      });
    }
  }, TICK_MS);

  // Stop once the primary bridge has fully handshaken. The bridge
  // dispatches a window event from its first-outbound emit site.
  const onBridgeReady = (): void => {
    clearInterval(handle);
    window.removeEventListener("dotli:debug:bridge-ready", onBridgeReady);
    emit({
      layer: "main",
      event: "monitor_stopped",
      flowId,
      timestamp: Date.now(),
      payload: { reason: "bridge_ready" },
    });
  };
  window.addEventListener("dotli:debug:bridge-ready", onBridgeReady, {
    once: true,
  });
}

/**
 * Accept `{ type: "dotli:debug-event", event: DotliDebugEvent }` from
 * any child iframe (specifically the sandbox at `<label>.app.dot.li`) and
 * push the payload into the local debug bus.
 *
 * The sandbox lives on a different origin and can't touch the host's
 * `emitDotliDebugEvent` directly, so it posts messages instead. We
 * validate the envelope (must be an object with a `sandbox` layer) and
 * ignore anything else. This listener sees the full `window.message`
 * stream, so non-debug TrUAPI and loading-status messages must pass
 * through cleanly.
 */
function listenForSandboxDebugEvents(emit: EmitFn): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as
      | { type?: unknown; event?: unknown }
      | null
      | undefined;
    if (
      data === null ||
      data === undefined ||
      typeof data !== "object" ||
      data.type !== "dotli:debug-event"
    ) {
      return;
    }
    const payload = data.event as
      | (DotliDebugEvent & { layer?: unknown })
      | null
      | undefined;
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== "object" ||
      payload.layer !== "sandbox"
    ) {
      return;
    }
    try {
      emit(payload);
      // eslint-disable-next-line no-restricted-syntax -- best-effort forwarder; a malformed event from the sandbox must never break the host.
    } catch {
      /* ignore: a malformed event shouldn't kill the host */
    }
  });
}

/** SWR pass after fast-path render. Re-resolves, updates cache, surfaces a reload notice on change. */
async function runBackgroundRevalidate(
  label: string,
  servedCid: string,
  chainBackend: Backend,
): Promise<void> {
  const stopTimer = m.timer(S.CACHE_REVALIDATE_LATENCY);
  try {
    let freshCid: string | null;
    if (chainBackend !== "rpc-gateway") {
      const { resolveDotNameRemote } = await import("@dotli/protocol/client");
      freshCid = await resolveDotNameRemote(label);
    } else {
      const { resolveDotNameViaRpc } =
        await import("@dotli/resolver/rpc-resolve");
      freshCid = await resolveDotNameViaRpc(label);
    }
    stopTimer();
    const outcome = await recordRevalidateOutcome(label, servedCid, freshCid);
    if (outcome.kind === "update") {
      log.warn(
        `[dot.li cid-cache] revalidate: ${label} updated ${servedCid} -> ${outcome.cid}`,
      );
      showNotification({
        label: "New version available",
        text: "This site has been updated. Reload to see the latest version.",
        dismissMs: 0,
        action: {
          label: "Reload",
          onClick: () => {
            window.location.reload();
          },
        },
      });
    } else if (outcome.kind === "cleared") {
      // Owner unset the pointer. Cache is already evicted, so reload to show the cold-path error.
      log.warn(
        `[dot.li cid-cache] revalidate: ${label} cleared on-chain, reloading`,
      );
      window.location.reload();
    }
  } catch (err) {
    stopTimer();
    m.count(S.CACHE_REVALIDATE_ERROR);
    log.warn(`[dot.li cid-cache] revalidate failed for ${label}:`, err);
    captureException(err, { kind: "cid_cache_revalidate_error" });
  }
}

interface AuthSubscribeApi {
  backend: string;
  subscribeAll: (
    topicsHex: string[],
    timeoutMs: number,
  ) => Promise<{ count: number; isComplete: boolean }>;
  subscribeAny: (
    topicsHex: string[],
    timeoutMs: number,
  ) => Promise<{ count: number; isComplete: boolean }>;
}

function hexToBytes(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function runAuthSubscribeHook(chainBackend: string): Promise<void> {
  log.warn("[dot.li auth-subscribe] init auth + statement store");
  const authMod = await import("@dotli/auth/auth");
  await authMod.initAuth();
  const store = await authMod.onStatementStoreReady();

  type Filter = { matchAll: Uint8Array[] } | { matchAny: Uint8Array[] };

  function subscribeFor(
    filter: Filter,
    timeoutMs: number,
  ): Promise<{ count: number; isComplete: boolean }> {
    return new Promise((resolve) => {
      let count = 0;
      let lastIsComplete = false;
      const unsub = store.subscribeStatements(filter, (page) => {
        count += page.statements.length;
        lastIsComplete = page.isComplete;
        return undefined;
      });
      setTimeout(() => {
        unsub();
        resolve({ count, isComplete: lastIsComplete });
      }, timeoutMs);
    });
  }

  const api: AuthSubscribeApi = {
    backend: chainBackend,
    subscribeAll: (topicsHex, timeoutMs) =>
      subscribeFor({ matchAll: topicsHex.map(hexToBytes) }, timeoutMs),
    subscribeAny: (topicsHex, timeoutMs) =>
      subscribeFor({ matchAny: topicsHex.map(hexToBytes) }, timeoutMs),
  };

  (
    window as unknown as { __dotliAuthSubscribe: AuthSubscribeApi }
  ).__dotliAuthSubscribe = api;
  log.warn(
    `[dot.li auth-subscribe] window.__dotliAuthSubscribe ready (backend=${chainBackend})`,
  );
  document.title = "dotli-auth-subscribe-ready";
}

/** Best-effort `localStorage.getItem`, returning null on Safari-private-mode failure. */
function readRawLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Reconcile URL > shared > localStorage > default per axis, persist back
 * to URL, localStorage, and (for shared axes) the cross-subdomain store,
 * then wipe and reload (matching the modal Save flow) when a URL value
 * displaces a prior persisted choice.
 */
async function applyUrlSettings(): Promise<void> {
  const search = new URLSearchParams(window.location.search);
  const parsed = parseSettingsFromSearch(search);

  // Snapshot raw localStorage before bootstrap (and before `getNetwork`/
  // `getBackend`/`getCacheSettings` below). Those calls auto-seed defaults
  // on first read, which would make every fresh-subdomain visit look like a
  // "change" and trigger an unnecessary wipe.
  const hadPriorPersisted =
    readRawLocalStorage(NETWORK_KEY) !== null ||
    readRawLocalStorage(BACKEND_KEY) !== null ||
    readRawLocalStorage(CACHE_KEY) !== null;

  const rawUrlBackend = search.get("chainBackend");
  const rawPersistedBackend = readRawLocalStorage(BACKEND_KEY);
  const sharedWorkerFallback =
    !isSharedWorkerAvailable() &&
    (rawUrlBackend === "smoldot-shared-worker" ||
      rawPersistedBackend === "smoldot-shared-worker");

  // Bootstrap shared mode BEFORE reading prior values, so `prior.chain` /
  // `prior.cache` reflect the cross-subdomain shared store (production) or
  // per-origin localStorage (localhost). The swapped adapter also mirrors
  // any subsequent `setBackend` / `setCacheSettings` calls below to the
  // shared store, so URL-driven changes propagate across subdomains.
  try {
    const { bootstrapSharedMode } = await import("@dotli/ui/shared-mode");
    await bootstrapSharedMode();
  } catch (err: unknown) {
    log.warn(
      "[dot.li perf] Shared mode bootstrap failed; continuing with per-origin localStorage:",
      err instanceof Error ? err.message : err,
    );
  }

  const prior = {
    network: getNetwork(),
    chain: getBackend(),
    cache: getCacheSettings(),
  };

  const next = {
    network: parsed.network ?? prior.network,
    chain: parsed.chainBackend ?? prior.chain,
    cache: {
      skipArchiveCache: parsed.skipArchiveCache ?? prior.cache.skipArchiveCache,
      skipCidCache: parsed.skipCidCache ?? prior.cache.skipCidCache,
      skipWorkerCache: parsed.skipWorkerCache ?? prior.cache.skipWorkerCache,
    },
  };

  setNetwork(next.network);
  setBackend(next.chain);
  setCacheSettings(next.cache);

  if (
    writeSettingsToSearch(
      { network: next.network, chainBackend: next.chain, cache: next.cache },
      search,
    )
  ) {
    const query = search.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", newUrl);
  }

  if (sharedWorkerFallback) {
    showNotification({
      label: "Light Client Shared unavailable",
      text: "This browser doesn't support Light Client Shared. Falling back to Light Client Per-Tab.",
      dismissMs: 5_000,
    });
  }

  const changed =
    next.network !== prior.network ||
    next.chain !== prior.chain ||
    next.cache.skipArchiveCache !== prior.cache.skipArchiveCache ||
    next.cache.skipCidCache !== prior.cache.skipCidCache ||
    next.cache.skipWorkerCache !== prior.cache.skipWorkerCache;

  // On production, bootstrap loaded the protocol iframe with `prior.chain`
  // before applyUrlSettings switched it to `next.chain`, so tear it down so
  // the next `ensureProtocolFrame()` rebuilds it in the new sub-mode.
  // (No-op on localhost, where the HTTP channel never loaded an iframe.)
  if (prior.chain !== next.chain) {
    const { resetProtocolFrame } = await import("@dotli/protocol/client");
    resetProtocolFrame();
  }

  // Same logic for the trusted-RPC path's cached `chainHead_v1_follow`.
  if (prior.chain !== next.chain || prior.network !== next.network) {
    try {
      const r = await import("@dotli/resolver/rpc-resolve");
      r.destroyRpcClient();
      // eslint-disable-next-line no-restricted-syntax -- defensive teardown: the rpc-resolve module may not have been imported yet on this boot, in which case there is nothing to destroy.
    } catch {
      /* not loaded yet */
    }
  }

  // Fresh origins have nothing to be stale about, and no-op URLs (match
  // localStorage) leave existing state intact.
  if (!changed || !hadPriorPersisted) {
    return;
  }

  // Wipe host origin and signal the other two origins to purge themselves
  // on their next boot. wipeOriginState clears localStorage, so capture
  // the theme and the just-written settings and re-persist them.
  const theme = readRawLocalStorage("dotli-theme");
  await wipeOriginState();
  setNetwork(next.network);
  setBackend(next.chain);
  setCacheSettings(next.cache);
  if (theme === "light" || theme === "dark") {
    try {
      localStorage.setItem("dotli-theme", theme);
      // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable post-wipe in Safari private mode; theme restore is best-effort.
    } catch {
      /* localStorage unavailable */
    }
  }
  try {
    sessionStorage.setItem("dotli:pending-reset:protocol", "1");
    sessionStorage.setItem("dotli:pending-reset:sandbox", "1");
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); cross-origin purges are best-effort, reload below is unconditional.
  } catch {
    /* sessionStorage unavailable */
  }
  window.location.reload();
}

function switchBackendAndReload(nextBackend: Backend): void {
  setBackend(nextBackend);
  const search = new URLSearchParams(window.location.search);
  if (
    writeSettingsToSearch(
      {
        network: getNetwork(),
        chainBackend: nextBackend,
        cache: getCacheSettings(),
      },
      search,
    )
  ) {
    const query = search.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", newUrl);
  }
  window.location.reload();
}

async function main(): Promise<void> {
  const previewTargetUrl = parsePreviewTargetUrl(window.location);

  // Guard: if running inside an iframe, bail out to avoid a nested
  // dot.li instance with a duplicate topbar.
  if (window.self !== window.top && previewTargetUrl === null) {
    return;
  }

  performance.mark("dotli:main:start");
  log.warn(`[dot.li perf] main() started (${elapsed(T0)})`);

  // Runtime-gated: the panel ships in every build but the heavy chunk
  // is only fetched when the user opts in via `?debug=true` (set by the
  // "Open in debug mode" Settings button) or a persisted sessionStorage
  // entry. When disabled, the bus stays in its null-stub state and
  // every `emitDotliDebugEvent` call throughout main() early-exits.
  //
  // `?debug=off` and sessionStorage still let users silence the panel
  // on a per-tab basis after enabling it.
  const { emitDotliDebugEvent, enableDotliDebugBuffering } =
    await import("@dotli/truapi-debug/dotli-debug-bus");
  const debugMode = resolveTruapiDebugMode();
  if (debugMode.enabled) {
    enableDotliDebugBuffering();
    void import("@dotli/truapi-debug/panel").then(
      ({ setupTruapiDebugPanel }) => {
        setupTruapiDebugPanel({ startCollapsed: !debugMode.explicit });
        log.warn(`[dot.li] TrUAPI debug panel enabled`);
      },
    );
  }

  // Per-tab boot flow id. Every boot/resolve/render/bridge event from
  // this page load carries the same id so the debug panel can group
  // them into one box.
  const bootFlowId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `boot-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;

  // Main-thread monitor. Polls at 50ms, and any delta > 200ms means the
  // event loop was blocked for `durationMs - 50ms`. Heartbeats land
  // every 2 seconds so the system swimlane shows "host still alive"
  // even when nothing else is happening. The monitor stops once the
  // bridge has exchanged traffic in both directions (first outbound
  // response posted) or after MAX_MONITOR_MS, whichever comes
  // first.
  if (debugMode.enabled) {
    startMainThreadMonitor(bootFlowId, emitDotliDebugEvent);
    // Forward sandbox-origin debug events up to the host's debug bus so
    // the "what is the product iframe doing?" window (SW register,
    // cache lookup, archive fetch, decrypt, document.write) is visible
    // in the same System swimlane as the host's own events.
    listenForSandboxDebugEvents(emitDotliDebugEvent);
  }

  // Seed settings from URL params before any consumer reads them, so the
  // protocol pre-warm and downstream getters see the resolved values.
  // `applyUrlSettings` also runs the shared-mode bootstrap (so prior values
  // pick up cross-subdomain state and URL writes mirror to the shared
  // store). The await blocks if a URL-driven change forces a wipe and
  // reload. The reload then replaces the page, so anything below it never
  // runs.
  await applyUrlSettings();

  const chainBackend = getBackend();
  const cacheSettings = getCacheSettings();
  emitDotliDebugEvent({
    layer: "boot",
    event: "started",
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {
      chainBackend,
      skipCidCache: cacheSettings.skipCidCache,
      skipArchiveCache: cacheSettings.skipArchiveCache,
    },
  });
  log.warn(`[dot.li perf] chain=${chainBackend}`);
  m.setDefaults({
    chain_backend: chainBackend,
    skip_cid_cache: String(cacheSettings.skipCidCache),
    skip_archive_cache: String(cacheSettings.skipArchiveCache),
  });

  // Pre-warm the protocol iframe for every chain backend so sandboxed apps
  // that call `chainConnect` have a handler waiting on the other side. The
  // submode mapping is 1:1 with the chain backend.
  //   smoldot-shared-worker maps to "shared-worker"
  //   smoldot-direct        maps to "direct"
  //   rpc-gateway           maps to "rpc"
  {
    const subMode: "shared-worker" | "direct" | "rpc" =
      chainBackend === "smoldot-shared-worker"
        ? "shared-worker"
        : chainBackend === "smoldot-direct"
          ? "direct"
          : "rpc";
    // One-shot full-reset signal written by the settings popover before
    // reloading. Forces `skipWorkerCache` for this boot regardless of the
    // persisted cache preference, so the user's explicit "Save & Apply"
    // action guarantees a clean chain DB on the protocol origin.
    let pendingProtocolReset = false;
    try {
      if (sessionStorage.getItem("dotli:pending-reset:protocol") === "1") {
        pendingProtocolReset = true;
        sessionStorage.removeItem("dotli:pending-reset:protocol");
      }
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable (Safari private mode); reset flag falls back to false which is the safe default.
    } catch {
      /* sessionStorage unavailable: skip pending-reset pick up */
    }
    const protocolChunkPromise = import("@dotli/protocol/client");
    void protocolChunkPromise.then(
      ({ ensureProtocolFrame, warmupProtocol, setProtocolSubMode }) => {
        setProtocolSubMode(subMode, {
          skipWorkerCache:
            pendingProtocolReset || cacheSettings.skipWorkerCache,
        });
        void ensureProtocolFrame();
        void warmupProtocol();
      },
    );
    emitDotliDebugEvent({
      layer: "boot",
      event: "protocol_warmup_started",
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: { subMode },
    });
  }

  // Auth-subscribe hook: when `?initAuthSubscribe=1` is in the URL,
  // initialize the auth module and statement-store, expose
  // `window.__dotliAuthSubscribe` for the Playwright spec, then bail out
  // before the normal landing/.dot flow runs. The protocol iframe
  // pre-warm above is what makes `createRemoteChainProvider(...)` work
  // for the smoldot statement-store path, so this branch sits AFTER the
  // pre-warm.
  if (
    new URLSearchParams(window.location.search).get("initAuthSubscribe") === "1"
  ) {
    await runAuthSubscribeHook(chainBackend);
    return;
  }

  // Initialize top bar UI (auth is lazy-loaded inside topbar when needed)
  const t0 = performance.now();
  initTopBar();
  log.warn(`[dot.li perf] initTopBar() done (${dur(t0)})`);
  emitDotliDebugEvent({
    layer: "boot",
    event: "topbar_ready",
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {},
  });

  const label = parseDotLabel();

  if (label === null && previewTargetUrl !== null) {
    const host = new URL(previewTargetUrl).host;
    log.warn(`[dot.li perf] Preview route: ${host} (${elapsed(T0)})`);

    initScheduledNotifications({ label: host });

    const urlBar = document.getElementById("topbar-url");
    if (urlBar !== null) {
      urlBar.innerHTML = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="topbar-url-text"><span class="dot-domain">${escapeHtml(host)}</span></span></div>`;
    }

    const { renderIframe } = await import("@dotli/ui/bridge");
    await renderIframe(previewTargetUrl, host);
    history.replaceState(
      null,
      "",
      `/__preview?url=${encodeURIComponent(previewTargetUrl)}`,
    );
    document.title = `${host} — ${SITE_ID}`;
    performance.mark("dotli:main:end");
    return;
  }

  const localhostUrl = parseLocalhostUrl();
  emitDotliDebugEvent({
    layer: "boot",
    event: "url_parsed",
    flowId: bootFlowId,
    timestamp: Date.now(),
    payload: {
      label,
      localhostHost: localhostUrl === null ? null : new URL(localhostUrl).host,
      deepPath: window.location.pathname + window.location.search,
    },
  });
  if (label === null && localhostUrl !== null) {
    const host = new URL(localhostUrl).host;
    log.warn(`[dot.li perf] Localhost proxy: ${host} (${elapsed(T0)})`);

    initScheduledNotifications({ label: host });

    const urlBar = document.getElementById("topbar-url");
    if (urlBar !== null) {
      urlBar.innerHTML = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="topbar-url-text"><span class="dot-domain">${escapeHtml(host)}</span></span></div>`;
    }

    const { renderIframe } = await import("@dotli/ui/bridge");
    await renderIframe(localhostUrl, host);

    shieldVerified = true;
    bindTopbarAutoHide();
    setupTopbarAutoHide();

    // Deep path was forwarded to the product iframe, so strip it so the URL bar doesn't show a stale path
    history.replaceState(null, "", "/" + host);
    document.title = `${host} — ${SITE_ID}`;
    performance.mark("dotli:main:end");
    emitDotliDebugEvent({
      layer: "boot",
      event: "ready",
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label: null,
        totalMs: performance.now() - T0,
        path: "localhost",
      },
    });
    return;
  }

  if (label === null) {
    log.warn(`[dot.li perf] Landing page — no subdomain (${elapsed(T0)})`);
    showLanding();
    performance.mark("dotli:main:end");
    emitDotliDebugEvent({
      layer: "boot",
      event: "landing_page_shown",
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {},
    });
    return;
  }

  bindTopbarAutoHide();

  log.warn(`[dot.li perf] Subdomain detected: "${label}" (${elapsed(T0)})`);

  initScheduledNotifications({ label });

  // Pre-load render chunk in parallel (overlap with CID resolution)
  const renderChunkPromise: Promise<RenderChunk> = import("@dotli/ui/bridge");
  void renderChunkPromise.catch(() => {
    /* fire-and-forget */
  });

  // The topbar DOM nodes are required-by-contract invariants of
  // `index.html`. Their absence is a build/deploy bug, not a recoverable
  // runtime branch, so fail loud so monitoring catches it instead of silently
  // leaving the page in its initial loading state.
  const urlBar = document.getElementById("topbar-url");
  if (urlBar === null) {
    const err = new Error("Required DOM node missing: #topbar-url");
    captureException(err, { surface: "host_main_dom_invariant" });
    showError("UI failed to initialise", err.message);
    return;
  }
  urlBar.innerHTML = `<div class="topbar-url-pill" id="url-pill"><span class="verification-shield-wrap"><svg id="verification-shield" class="verification-shield" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-describedby="verification-tooltip"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><span class="verification-tooltip" id="verification-tooltip" role="tooltip"><span class="verification-tooltip-title">How was this site loaded?</span><span class="verification-tooltip-row"><span class="verification-tooltip-dot is-verified" aria-hidden="true"></span><strong class="verification-tooltip-label">Verified</strong><span class="verification-tooltip-desc">More secure, checked by your light client.</span></span><span class="verification-tooltip-row"><span class="verification-tooltip-dot is-trusted" aria-hidden="true"></span><strong class="verification-tooltip-label">Trusted</strong><span class="verification-tooltip-desc">Served by an external RPC provider.</span></span></span></span><span class="topbar-url-text"><span class="dot-domain">${escapeHtml(label)}</span><span class="dot-tld">.dot</span></span></div>`;

  // Listen for status messages from the sandbox iframe so the loading
  // UI continues seamlessly from resolution into content fetching.
  listenForSandboxStatus();

  // Relay sandbox `bitswap_v1_get` requests to the protocol iframe's smoldot.
  // The sandbox is on a different origin and can't postMessage the protocol
  // iframe directly. The host bridges the two so a single warm Bulletin
  // chain serves every sandbox load instead of cold-starting a second
  // smoldot per page.
  listenForSandboxBitswap();

  const shieldState: "verified" | "validating" = isVerifiedSession(chainBackend)
    ? "verified"
    : "validating";

  if (chainBackend === "smoldot-shared-worker") {
    initPhases(["Starting Worker", "Syncing", "Resolving"]);
  } else if (chainBackend === "smoldot-direct") {
    initPhases(["Starting", "Connecting", "Syncing", "Resolving"]);
  } else {
    initPhases(["Connecting", "Resolving"]);
  }
  advancePhase(0);
  showStatus(`Resolving ${label}.dot`);

  try {
    const cachedCid = cacheSettings.skipCidCache
      ? null
      : await getCachedCid(label);
    emitDotliDebugEvent({
      layer: "boot",
      event: "cid_cache_checked",
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: { label, hit: cachedCid !== null, cid: cachedCid ?? undefined },
    });
    if (cachedCid !== null) {
      m.count(S.CACHE_HIT);
      log.warn(
        `[dot.li resolve] path=cache (${chainBackend}) (${elapsed(T0)}) -> ${cachedCid}`,
      );
      // Wrap the warm-path render in a span so its duration is queryable
      // as `dotli.e2e.fast_path` alongside `dotli.e2e.slow_path`.
      await m.span(S.E2E_FAST, async () => {
        setShieldState(shieldState);
        const { renderAppSubdomain } = await renderChunkPromise;
        await renderAppSubdomain(cachedCid, label);
      });
      void applyProductBranding(label, chainBackend).catch((err: unknown) => {
        log.warn(
          `[dot.li manifest] branding failed for ${label}.dot: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      performance.mark("dotli:main:end");
      log.warn(`[dot.li perf] === TOTAL (fast path): ${dur(T0)} ===`);
      emitDotliDebugEvent({
        layer: "boot",
        event: "ready",
        flowId: bootFlowId,
        timestamp: Date.now(),
        payload: {
          label,
          totalMs: performance.now() - T0,
          path: "fast",
        },
      });
      // SWR: keep the cache honest across reloads without blocking the render.
      requestIdleCallback(() => {
        void runBackgroundRevalidate(label, cachedCid, chainBackend);
      });
      return;
    }
    m.count(S.CACHE_MISS);
    log.warn(`[dot.li perf] CID cache MISS (${elapsed(T0)})`);

    // One event per cold resolve attempt, BEFORE anything that can fail.
    Sentry.captureMessage("dotli.resolve_attempt", {
      level: "info",
      tags: {
        surface: "host_main_resolve",
        outcome: "pending",
        chain_backend: chainBackend,
      },
    });

    // Wall-clock cold-path duration, emitted as a trace_metric distribution
    // after success. The previous m.span wrapper recorded garbage on the
    // smoldot path (closure detachment across postMessage awaits).
    const coldStartMs = performance.now();
    performance.mark("dotli:resolve:start");
    const resolveStart = performance.now();

    const resolveFlowId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `resolve-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
    const resolveSource: "smoldot" | "rpc-gateway" =
      chainBackend !== "rpc-gateway" ? "smoldot" : "rpc-gateway";
    emitDotliDebugEvent({
      layer: "resolve",
      event: "started",
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: { label, source: resolveSource },
    });
    const emitPhase = (msg: string, phaseName: string): void => {
      emitDotliDebugEvent({
        layer: "resolve",
        event: "phase",
        flowId: resolveFlowId,
        timestamp: Date.now(),
        payload: { label, phase: phaseName, message: msg },
      });
    };

    /**
     * Try the app subname first, fall back to the base label when the
     * subname has no contenthash.
     */
    let cid: string | null;
    if (chainBackend !== "rpc-gateway") {
      log.warn(
        `[dot.li resolve] path=smoldot (trustless light-client) (${elapsed(T0)})`,
      );
      // After 10s of slow loading on the verified path, surface a one-click
      // escape to the gateway backend. The user trades the light-client
      // verification badge for a faster, trust-based load.
      const cancelGatewayEscape = showGatewayEscape(() => {
        m.count(S.GATEWAY_ESCAPE, { from_backend: chainBackend });
        switchBackendAndReload("rpc-gateway");
      });

      try {
        const { resolveDotNameRemote } = await import("@dotli/protocol/client");
        const { statusToPhase } = await import("@dotli/resolver/resolve");
        const onResolveProgress = (msg: string): void => {
          // Progress events arrive as opaque strings across the iframe
          // boundary. The resolver package owns the authoritative
          // mapping from status text to ResolvePhase, so we defer to it
          // instead of maintaining a parallel regex here.
          const phase = statusToPhase(msg);
          if (phase === "asset-hub-connecting") {
            advancePhase(1);
          } else if (
            phase === "asset-hub-syncing" ||
            phase === "asset-hub-ready"
          ) {
            advancePhase(2);
          } else if (phase === "resolving-content") {
            advancePhase(3);
          }
          emitPhase(msg, phase ?? "progress");
          showStatus(msg);
        };
        cid = await resolveDotNameRemote(`app.${label}`, onResolveProgress);
        if (cid === null) {
          cid = await resolveDotNameRemote(label, onResolveProgress);
          log.warn(
            `[dot.li resolve] fallback ${label}.dot contenthash -> ${cid ?? "null"}`,
          );
        }
      } finally {
        cancelGatewayEscape();
      }
    } else {
      log.warn(
        `[dot.li resolve] path=json-rpc (gateway mode) (${elapsed(T0)})`,
      );
      const { resolveDotNameViaRpc } =
        await import("@dotli/resolver/rpc-resolve");
      const onResolveProgress = (msg: string): void => {
        emitPhase(msg, "progress");
        showStatus(msg);
      };
      cid = await resolveDotNameViaRpc(`app.${label}`, onResolveProgress);
      if (cid === null) {
        cid = await resolveDotNameViaRpc(label, onResolveProgress);
        log.warn(
          `[dot.li resolve] fallback ${label}.dot contenthash -> ${cid ?? "null"}`,
        );
      }
    }

    emitDotliDebugEvent({
      layer: "resolve",
      event: "completed",
      flowId: resolveFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        source: resolveSource,
        cid,
        durationMs: performance.now() - resolveStart,
      },
    });

    stopStatusTick();
    performance.mark("dotli:resolve:end");
    log.warn(
      `[dot.li resolve] RESOLVED ${label}.dot via ${chainBackend} in ${dur(resolveStart)} (total ${elapsed(T0)}) -> ${cid ?? "null"}`,
    );

    if (cid === null) {
      showNoContentError(label);
      performance.mark("dotli:main:end");
      return;
    }

    if (!cacheSettings.skipCidCache) {
      requestIdleCallback(() => {
        void setCachedCid(label, cid);
      });
    }

    setShieldState(shieldState);

    const { renderAppSubdomain } = await renderChunkPromise;
    await renderAppSubdomain(cid, label);
    void applyProductBranding(label, chainBackend).catch((err: unknown) => {
      log.warn(
        `[dot.li manifest] branding failed for ${label}.dot: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    m.distribution(S.E2E_SLOW, performance.now() - coldStartMs, "millisecond", {
      outcome: "ok",
      chain_backend: chainBackend,
    });
    performance.mark("dotli:main:end");
    log.warn(`[dot.li perf] === TOTAL: ${dur(T0)} ===`);
    emitDotliDebugEvent({
      layer: "boot",
      event: "ready",
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        totalMs: performance.now() - T0,
        path: "slow",
      },
    });
  } catch (err) {
    performance.mark("dotli:main:end");
    // Report before rendering so monitoring always sees the root cause, even
    // if `showError()` itself throws (e.g. a DOM node is missing). The global
    // unhandled-rejection handler doesn't catch this, because the try/catch
    // here already has. Carry the active dependency as a tag so Sentry and the
    // user-visible error both attribute the failure to the specific
    // dependency the chosen mode dialed.
    const dependency =
      chainBackend === "rpc-gateway" ? "asset-hub-rpc" : "smoldot";
    captureException(err, {
      surface: "host_main_resolve",
      outcome: "error",
      dependency,
      chain_backend: chainBackend,
    });
    // Full cause chain to console for devs.
    log.error(
      `[dot.li] Resolution failed via ${dependency}: ${serializeError(err)}`,
    );
    emitDotliDebugEvent({
      layer: "boot",
      event: "failed",
      flowId: bootFlowId,
      timestamp: Date.now(),
      payload: {
        label,
        reason: err instanceof Error ? err.message : String(err),
        dependency,
      },
    });
    const error = describeError(err, chainBackend !== "rpc-gateway");
    if (error.recovery === "none") {
      showError("Domain can't be reached", error.message);
      return;
    }
    if (error.recovery === "reload") {
      showError("Domain can't be reached", error.message, {
        label: "Reload",
        onClick: () => {
          window.location.reload();
        },
      });
      return;
    }
    // Tiered failover: any smoldot becomes rpc-gateway, rpc-gateway becomes smoldot-shared-worker.
    const nextBackend =
      chainBackend === "rpc-gateway" ? "smoldot-shared-worker" : "rpc-gateway";
    const btnLabel = FAILOVER_BTN_LABELS[nextBackend];
    const svg = (paths: string): string =>
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const refreshIcon = svg(
      '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    );
    const switchIcon =
      nextBackend === "rpc-gateway"
        ? svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>')
        : svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>');
    showError("Domain can't be reached", error.message, [
      {
        label: REFRESH_BTN_LABEL,
        icon: refreshIcon,
        onClick: () => {
          window.location.reload();
        },
      },
      {
        label: btnLabel,
        icon: switchIcon,
        onClick: () => {
          emitDotliDebugEvent({
            layer: "failover",
            event: "chain_backend",
            flowId:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `fail-${String(Date.now())}`,
            timestamp: Date.now(),
            payload: {
              from: chainBackend,
              to: nextBackend,
              reason: err instanceof Error ? err.message : "resolution failed",
            },
          });
          switchBackendAndReload(nextBackend);
        },
      },
    ]);
  }
}

void main();
