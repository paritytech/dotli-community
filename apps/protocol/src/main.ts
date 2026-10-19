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
import { chainBytesReceived, installByteMeter, loadProvider } from '@dotli/chains';
import { loadResolve } from '@dotli/resolver';

import { deleteAllDatabases, errorMessage, log, serializeError } from '@dotli/shared';
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
  ProtocolFatalError,
  ProtocolInitFailedError,
  protocolSchema,
} from '@dotli/protocol';
import { DB_NAME } from '@dotli/storage';
import { createTransport, createWindowProvider } from '@dotli/transport';

import { connectSharedWorker, registerWorkerRelay } from './shared-worker-link.js';
import { readSessionTuning, resolveBudgetCapMs } from './session-tuning.js';
import { createEngine, serveEngineScope, type ProtocolEngine } from './engine.js';
import { loadGatewayChains, loadLightClientService } from './lazy.js';
import { createSharedStoreHandler, serveLocalWallet, SHARED_AUTH_CHANNEL } from './shared-store-handler.js';
import { createRefusalReporter, createWireReport, reportRefusals } from './refusal-report.js';
import { intervalTicker, NET_BYTES_INTERVAL_MS, shareNetBytes } from './net-bytes.js';
import { createFrameBoot } from './frame-boot.js';
import { createTelemetryHandler, lightClientDb } from './telemetry-handler.js';

// Runs before `init()` loads the light client on demand, so its sockets are counted from the first. Smoldot traffic is
// invisible to resource timing, so the speed readout needs this.
installByteMeter();

// What the host hears of this frame's boot, on subscribe, so a failure before the host asks is not lost.
const boot = createFrameBoot();

// No reload here. The hidden iframe hands the failure to the parent, which shows and reports it, so no capture either.
window.addEventListener('vite:preloadError', event => {
  // Typed as an Error, but the loader hands on whatever the import rejected with.
  const payload: unknown = event.payload;
  log.error('[dot.li protocol] Asset failed to load', payload);
  // The browser's message names the chunk. Only Safari omits it.
  const msg = payload === undefined ? 'no detail from the loader' : serializeError(payload);
  boot.fail(new ProtocolFatalError(`Protocol iframe asset failed to load: ${msg}`, { cause: payload }));
});

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

// What this frame's provider and transport drop, each counted once, whichever of them drops it.
const wire = createWireReport('frame', { warn: log.warn, count: m.count });

// The one channel to the host page. It answers the handshake at once, so it is bound before anything loads, and it
// speaks only when spoken to. The host's hello names no page load, which this frame reads from its URL.
const serving = createTransport(
  protocolSchema,
  createWindowProvider({
    listen: window,
    peer: () => window.parent,
    // Same allowlist as shared auth, so sandboxed apps never drive the chain bridge directly.
    origin: isSharedAuthOriginAllowed,
    // Only a host page of an earlier release sends objects. It never hears an answer and fails by its own timeout.
    onNotBytes: wire.onNotBytes,
    onRefusedOrigin: wire.onRefusedOrigin,
  }),
  { handshake: 'accept', hello: { resolutionId: null }, onIssue: wire.onIssue },
);
serving.handleSubscription(protocolSchema.traits.frame.status, boot.frameStatus);
serving.handleSubscription(protocolSchema.traits.frame.telemetry, boot.telemetry);

// What the stores, the wallet and the engine refuse is logged and counted, as well as answered.
const served = reportRefusals(serving, createRefusalReporter({ warn: log.warn, count: m.count }));
createSharedStoreHandler(served, {
  storage: () => localStorage,
  channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SHARED_AUTH_CHANNEL) : null,
});
serveLocalWallet(served);

/** Deletes every IndexedDB that could warm-start the chains, keeping dotli's own stores of user state. */
async function purgeWorkerCaches(): Promise<void> {
  // Rejects rather than continuing, which would boot smoldot against the stale DB.
  const deleted = await deleteAllDatabases(indexedDB, [DB_NAME]);
  log.event('Worker caches purged', { flow: 'protocol', databases: deleted.length });
}

/** A boot that cannot start, which the host answers by dropping this frame and building a new one after a wait. */
function failInit(message: string, cause?: unknown): void {
  log.error(`[dot.li protocol] ${message}`);
  boot.fail(new ProtocolInitFailedError(message, cause === undefined ? undefined : { cause }));
}

async function init(): Promise<void> {
  const mode = frameSearch.get('mode');
  // No mode means an auth-only iframe.
  if (mode === null) {
    log.event('Protocol mode', { flow: 'protocol', mode: 'auth-only' });
    boot.ready();
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
      log.error('[dot.li protocol] purgeWorkerCaches failed:', err);
      failInit(`Failed to reset chain DB: ${errorMessage(err)}`, err);
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
      await initRpcMode();
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

async function initSharedWorkerMode(network: Network): Promise<void> {
  // Vite only rewrites a literal `new URL` argument, so the network travels in the worker name, not a query param.
  const worker = new SharedWorker(new URL('./protocol-shared-worker.ts', import.meta.url), {
    type: 'module',
    name: `dotli-protocol-${network}`,
  });
  const link = connectSharedWorker({
    worker,
    window,
    resolutionId: getResolutionId(),
    readyTimeoutMs: TIMEOUTS.SHARED_WORKER_READY,
    onIssue: wire.onIssue,
  });
  // The worker reports what it refuses, so these calls skip this frame's refusal report.
  registerWorkerRelay(serving, link.transport, link.status, boot);
  await link.ready;
  boot.ready();
}

/**
 * Serves `engine` and reports the frame ready. The iframe serves its one parent, so one scope holds every connection.
 */
function serveEngine(engine: ProtocolEngine): void {
  serveEngineScope(served, engine);
  boot.ready();
  window.addEventListener('beforeunload', () => {
    engine.cleanup();
  });
}

async function initDirectMode(): Promise<void> {
  // Dynamic so the other modes pay for neither smoldot nor the chain pool.
  const [provider, resolve, lightClientService] = await Promise.all([
    loadProvider(),
    loadResolve(),
    loadLightClientService(),
  ]);
  const session = readSessionTuning(() => sessionStorage);
  const lightClient = provider.createLightClient(provider.lightClientDeps(session, isLocalhost));
  const service = lightClientService.startLightClientService({
    lightClient,
    resolver: { createDotnsResolver: resolve.createDotnsResolver, enableSyncReporting: provider.enableSyncReporting },
    services: getActiveServicesConfig(),
  });
  window.addEventListener('pagehide', service.stop);

  lightClient.subscribe(change => {
    if (change.kind === 'fatal') {
      log.error(`[dot.li protocol] Light client died, signaling fatal: ${change.message}`);
      boot.fail(new ProtocolFatalError(change.message));
    }
  });

  boot.serveTelemetry(
    createTelemetryHandler({
      onChainSync: provider.onChainSync,
      // Telemetry only, attached by the host to the resolution it is tracing.
      onChainDetail: provider.onChainDetail,
      ...lightClientDb(lightClient),
      netBytes: shareNetBytes(chainBytesReceived, intervalTicker(NET_BYTES_INTERVAL_MS)),
      // This frame's light client is its own, so each database read is this tab's.
      joinedSynced: () => false,
    }),
  );

  const engine = createEngine({
    pool: service.pool,
    isChainSupported: lightClient.isChainSupported,
    onWarmup: () => {
      // Legacy-account auth reads People, which would race a cold warp sync. Resolution does not need it.
      void service.dotns.waitForPeopleFinalized().catch((err: unknown) => {
        log.warn('[dot.li protocol] People chain warm failed (retried on demand)', err);
      });
      return Promise.resolve();
    },
    resolver: service.dotns,
    syncBudgetCapMs: resolveBudgetCapMs(session),
  });

  serveEngine(engine);
}

// Gateway mode resolves names in the host process, so no resolver is wired here.
async function initRpcMode(): Promise<void> {
  const { openGatewayChains } = await loadGatewayChains();
  const engine = createEngine(openGatewayChains());

  serveEngine(engine);
}

void init().catch((err: unknown) => {
  log.error('[dot.li protocol] Init failed:', err);
  boot.fail(new ProtocolInitFailedError(serializeError(err), { cause: err }));
});
