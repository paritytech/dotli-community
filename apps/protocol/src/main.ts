// dot.li — Protocol host entry point
//
// Three modes, selected explicitly via `?mode=` URL parameter:
//   1. "shared-worker" — smoldot runs in a SharedWorker shared across tabs
//   2. "direct"        — smoldot runs in this iframe with no cross-tab coordination
//   3. "rpc"           — trusted WSS JSON-RPC to a public node (no smoldot),
//                        used by gateway mode to bridge sandboxed-app chain calls

import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
} from "@dotli/metrics/sentry";

// Do NOT silently reload on chunk preload failure. The protocol iframe is
// hidden and has no UI of its own, so it surfaces the failure to the parent
// via the standard error envelope. The parent will render the user-facing
// error.
window.addEventListener("vite:preloadError", (event) => {
  const evt = event as unknown as { payload?: unknown };
  captureException(evt.payload ?? new Error("vite:preloadError"), {
    kind: "chunk_preload_error",
    surface: "protocol_iframe",
  });
  if (window.parent !== window) {
    const msg =
      evt.payload instanceof Error
        ? evt.payload.message
        : "Asset failed to load";
    window.parent.postMessage(
      {
        namespace: "dotli:protocol",
        kind: "fatal",
        message: `Protocol iframe asset failed to load: ${msg}`,
      } as const,
      "*",
    );
  }
});
import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";
import type { StringJsonRpcConnection } from "@dotli/protocol/broker";
import {
  BASE_DOMAIN,
  MAX_CONNECTIONS_PER_ORIGIN,
  SITE_ID,
  TIMEOUTS,
  type SiteId,
} from "@dotli/config/config";
// Smoldot / relay-chain / dot-name resolver imports live behind
// `initDirectMode()` (dynamic) so `rpc` mode doesn't drag smoldot into the
// protocol iframe's initial chunk. The SharedWorker path doesn't import
// these either — smoldot for shared-worker mode lives inside
// `./protocol-shared-worker.ts`, which is already a separate bundle.
import {
  createRpcChainProvider,
  isRpcChainSupported,
} from "@dotli/resolver/rpc-chain";
import { log } from "@dotli/shared/log";
import { serializeError } from "@dotli/shared/errors";
import { createChainBrokerManager } from "@dotli/protocol/broker";
import {
  buildSharedAuthStorageKey,
  hasStoredSharedAuthSession,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedAuthStorageKey,
  SHARED_AUTH_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
import {
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from "@dotli/protocol/messages";
import type { SWRelayRequest, SWOutbound } from "./protocol-shared-worker";

initSentry("host");
installGlobalErrorHandlers("host");

import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";

// ── Origin validation (shared across all modes) ──────────────

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const hostname = self.location.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const port = self.location.port || "5173";
    origins.add(`http://localhost:${port}`);
    origins.add(`http://${hostname}:${port}`);
    return origins;
  }
  origins.add(`https://${BASE_DOMAIN}`);
  origins.add(`https://host.${BASE_DOMAIN}`);
  return origins;
}

function isAllowedOrigin(origin: string): boolean {
  const allowed = getAllowedOrigins();
  if (allowed.has(origin)) {
    return true;
  }
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith(`.${BASE_DOMAIN}`)) {
      return true;
    }
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
      return true;
    }
    // eslint-disable-next-line no-restricted-syntax -- `new URL()` throws on a malformed origin; the deny path (`return false`) is the correct response.
  } catch {
    /* invalid origin — deny */
  }
  return false;
}

function postToSource(
  source: MessageEventSource | null,
  origin: string,
  message: ProtocolEnvelope,
): void {
  if (!source) {
    return;
  }
  (source as Window).postMessage(message, origin);
}

// ── Shared-auth cross-tab broadcast ──────────────────────────
//
// The shared-auth path is intentionally handled on the host window (not in the
// SharedWorker) because it only needs `localStorage` — no smoldot, no chain.
// Each tab embeds its own host iframe, so when tab A writes a session, tab B's
// adapter subscribers need to be notified. We bridge tabs with a
// `BroadcastChannel` scoped to the host origin:
//
//   1. Tab A's host iframe receives an `authStorageWrite` request from its
//      parent and writes to localStorage.
//   2. Tab A's host iframe posts `{ siteId, key, value }` on the
//      `dotli:shared-auth` BroadcastChannel.
//   3. Tab B's host iframe (different window, same origin) receives the
//      broadcast and forwards it to *its* parent window via `postMessage` as
//      an `auth-storage-changed` envelope.
//   4. The parent window's protocol client dispatches to local subscribers.
//
// The originating tab does NOT receive its own BroadcastChannel message (per
// spec), so tab A's local subscribers fire via the in-process `emit` in
// `createSharedAuthStorageAdapter`'s `.map(() => emit(...))` chain — there is
// no double-dispatch.

const SHARED_AUTH_BROADCAST_CHANNEL = "dotli:shared-auth";

interface SharedAuthBroadcastMessage {
  siteId: SiteId;
  key: string;
  value: string | null;
}

const sharedAuthChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(SHARED_AUTH_BROADCAST_CHANNEL)
    : null;

// The origin of the parent window embedding this host iframe. Populated from
// `document.referrer` at module load (best-effort — may be blank under strict
// referrer policies) and refreshed on every validated shared-auth request.
// Broadcasts are only forwarded to the parent when we know its origin, so
// unrelated embedders never receive a shared-auth change notification.
let parentOrigin: string | null = initialParentOriginFromReferrer();

function initialParentOriginFromReferrer(): string | null {
  try {
    const ref = document.referrer;
    if (ref === "") {
      return null;
    }
    const origin = new URL(ref).origin;
    return isAllowedOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function broadcastSharedAuthChange(
  siteId: SiteId,
  key: string,
  value: string | null,
): void {
  if (sharedAuthChannel === null) {
    return;
  }
  try {
    const msg: SharedAuthBroadcastMessage = { siteId, key, value };
    sharedAuthChannel.postMessage(msg);
  } catch (error: unknown) {
    log.warn("[dot.li protocol] Shared auth broadcast failed:", error);
  }
}

function isSharedAuthBroadcastMessage(
  value: unknown,
): value is SharedAuthBroadcastMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as {
    siteId?: unknown;
    key?: unknown;
    value?: unknown;
  };
  return (
    typeof obj.siteId === "string" &&
    typeof obj.key === "string" &&
    (obj.value === null || typeof obj.value === "string")
  );
}

function bindSharedAuthBroadcastRelay(): void {
  if (sharedAuthChannel === null) {
    return;
  }
  sharedAuthChannel.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isSharedAuthBroadcastMessage(data)) {
      return;
    }
    // Only the current host's SiteId is valid (see `isSharedAuthSiteId`). We
    // still defensively filter here so stale broadcasts from a different
    // root domain (which shouldn't happen — the channel is origin-scoped)
    // cannot leak across trust boundaries.
    if (data.siteId !== SITE_ID) {
      return;
    }
    if (parentOrigin === null || window.parent === window) {
      return;
    }
    try {
      window.parent.postMessage(
        {
          namespace: "dotli:protocol",
          kind: "auth-storage-changed",
          siteId: data.siteId,
          key: data.key,
          value: data.value,
        } as const,
        parentOrigin,
      );
    } catch (error: unknown) {
      log.warn(
        "[dot.li protocol] Failed to forward shared auth change to parent:",
        error,
      );
    }
  });
}

function bindSharedAuthListener(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isProtocolEnvelope(data) ||
      data.kind !== "request" ||
      !isSharedAuthRequestMethod(data.method)
    ) {
      return;
    }
    // First gate: the broad protocol origin allowlist (`*.<BASE_DOMAIN>` +
    // localhost). The narrower shared-auth allowlist — which additionally
    // rejects `app.<BASE_DOMAIN>` and sandboxed SPA subdomains — runs inside
    // `handleSharedAuthRequest` via `assertSharedAuthOrigin`.
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected shared-auth request from disallowed origin: ${event.origin}`,
      );
      return;
    }
    // Remember the parent origin so cross-tab broadcast forwards target a
    // known origin rather than `*`. This runs on every request, not just the
    // first, so we tolerate (unlikely) parent navigations that replace the
    // embedding page.
    parentOrigin = event.origin;

    try {
      handleSharedAuthRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      postToSource(event.source, event.origin, {
        namespace: "dotli:protocol",
        kind: "response",
        id: data.id,
        ok: false,
        error: serializeError(error),
      });
    }
  });
}

function signalReady(): void {
  if (window.parent !== window) {
    window.parent.postMessage(
      { namespace: "dotli:protocol", kind: "ready" } as const,
      "*",
    );
  }
}

// ── Mode initialization (explicit, no auto-detection) ───────

type RequestedMode = "shared-worker" | "direct" | "rpc" | null;

/**
 * Distinguish "no mode requested" (auth-only iframe — legitimate) from
 * "mode requested but unrecognised" (host bug or URL-tampering — must
 * surface to the parent so the user sees a real error instead of a silent
 * downgrade to auth-only behavior).
 */
function getRequestedMode(): RequestedMode | "invalid" {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get("mode");
  } catch {
    return "invalid";
  }
  if (raw === null) {
    return null;
  }
  if (raw === "shared-worker" || raw === "direct" || raw === "rpc") {
    return raw;
  }
  return "invalid";
}

function getSkipWorkerCache(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("skipWorkerCache") === "1";
  } catch {
    return false;
  }
}

/**
 * Purge every IndexedDB on this origin that isn't one of ours. Covers
 * smoldot's internal chain DB + polkadot-api's caches — anything persisted
 * across page loads that could warm-start the runtime. The dot.li-owned
 * stores (`dotli`, `dotli-sw`) are preserved because they hold user state
 * (CID cache, shared auth), which is orthogonal to worker bootstrapping.
 *
 * Best-effort: some browsers don't expose `indexedDB.databases()` (Firefox
 * historically, Safari pre-17); on those, the skip still takes effect for
 * future writes but we can't proactively clear prior state.
 */
async function purgeWorkerCaches(): Promise<void> {
  // Throw on enumeration failure and await each delete: a silent log-and-
  // continue would let smoldot boot against the still-present stale DB.
  const KEEP = new Set(["dotli", "dotli-sw"]);
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  ) {
    throw new Error(
      "Browser does not expose indexedDB.databases() — cannot fully purge worker caches. " +
        "Please clear site data manually before retrying.",
    );
  }
  const dbs = await indexedDB.databases();
  const targets = dbs
    .map((db) => db.name)
    .filter(
      (name): name is string =>
        name !== undefined && name !== "" && !KEEP.has(name),
    );
  await Promise.all(
    targets.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => {
            resolve();
          };
          req.onerror = () => {
            reject(
              new Error(
                `Failed to delete IDB ${name}: ${req.error?.name ?? "unknown"}`,
                req.error ? { cause: req.error } : undefined,
              ),
            );
          };
          req.onblocked = () => {
            reject(
              new Error(`Delete of IDB ${name} blocked by another connection`),
            );
          };
        }),
    ),
  );
  log.warn("[dot.li protocol] Purged worker caches (skipWorkerCache)");
}

async function init(): Promise<void> {
  const mode = getRequestedMode();

  if (mode === "invalid") {
    let raw: string | null = null;
    try {
      raw = new URLSearchParams(window.location.search).get("mode");
      // eslint-disable-next-line no-restricted-syntax -- best-effort extraction of the offending mode value for the error message; the error is already signalled below regardless.
    } catch {
      /* URL parse failed — fall through with raw=null */
    }
    const message = `Unknown protocol mode: ${raw === null ? "<unparseable>" : `"${raw}"`}`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }

  // When no mode is requested, the iframe is only serving shared auth
  // storage requests (localStorage). No chain provider needed.
  if (mode === null) {
    log.warn(
      "[dot.li protocol] No mode requested — auth-only iframe, skipping chain provider",
    );
    signalReady();
    return;
  }

  // Worker-cache purge runs *before* any broker/smoldot init so the clean
  // state is what the chain client opens against. A purge failure when the
  // user explicitly requested skipWorkerCache MUST abort init — proceeding
  // against a stale DB would silently violate the user's setting.
  if (getSkipWorkerCache()) {
    try {
      await purgeWorkerCaches();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[dot.li protocol] purgeWorkerCaches failed:", err);
      signalError(`Failed to reset chain DB: ${message}`);
      return;
    }
  }

  const stopInit = m.timer(S.PROTOCOL_INIT);
  log.warn(`[dot.li protocol] Requested mode: ${mode}`);

  if (mode === "shared-worker") {
    if (typeof SharedWorker === "undefined") {
      const msg = "SharedWorker is not available in this browser";
      log.error(`[dot.li protocol] ${msg}`);
      signalError(msg);
      stopInit();
      return;
    }
    // Register protocol_mode as a session default before any further metrics
    // so bootnode errors, chain-connect failures etc. all carry the mode tag.
    // Values are kebab-case to match `DotliMode` + the `?mode=` URL convention
    // (see M-5: one naming convention across host + protocol).
    m.setDefaults({ protocol_mode: "shared-worker" });
    await initSharedWorkerMode();
    m.count(S.PROTOCOL_MODE, { mode: "shared-worker" });
  } else if (mode === "rpc") {
    m.setDefaults({ protocol_mode: "rpc" });
    initRpcMode();
    m.count(S.PROTOCOL_MODE, { mode: "rpc" });
  } else {
    m.setDefaults({ protocol_mode: "direct" });
    await initDirectMode();
    m.count(S.PROTOCOL_MODE, { mode: "direct" });
  }

  stopInit();
}

function signalError(message: string): void {
  // `init-failed` is a dedicated envelope — it has no `id` because no
  // request was in flight when init died. The client listens for this
  // alongside `fatal` and rejects every pending request + blocks new
  // work until the user reloads. The old `id: "__init__"` sentinel was
  // a collision hazard (any real request using that id would alias).
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        namespace: "dotli:protocol",
        kind: "init-failed",
        message,
      } as const,
      "*",
    );
  }
}

// ── Mode 1: SharedWorker relay ───────────────────────────────

async function initSharedWorkerMode(): Promise<void> {
  const swStartTime = performance.now();

  const worker = new SharedWorker(
    new URL("./protocol-shared-worker.ts", import.meta.url),
    { type: "module", name: "dotli-protocol" },
  );
  const port = worker.port;

  // Listen for SharedWorker errors (e.g. if the script fails to load)
  worker.addEventListener("error", (event) => {
    log.error("[dot.li protocol] SharedWorker error event:", event);
    m.count(S.BOOTNODE_ERROR, { source: "shared-worker" });
  });

  // Wait for SharedWorker to signal ready (or error)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waitMs = performance.now() - swStartTime;
      m.distribution(S.PROTOCOL_SW_READY, waitMs, "millisecond", {
        outcome: "timeout",
      });
      reject(new Error("SharedWorker did not signal ready within timeout"));
    }, TIMEOUTS.SHARED_WORKER_READY);

    function onMessage(event: MessageEvent): void {
      const data = event.data as SWOutbound | null;
      if (data?.type === "ready") {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
        const readyMs = performance.now() - swStartTime;
        m.measure(S.PROTOCOL_SW_READY, readyMs);
        m.distribution(S.PROTOCOL_SW_READY, readyMs, "millisecond", {
          outcome: "ok",
        });
        resolve();
      } else if (data?.type === "error") {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
        const failMs = performance.now() - swStartTime;
        m.distribution(S.PROTOCOL_SW_READY, failMs, "millisecond", {
          outcome: "error",
        });
        reject(new Error(`SharedWorker error: ${data.message}`));
      }
    }

    port.addEventListener("message", onMessage);
    port.start();
  });

  log.warn("[dot.li protocol] === SHARED WORKER MODE ACTIVE ===");
  log.warn(
    "[dot.li protocol] Smoldot runs in SharedWorker, persists across navigations",
  );

  // Relay: parent postMessage → SharedWorker
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (isSharedAuthRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
      );
      return;
    }

    const msg: SWRelayRequest = {
      type: "relay-request",
      envelope: data,
      origin: event.origin,
    };
    port.postMessage(msg);
  });

  // Relay: SharedWorker → parent
  port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as SWOutbound | null;
    if (data?.type === "relay-response" && window.parent !== window) {
      window.parent.postMessage(data.envelope, "*");
    }
  });

  signalReady();

  window.addEventListener("beforeunload", () => {
    log.warn(
      "[dot.li protocol] Iframe unloading, sending disconnect to SharedWorker",
    );
    try {
      port.postMessage({ type: "disconnect" });
      // eslint-disable-next-line no-restricted-syntax -- best-effort unload signal to the SharedWorker; the port may already be closed (browser tab unloading), which is the expected terminal state.
    } catch {
      /* port already closed on unload — safe */
    }
    port.close();
  });
}

// ── Direct mode ─────────────────────────────────────────────

async function initDirectMode(): Promise<void> {
  log.warn("[dot.li protocol] === DIRECT MODE ===");
  log.warn(
    "[dot.li protocol] Smoldot runs in this iframe with no cross-tab coordination",
  );

  // Dynamic imports so users in `rpc` or `shared-worker` submode don't pay
  // the smoldot / chain-specs bundle cost (D-1).
  const [
    { createChainProvider, isChainSupported },
    resolve,
    smoldotMod,
    bulletin,
  ] = await Promise.all([
    import("@dotli/resolver/chains"),
    import("@dotli/resolver/resolve"),
    import("@dotli/resolver/smoldot"),
    import("@dotli/resolver/bulletin"),
  ]);
  const { getRelayChain, getSmoldot, resolveDotName, resolveOwner } = resolve;
  const { terminateSmoldot, onSmoldotFatal } = smoldotMod;
  const { submitPreimageTransaction, getTestSigner } = bulletin;

  // Smoldot panic → broadcast fatal to parent. Direct mode has no
  // SharedWorker in the loop, so we post straight up to the host shell.
  onSmoldotFatal((message) => {
    log.error("[dot.li protocol] Smoldot panic detected, signaling fatal");
    if (window.parent !== window) {
      window.parent.postMessage(
        {
          namespace: "dotli:protocol",
          kind: "fatal",
          message,
        },
        "*",
      );
    }
  });

  const engine = createEngine({
    createChainProvider,
    isChainSupported,
    onInit: () => {
      getSmoldot();
    },
    onCleanup: () => {
      terminateSmoldot();
    },
    onWarmup: async () => {
      getSmoldot();
      await getRelayChain();
    },
    resolveDotName,
    resolveOwner,
    submitBulletinPreimage: (value) =>
      submitPreimageTransaction(value, getTestSigner()),
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
  });
}

// ── RPC mode (gateway) ──────────────────────────────────────
//
// No smoldot. Sandboxed app chain requests are bridged to a trusted WSS
// JSON-RPC endpoint via the shared broker. Name resolution in gateway mode
// happens in the host process (see `@dotli/resolver/rpc-resolve`), not via
// this iframe, so `resolveDotName` / `resolveOwner` requests aren't wired
// up here — the host never sends them when gateway is active.

function initRpcMode(): void {
  log.warn("[dot.li protocol] === RPC MODE ===");
  log.warn(
    "[dot.li protocol] Chain calls routed via WSS JSON-RPC (no smoldot)",
  );

  const engine = createEngine({
    createChainProvider: createRpcChainProvider,
    isChainSupported: isRpcChainSupported,
    // No onInit / onCleanup: the WS provider lifecycle is owned by the
    // broker's `ensureUpstream` / `disconnectAll`.
    // No resolver: gateway-mode resolution doesn't go through this iframe.
    submitBulletinPreimage: async (value) => {
      const bulletin = await import("@dotli/resolver/bulletin");
      await bulletin.submitPreimageTransaction(value, bulletin.getTestSigner());
    },
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener("beforeunload", () => {
    engine.cleanup();
  });
}

function bindEngineToMessages(engine: ProtocolEngine): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== "request") {
      return;
    }
    if (isSharedAuthRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(
        `[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`,
      );
      return;
    }

    void engine
      .handleRequest(data, event.origin, (response) => {
        postToSource(event.source, event.origin, response);
      })
      .catch((error: unknown) => {
        log.error("[dot.li protocol] Request failed:", error);
        postToSource(event.source, event.origin, {
          namespace: "dotli:protocol",
          kind: "response",
          id: data.id,
          ok: false,
          error: serializeError(error),
        });
      });
  });
}

// ── Protocol engine (used by direct mode) ────────────────────

type ResponseCallback = (envelope: ProtocolEnvelope) => void;

function assertSharedAuthSiteId(value: unknown): asserts value is SiteId {
  if (typeof value !== "string" || !isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertSharedAuthKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isSharedAuthStorageKey(value)) {
    throw new Error(`Invalid shared auth key: ${String(value)}`);
  }
}

function assertSharedAuthOrigin(origin: string): void {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Shared auth request denied from origin: ${origin}`);
  }
}

function handleSharedAuthRequest(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): void {
  if (!isSharedAuthRequestMethod(request.method)) {
    throw new Error(`Not a shared auth request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case "authHasSession": {
      const payload = request.payload as ProtocolRequestMap["authHasSession"];
      assertSharedAuthSiteId(payload.siteId);
      const value = localStorage.getItem(
        buildSharedAuthStorageKey(payload.siteId, SHARED_AUTH_SESSION_KEY),
      );
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: hasStoredSharedAuthSession(value),
      });
      return;
    }

    case "authStorageRead": {
      const payload = request.payload as ProtocolRequestMap["authStorageRead"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: localStorage.getItem(
          buildSharedAuthStorageKey(payload.siteId, payload.key),
        ),
      });
      return;
    }

    case "authStorageWrite": {
      const payload = request.payload as ProtocolRequestMap["authStorageWrite"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      if (typeof payload.value !== "string") {
        throw new Error("Invalid shared auth value");
      }
      localStorage.setItem(
        buildSharedAuthStorageKey(payload.siteId, payload.key),
        payload.value,
      );
      broadcastSharedAuthChange(payload.siteId, payload.key, payload.value);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case "authStorageClear": {
      const payload = request.payload as ProtocolRequestMap["authStorageClear"];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      localStorage.removeItem(
        buildSharedAuthStorageKey(payload.siteId, payload.key),
      );
      broadcastSharedAuthChange(payload.siteId, payload.key, null);
      respond({
        namespace: "dotli:protocol",
        kind: "response",
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

interface ProtocolEngine {
  handleRequest: (
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ) => Promise<void>;
  cleanup: () => void;
}

interface EngineOptions {
  /** Factory for a `JsonRpcProvider` keyed by genesis hash. */
  createChainProvider: (genesisHash: string) => JsonRpcProvider | null;
  /** Whether the given genesis hash is handled by this engine. */
  isChainSupported: (genesisHash: string) => boolean;
  /** Called once at engine creation — e.g. to kick off smoldot pre-sync. */
  onInit?: () => void;
  /** Called at cleanup time after broker teardown. */
  onCleanup?: () => void;
  /** Called on `warmup` requests. If omitted, `warmup` resolves immediately. */
  onWarmup?: () => Promise<void>;
  /** Resolver implementations. If omitted, resolution methods reject with a
   *  clear error so hanging callers surface fast. */
  resolveDotName?: (
    label: string,
    onStatus: (message: string) => void,
  ) => Promise<string | null>;
  resolveOwner?: (label: string) => Promise<string | null>;
  /** Bulletin Paseo preimage submission. */
  submitBulletinPreimage?: (value: Uint8Array) => Promise<void>;
}

function createEngine(options: EngineOptions): ProtocolEngine {
  const MAX_CONNS = 10;
  const connections = new Map<string, StringJsonRpcConnection>();
  const originConns = new Map<string, Set<string>>();
  const broker = createChainBrokerManager(options.createChainProvider);
  options.onInit?.();

  function assertStr(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid ${name}: expected non-empty string`);
    }
  }

  async function handleRequest(
    request: ProtocolRequestEnvelope,
    origin: string,
    respond: ResponseCallback,
  ): Promise<void> {
    if (isSharedAuthRequestMethod(request.method)) {
      handleSharedAuthRequest(request, origin, respond);
      return;
    }

    switch (request.method) {
      case "warmup": {
        if (options.onWarmup) {
          await options.onWarmup();
        }
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "resolveDotName": {
        if (!options.resolveDotName) {
          throw new Error("resolveDotName is not served by this protocol mode");
        }
        const payload = request.payload as ProtocolRequestMap["resolveDotName"];
        assertStr(payload.label, "label");
        const result = await options.resolveDotName(
          payload.label,
          (message) => {
            respond({
              namespace: "dotli:protocol",
              kind: "progress",
              id: request.id,
              message,
            });
          },
        );
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "resolveOwner": {
        if (!options.resolveOwner) {
          throw new Error("resolveOwner is not served by this protocol mode");
        }
        const payload = request.payload as ProtocolRequestMap["resolveOwner"];
        assertStr(payload.label, "label");
        const result = await options.resolveOwner(payload.label);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result,
        });
        return;
      }

      case "chainConnect": {
        const payload = request.payload as ProtocolRequestMap["chainConnect"];
        assertStr(payload.genesisHash, "genesisHash");
        assertStr(payload.connectionId, "connectionId");
        if (connections.size >= MAX_CONNS) {
          throw new Error(
            `Connection limit reached (max ${String(MAX_CONNS)})`,
          );
        }
        const oc = originConns.get(origin) ?? new Set<string>();
        if (oc.size >= MAX_CONNECTIONS_PER_ORIGIN) {
          throw new Error(
            `Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`,
          );
        }
        if (!options.isChainSupported(payload.genesisHash)) {
          throw new Error(`Unsupported chain: ${payload.genesisHash}`);
        }
        const connection = broker.connectRemote(
          payload.genesisHash,
          payload.connectionId,
          (message) => {
            respond({
              namespace: "dotli:protocol",
              kind: "chain-message",
              connectionId: payload.connectionId,
              message,
            });
          },
        );
        if (connection === null) {
          throw new Error("Failed to create chain broker");
        }
        connections.set(payload.connectionId, connection);
        oc.add(payload.connectionId);
        originConns.set(origin, oc);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "chainSend": {
        const payload = request.payload as ProtocolRequestMap["chainSend"];
        assertStr(payload.connectionId, "connectionId");
        assertStr(payload.message, "message");
        const conn = connections.get(payload.connectionId);
        if (conn === undefined) {
          throw new Error(`Unknown chain connection: ${payload.connectionId}`);
        }
        conn.send(payload.message);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "chainDisconnect": {
        const payload =
          request.payload as ProtocolRequestMap["chainDisconnect"];
        assertStr(payload.connectionId, "connectionId");
        const conn = connections.get(payload.connectionId);
        conn?.disconnect();
        connections.delete(payload.connectionId);
        for (const [orig, conns] of originConns) {
          conns.delete(payload.connectionId);
          if (conns.size === 0) {
            originConns.delete(orig);
          }
        }
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      case "bulletinSubmitPreimage": {
        if (!options.submitBulletinPreimage) {
          throw new Error(
            "bulletinSubmitPreimage is not served by this protocol mode",
          );
        }
        const payload =
          request.payload as ProtocolRequestMap["bulletinSubmitPreimage"];
        if (!(payload.value instanceof Uint8Array)) {
          throw new Error("Invalid value: expected Uint8Array");
        }
        await options.submitBulletinPreimage(payload.value);
        respond({
          namespace: "dotli:protocol",
          kind: "response",
          id: request.id,
          ok: true,
          result: true,
        });
        return;
      }

      default: {
        const _method: never = request.method;
        throw new Error(`Unknown protocol method: ${_method as string}`);
      }
    }
  }

  function cleanup(): void {
    for (const conn of connections.values()) {
      conn.disconnect();
    }
    connections.clear();
    originConns.clear();
    broker.disconnectAll();
    options.onCleanup?.();
  }

  return { handleRequest, cleanup };
}

// ── Boot ─────────────────────────────────────────────────────

bindSharedAuthListener();
bindSharedAuthBroadcastRelay();

void init().catch((err: unknown) => {
  log.error("[dot.li protocol] Init failed:", err);
  signalError(err instanceof Error ? err.message : String(err));
});
