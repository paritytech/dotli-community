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
  DEBUG,
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
  isValidSharedAuthKey,
  isValidSharedModeKey,
  isProtocolEnvelope,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  isSharedWalletOperation,
  isSharedWalletState,
  createWalletOwner,
  isWalletOwnerOperation,
  type WalletOwner,
} from '@dotli/protocol';
import { handleWalletOperation, WALLET_DB_NAME, withSharedWalletRevision } from './wallet-storage.js';

import type { SWRelayRequest, SWOutbound } from './protocol-shared-worker.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { observeChains } from './observe-chains.js';
import { createEngine, type ProtocolEngine, type ResponseCallback } from './engine.js';
import protocolSharedWorkerUrl from './protocol-shared-worker.ts?sharedworker&url';
import { sharedWorkerGeneration } from './shared-worker-generation.js';
import { errorResponse } from './error-response.js';

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

type SharedStore = 'auth' | 'mode';
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

    void handleSharedAuthRequest(data, event.origin, response => {
      postToSource(event.source, event.origin, response);
    }).catch((error: unknown) => {
      countSharedReject('auth', 'validation');
      postToSource(event.source, event.origin, errorResponse(data.id, error));
    });
  });
}

/** Debug-only secret RPC. Only the validated trusted parent may use it. */
function bindSharedWalletListener(): void {
  if (!DEBUG) {
    return;
  }
  const channel = new BroadcastChannel('dotli:shared-wallet');
  let walletOwner: WalletOwner | undefined;
  channel.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isProtocolEnvelope(data) ||
      data.kind !== 'wallet-storage-changed' ||
      data.siteId !== SITE_ID ||
      !isSharedWalletState(data.state) ||
      parentOrigin === null ||
      !isSharedAuthOriginAllowed(parentOrigin) ||
      window.parent === window
    ) {
      return;
    }
    // Explicit construction ensures no secret-bearing extra fields get relayed.
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'wallet-storage-changed',
        siteId: SITE_ID,
        state: {
          version: data.state.version,
          revision: data.state.revision,
          enabled: data.state.enabled,
          hasWallet: data.state.hasWallet,
          storedInOtherApp: data.state.storedInOtherApp,
        },
      },
      parentOrigin,
    );
  });
  window.addEventListener('message', (event: MessageEvent) => {
    const request: unknown = event.data;
    if (
      !isProtocolEnvelope(request) ||
      request.kind !== 'request' ||
      (request.method !== 'walletStorage' && request.method !== 'walletOwner')
    ) {
      return;
    }
    if (event.source !== window.parent || !isSharedAuthOriginAllowed(event.origin)) {
      return;
    }
    parentOrigin = event.origin;
    void (async () => {
      const payload: unknown = request.payload;
      if (typeof payload !== 'object' || payload === null || !('siteId' in payload) || !('operation' in payload)) {
        throw new Error('Invalid wallet operation');
      }
      assertSharedAuthSiteId(payload.siteId);
      if (request.method === 'walletOwner') {
        if (!isWalletOwnerOperation(payload.operation)) {
          throw new Error('Invalid wallet owner operation');
        }
        walletOwner ??= createPageWalletOwner();
        const lease = await walletOwner.handle(payload.operation, request.deadlineMs);
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result: lease,
        });
        return;
      }
      if (!isSharedWalletOperation(payload.operation)) {
        throw new Error('Invalid wallet operation');
      }
      const result = await handleWalletOperation(
        payload.operation,
        state => {
          try {
            channel.postMessage({
              namespace: 'dotli:protocol',
              kind: 'wallet-storage-changed',
              siteId: SITE_ID,
              state,
            });
          } catch (error: unknown) {
            // The write itself succeeded and is answered, so the host never
            // hears that other tabs missed it.
            captureException(error, { flow: 'storage', step: 'wallet_revision_broadcast' });
          }
        },
        request.deadlineMs,
      );
      try {
        postToSource(event.source, event.origin, {
          namespace: 'dotli:protocol',
          kind: 'response',
          id: request.id,
          ok: true,
          result,
        });
      } finally {
        result.secret?.fill(0);
      }
    })().catch((error: unknown) => {
      postToSource(event.source, event.origin, errorResponse(request.id, error));
    });
  });
}

// One tab of the profile runs the test wallet. The lease lives here, on the
// host origin every app page shares, and ends when this page goes away.
function createPageWalletOwner(): WalletOwner {
  if (typeof navigator.locks === 'undefined') {
    throw new Error('Shared wallets require secure-context Web Locks');
  }
  const owner = createWalletOwner({
    locks: navigator.locks,
    channel: new BroadcastChannel('dotli:test-wallet-owner'),
    randomId: () => crypto.randomUUID(),
  });
  owner.onRevoked(lease => {
    if (parentOrigin === null || window.parent === window) {
      void owner.handle({ action: 'release', lease });
      return;
    }
    // The page stops its wallet workers, then releases the lease itself.
    window.parent.postMessage(
      {
        namespace: 'dotli:protocol',
        kind: 'wallet-owner-revoked',
        siteId: SITE_ID,
        lease,
      },
      parentOrigin,
    );
  });
  window.addEventListener('pagehide', () => {
    owner.releaseAll();
  });
  return owner;
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
  const keep: Record<string, true> = { dotli: true, 'dotli-sw': true, [WALLET_DB_NAME]: true, 'dotli-core': true };
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error(
      'Browser does not expose indexedDB.databases() — cannot fully purge worker caches. ' +
        'Please clear site data manually before retrying.',
    );
  }
  const dbs = await indexedDB.databases();
  const targets = dbs
    .map(db => db.name)
    .filter((name): name is string => name !== undefined && name !== '' && !Object.hasOwn(keep, name));
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

  // The URL import keeps Vite's worker bundling while allowing a fresh URL
  // after a crash. Reusing the closed worker's exact URL/name can attach to a
  // retired Chromium worker without starting it. All tabs share this network
  // generation; the name still supplies the worker's validated network.
  const generation = await sharedWorkerGeneration(network);
  const workerUrl = new URL(protocolSharedWorkerUrl, import.meta.url);
  workerUrl.searchParams.set('generation', generation);
  const worker = new SharedWorker(workerUrl, {
    type: 'module',
    name: `dotli-protocol-${network}`,
  });
  const port = worker.port;
  let halted = false;
  // Set while the ready wait below is pending.
  let failReadyWait: ((error: Error, reason: string) => void) | null = null;
  // Every terminal failure of the worker ends here: its script failing to
  // load, an uncaught error inside it, or a fatal it reports. Logging alone
  // would leave the host's native consumer on a dead lease, so the host
  // always hears of it through its typed frame halt path, and a pending ready
  // wait fails now with the cause rather than at the timeout with none.
  const halt = (message: string, reason: string): void => {
    if (halted) {
      return;
    }
    halted = true;
    port.close();
    // Commit the replacement identity before the host can boot another
    // frame. The lock serializes simultaneous fatals from every attached tab.
    void sharedWorkerGeneration(network, generation)
      .catch((error: unknown) => {
        message = `${message}; SharedWorker generation retirement failed: ${serializeError(error)}`;
      })
      .then(() => {
        failReadyWait?.(new Error(message), reason);
        if (window.parent !== window) {
          window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'fatal', message }, '*');
        }
      });
  };

  // Fires when the worker script cannot be fetched or evaluated. Uncaught
  // errors inside a running worker go to its own handlers, which report them
  // as a fatal below.
  worker.addEventListener('error', event => {
    const detail = event instanceof ErrorEvent && event.message !== '' ? `: ${event.message}` : '';
    const error = new Error(`SharedWorker failed to start${detail}`);
    log.error('[dot.li protocol] SharedWorker error event', error);
    halt(error.message, 'load_failed');
  });

  // Before the ready wait, because `smoldot-db` arrives during pre-sync and MessagePort events are not replayed.
  port.addEventListener('message', (event: MessageEvent) => {
    if (halted) {
      return;
    }
    const data = event.data as SWOutbound | null;
    if (data?.type === 'relay-response' && (data.envelope.kind === 'fatal' || data.envelope.kind === 'init-failed')) {
      halt(data.envelope.message, 'worker_fatal');
      return;
    }
    if (data?.type === 'error') {
      halt(`SharedWorker error: ${data.message}`, 'worker_reported');
      return;
    }
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
      if (halted) {
        return;
      }
      const data = event.data as SWOutbound | null;
      if (data?.type === 'ready') {
        settle('ok');
      }
    }

    const timer = setTimeout(() => {
      settle('timeout', new Error(PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT));
    }, TIMEOUTS.SHARED_WORKER_READY);
    failReadyWait = (error, reason) => {
      settle('error', error, reason);
    };
    port.addEventListener('message', onMessage);
    port.start();
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (halted) {
      return;
    }
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request') {
      return;
    }
    if (
      isSharedAuthRequestMethod(data.method) ||
      isSharedModeRequestMethod(data.method) ||
      data.method === 'walletStorage' ||
      data.method === 'walletOwner'
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
    if (halted) {
      return;
    }
    halted = true;
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
      data.method === 'walletStorage' ||
      data.method === 'walletOwner'
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

async function handleSharedAuthRequest(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): Promise<void> {
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
      const { siteId, key, value } = payload;
      const commit = (): void => {
        localStorage.setItem(buildSharedAuthStorageKey(siteId, key), value);
        broadcastSharedAuthChange(siteId, key, value);
      };
      if (payload.walletRevision !== undefined) {
        if (!DEBUG) {
          throw new Error('Experimental wallets require a debug build');
        }
        await withSharedWalletRevision(payload.walletRevision, commit, request.deadlineMs);
      } else {
        commit();
      }
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
bindSharedWalletListener();

void init().catch((err: unknown) => {
  log.error('[dot.li protocol] Init failed:', err);
  signalError(serializeError(err));
});
