// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";
import { ProtocolFatalError, ProtocolInitFailedError } from "./errors";
import type {
  ExecutableManifest,
  ManifestResult,
  RootManifest,
} from "@dotli/resolver/manifest";
import { BASE_DOMAIN, type SiteId } from "@dotli/config/config";
import {
  getActiveGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
  getNetwork,
} from "@dotli/config/network";
import { getBackend, type Backend } from "@dotli/config/mode";
import { log } from "@dotli/shared/log";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import {
  isProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolRequestMethod,
} from "./messages";
import {
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
} from "./auth-storage";
import { serializeError } from "@dotli/shared/errors";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (message: string) => void;
}

interface RemoteChainConnection {
  onMessage: (message: JsonRpcMessage) => void;
  pendingMessages: JsonRpcRequest[];
  connected: boolean;
}

export interface SharedAuthStorageChange {
  siteId: SiteId;
  key: string;
  value: string | null;
}

export type SharedAuthStorageListener = (
  change: SharedAuthStorageChange,
) => void;

let protocolIframe: HTMLIFrameElement | null = null;
let hostFramePromise: Promise<void> | null = null;
let protocolReadyPromise: Promise<void> | null = null;
const pendingRequests = new Map<string, PendingRequest>();
const chainConnections = new Map<string, RemoteChainConnection>();
const sharedAuthListeners = new Set<SharedAuthStorageListener>();
let listenerBound = false;
let protocolReady = false;
interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}
let pendingReadyResolvers: ReadyWaiter[] = [];

/** Sub-mode to pass to the protocol iframe. `null` means the iframe is
 *  only needed for shared auth, with no chain provider at all.
 *
 *  `"shared-worker"` and `"direct"` are P2P (smoldot-backed) submodes.
 *  `"rpc"` is the gateway submode: chain calls are bridged over trusted
 *  WSS JSON-RPC instead of smoldot. */
type ProtocolSubMode = "shared-worker" | "direct" | "rpc";
let protocolSubMode: ProtocolSubMode | null = null;

/** Map the user-facing `Backend` to the protocol iframe sub-mode.
 *  The iframe doesn't carry the `smoldot-` / `rpc-gateway` prefix.
 *  That prefix already lives on the chain side of the boundary. */
function backendToSubMode(backend: Backend): ProtocolSubMode {
  if (backend === "smoldot-shared-worker") {
    return "shared-worker";
  }
  if (backend === "smoldot-direct") {
    return "direct";
  }
  return "rpc";
}

/** When true, ask the protocol iframe to purge its IDB caches before
 *  starting up, i.e. every cold start from scratch, no warm-start state. */
let protocolSkipWorkerCache = false;

/**
 * Set the sub-mode for the protocol iframe.
 */
export function setProtocolSubMode(
  mode: ProtocolSubMode,
  opts: { skipWorkerCache?: boolean } = {},
): void {
  protocolSubMode = mode;
  protocolSkipWorkerCache = opts.skipWorkerCache === true;
}

export function getProtocolOrigin(): string {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    const port =
      window.location.port.length > 0 ? window.location.port : "5173";
    return `http://host.localhost:${port}`;
  }
  return `https://host.${BASE_DOMAIN}`;
}

function resolveProtocolReady(): void {
  if (protocolReady) {
    return;
  }
  protocolReady = true;
  const resolvers = pendingReadyResolvers;
  pendingReadyResolvers = [];
  for (const waiter of resolvers) {
    waiter.resolve();
  }
}

/**
 * Tear down the cached iframe and ready state so the next request creates
 * a fresh one. Exposed for callers (e.g. the shared-mode bootstrap) that
 * may discover after the initial iframe load that the chosen sub-mode
 * was wrong and need a clean restart before chain operations run.
 *
 * Side effects callers should be aware of:
 *   - Any in-flight `postRequest()` whose response hasn't arrived will be
 *     orphaned: it will time out via the per-method timer instead of
 *     completing. Callers that have outstanding work should expect those
 *     rejections.
 *   - Any `waitForProtocolReady()` waiter is rejected immediately rather
 *     than waiting for `IFRAME_READY_TIMEOUT_MS`.
 *   - In `shared-worker` mode, removing the iframe drops its
 *     `SharedWorker` port too. The SharedWorker itself stays alive (it's
 *     shared across tabs), but this tab's connection cycles. Its pre-sync
 *     progress is preserved on the worker side, while the local `port` is
 *     gone and the next iframe load reopens a fresh one.
 */
export function resetProtocolFrame(): void {
  resetProtocolFrameState();
}

function resetProtocolFrameState(reason?: Error): void {
  protocolIframe?.remove();
  protocolIframe = null;
  hostFramePromise = null;
  protocolReadyPromise = null;
  protocolReady = false;
  // Reject any callers blocked on `waitForProtocolReady()` before we drop the
  // resolvers. Otherwise their promises would hang until the 120s timeout.
  const orphaned = pendingReadyResolvers;
  pendingReadyResolvers = [];
  if (orphaned.length > 0) {
    const err =
      reason ?? new Error("Protocol frame state reset before ready signal");
    for (const waiter of orphaned) {
      waiter.reject(err);
    }
  }
}

function bindMessageListener(): void {
  if (listenerBound) {
    return;
  }
  listenerBound = true;

  window.addEventListener("message", (event: MessageEvent) => {
    if (!isProtocolEnvelope(event.data)) {
      return;
    }

    if (event.origin !== getProtocolOrigin()) {
      return;
    }

    const frameWindow = protocolIframe?.contentWindow;
    if (
      frameWindow !== null &&
      frameWindow !== undefined &&
      event.source !== frameWindow
    ) {
      return;
    }

    const msg = event.data;
    switch (msg.kind) {
      case "progress":
        pendingRequests.get(msg.id)?.onProgress?.(msg.message);
        return;
      case "response": {
        const pending = pendingRequests.get(msg.id);
        if (!pending) {
          return;
        }
        pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          const err = new Error(msg.error || "Unknown protocol error");
          err.name = "ProtocolResponseError";
          pending.reject(err);
        }
        return;
      }
      case "fatal":
      case "init-failed": {
        // Smoldot (or the protocol iframe) has died, either crashed
        // mid-session (`fatal`) or failed to come up at all
        // (`init-failed`). Either way every in-flight request is
        // orphaned: the chain is gone, nothing will ever respond.
        const kind = msg.kind === "fatal" ? "Fatal" : "Init failed";
        log.error(`[dot.li protocol] ${kind}: ${msg.message}`);
        const err =
          msg.kind === "fatal"
            ? new ProtocolFatalError(`${kind}: ${msg.message}`)
            : new ProtocolInitFailedError(`${kind}: ${msg.message}`);

        // Reject each pending request with the underlying cause so the
        // loading UI fails fast instead of spinning until per-request
        // timeouts.
        for (const [id, pending] of pendingRequests) {
          pendingRequests.delete(id);
          pending.reject(err);
        }

        // Route through the same reset path used by iframe load failures
        // so callers blocked on `waitForProtocolReady()`
        // (`pendingReadyResolvers`) are rejected immediately rather than
        // hanging until `IFRAME_READY_TIMEOUT_MS` even though the chain is
        // already known dead. This also clears the iframe,
        // `hostFramePromise`, and `protocolReadyPromise` so the next
        // `ensureProtocolFrame()` call can attempt a clean re-boot (e.g.
        // after the user switches settings) instead of being stuck on a
        // poisoned cached rejection.
        resetProtocolFrameState(err);
        return;
      }
      case "chain-message": {
        const conn = chainConnections.get(msg.connectionId);
        if (!conn) {
          log.warn(
            `[dot.li protocol] chain-message for unknown connectionId: ${msg.connectionId} (known: ${[...chainConnections.keys()].join(", ")})`,
          );
          return;
        }
        // Envelope ships `message` as a string. The provider contract
        // wants the consumer to receive a parsed `JsonRpcMessage`.
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(msg.message) as JsonRpcMessage;
        } catch (err: unknown) {
          log.error(
            `[dot.li protocol] chain-message JSON parse failed (conn=${msg.connectionId.slice(-8)}):`,
            err instanceof Error ? err.message : err,
          );
          return;
        }
        try {
          conn.onMessage(parsed);
        } catch (err: unknown) {
          log.error(
            `[dot.li protocol] onMessage threw (conn=${msg.connectionId.slice(-8)}):`,
            err instanceof Error ? err.message : err,
          );
        }
        return;
      }
      case "chain-halt":
        chainConnections.delete(msg.connectionId);
        return;
      case "request":
        // Ignore inbound requests on the client side
        return;
      case "ready":
        resolveProtocolReady();
        return;
      case "auth-storage-changed": {
        const change: SharedAuthStorageChange = {
          siteId: msg.siteId,
          key: msg.key,
          value: msg.value,
        };
        for (const listener of sharedAuthListeners) {
          try {
            listener(change);
          } catch (err: unknown) {
            log.error(
              "[dot.li protocol] Shared auth listener threw:",
              err instanceof Error ? err.message : err,
            );
          }
        }
        return;
      }
    }
  });
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const IFRAME_LOAD_TIMEOUT_MS = 30_000;
// The iframe signals "ready" only after the SharedWorker pre-syncs the
// chain. This must exceed `TIMEOUTS.SHARED_WORKER_READY` so the outer wait
// doesn't race the inner presync.
const IFRAME_READY_TIMEOUT_MS = 240_000;
// NO automatic retries. The user picked this protocol path. If the iframe
// load fails the cause must surface immediately so the user (or a
// higher-level UI affordance) can decide whether to retry.

function createHostIframe(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    const params = new URLSearchParams();
    // Fall back to the stored Backend when the async
    // setProtocolSubMode() has not run yet.
    const mode: ProtocolSubMode =
      protocolSubMode ?? backendToSubMode(getBackend());
    params.set("mode", mode);
    params.set("network", getNetwork());
    if (protocolSkipWorkerCache) {
      params.set("skipWorkerCache", "1");
    }
    const query = params.toString();
    iframe.src =
      query.length > 0
        ? `${getProtocolOrigin()}?${query}`
        : getProtocolOrigin();
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText =
      "position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;";

    const timer = setTimeout(() => {
      cleanup();
      iframe.remove();
      reject(new Error("Shared host iframe timed out while loading"));
    }, IFRAME_LOAD_TIMEOUT_MS);

    const onLoad = (): void => {
      cleanup();
      protocolIframe = iframe;
      resolve();
    };

    const onError = (): void => {
      cleanup();
      iframe.remove();
      reject(new Error("Shared host iframe failed to load"));
    };

    function cleanup(): void {
      clearTimeout(timer);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
    }

    iframe.addEventListener("load", onLoad, { once: true });
    iframe.addEventListener("error", onError, { once: true });
    document.body.appendChild(iframe);
  });
}

async function ensureHostFrame(): Promise<void> {
  bindMessageListener();

  if (protocolIframe?.contentWindow) {
    return;
  }

  if (hostFramePromise) {
    return hostFramePromise;
  }

  hostFramePromise = (async () => {
    try {
      await createHostIframe();
    } catch (error: unknown) {
      m.count(S.PROTOCOL_IFRAME_READY, {
        outcome: "error",
        phase: "load",
        reason: error instanceof Error ? error.name : "unknown",
      });
      m.breadcrumb("protocol iframe load failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      log.error("[dot.li protocol] Host iframe load failed:", error);
      resetProtocolFrameState();
      hostFramePromise = null;
      throw error;
    }
  })();

  return hostFramePromise;
}

function waitForProtocolReady(): Promise<void> {
  const stopIframe = m.timer(S.PROTOCOL_IFRAME_READY);
  return new Promise<void>((resolve, reject) => {
    if (protocolReady) {
      stopIframe();
      resolve();
      return;
    }

    const waiter: ReadyWaiter = {
      resolve: () => {
        clearTimeout(timer);
        stopIframe();
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        stopIframe();
        reject(err);
      },
    };

    const timer = setTimeout(() => {
      pendingReadyResolvers = pendingReadyResolvers.filter((w) => w !== waiter);
      stopIframe();
      reject(new Error("Shared protocol iframe timed out (no ready signal)"));
    }, IFRAME_READY_TIMEOUT_MS);

    pendingReadyResolvers.push(waiter);
  });
}

export async function ensureProtocolFrame(): Promise<void> {
  await ensureHostFrame();

  if (protocolReady) {
    return;
  }

  if (protocolReadyPromise) {
    return protocolReadyPromise;
  }

  protocolReadyPromise = (async () => {
    try {
      await waitForProtocolReady();
    } catch (error: unknown) {
      // Do NOT auto-retry. The SharedWorker no longer retries its own
      // presync either (see protocol-shared-worker.ts), so this failure
      // surfaces the actual cause to the caller without silent recovery.
      // The cached promise is released so an explicit user action (e.g.
      // "Change settings") can try again.
      m.count(S.PROTOCOL_IFRAME_READY, {
        phase: "ready",
        outcome: "error",
        reason: error instanceof Error ? error.name : "unknown",
      });
      m.breadcrumb("protocol iframe ready wait failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      log.error("[dot.li protocol] Ready wait failed:", error);
      protocolReadyPromise = null;
      throw error;
    }
  })();

  return protocolReadyPromise;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// Methods whose completion time depends on chain sync or user patience.
// No per-request timeout. A smoldot panic emits a `fatal` envelope that
// rejects pending requests, and the user can abandon via the "Change
// settings" affordance. Waiting longer than 5 min is fine. Silently
// killing the request is not.
const UNTIMED_METHODS: ReadonlySet<ProtocolRequestMethod> =
  new Set<ProtocolRequestMethod>(["warmup"]);
const METHOD_TIMEOUTS: Partial<Record<ProtocolRequestMethod, number>> = {
  chainConnect: 30_000,
  resolveDotName: 90_000,
  resolveOwner: 90_000,
  resolveExecutableManifest: 30_000,
  resolveRootManifest: 30_000,
};

async function postRequest<M extends ProtocolRequestMethod>(
  method: M,
  payload: ProtocolRequestMap[M],
  onProgress?: (message: string) => void,
  needsProtocolReady = !isSharedAuthRequestMethod(method) &&
    !isSharedModeRequestMethod(method),
): Promise<unknown> {
  await (needsProtocolReady ? ensureProtocolFrame() : ensureHostFrame());
  const frameWindow = protocolIframe?.contentWindow;
  if (!frameWindow) {
    throw new Error("Shared protocol iframe is unavailable");
  }

  const id = createRequestId();
  const envelope: ProtocolRequestEnvelope<M> = {
    namespace: "dotli:protocol",
    kind: "request",
    id,
    method,
    payload,
  };

  const timeoutMs = UNTIMED_METHODS.has(method)
    ? null
    : (METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS);
  const stopReq = m.timer(S.PROTOCOL_REQUEST);

  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            pendingRequests.delete(id);
            m.count(S.PROTOCOL_REQUEST, { outcome: "timeout", method });
            stopReq();
            reject(
              new Error(
                `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
              ),
            );
          }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (value) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        stopReq();
        resolve(value);
      },
      reject: (reason?: unknown) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
      onProgress,
    });

    frameWindow.postMessage(envelope, getProtocolOrigin());
  });
}

export async function warmupProtocol(): Promise<void> {
  await postRequest("warmup", {});
}

export async function resolveDotNameRemote(
  label: string,
  onStatus?: (message: string) => void,
): Promise<string | null> {
  return (await postRequest("resolveDotName", { label }, onStatus)) as
    | string
    | null;
}

export async function resolveOwnerRemote(
  label: string,
): Promise<string | null> {
  return (await postRequest("resolveOwner", { label })) as string | null;
}

/**
 * Remote proxy for the executable-manifest reader.
 *
 * Returns the same discriminated result as the in-process
 * `resolveExecutableManifest`. The bridge serialises the result as-is.
 */
export async function resolveExecutableManifestRemote(
  label: string,
  kind: "app" | "widget" | "worker",
): Promise<ManifestResult<ExecutableManifest>> {
  return (await postRequest("resolveExecutableManifest", {
    label,
    kind,
  })) as ManifestResult<ExecutableManifest>;
}

/** Remote proxy for the root-manifest reader. */
export async function resolveRootManifestRemote(
  label: string,
): Promise<ManifestResult<RootManifest>> {
  return (await postRequest("resolveRootManifest", {
    label,
  })) as ManifestResult<RootManifest>;
}

export async function hasSharedAuthSession(siteId: SiteId): Promise<boolean> {
  return (await postRequest("authHasSession", { siteId })) as boolean;
}

export async function readSharedAuthStorage(
  siteId: SiteId,
  key: string,
): Promise<string | null> {
  return (await postRequest("authStorageRead", { siteId, key })) as
    | string
    | null;
}

export async function writeSharedAuthStorage(
  siteId: SiteId,
  key: string,
  value: string,
): Promise<void> {
  await postRequest("authStorageWrite", { siteId, key, value });
}

export async function clearSharedAuthStorage(
  siteId: SiteId,
  key: string,
): Promise<void> {
  await postRequest("authStorageClear", { siteId, key });
}

/**
 * Shared mode storage lives on `host.<BASE_DOMAIN>` so the user's backend
 * and cache preferences travel with them across every subdomain of the
 * registrable root. Reads return `null` when the key has never been
 * written (caller decides the default).
 */
export async function readSharedModeStorage(
  siteId: SiteId,
  key: string,
): Promise<string | null> {
  return (await postRequest("modeStorageRead", { siteId, key })) as
    | string
    | null;
}

export async function writeSharedModeStorage(
  siteId: SiteId,
  key: string,
  value: string,
): Promise<void> {
  await postRequest("modeStorageWrite", { siteId, key, value });
}

export async function clearSharedModeStorage(
  siteId: SiteId,
  key: string,
): Promise<void> {
  await postRequest("modeStorageClear", { siteId, key });
}

/**
 * Subscribe to cross-tab shared auth storage changes.
 *
 * Writes and clears performed by *sibling tabs* of the same root domain (e.g.
 * another `*.dot.li` tab) arrive here as notifications. The originating tab
 * does NOT receive its own writes via this channel. It already emits to local
 * listeners inline when its own `write`/`clear` resolves.
 *
 * Ensures the host iframe is created so it can relay `BroadcastChannel`
 * notifications from sibling host iframes. The returned function unsubscribes.
 */
export function subscribeSharedAuthStorage(
  listener: SharedAuthStorageListener,
): () => void {
  sharedAuthListeners.add(listener);
  // Best-effort iframe warm-up so the relay path is live. We intentionally
  // don't await or surface errors. The caller's subscribe contract is
  // synchronous, and the iframe will be lazily (re)created on the next
  // explicit request if this warm-up fails.
  void ensureHostFrame().catch((error: unknown) => {
    log.warn(
      "[dot.li protocol] Failed to ensure host frame for shared auth subscription:",
      error,
    );
  });
  return () => {
    sharedAuthListeners.delete(listener);
  };
}

export function isRemoteChainSupported(genesisHash: string): boolean {
  // Advertise only what the *active* backend can actually serve. Gateway mode
  // bridges a curated RPC subset (no Bulletin chain — its content goes via
  // IPFS gateways), while smoldot can run any configured chain.
  const supported =
    getBackend() === "rpc-gateway"
      ? getActiveGatewaySupportedGenesisHashes()
      : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}

/**
 * Notification-style requests (no `id`) get `null`, nothing to respond to.
 */
function buildJsonRpcError(
  request: JsonRpcRequest,
  errorMessage: string,
): JsonRpcMessage | null {
  if (request.id === undefined || request.id === null) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32603, message: errorMessage },
  };
}

export function createRemoteChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  if (!isRemoteChainSupported(genesisHash)) {
    return null;
  }

  return (onMessage): JsonRpcConnection => {
    const connectionId = createRequestId();
    const remote: RemoteChainConnection = {
      onMessage,
      pendingMessages: [],
      connected: false,
    };

    chainConnections.set(connectionId, remote);

    void ensureProtocolFrame()
      .then(async () => {
        await postRequest("chainConnect", { genesisHash, connectionId });
        remote.connected = true;
        for (const message of remote.pendingMessages) {
          void postRequest("chainSend", {
            connectionId,
            message: JSON.stringify(message),
          });
        }
        remote.pendingMessages = [];
      })
      .catch((error: unknown) => {
        // Connection failed. Send JSON-RPC error responses for all
        // pending messages so polkadot-api's client knows the connection
        // died instead of hanging on "Not connected" forever.
        const reason = serializeError(error);
        log.error("[dot.li protocol] Failed to connect remote chain:", error);
        for (const pending of remote.pendingMessages) {
          const errResponse = buildJsonRpcError(pending, reason);
          if (errResponse !== null) {
            onMessage(errResponse);
          }
        }
        remote.pendingMessages = [];
        chainConnections.delete(connectionId);
      });

    return {
      send(message) {
        const current = chainConnections.get(connectionId);
        if (!current) {
          // Connection was removed (failed or disconnected).
          // Respond with an error so the caller doesn't hang.
          const errResponse = buildJsonRpcError(
            message,
            "Chain connection is closed",
          );
          if (errResponse !== null) {
            onMessage(errResponse);
          }
          return;
        }
        if (!current.connected) {
          current.pendingMessages.push(message);
          return;
        }
        void postRequest("chainSend", {
          connectionId,
          message: JSON.stringify(message),
        }).catch((error: unknown) => {
          const reason = serializeError(error);
          log.error("[dot.li protocol] Remote chain send failed:", error);
          const errResponse = buildJsonRpcError(message, reason);
          if (errResponse !== null) {
            onMessage(errResponse);
          }
        });
      },
      disconnect() {
        const current = chainConnections.get(connectionId);
        chainConnections.delete(connectionId);
        if (!current) {
          return;
        }
        void postRequest("chainDisconnect", { connectionId }).catch(
          (error: unknown) => {
            log.warn("[dot.li protocol] Remote disconnect failed:", error);
          },
        );
      },
    };
  };
}
