// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol iframe entry. `?mode=` picks smoldot in a cross-tab SharedWorker, smoldot in this iframe, or trusted WSS
// RPC for gateway mode.

import {
  initSentry,
  installGlobalErrorHandlers,
  getResolutionId,
  m,
  setResolutionId,
  spans as S,
} from '@dotli/metrics';
import {
  chainBytesReceived,
  installByteMeter,
  createChainPool,
  createCoreRpcChainProvider,
  isCoreRpcChainSupported,
  loadProvider,
} from '@dotli/chains';
import { loadResolve } from '@dotli/resolver';

// Before anything opens a socket. Smoldot traffic is invisible to resource timing, so the speed readout needs this.
installByteMeter();

// No reload here. The hidden iframe hands the failure to the parent, which shows and reports it, so no capture either.
window.addEventListener('vite:preloadError', event => {
  const evt = event as unknown as { payload?: unknown };
  log.error('[dot.li protocol] Asset failed to load', evt.payload);
  // The browser's message names the chunk. Only Safari omits it.
  const msg = evt.payload === undefined ? 'no detail from the loader' : serializeError(evt.payload);
  postToParent({
    namespace: 'dotli:protocol',
    kind: 'fatal',
    message: `Protocol iframe asset failed to load: ${msg}`,
  });
});

import { deleteIdb, log, serializeError } from '@dotli/shared';
import {
  TIMEOUTS,
  getActiveServicesConfig,
  isLocalhost,
  parseSettingsFromSearch,
  setActiveNetwork,
  type Network,
} from '@dotli/config';

import {
  backendOfFrameMode,
  isSharedAuthOriginAllowed,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
} from '@dotli/protocol';
import { DB_NAME } from '@dotli/storage';

import type { SWRelayRequest } from './worker-messages.js';
import { connectSharedWorker } from './shared-worker-link.js';
import { readSessionTuning } from './session-tuning.js';
import { chainDetailEnvelope, chainSyncEnvelope } from './envelopes.js';
import { createEngine, type ResponseCallback } from './engine.js';
import { startLightClientService } from './light-client-service.js';
import { handleLocalWalletRequest } from './local-wallet-handler.js';
import { createSharedStoreHandler, SHARED_AUTH_CHANNEL } from './shared-store-handler.js';
import { createFrameRouter } from './frame-router.js';
import { createRefusalReporter } from './refusal-report.js';

initSentry('protocol');
installGlobalErrorHandlers('protocol');

// The host builds this frame's URL from its settings, so it is read once.
const frameSearch = new URLSearchParams(window.location.search);

// At module scope because auth-only and invalid-mode boots return early from init() yet belong to the resolution.
adoptResolutionId();

function adoptResolutionId(): void {
  const id = frameSearch.get('resolutionId');
  if (id !== null && id !== '') {
    setResolutionId(id);
  }
}

// Same allowlist as shared auth, so sandboxed apps never drive the chain bridge directly.
function isAllowedOrigin(origin: string): boolean {
  return isSharedAuthOriginAllowed(origin);
}

// Only an allowed parent hears other tabs' auth writes. The referrer may be blank under strict referrer policies.
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

const sharedStore = createSharedStoreHandler({
  storage: () => localStorage,
  channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SHARED_AUTH_CHANNEL) : null,
  parent: window.parent !== window ? window.parent : null,
  initialParentOrigin: initialParentOriginFromReferrer(),
});

async function serveLocalWallet(
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
): Promise<void> {
  const result = await handleLocalWalletRequest(request, origin);
  respond({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result });
}

const router = createFrameRouter({
  target: window,
  isAllowedOrigin,
  routes: { auth: sharedStore.auth, mode: sharedStore.mode, wallet: serveLocalWallet },
  onRefused: createRefusalReporter({ warn: log.warn, count: m.count }),
});

/** Every envelope this frame sends its parent, typed, so a shape change in the wire contract fails the build here. */
function postToParent(envelope: ProtocolEnvelope): void {
  if (window.parent !== window) {
    window.parent.postMessage(envelope, '*');
  }
}

function signalParent(kind: 'ready' | 'listening'): void {
  postToParent({ namespace: 'dotli:protocol', kind });
}

/** Deletes every IndexedDB that could warm-start the chains, keeping dotli's own stores of user state. */
async function purgeWorkerCaches(): Promise<void> {
  // Throws rather than continuing, which would boot smoldot against the stale DB.
  const KEEP = new Set([DB_NAME]);
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
  await Promise.all(targets.map(name => deleteIdb(indexedDB, name)));
  log.event('Worker caches purged', { flow: 'protocol', databases: targets.length });
}

/** A boot that cannot start, which the host answers by dropping this frame and building a new one after a wait. */
function failInit(message: string): void {
  log.error(`[dot.li protocol] ${message}`);
  signalError(message);
}

async function init(): Promise<void> {
  const mode = frameSearch.get('mode');
  // No mode means an auth-only iframe.
  if (mode === null) {
    log.event('Protocol mode', { flow: 'protocol', mode: 'auth-only' });
    signalParent('ready');
    return;
  }
  // An unknown mode errors instead of silently going auth-only.
  const backend = backendOfFrameMode(mode);
  if (backend === null) {
    failInit(`Unknown protocol mode: "${mode}"`);
    return;
  }
  // From the URL, because this origin cannot see the host's network in its `localStorage`.
  const { network, skipWorkerCache } = parseSettingsFromSearch(frameSearch);
  if (network === null) {
    failInit(`Missing or unknown protocol network: "${frameSearch.get('network') ?? ''}"`);
    return;
  }
  setActiveNetwork(network);
  m.setDefaults({ network });
  log.event('Protocol mode', { flow: 'protocol', mode, network });

  // Before any smoldot init. A failed purge aborts, since a stale DB would silently ignore the user's setting.
  if (skipWorkerCache === true) {
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
    if (backend === 'smoldot-shared-worker') {
      if (typeof SharedWorker === 'undefined') {
        failInit('SharedWorker is not available in this browser');
        return;
      }
      // Before any further metrics, so every one carries the mode.
      m.setDefaults({ protocol_mode: 'shared-worker' });
      await initSharedWorkerMode(network);
      m.count(S.PROTOCOL_MODE, { mode: 'shared-worker' });
    } else if (backend === 'rpc-gateway') {
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
  // No `id`, since no request was in flight. The host rejects everything pending, drops this frame and builds a new one
  // after a wait.
  postToParent({ namespace: 'dotli:protocol', kind: 'init-failed', message });
}

async function initSharedWorkerMode(network: Network): Promise<void> {
  // Vite only rewrites a literal `new URL` argument, so the network travels in the worker name, not a query param.
  const worker = new SharedWorker(new URL('./protocol-shared-worker.ts', import.meta.url), {
    type: 'module',
    name: `dotli-protocol-${network}`,
  });
  const port = await connectSharedWorker({
    worker,
    window,
    relay: postToParent,
    readyTimeoutMs: TIMEOUTS.SHARED_WORKER_READY,
  });

  router.setRoute('chain', (request, origin) => {
    // Per request, since the worker serves every tab.
    const resolutionId = getResolutionId();
    const msg: SWRelayRequest = {
      type: 'relay-request',
      envelope: request,
      origin,
      ...(resolutionId !== null ? { resolutionId } : {}),
    };
    port.postMessage(msg);
  });

  signalParent('ready');
}

async function initDirectMode(): Promise<void> {
  // Dynamic so the other modes do not pay for the smoldot bundle.
  const [provider, resolve] = await Promise.all([loadProvider(), loadResolve()]);
  const lightClient = provider.createLightClient(
    provider.lightClientDeps(
      readSessionTuning(() => sessionStorage),
      isLocalhost,
    ),
  );
  const service = startLightClientService({
    lightClient,
    resolver: { createDotnsResolver: resolve.createDotnsResolver, enableSyncReporting: provider.enableSyncReporting },
    services: getActiveServicesConfig(),
  });
  window.addEventListener('pagehide', service.stop);

  lightClient.subscribe(change => {
    if (change.kind === 'fatal') {
      log.error(`[dot.li protocol] Light client died, signaling fatal: ${change.message}`);
    }
    if (change.kind === 'db') {
      const { chain, outcome } = change;
      postToParent({ namespace: 'dotli:protocol', kind: 'smoldot-db', chain, outcome });
      return;
    }
    postToParent({ namespace: 'dotli:protocol', kind: 'fatal', message: change.message });
  });

  provider.onChainSync(event => {
    postToParent(chainSyncEnvelope(event));
  });

  // Telemetry only, attached by the host to the resolution it is tracing.
  provider.onChainDetail(detail => {
    postToParent(chainDetailEnvelope(detail));
  });

  // Cumulative totals, so the host owns the averaging and a dropped message only widens one window.
  if (window.parent !== window) {
    const postBytes = (): void => {
      postToParent({ namespace: 'dotli:protocol', kind: 'net-bytes', received: chainBytesReceived() });
    };
    // A baseline now, since a rate needs two readings.
    postBytes();
    const reportBytes = setInterval(postBytes, 500);
    window.addEventListener('pagehide', () => {
      clearInterval(reportBytes);
    });
  }

  const engine = createEngine({
    broker: service.broker,
    isChainSupported: lightClient.isChainSupported,
    onWarmup: () => {
      // Legacy-account auth reads People, which would race a cold warp sync. Resolution does not need it.
      void service.dotns.waitForPeopleFinalized().catch((err: unknown) => {
        log.warn('[dot.li protocol] People chain warm failed (retried on demand)', err);
      });
      return Promise.resolve();
    },
    resolver: service.dotns,
  });

  // The iframe serves its one parent, so one scope holds every connection.
  router.setRoute('chain', engine.openScope().handleRequest);
  signalParent('ready');

  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

// Gateway mode resolves names in the host process, so no resolver is wired here.
function initRpcMode(): void {
  const engine = createEngine({
    // The core set, so the network panel can watch Bulletin. Advertisement to dApps is curated in
    // `isRemoteChainSupported`. An unused RPC chain's socket closes a minute after its last connection.
    broker: createChainPool({ createTransport: createCoreRpcChainProvider, destroyDelay: 60_000 }),
    isChainSupported: isCoreRpcChainSupported,
  });

  // The iframe serves its one parent, so one scope holds every connection.
  router.setRoute('chain', engine.openScope().handleRequest);
  signalParent('ready');

  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

signalParent('listening');

void init().catch((err: unknown) => {
  log.error('[dot.li protocol] Init failed:', err);
  signalError(serializeError(err));
});
