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

import { deleteIdb, log, serializeError } from '@dotli/shared';
import {
  TIMEOUTS,
  getActiveServicesConfig,
  isLocalhost,
  isValidNetwork,
  setActiveNetwork,
  type Network,
} from '@dotli/config';

import { isSharedAuthOriginAllowed, type ProtocolRequestEnvelope } from '@dotli/protocol';
import { DB_NAME } from '@dotli/storage';

import type { SWRelayRequest } from './worker-messages.js';
import { connectSharedWorker } from './shared-worker-link.js';
import { readSessionTuning } from './session-tuning.js';
import { createEngine, type ResponseCallback } from './engine.js';
import { startLightClientService } from './light-client-service.js';
import { handleLocalWalletRequest } from './local-wallet-handler.js';
import { createSharedStoreHandler, SHARED_AUTH_CHANNEL } from './shared-store-handler.js';
import { createFrameRouter } from './frame-router.js';
import { createRefusalReporter } from './refusal-report.js';

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

function signalParent(kind: 'ready' | 'listening'): void {
  if (window.parent !== window) {
    window.parent.postMessage({ namespace: 'dotli:protocol', kind } as const, '*');
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
    signalParent('ready');
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
  setActiveNetwork(requestedNetwork.network);
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
  // No `id`, since no request was in flight. The host rejects everything pending, drops this frame and builds a new one
  // after a wait.
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
  // Vite only rewrites a literal `new URL` argument, so the network travels in the worker name, not a query param.
  const worker = new SharedWorker(new URL('./protocol-shared-worker.ts', import.meta.url), {
    type: 'module',
    name: `dotli-protocol-${network}`,
  });
  const port = await connectSharedWorker({
    worker,
    window,
    relay: envelope => {
      if (window.parent !== window) {
        window.parent.postMessage(envelope, '*');
      }
    },
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
    if (window.parent === window) {
      return;
    }
    if (change.kind === 'db') {
      const { chain, outcome } = change;
      window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'smoldot-db', chain, outcome }, '*');
      return;
    }
    window.parent.postMessage({ namespace: 'dotli:protocol', kind: 'fatal', message: change.message }, '*');
  });

  provider.onChainSync(event => {
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
  provider.onChainDetail(detail => {
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
