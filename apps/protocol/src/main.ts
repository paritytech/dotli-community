// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol iframe entry. `?mode=` picks smoldot in a cross-tab SharedWorker, smoldot in this iframe, or trusted WSS
// RPC for gateway mode.

import {
  initSentry,
  installGlobalErrorHandlers,
  captureException,
  getResolutionId,
  m,
  setResolutionId,
  spans as S,
} from '@dotli/metrics';
import {
  chainBytesReceived,
  installByteMeter,
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
  loadProvider,
  loadResolve,
} from '@dotli/resolver';

// Before anything opens a socket. Smoldot traffic is invisible to resource timing, so the speed readout needs this.
installByteMeter();

// No reload here. The hidden iframe hands the failure to the parent, which shows and reports it, so no capture either.
window.addEventListener('vite:preloadError', event => {
  const evt = event as unknown as { payload?: unknown };
  log.error('[dot.li protocol] Asset failed to load', evt.payload);
  if (window.parent !== window) {
    // The browser's message names the chunk. Only Safari omits it.
    const msg = evt.payload === undefined ? 'no detail from the loader' : serializeError(evt.payload);
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'fatal',
        message: `Protocol iframe asset failed to load: ${msg}`,
      } as const,
      '*',
    );
  }
});

import { log, serializeError } from '@dotli/shared';
import {
  SITE_ID,
  TIMEOUTS,
  type SiteId,
  getActiveServicesConfig,
  isValidNetwork,
  setNetworkOverride,
  type Network,
} from '@dotli/config';

import {
  requireBrokerLocalProvider,
  buildSharedAuthStorageKey,
  buildSharedModeStorageKey,
  isSharedAuthOriginAllowed,
  isSharedAuthRequestMethod,
  isSharedAuthSiteId,
  isSharedModeRequestMethod,
  isSharedWalletRequestMethod,
  isValidSharedAuthKey,
  isValidSharedModeKey,
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from '@dotli/protocol';

import type { SWRelayRequest, SWOutbound } from './protocol-shared-worker.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { observeChains } from './observe-chains.js';
import { createEngine, type ProtocolEngine, type ResponseCallback } from './engine.js';
import { errorResponse } from './error-response.js';
import { handleLocalWalletRequest } from './local-wallet-handler.js';

initSentry('protocol');
installGlobalErrorHandlers('protocol');

// At module scope because auth-only and invalid-mode boots return early from init() yet belong to the resolution.
adoptResolutionId();

function adoptResolutionId(): void {
  try {
    const id = new URLSearchParams(window.location.search).get('resolutionId');
    if (id !== null && id !== '') {
      setResolutionId(id);
    }
    // eslint-disable-next-line no-restricted-syntax -- telemetry correlation is never a reason to fail a boot. An untagged iframe is the acceptable outcome.
  } catch {
    /* URL unparseable, carry on untagged */
  }
}

// Same allowlist as shared auth, so sandboxed apps never drive the chain bridge directly.
function isAllowedOrigin(origin: string): boolean {
  return isSharedAuthOriginAllowed(origin);
}

function postToSource(source: MessageEventSource | null, origin: string, message: ProtocolEnvelope): void {
  if (!source) {
    return;
  }
  (source as Window).postMessage(message, origin);
}

// Each tab's iframe relays other tabs' shared-auth writes to its parent. BroadcastChannel skips the sender, whose
// adapter emits locally, so nothing is dispatched twice.
const SHARED_AUTH_BROADCAST_CHANNEL = 'dotli:shared-auth';

interface SharedAuthBroadcastMessage {
  siteId: SiteId;
  key: string;
  value: string | null;
}

const sharedAuthChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SHARED_AUTH_BROADCAST_CHANNEL) : null;

// Broadcasts go only to a known parent origin, so unrelated embedders never hear them. The referrer may be blank
// under strict referrer policies.
let parentOrigin: string | null = initialParentOriginFromReferrer();

function initialParentOriginFromReferrer(): string | null {
  try {
    const ref = document.referrer;
    if (ref === '') {
      return null;
    }
    const origin = new URL(ref).origin;
    return isAllowedOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function broadcastSharedAuthChange(siteId: SiteId, key: string, value: string | null): void {
  if (sharedAuthChannel === null) {
    return;
  }
  try {
    const msg: SharedAuthBroadcastMessage = { siteId, key, value };
    sharedAuthChannel.postMessage(msg);
  } catch (error: unknown) {
    // The write was already answered, so the host never hears other tabs missed it.
    captureException(error, { flow: 'storage', step: 'shared_auth_broadcast' });
  }
}

function isSharedAuthBroadcastMessage(value: unknown): value is SharedAuthBroadcastMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as {
    siteId?: unknown;
    key?: unknown;
    value?: unknown;
  };
  return (
    typeof obj.siteId === 'string' &&
    typeof obj.key === 'string' &&
    (obj.value === null || typeof obj.value === 'string')
  );
}

function bindSharedAuthBroadcastRelay(): void {
  if (sharedAuthChannel === null) {
    return;
  }
  sharedAuthChannel.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isSharedAuthBroadcastMessage(data)) {
      return;
    }
    // Defensive, the channel is already origin-scoped.
    if (data.siteId !== SITE_ID) {
      return;
    }
    if (parentOrigin === null || window.parent === window) {
      return;
    }
    try {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'auth-storage-changed',
          siteId: data.siteId,
          key: data.key,
          value: data.value,
        } as const,
        parentOrigin,
      );
    } catch (error: unknown) {
      // Nothing waits on this notification, so the host never hears it was lost.
      captureException(error, { flow: 'storage', step: 'shared_auth_forward' });
    }
  });
}

type SharedStore = 'auth' | 'mode' | 'wallet';
type SharedRejectReason = 'origin' | 'validation';

function countSharedReject(store: SharedStore, reason: SharedRejectReason): void {
  m.count(S.SHARED_STORAGE_REJECTED, { store, reason });
}

function bindSharedAuthListener(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request' || !isSharedAuthRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected shared-auth request from disallowed origin: ${event.origin}`);
      countSharedReject('auth', 'origin');
      return;
    }
    // On every request, in case the parent navigated.
    parentOrigin = event.origin;

    try {
      handleSharedAuthRequest(data, event.origin, response => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      countSharedReject('auth', 'validation');
      postToSource(event.source, event.origin, errorResponse(data.id, error));
    }
  });
}

function signalReady(): void {
  if (window.parent !== window) {
    window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'ready' } as const, '*');
  }
}

type RequestedMode = 'shared-worker' | 'direct' | 'rpc' | null;

/** No mode means an auth-only iframe. An unknown mode is `invalid` so it errors instead of silently going auth-only. */
function getRequestedMode(): RequestedMode | 'invalid' {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get('mode');
  } catch {
    return 'invalid';
  }
  if (raw === null) {
    return null;
  }
  if (raw === 'shared-worker' || raw === 'direct' || raw === 'rpc') {
    return raw;
  }
  return 'invalid';
}

function getSkipWorkerCache(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('skipWorkerCache') === '1';
  } catch {
    return false;
  }
}

type RequestedNetwork = { kind: 'ok'; network: Network } | { kind: 'missing' } | { kind: 'invalid'; raw: string };

/** Read from the URL because this origin cannot see the host's `dotli:network` in `localStorage`. */
function getRequestedNetwork(): RequestedNetwork {
  let raw: string | null;
  try {
    raw = new URLSearchParams(window.location.search).get('network');
  } catch {
    return { kind: 'invalid', raw: '<unparseable>' };
  }
  if (raw === null) {
    return { kind: 'missing' };
  }
  if (isValidNetwork(raw)) {
    return { kind: 'ok', network: raw };
  }
  return { kind: 'invalid', raw };
}

/** Deletes every IndexedDB that could warm-start the chains, keeping dotli's own stores of user state. */
async function purgeWorkerCaches(): Promise<void> {
  // Throws rather than continuing, which would boot smoldot against the stale DB.
  const KEEP = new Set(['dotli', 'dotli-sw']);
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error(
      'Browser does not expose indexedDB.databases() — cannot fully purge worker caches. ' +
        'Please clear site data manually before retrying.',
    );
  }
  const dbs = await indexedDB.databases();
  const targets = dbs
    .map(db => db.name)
    .filter((name): name is string => name !== undefined && name !== '' && !KEEP.has(name));
  await Promise.all(
    targets.map(
      name =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => {
            resolve();
          };
          req.onerror = () => {
            reject(
              new Error(
                `Failed to delete IDB ${name}: ${req.error?.name ?? 'unknown'}`,
                req.error ? { cause: req.error } : undefined,
              ),
            );
          };
          req.onblocked = () => {
            reject(new Error(`Delete of IDB ${name} blocked by another connection`));
          };
        }),
    ),
  );
  log.event('Worker caches purged', { flow: 'protocol', databases: targets.length });
}

async function init(): Promise<void> {
  const mode = getRequestedMode();

  if (mode === 'invalid') {
    let raw: string | null = null;
    try {
      raw = new URLSearchParams(window.location.search).get('mode');
      // eslint-disable-next-line no-restricted-syntax -- best-effort extraction of the mode value for the message, the error is signalled below regardless.
    } catch {
      /* URL parse failed, fall through with raw=null */
    }
    const message = `Unknown protocol mode: ${raw === null ? '<unparseable>' : `"${raw}"`}`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }

  if (mode === null) {
    log.event('Protocol mode', { flow: 'protocol', mode: 'auth-only' });
    signalReady();
    return;
  }
  const requestedNetwork = getRequestedNetwork();
  if (requestedNetwork.kind === 'invalid') {
    const message = `Unknown protocol network: "${requestedNetwork.raw}"`;
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }
  if (requestedNetwork.kind === 'missing') {
    const message = 'Missing required `network` URL param — host shell did not propagate the active network.';
    log.error(`[dot.li protocol] ${message}`);
    signalError(message);
    return;
  }
  setNetworkOverride(requestedNetwork.network);
  m.setDefaults({ network: requestedNetwork.network });
  log.event('Protocol mode', { flow: 'protocol', mode, network: requestedNetwork.network });

  // Before any smoldot init. A failed purge aborts, since a stale DB would silently ignore the user's setting.
  if (getSkipWorkerCache()) {
    try {
      await purgeWorkerCaches();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[dot.li protocol] purgeWorkerCaches failed:', err);
      signalError(`Failed to reset chain DB: ${message}`);
      return;
    }
  }

  const initStart = performance.now();
  let initOutcome: 'ok' | 'error' = 'error';
  try {
    if (mode === 'shared-worker') {
      if (typeof SharedWorker === 'undefined') {
        const msg = 'SharedWorker is not available in this browser';
        log.error(`[dot.li protocol] ${msg}`);
        signalError(msg);
        return;
      }
      // Before any further metrics, so every one carries the mode.
      m.setDefaults({ protocol_mode: 'shared-worker' });
      await initSharedWorkerMode(requestedNetwork.network);
      m.count(S.PROTOCOL_MODE, { mode: 'shared-worker' });
    } else if (mode === 'rpc') {
      m.setDefaults({ protocol_mode: 'rpc' });
      initRpcMode();
      m.count(S.PROTOCOL_MODE, { mode: 'rpc' });
    } else {
      m.setDefaults({ protocol_mode: 'direct' });
      await initDirectMode();
      m.count(S.PROTOCOL_MODE, { mode: 'direct' });
    }
    initOutcome = 'ok';
  } finally {
    const initMs = performance.now() - initStart;
    // A failed init is only a point in the distribution.
    if (initOutcome === 'ok') {
      m.measure(S.PROTOCOL_INIT, initMs);
    }
    m.distribution(S.PROTOCOL_INIT, initMs, 'millisecond', { outcome: initOutcome });
  }
}

function signalError(message: string): void {
  // No `id`, since no request was in flight. The client rejects everything pending and blocks until reload.
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'init-failed',
        message,
      } as const,
      '*',
    );
  }
}

async function initSharedWorkerMode(network: Network): Promise<void> {
  const swStartTime = performance.now();

  // Vite only rewrites a literal `new URL` argument, so the network travels in the worker name, not a query param.
  const worker = new SharedWorker(new URL('./protocol-shared-worker.ts', import.meta.url), {
    type: 'module',
    name: `dotli-protocol-${network}`,
  });
  const port = worker.port;

  let failReadyWait: ((error: Error) => void) | null = null;

  // Fires only when the worker script cannot be fetched or evaluated.
  worker.addEventListener('error', event => {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new Error(`SharedWorker failed to start${detail}`);
    log.error('[dot.li protocol] SharedWorker error event', error);
    if (failReadyWait !== null) {
      // Fails now with the cause instead of at the ready timeout. The host reports the resulting `init-failed`.
      failReadyWait(error);
      return;
    }
    // After ready nothing waits on the worker's start, so the host would never hear of it.
    captureException(error, { flow: 'protocol', step: 'shared_worker_error' });
  });

  // Before the ready wait, because `smoldot-db` arrives during pre-sync and MessagePort events are not replayed.
  port.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as SWOutbound | null;
    if (data?.type === 'relay-response' && window.parent !== window) {
      window.parent.postMessage(data.envelope, '*');
    }
  });

  await new Promise<void>((resolve, reject) => {
    function settle(outcome: 'ok' | 'error' | 'timeout', error?: Error, reason?: string): void {
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      failReadyWait = null;
      const waitMs = performance.now() - swStartTime;
      m.distribution(S.PROTOCOL_SW_READY, waitMs, 'millisecond', {
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (error !== undefined) {
        reject(error);
        return;
      }
      m.measure(S.PROTOCOL_SW_READY, waitMs);
      resolve();
    }

    function onMessage(event: MessageEvent): void {
      const data = event.data as SWOutbound | null;
      if (data?.type === 'ready') {
        settle('ok');
      } else if (data?.type === 'error') {
        settle('error', new Error(`SharedWorker error: ${data.message}`), 'worker_reported');
      }
    }

    const timer = setTimeout(() => {
      settle('timeout', new Error(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT));
    }, TIMEOUTS.SHARED_WORKER_READY);
    failReadyWait = error => {
      settle('error', error, 'load_failed');
    };
    port.addEventListener('message', onMessage);
    port.start();
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request') {
      return;
    }
    if (
      isSharedAuthRequestMethod(data.method) ||
      isSharedModeRequestMethod(data.method) ||
      isSharedWalletRequestMethod(data.method)
    ) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`);
      return;
    }

    // Per request, since the worker serves every tab.
    const resolutionId = getResolutionId();
    const msg: SWRelayRequest = {
      type: 'relay-request',
      envelope: data,
      origin: event.origin,
      ...(resolutionId !== null ? { resolutionId } : {}),
    };
    port.postMessage(msg);
  });

  signalReady();

  window.addEventListener('beforeunload', () => {
    try {
      port.postMessage({ type: 'disconnect' });
      // eslint-disable-next-line no-restricted-syntax -- best-effort unload signal, the port may already be closed.
    } catch {
      /* port already closed on unload, safe */
    }
    port.close();
  });
}

async function initDirectMode(): Promise<void> {
  // Dynamic so the other modes do not pay for the smoldot bundle.
  const [provider, resolve] = await Promise.all([loadProvider(), loadResolve()]);
  const { createChainProvider, isChainSupported, onProviderFatal, onSmoldotDbOutcome } = provider;
  const {
    resolveDotName,
    resolveExecutableManifest,
    resolveOwner,
    resolveRootManifest,
    setResolverAssetHubProvider,
    setResolverPeopleProvider,
    waitForPeopleFinalized,
  } = resolve;
  // Before the first `createChainProvider` call, or that connection carries no lifecycle watch.
  resolve.enableSyncReporting([
    // The chains the load waits on, in that order.
    'relay',
    'asset-hub',
    'bulletin',
    // Off the loading path, but the network panel lists its peer count.
    'people',
  ]);
  const { onChainSync } = resolve;

  const services = getActiveServicesConfig();

  onProviderFatal(message => {
    log.error(`[dot.li protocol] Light client died, signaling fatal: ${message}`);
    if (window.parent !== window) {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'fatal',
          message,
        },
        '*',
      );
    }
  });

  onChainSync(event => {
    if (window.parent === window) {
      return;
    }
    const { chain, kind, ...rest } = event;
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'chain-sync',
        chain,
        syncKind: kind,
        ...rest,
      },
      '*',
    );
  });

  // Telemetry only, attached by the host to the resolution it is tracing.
  resolve.onChainDetail(detail => {
    if (window.parent === window) {
      return;
    }
    window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'chain-detail', ...detail }, '*');
  });

  // Cumulative totals, so the host owns the averaging and a dropped message only widens one window.
  if (window.parent !== window) {
    const postBytes = (): void => {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'net-bytes',
          received: chainBytesReceived(),
        },
        '*',
      );
    };
    // A baseline now, since a rate needs two readings.
    postBytes();
    const reportBytes = setInterval(postBytes, 500);
    window.addEventListener('pagehide', () => {
      clearInterval(reportBytes);
    });
  }

  onSmoldotDbOutcome((chain, outcome) => {
    if (window.parent !== window) {
      window.parent.postMessage(
        {
          namespace: 'dotli:protocol',
          kind: 'smoldot-db',
          chain,
          outcome,
        },
        '*',
      );
    }
  });

  const engine = createEngine({
    createChainProvider,
    isChainSupported,
    // Releasing a smoldot chain makes the light client drop it and re-sync later.
    destroyDelay: Infinity,
    onBrokerReady: broker => {
      // The relay carries the warp progress but papi never dials it. Bulletin opened lazily by the first
      // `bitswap_v1_get` has no peers yet and fails it, so it finds peers while the name resolves.
      const stopWatching = observeChains(broker, [services.relay.genesis, services.bulletin.genesis]);
      window.addEventListener('pagehide', stopWatching);
      // One follow per chain, shared with the broker (see protocol-shared-worker).
      setResolverAssetHubProvider(() =>
        requireBrokerLocalProvider(broker, getActiveServicesConfig().assethub.genesis, 'Asset Hub'),
      );
      setResolverPeopleProvider(() =>
        requireBrokerLocalProvider(broker, getActiveServicesConfig().people.genesis, 'People'),
      );
    },
    onWarmup: () => {
      // Legacy-account auth reads People, which would race a cold warp sync. Resolution does not need it.
      void waitForPeopleFinalized().catch((err: unknown) => {
        log.warn('[dot.li protocol] People chain warm failed (retried on demand)', err);
      });
      return Promise.resolve();
    },
    resolveDotName,
    resolveOwner,
    resolveExecutableManifest,
    resolveRootManifest,
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

// Gateway mode resolves names in the host process, so no resolver is wired here.
function initRpcMode(): void {
  const engine = createEngine({
    // The core set, so the network panel can watch Bulletin. Advertisement to dApps is curated in
    // `isRemoteChainSupported`.
    createChainProvider: createCoreRpcChainProvider,
    isChainSupported: isCoreRpcChainSupported,
    // An unused RPC chain's socket closes a minute after its last connection.
    destroyDelay: 60_000,
  });

  bindEngineToMessages(engine);
  signalReady();

  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

function bindEngineToMessages(engine: ProtocolEngine): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request') {
      return;
    }
    if (
      isSharedAuthRequestMethod(data.method) ||
      isSharedModeRequestMethod(data.method) ||
      isSharedWalletRequestMethod(data.method)
    ) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected request from disallowed origin: ${event.origin}`);
      return;
    }

    void engine
      .handleRequest(data, event.origin, response => {
        postToSource(event.source, event.origin, response);
      })
      .catch((error: unknown) => {
        // The host rebuilds this failure from the response and reports it.
        log.warn(`[dot.li protocol] ${data.method} failed`, error);
        postToSource(event.source, event.origin, errorResponse(data.id, error));
      });
  });
}

function assertSharedAuthSiteId(value: unknown): asserts value is SiteId {
  if (typeof value !== 'string' || !isSharedAuthSiteId(value)) {
    throw new Error(`Invalid siteId: ${String(value)}`);
  }
}

function assertSharedAuthKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSharedAuthKey(value)) {
    throw new Error(`Invalid shared auth key: ${String(value)}`);
  }
}

function assertSharedAuthOrigin(origin: string): void {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Shared auth request denied from origin: ${origin}`);
  }
}

function assertSharedModeKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isValidSharedModeKey(value)) {
    throw new Error(`Invalid shared mode key: ${String(value)}`);
  }
}

/** Reuses the shared-auth checks so both stores keep one trust boundary. */
function handleSharedModeRequest(request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback): void {
  if (!isSharedModeRequestMethod(request.method)) {
    throw new Error(`Not a shared mode request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case 'modeStorageRead': {
      const payload = request.payload as ProtocolRequestMap['modeStorageRead'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: localStorage.getItem(buildSharedModeStorageKey(payload.siteId, payload.key)),
      });
      return;
    }

    case 'modeStorageWrite': {
      const payload = request.payload as ProtocolRequestMap['modeStorageWrite'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      if (typeof payload.value !== 'string') {
        throw new Error(PROTOCOL_APP_ERRORS.INVALID_SHARED_MODE_VALUE);
      }
      localStorage.setItem(buildSharedModeStorageKey(payload.siteId, payload.key), payload.value);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'modeStorageClear': {
      const payload = request.payload as ProtocolRequestMap['modeStorageClear'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedModeKey(payload.key);
      localStorage.removeItem(buildSharedModeStorageKey(payload.siteId, payload.key));
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

function bindSharedModeListener(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request' || !isSharedModeRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected shared-mode request from disallowed origin: ${event.origin}`);
      countSharedReject('mode', 'origin');
      return;
    }

    try {
      handleSharedModeRequest(data, event.origin, response => {
        postToSource(event.source, event.origin, response);
      });
    } catch (error: unknown) {
      countSharedReject('mode', 'validation');
      postToSource(event.source, event.origin, errorResponse(data.id, error));
    }
  });
}

function bindLocalWalletListener(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request' || !isSharedWalletRequestMethod(data.method)) {
      return;
    }
    if (!isAllowedOrigin(event.origin)) {
      log.warn(`[dot.li protocol] Rejected local wallet request from disallowed origin: ${event.origin}`);
      countSharedReject('wallet', 'origin');
      return;
    }
    handleLocalWalletRequest(data, event.origin).then(
      result => {
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: data.id,
          ok: true,
          result,
        });
      },
      (error: unknown) => {
        // The host rebuilds this failure from the response and reports it.
        log.warn(`[dot.li protocol] ${data.method} failed`, error);
        postToSource(event.source, event.origin, errorResponse(data.id, error));
      },
    );
  });
}

function handleSharedAuthRequest(request: ProtocolRequestEnvelope, origin: string, respond: ResponseCallback): void {
  if (!isSharedAuthRequestMethod(request.method)) {
    throw new Error(`Not a shared auth request: ${request.method as string}`);
  }

  assertSharedAuthOrigin(origin);

  switch (request.method) {
    case 'authStorageRead': {
      const payload = request.payload as ProtocolRequestMap['authStorageRead'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: localStorage.getItem(buildSharedAuthStorageKey(payload.siteId, payload.key)),
      });
      return;
    }

    case 'authStorageWrite': {
      const payload = request.payload as ProtocolRequestMap['authStorageWrite'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      if (typeof payload.value !== 'string') {
        throw new Error(PROTOCOL_APP_ERRORS.INVALID_SHARED_AUTH_VALUE);
      }
      localStorage.setItem(buildSharedAuthStorageKey(payload.siteId, payload.key), payload.value);
      broadcastSharedAuthChange(payload.siteId, payload.key, payload.value);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'authStorageClear': {
      const payload = request.payload as ProtocolRequestMap['authStorageClear'];
      assertSharedAuthSiteId(payload.siteId);
      assertSharedAuthKey(payload.key);
      localStorage.removeItem(buildSharedAuthStorageKey(payload.siteId, payload.key));
      broadcastSharedAuthChange(payload.siteId, payload.key, null);
      respond({
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }
  }
}

bindSharedAuthListener();
bindSharedAuthBroadcastRelay();
bindSharedModeListener();
bindLocalWalletListener();

void init().catch((err: unknown) => {
  log.error('[dot.li protocol] Init failed:', err);
  signalError(serializeError(err));
});
