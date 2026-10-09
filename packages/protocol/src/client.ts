// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { chainHaltedError, type RemoteChainHalt } from './chain-halted.js';
import { ProtocolFatalError, PROTOCOL_ERRORS, ProtocolInitFailedError, ProtocolRequestError } from './errors.js';
import type { ExecutableManifest, ManifestResult, RootManifest } from '@dotli/resolver';
import {
  BASE_DOMAIN,
  SITE_ID,
  DEV_PROTOCOL_PORT,
  type SiteId,
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
  getNetwork,
  getBackend,
  type Backend,
} from '@dotli/config';

import { log, serializeError } from '@dotli/shared';
import { getResolutionId, m, spans as S } from '@dotli/metrics';
import type { SmoldotDbChain, SmoldotDbOutcome } from './messages.js';
import {
  isChainDetailPayloadValid,
  isChainSyncPayloadValid,
  isProtocolEnvelope,
  type ProtocolChainDetailEnvelope,
  type ProtocolChainSyncEnvelope,
  type ProtocolNetBytesEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolRequestMethod,
} from './messages.js';
import { isSharedAuthRequestMethod, isSharedModeRequestMethod } from './auth-storage.js';
import { DEFAULT_TIMEOUT_MS, METHOD_TIMEOUTS, UNTIMED_METHODS } from './method-timeouts.js';
import {
  isSharedWalletState,
  type SharedWalletOperation,
  type SharedWalletResult,
  type SharedWalletState,
} from './wallet-storage.js';
import type { WalletOwnerOperation } from './wallet-owner.js';

interface PendingRequest {
  method: ProtocolRequestMethod;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Page load steps, breadcrumbed when sent and settled so a failed load's trail names what it waited on.
 * Storage and chain traffic is per product call and would crowd them out.
 */
const TRAILED_METHODS: ReadonlySet<ProtocolRequestMethod> = new Set<ProtocolRequestMethod>([
  'warmup',
  'chainConnect',
  'resolveDotName',
  'resolveOwner',
  'resolveExecutableManifest',
  'resolveRootManifest',
]);

interface RemoteChainConnection {
  onMessage: (message: JsonRpcMessage) => void;
  /** Told once when the chain behind this connection halts. */
  onHalt: ((reason: RemoteChainHalt) => void) | null;
  pendingMessages: JsonRpcRequest[];
  connected: boolean;
}

export interface SharedAuthStorageChange {
  siteId: SiteId;
  key: string;
  value: string | null;
}

export type SharedAuthStorageListener = (change: SharedAuthStorageChange) => void;

let protocolIframe: HTMLIFrameElement | null = null;
let hostFramePromise: Promise<void> | null = null;
let protocolReadyPromise: Promise<void> | null = null;
// The last ready wait failed and no reset followed, so the frame is not on its way up.
let protocolReadyWaitFailed = false;
const pendingRequests = new Map<string, PendingRequest>();
const chainConnections = new Map<string, RemoteChainConnection>();
const protocolReadyListeners = new Set<() => void>();
const sharedAuthListeners = new Set<SharedAuthStorageListener>();
const sharedWalletListeners = new Set<(state: SharedWalletState) => void>();
const walletOwnerRevokedListeners = new Set<(lease: string | undefined) => void>();
const chainSyncListeners = new Set<(event: ProtocolChainSyncEnvelope) => void>();
let lastNetBytesTotal = 0;
const netBytesListeners = new Set<(event: ProtocolNetBytesEnvelope) => void>();
const chainDetailListeners = new Set<(event: ProtocolChainDetailEnvelope) => void>();
let listenerBound = false;
let protocolReady = false;
interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}
let pendingReadyResolvers: ReadyWaiter[] = [];

/** `"rpc"` bridges chain calls over trusted WSS JSON-RPC instead of smoldot. `null` serves shared auth only. */
type ProtocolSubMode = 'shared-worker' | 'direct' | 'rpc';
let protocolSubMode: ProtocolSubMode | null = null;

function backendToSubMode(backend: Backend): ProtocolSubMode {
  if (backend === 'smoldot-shared-worker') {
    return 'shared-worker';
  }
  if (backend === 'smoldot-direct') {
    return 'direct';
  }
  return 'rpc';
}

/** Asks the iframe to purge its IndexedDB caches first, forcing a cold start. */
let protocolSkipWorkerCache = false;

export function setProtocolSubMode(mode: ProtocolSubMode, opts: { skipWorkerCache?: boolean } = {}): void {
  protocolSubMode = mode;
  protocolSkipWorkerCache = opts.skipWorkerCache === true;
}

export function getProtocolOrigin(): string {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (import.meta.env.DEV) {
      return `http://host.localhost:${DEV_PROTOCOL_PORT}`;
    }
    const port = window.location.port.length > 0 ? window.location.port : '5173';
    return `http://host.localhost:${port}`;
  }
  return `https://host.${BASE_DOMAIN}`;
}

// A chain stays "unknown" on the gateway path, which runs no light client, and until its store answers.
const smoldotDbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();

/** Whether a chain began from existing smoldot state, so telemetry keeps cold syncs and warm resumes apart. */
export function getSmoldotDbOutcome(chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown' {
  return smoldotDbOutcomes.get(chain) ?? 'unknown';
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
 * Drops the iframe and ready state so the next request boots a fresh one, for a caller that finds
 * the sub-mode wrong. In-flight requests are orphaned to their own timers, and ready waiters are
 * rejected at once. A SharedWorker keeps its sync progress, only this tab's port cycles.
 */
export function resetProtocolFrame(): void {
  resetProtocolFrameState();
}

function resetProtocolFrameState(reason?: Error): void {
  if (protocolIframe !== null) {
    // The iframe holds the Web Lock. Retire the page's signer synchronously,
    // before removing its lock owner lets another tab start signing.
    broadcast(walletOwnerRevokedListeners, undefined, 'Wallet owner');
  }
  protocolIframe?.remove();
  protocolIframe = null;
  // The rebuilt frame's byte meter restarts at zero, and the monotonic gate would drop its reports.
  lastNetBytesTotal = 0;
  hostFramePromise = null;
  protocolReadyPromise = null;
  protocolReadyWaitFailed = false;
  protocolReady = false;
  const orphaned = pendingReadyResolvers;
  pendingReadyResolvers = [];
  if (orphaned.length > 0) {
    const err = reason ?? new Error(PROTOCOL_ERRORS.FRAME_RESET);
    for (const waiter of orphaned) {
      waiter.reject(err);
    }
  }
}

/** Deliver to every listener, so one that throws cannot silence the rest. */
function broadcast<T>(listeners: ReadonlySet<(event: T) => void>, event: T, label: string): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err: unknown) {
      log.error(`[dot.li protocol] ${label} listener threw:`, err instanceof Error ? err.message : err);
    }
  }
}

function bindMessageListener(): void {
  if (listenerBound) {
    return;
  }
  listenerBound = true;

  window.addEventListener('message', (event: MessageEvent) => {
    if (!isProtocolEnvelope(event.data)) {
      return;
    }

    if (event.origin !== getProtocolOrigin()) {
      return;
    }

    const frameWindow = protocolIframe?.contentWindow;
    if (frameWindow !== null && frameWindow !== undefined && event.source !== frameWindow) {
      return;
    }

    const msg = event.data;
    switch (msg.kind) {
      case 'progress':
        pendingRequests.get(msg.id)?.onProgress?.(msg.message);
        return;
      case 'response': {
        const pending = pendingRequests.get(msg.id);
        if (!pending) {
          return;
        }
        pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(
            new ProtocolRequestError(
              msg.error || 'Unknown protocol error',
              // A bare `"Error"` carries nothing, and would cost us the
              // "crossed the protocol boundary" signal dashboards filter on.
              msg.errorName !== undefined && msg.errorName !== 'Error' ? msg.errorName : 'ProtocolResponseError',
              pending.method,
              typeof msg.errorStack === 'string' ? msg.errorStack : undefined,
            ),
          );
        }
        return;
      }
      case 'chain-sync': {
        if (!isChainSyncPayloadValid(msg)) {
          return;
        }
        broadcast(chainSyncListeners, msg, 'Chain sync');
        return;
      }
      case 'chain-detail': {
        if (!isChainDetailPayloadValid(msg)) {
          return;
        }
        broadcast(chainDetailListeners, msg, 'Chain detail');
        return;
      }
      case 'net-bytes': {
        // Cumulative, so a total below the last one is spoofed or corrupt
        // traffic and would feed a negative rate into the network panel.
        if (!Number.isFinite(msg.received) || msg.received < lastNetBytesTotal) {
          return;
        }
        lastNetBytesTotal = msg.received;
        broadcast(netBytesListeners, msg, 'Net bytes');
        return;
      }
      case 'fatal':
      case 'init-failed': {
        // Smoldot or the iframe died, so nothing will answer any request in flight.
        const kind = msg.kind === 'fatal' ? 'Fatal' : 'Init failed';
        log.error(`[dot.li protocol] ${kind}: ${msg.message}`);
        const err =
          msg.kind === 'fatal'
            ? new ProtocolFatalError(`${kind}: ${msg.message}`)
            : new ProtocolInitFailedError(`${kind}: ${msg.message}`);

        for (const [id, pending] of pendingRequests) {
          pendingRequests.delete(id);
          pending.reject(err);
        }

        // The reset rejects ready waiters and clears cached promises so the next ensureProtocolFrame()
        // can reboot. It runs before halting so a `'frame'` listener that dials again misses the dead frame.
        const orphanedConnections = [...chainConnections];
        chainConnections.clear();
        resetProtocolFrameState(err);
        for (const [id, connection] of orphanedConnections) {
          haltRemote(id, connection, 'frame');
        }
        return;
      }
      case 'chain-message': {
        const conn = chainConnections.get(msg.connectionId);
        if (!conn) {
          log.warn(
            `[dot.li protocol] chain-message for unknown connectionId: ${msg.connectionId} (known: ${[...chainConnections.keys()].join(', ')})`,
          );
          return;
        }
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
        guardConsumer(msg.connectionId, 'onMessage', () => {
          conn.onMessage(parsed);
        });
        return;
      }
      case 'chain-halt': {
        const halted = chainConnections.get(msg.connectionId);
        chainConnections.delete(msg.connectionId);
        if (halted !== undefined) {
          haltRemote(msg.connectionId, halted, 'chain');
        }
        return;
      }
      case 'request':
        return;
      case 'ready':
        resolveProtocolReady();
        for (const listener of [...protocolReadyListeners]) {
          try {
            listener();
          } catch (err: unknown) {
            log.error('[dot.li protocol] onProtocolReady listener threw:', err instanceof Error ? err.message : err);
          }
        }
        return;
      case 'wallet-storage-changed':
        if (msg.siteId === SITE_ID && isSharedWalletState(msg.state)) {
          for (const listener of sharedWalletListeners) {
            try {
              listener(msg.state);
            } catch (error) {
              log.error('[dot.li protocol] Shared wallet listener failed:', error);
            }
          }
        }
        return;
      case 'wallet-owner-revoked':
        if (msg.siteId === SITE_ID && typeof msg.lease === 'string') {
          for (const listener of walletOwnerRevokedListeners) {
            try {
              listener(msg.lease);
            } catch (error) {
              log.error('[dot.li protocol] Wallet owner listener failed:', error);
            }
          }
        }
        return;
      case 'smoldot-db':
        // These become Sentry tags and the envelope check covers only namespace and kind, so a buggy
        // frame could otherwise write unbounded tag values.
        {
          const chain: string = msg.chain;
          const outcome: string = msg.outcome;
          if (
            (chain === 'relay' || chain === 'hub' || chain === 'bulletin') &&
            (outcome === 'hit' || outcome === 'miss' || outcome === 'unavailable')
          ) {
            smoldotDbOutcomes.set(chain, outcome);
          }
        }
        return;
      case 'auth-storage-changed': {
        const change: SharedAuthStorageChange = {
          siteId: msg.siteId,
          key: msg.key,
          value: msg.value,
        };
        broadcast(sharedAuthListeners, change, 'Shared auth');
        return;
      }
    }
  });
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const IFRAME_LOAD_TIMEOUT_MS = 30_000;
// Ready follows the SharedWorker presync, so this must exceed `TIMEOUTS.SHARED_WORKER_READY`.
const IFRAME_READY_TIMEOUT_MS = 240_000;
// No automatic retries. A failed load surfaces at once so the user can decide whether to retry.

function createHostIframe(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Not cleared on teardown, which runs inside the `fatal` arm before the host's pending rejection
    // and would strip the tags from the very failures they explain.
    smoldotDbOutcomes.clear();
    const iframe = document.createElement('iframe');
    const params = new URLSearchParams();
    // The async setProtocolSubMode() may not have run yet.
    const mode: ProtocolSubMode = protocolSubMode ?? backendToSubMode(getBackend());
    params.set('mode', mode);
    params.set('network', getNetwork());
    if (protocolSkipWorkerCache) {
      params.set('skipWorkerCache', '1');
    }
    // On the URL, not posted after load, because the iframe's Sentry client emits before any handshake.
    const resolutionId = getResolutionId();
    if (resolutionId !== null) {
      params.set('resolutionId', resolutionId);
    }
    const query = params.toString();
    iframe.src = query.length > 0 ? `${getProtocolOrigin()}?${query}` : getProtocolOrigin();
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;';

    const timer = setTimeout(() => {
      cleanup();
      iframe.remove();
      reject(new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT));
    }, IFRAME_LOAD_TIMEOUT_MS);

    const onLoad = (): void => {
      cleanup();
      protocolIframe = iframe;
      resolve();
    };

    const onError = (): void => {
      cleanup();
      iframe.remove();
      reject(new Error(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED));
    };

    function cleanup(): void {
      clearTimeout(timer);
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
    }

    iframe.addEventListener('load', onLoad, { once: true });
    iframe.addEventListener('error', onError, { once: true });
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
        outcome: 'error',
        phase: 'load',
        reason: error instanceof Error ? error.name : 'unknown',
      });
      m.breadcrumb('protocol iframe load failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      log.error('[dot.li protocol] Host iframe load failed:', error);
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
      reject: err => {
        clearTimeout(timer);
        stopIframe();
        reject(err);
      },
    };

    const timer = setTimeout(() => {
      pendingReadyResolvers = pendingReadyResolvers.filter(w => w !== waiter);
      stopIframe();
      reject(new Error(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT));
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

  protocolReadyWaitFailed = false;
  protocolReadyPromise = (async () => {
    try {
      await waitForProtocolReady();
    } catch (error: unknown) {
      // No auto-retry, so the real cause surfaces. Releasing the cached promise lets the user try again.
      m.count(S.PROTOCOL_IFRAME_READY, {
        phase: 'ready',
        outcome: 'error',
        reason: error instanceof Error ? error.name : 'unknown',
      });
      m.breadcrumb('protocol iframe ready wait failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      log.error('[dot.li protocol] Ready wait failed:', error);
      protocolReadyPromise = null;
      protocolReadyWaitFailed = true;
      throw error;
    }
  })();

  return protocolReadyPromise;
}

async function postRequest<M extends ProtocolRequestMethod>(
  method: M,
  payload: ProtocolRequestMap[M],
  onProgress?: (message: string) => void,
  needsProtocolReady = !isSharedAuthRequestMethod(method) &&
    !isSharedModeRequestMethod(method) &&
    method !== 'walletStorage' &&
    method !== 'walletOwner',
): Promise<unknown> {
  await (needsProtocolReady ? ensureProtocolFrame() : ensureHostFrame());
  const frameWindow = protocolIframe?.contentWindow;
  if (!frameWindow) {
    throw new Error(PROTOCOL_ERRORS.FRAME_UNAVAILABLE);
  }

  const id = createRequestId();
  const timeoutMs = UNTIMED_METHODS.has(method) ? null : (METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS);
  const envelope: ProtocolRequestEnvelope<M> = {
    namespace: 'dotli:protocol',
    kind: 'request',
    id,
    method,
    payload,
    ...(timeoutMs === null ? {} : { deadlineMs: Date.now() + timeoutMs }),
  };
  // `chainSend` is fire-and-ack, one per product JSON-RPC message: timed, it
  // would swamp the resolution and connect round trips this span measures.
  const stopReq = method === 'chainSend' ? (): number => 0 : m.timer(S.PROTOCOL_REQUEST);
  const trailed = TRAILED_METHODS.has(method);
  const sentAt = performance.now();
  const settled = (outcome: 'ok' | 'error' | 'timeout', err?: Error): void => {
    stopReq();
    if (outcome !== 'ok') {
      m.count(S.PROTOCOL_REQUEST, { outcome, method });
    }
    if (trailed) {
      log.event(`${method} ${outcome === 'ok' ? 'done' : outcome === 'timeout' ? 'timed out' : 'failed'}`, {
        flow: 'protocol',
        ms: Math.round(performance.now() - sentAt),
        ...(err !== undefined ? { error: `${err.name}: ${err.message}`.slice(0, 200) } : {}),
      });
    }
  };
  if (trailed) {
    log.event(`${method} sent`, {
      flow: 'protocol',
      ...(timeoutMs === null ? {} : { timeout_ms: timeoutMs }),
    });
  }

  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            pendingRequests.delete(id);
            const err = new ProtocolRequestError(
              `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
              'ProtocolTimeoutError',
              method,
            );
            settled('timeout', err);
            reject(err);
          }, timeoutMs);

    pendingRequests.set(id, {
      method,
      resolve: value => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        settled('ok');
        resolve(value);
      },
      reject: (reason?: unknown) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        const err = reason instanceof Error ? reason : new Error(String(reason));
        settled('error', err);
        reject(err);
      },
      onProgress,
    });

    frameWindow.postMessage(envelope, getProtocolOrigin());
  });
}
type ResolverRequestMethod = 'resolveDotName' | 'resolveOwner' | 'resolveExecutableManifest' | 'resolveRootManifest';

function isStoppedResolverResponse(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'ApiStoppedError' ||
      (error.name === 'ProtocolResponseError' && error.message.startsWith('chainHead follow stopped')))
  );
}

async function postResolverRequest<M extends ResolverRequestMethod>(
  method: M,
  payload: ProtocolRequestMap[M],
  onProgress?: (message: string) => void,
): Promise<unknown> {
  try {
    return await postRequest(method, payload, onProgress);
  } catch (error: unknown) {
    if (!isStoppedResolverResponse(error)) {
      throw error;
    }
    log.warn(
      `[dot.li protocol] ${method} lost its chainHead follow; retrying once on the replacement resolver generation`,
    );
    onProgress?.('Light client stopped; reconnecting...');
    return postRequest(method, payload, onProgress);
  }
}

export async function warmupProtocol(): Promise<void> {
  await postRequest('warmup', {});
}

export async function resolveDotNameRemote(
  label: string,
  onStatus?: (message: string) => void,
): Promise<string | null> {
  return (await postResolverRequest('resolveDotName', { label }, onStatus)) as string | null;
}

export async function resolveOwnerRemote(label: string): Promise<string | null> {
  return (await postResolverRequest('resolveOwner', { label })) as string | null;
}

export async function resolveExecutableManifestRemote(
  label: string,
  kind: 'app' | 'widget' | 'worker',
): Promise<ManifestResult<ExecutableManifest>> {
  return (await postResolverRequest('resolveExecutableManifest', {
    label,
    kind,
  })) as ManifestResult<ExecutableManifest>;
}

export async function resolveRootManifestRemote(label: string): Promise<ManifestResult<RootManifest>> {
  return (await postResolverRequest('resolveRootManifest', {
    label,
  })) as ManifestResult<RootManifest>;
}

/** Secrets travel only over the validated protocol iframe RPC, never HTTP mode sync. */
export async function requestSharedWallet(
  siteId: SiteId,
  operation: SharedWalletOperation,
): Promise<SharedWalletResult> {
  return (await postRequest('walletStorage', {
    siteId,
    operation,
  })) as SharedWalletResult;
}

export function subscribeSharedWallet(listener: (state: SharedWalletState) => void): () => void {
  sharedWalletListeners.add(listener);
  return () => {
    sharedWalletListeners.delete(listener);
  };
}

/** Make this page the one tab running the test wallet; see `wallet-owner.ts`. */
export async function requestWalletOwner(operation: WalletOwnerOperation): Promise<string | undefined> {
  const result = await postRequest('walletOwner', {
    siteId: SITE_ID,
    operation,
  });
  return typeof result === 'string' ? result : undefined;
}

/** Stop signing before releasing a lease, or before its owning frame is removed. */
export function subscribeWalletOwnerRevoked(listener: (lease: string | undefined) => void): () => void {
  walletOwnerRevokedListeners.add(listener);
  return () => {
    walletOwnerRevokedListeners.delete(listener);
  };
}

export async function readSharedAuthStorage(siteId: SiteId, key: string): Promise<string | null> {
  return (await postRequest('authStorageRead', { siteId, key })) as string | null;
}

export async function writeSharedAuthStorage(
  siteId: SiteId,
  key: string,
  value: string,
  walletRevision?: string | null,
): Promise<void> {
  await postRequest('authStorageWrite', {
    siteId,
    key,
    value,
    ...(walletRevision === undefined ? {} : { walletRevision }),
  });
}

export async function clearSharedAuthStorage(siteId: SiteId, key: string): Promise<void> {
  await postRequest('authStorageClear', { siteId, key });
}

/** Lives on `host.<BASE_DOMAIN>` so backend and cache preferences follow the user across subdomains. */
export async function readSharedModeStorage(siteId: SiteId, key: string): Promise<string | null> {
  return (await postRequest('modeStorageRead', { siteId, key })) as string | null;
}

export async function writeSharedModeStorage(siteId: SiteId, key: string, value: string): Promise<void> {
  await postRequest('modeStorageWrite', { siteId, key, value });
}

export async function clearSharedModeStorage(siteId: SiteId, key: string): Promise<void> {
  await postRequest('modeStorageClear', { siteId, key });
}

/**
 * Hears shared-auth writes from sibling tabs of the same root domain, relayed by the host iframe
 * over `BroadcastChannel`. A tab's own writes do not arrive here.
 */
export function subscribeSharedAuthStorage(listener: SharedAuthStorageListener): () => void {
  sharedAuthListeners.add(listener);
  // Not awaited, since subscribe is synchronous. A failed warm-up is retried by the next request.
  void ensureHostFrame().catch((error: unknown) => {
    log.warn('[dot.li protocol] Failed to ensure host frame for shared auth subscription:', error);
  });
  return () => {
    sharedAuthListeners.delete(listener);
  };
}

/** Events arrive only after the origin- and source-gated listener validates them. */
export function onProtocolChainSync(listener: (event: ProtocolChainSyncEnvelope) => void): () => void {
  bindMessageListener();
  chainSyncListeners.add(listener);
  return () => {
    chainSyncListeners.delete(listener);
  };
}

/** Whether a frame signalled ready and has not been reset or died since. Does not start a frame. */
export function isProtocolReady(): boolean {
  return protocolReady;
}

/** Whether a started frame is still on its way up, so a dial now waits on it. Does not start a frame. */
export function isProtocolBooting(): boolean {
  return !protocolReady && !protocolReadyWaitFailed && (hostFramePromise !== null || protocolReadyPromise !== null);
}

/** Fires each time the frame comes up. Does not start a frame. */
export function onProtocolReady(listener: () => void): () => void {
  bindMessageListener();
  protocolReadyListeners.add(listener);
  return () => {
    protocolReadyListeners.delete(listener);
  };
}

export function onProtocolChainDetail(listener: (event: ProtocolChainDetailEnvelope) => void): () => void {
  bindMessageListener();
  chainDetailListeners.add(listener);
  return () => {
    chainDetailListeners.delete(listener);
  };
}

export function onProtocolNetBytes(listener: (event: ProtocolNetBytesEnvelope) => void): () => void {
  bindMessageListener();
  netBytesListeners.add(listener);
  return () => {
    netBytesListeners.delete(listener);
  };
}

/**
 * Wider than the advertised `isRemoteChainSupported`, since gateway mode keeps Bulletin connectable for bitswap's
 * content fetches through the frame.
 */
export function isRemoteChainConnectable(genesisHash: string): boolean {
  const supported =
    getBackend() === 'rpc-gateway' ? getActiveCoreGatewaySupportedGenesisHashes() : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}

export function isRemoteChainSupported(genesisHash: string): boolean {
  // Gateway mode bridges a curated RPC subset, while smoldot can run any configured chain.
  const supported =
    getBackend() === 'rpc-gateway' ? getActiveGatewaySupportedGenesisHashes() : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}

/** `null` for a notification, which has no `id` to answer. */
function buildJsonRpcError(
  request: JsonRpcRequest,
  error: string | ReturnType<typeof chainHaltedError>,
): JsonRpcMessage | null {
  if (request.id === undefined || request.id === null) {
    return null;
  }
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: typeof error === 'string' ? { code: -32603, message: error } : error,
  };
}

/** A consumer callback that throws is logged, not propagated. */
function guardConsumer(connectionId: string, label: string, call: () => void): void {
  try {
    call();
  } catch (err: unknown) {
    log.error(
      `[dot.li protocol] ${label} threw (conn=${connectionId.slice(-8)}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Unsent messages get the retryable halt error on a chain halt, and a plain close error on a dead frame. */
function haltRemote(connectionId: string, connection: RemoteChainConnection, reason: RemoteChainHalt): void {
  for (const message of connection.pendingMessages) {
    const errResponse = buildJsonRpcError(
      message,
      reason === 'chain' ? chainHaltedError() : 'Chain connection is closed',
    );
    if (errResponse !== null) {
      guardConsumer(connectionId, 'onMessage', () => {
        connection.onMessage(errResponse);
      });
    }
  }
  connection.pendingMessages = [];
  guardConsumer(connectionId, 'onHalt', () => {
    connection.onHalt?.(reason);
  });
}

/**
 * A remote chain provider whose connections may hear `onHalt` once:
 *
 * - `'chain'`: the chain halted and is rebuilt on the next connect. Every request in flight or unsent
 *   gets an error with `CHAIN_HALTED_ERROR_DATA`, and every follow its `stop`.
 * - `'frame'`: the frame died, never came up or refused the connection. Only unsent requests are
 *   answered, so a consumer without `onHalt` may wait on the rest forever.
 *
 * Later sends fail with `Chain connection is closed`. A message already on its way may still arrive
 * after `onHalt` and should be ignored.
 */
export type RemoteChainProvider = (
  onMessage: (message: JsonRpcMessage) => void,
  onHalt?: (reason: RemoteChainHalt) => void,
) => JsonRpcConnection;

function postDisconnect(connectionId: string): void {
  void postRequest('chainDisconnect', { connectionId }).catch((error: unknown) => {
    log.warn('[dot.li protocol] Remote disconnect failed:', error);
  });
}

export function createRemoteChainProvider(genesisHash: string): RemoteChainProvider | null {
  if (!isRemoteChainConnectable(genesisHash)) {
    return null;
  }

  return (onMessage, onHalt): JsonRpcConnection => {
    const connectionId = createRequestId();
    const remote: RemoteChainConnection = {
      onMessage,
      onHalt: onHalt ?? null,
      pendingMessages: [],
      connected: false,
    };

    chainConnections.set(connectionId, remote);
    // Not yet halted or disconnected. Whoever removes it tells the consumer.
    const isOpen = (): boolean => chainConnections.get(connectionId) === remote;

    void ensureProtocolFrame()
      .then(async () => {
        // Disconnected before the connect is posted: the frame never hears of it.
        if (!isOpen()) {
          return;
        }
        await postRequest('chainConnect', { genesisHash, connectionId });
        // Disconnected while the connect was in flight: it is closed in the
        // frame now that the connect settled, not before, or the frame would
        // keep a connection opened after its disconnect.
        if (!isOpen()) {
          postDisconnect(connectionId);
          return;
        }
        remote.connected = true;
        for (const message of remote.pendingMessages) {
          void postRequest('chainSend', {
            connectionId,
            message: JSON.stringify(message),
          }).catch((error: unknown) => {
            if (!isOpen()) {
              return;
            }
            const errResponse = buildJsonRpcError(message, serializeError(error));
            if (errResponse !== null) {
              onMessage(errResponse);
            }
          });
        }
        remote.pendingMessages = [];
      })
      .catch((error: unknown) => {
        if (!isOpen()) {
          return;
        }
        // Halts like a dead frame so a caching consumer drops it. Removed first so a send made during
        // the halt is answered at once, not queued and lost.
        log.error('[dot.li protocol] Failed to connect remote chain:', error);
        chainConnections.delete(connectionId);
        haltRemote(connectionId, remote, 'frame');
      });

    return {
      send(message) {
        if (!isOpen()) {
          const errResponse = buildJsonRpcError(message, 'Chain connection is closed');
          if (errResponse !== null) {
            onMessage(errResponse);
          }
          return;
        }
        if (!remote.connected) {
          remote.pendingMessages.push(message);
          return;
        }
        void postRequest('chainSend', {
          connectionId,
          message: JSON.stringify(message),
        }).catch((error: unknown) => {
          // A papi client re-follows on the `stop` that comes before
          // `chain-halt`, and the frame refuses that send for a connection it
          // has already forgotten.
          if (!isOpen()) {
            return;
          }
          const reason = serializeError(error);
          log.error('[dot.li protocol] Remote chain send failed:', error);
          const errResponse = buildJsonRpcError(message, reason);
          if (errResponse !== null) {
            onMessage(errResponse);
          }
        });
      },
      disconnect() {
        const wasOpen = isOpen();
        chainConnections.delete(connectionId);
        // Not accepted yet: a connect not posted is never posted, and one in
        // flight is closed in the frame once it settles.
        if (wasOpen && remote.connected) {
          postDisconnect(connectionId);
        }
      },
    };
  };
}
