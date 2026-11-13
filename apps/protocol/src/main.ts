// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol iframe entry. `?mode=` picks smoldot in a cross-tab SharedWorker, smoldot in this iframe, or trusted WSS
// RPC for gateway mode.

import {
  createReporter,
  defineCount,
  initSentry,
  installGlobalErrorHandlers,
  countMetric,
  getResolutionId,
  m,
  setResolutionId,
} from '@dotli/metrics';
import { byteMeter, loadProvider, SMOLDOT_DB_NAME, type ChainPool } from '@dotli/chains';
import { loadResolve } from '@dotli/resolver';

import { deleteIdb, getErrorMessage, log, serializeError } from '@dotli/shared';
import {
  TIMEOUTS,
  getActiveServicesConfig,
  isLocalhost,
  parseSettingsFromSearch,
  setActiveNetwork,
  type Backend,
  type Network,
} from '@dotli/config';

import {
  getBackendOfFrameMode,
  createWireReport,
  isSharedAuthOriginAllowed,
  ProtocolFatalError,
  ProtocolInitFailedError,
  protocolSchema,
} from '@dotli/protocol';
import { createTransport, createWindowProvider, ok } from '@dotli/transport';

import { connectSharedWorker } from './connectSharedWorker.js';
import { createEngine, type ProtocolEngine } from './createEngine.js';
import { createFrameBoot } from './createFrameBoot.js';
import { createRefusalReporter } from './createRefusalReporter.js';
import { createSharedStoreHandler } from './createSharedStoreHandler.js';
import { createTelemetryHandler } from './createTelemetryHandler.js';
import { disposeOnPageHide } from './disposeOnPageHide.js';
import { FRAME_LOG_TAG } from './frameLogTag.js';
import { loadGatewayChains, loadLightClientService } from './lazy.js';
import { toWorkerName } from './parseWorkerNetwork.js';
import { readResolveBudgetCap } from './readResolveBudgetCap.js';
import { readSessionTuning } from './readSessionTuning.js';
import { registerWorkerRelay } from './registerWorkerRelay.js';
import { serveEngineScope } from './serveEngineMethods.js';
import { serveLocalWallet } from './serveLocalWallet.js';
import { servePoolControl } from './servePoolControl.js';
import { shareNetBytes } from './shareNetBytes.js';
import { SHARED_WORKER_MODE } from './sharedWorkerMode.js';
import { toLightClientDb } from './toLightClientDb.js';
import { withRefusalReports } from './withRefusalReports.js';

const report = createReporter({ flow: 'protocol' });

/** The start of the mode, from after the chain database purge. */
const PROTOCOL_INIT = 'protocol.init';

const protocolModeMetric = defineCount('protocol.mode');

// Runs before `init()` loads the light client on demand, so its sockets are counted from the first. Smoldot's traffic
// is invisible to resource timing, so only this meter counts it.
byteMeter.install();

// What the host hears of this frame's boot, on subscribe, so a failure before the host asks is not lost.
const boot = createFrameBoot();

// No reload here. The failure reaches the host as the frame status's end, not as a capture.
window.addEventListener('vite:preloadError', event => {
  // Typed as an Error, but the loader hands on whatever the import rejected with.
  const payload: unknown = event.payload;
  log.error(`${FRAME_LOG_TAG} Asset failed to load`, payload);
  // The browser's message names the chunk. Only Safari omits it.
  const message = payload === undefined ? 'no detail from the loader' : serializeError(payload);
  boot.fail(new ProtocolFatalError(`Protocol iframe asset failed to load: ${message}`, { cause: payload }));
});

initSentry('protocol');
installGlobalErrorHandlers('protocol');

// Read once, since the frame's URL does not change.
const frameSearch = new URLSearchParams(window.location.search);

// At module scope because auth-only and invalid-mode boots return early from init() yet belong to the resolution.
const resolutionId = frameSearch.get('resolutionId');
if (resolutionId !== null && resolutionId !== '') {
  setResolutionId(resolutionId);
}

// What this frame's provider and transport drop, each counted once, whichever of them drops it.
const wire = createWireReport({ side: 'frame', count: countMetric });

// The one channel to the host page. It answers the handshake at once, so it is bound before anything loads, and it
// speaks only when spoken to. This frame reads its page load from its URL, never from a hello.
const serving = createTransport({
  schema: protocolSchema,
  provider: createWindowProvider({
    listen: window,
    peer: () => window.parent,
    // The shared-auth allowlist guards every method served here, the shared stores and the wallet included, so sandboxed
    // apps never drive them or the chain bridge directly.
    origin: isSharedAuthOriginAllowed,
    onRefusedOrigin: wire.onRefusedOrigin,
  }),
  handshake: 'respond',
  hello: { resolutionId: null },
  onIssue: wire.onIssue,
});
serving.handleSubscription(protocolSchema.sections.frame.status, boot.handleStatus);
serving.handleSubscription(protocolSchema.sections.frame.telemetry, boot.handleTelemetry);
// Answered at once, so the host can tell a frame that still answers from one that went silent. The frame answers as
// long as its page, so the stop goes unused.
serving.handleRequest(protocolSchema.sections.frame.heartbeat, () => ok());

// What the stores, the wallet and the engine refuse is logged and counted, as well as answered.
const served = withRefusalReports(serving, createRefusalReporter({ warn: log.warn, count: countMetric }));
const sharedStores = createSharedStoreHandler({
  serving: served,
  readStorage: () => localStorage,
});
// The frame serves the wallet as long as its page, so the stop goes unused.
serveLocalWallet({
  serving: served,
  onChange: siteId => {
    sharedStores.broadcastWalletChange(siteId);
  },
});

/**
 * Logs `message` and fails the boot for good, so this frame never serves the chains. The frame keeps serving the shared
 * store and the wallet after its init failed. Never throws.
 */
function failInit(message: string, options?: ErrorOptions): void {
  const error = new ProtocolInitFailedError(message, options);
  log.error(`${FRAME_LOG_TAG} Init failed:`, error);
  boot.fail(error);
}

async function init(): Promise<void> {
  const mode = frameSearch.get('mode');
  // No mode means an auth-only iframe.
  if (mode === null) {
    report.log.event('Protocol mode', { mode: 'auth-only' });
    boot.markReady();
    return;
  }
  // An unknown mode errors instead of silently going auth-only.
  const backend = getBackendOfFrameMode(mode);
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
  report.log.event('Protocol mode', { mode, network });

  // Before any smoldot init. A failed purge aborts, since a stale DB would silently ignore the user's setting.
  if (skipWorkerCache === true) {
    try {
      // The frame shares its origin with the landing page, so it deletes its own chain database by name and nothing
      // else.
      await deleteIdb(indexedDB, SMOLDOT_DB_NAME);
      report.log.event('Worker caches purged', { database: SMOLDOT_DB_NAME });
    } catch (error: unknown) {
      failInit(`Failed to reset chain DB: ${getErrorMessage(error)}`, { cause: error });
      return;
    }
  }

  const initStart = performance.now();
  let initOutcome: 'ok' | 'error' = 'error';
  try {
    if (await startMode(backend, network)) {
      initOutcome = 'ok';
    }
  } finally {
    const initMs = performance.now() - initStart;
    // A failed init is only a point in the distribution.
    if (initOutcome === 'ok') {
      m.measure(PROTOCOL_INIT, initMs);
    }
    m.distribution(PROTOCOL_INIT, initMs, { unit: 'millisecond', attributes: { outcome: initOutcome } });
  }
}

/**
 * Starts the mode `backend` names, tagging every later metric with it, and resolves whether it started. A browser
 * without `SharedWorker` fails the boot and resolves `false`. Rejects with what the mode's start rejects with.
 */
async function startMode(backend: Backend, network: Network): Promise<boolean> {
  switch (backend) {
    case 'smoldot-shared-worker':
      if (typeof SharedWorker === 'undefined') {
        failInit('SharedWorker is not available in this browser');
        return false;
      }
      // Before any further metrics, so every one carries the mode.
      m.setDefaults({ protocol_mode: SHARED_WORKER_MODE });
      await initSharedWorkerMode(network);
      protocolModeMetric.count({ mode: SHARED_WORKER_MODE });
      return true;
    case 'rpc-gateway':
      m.setDefaults({ protocol_mode: 'rpc' });
      await initRpcMode();
      protocolModeMetric.count({ mode: 'rpc' });
      return true;
    case 'smoldot-direct':
      m.setDefaults({ protocol_mode: 'direct' });
      await initDirectMode();
      protocolModeMetric.count({ mode: 'direct' });
      return true;
  }
}

async function initSharedWorkerMode(network: Network): Promise<void> {
  // Vite only rewrites a literal `new URL` argument, so the network travels in the worker name, not a query param.
  const worker = new SharedWorker(new URL('./protocolSharedWorker.ts', import.meta.url), {
    type: 'module',
    name: toWorkerName(network),
  });
  const link = connectSharedWorker({
    worker,
    page: window,
    resolutionId: getResolutionId(),
    readyTimeoutMs: TIMEOUTS.SHARED_WORKER_READY,
    onIssue: wire.onIssue,
  });
  // The link and the relay live as long as the frame's page, so their stops go unused.
  // Relayed calls skip this frame's refusal report, since the refusals they carry are not this frame's own.
  registerWorkerRelay({ serving, worker: link.transport, workerStatus: link.status, boot });
  await link.ready;
  boot.markReady();
}

/**
 * Serves `engine` and the pause of `pool`, reports the frame ready, and disposes `engine` once the page is hidden for
 * good. The iframe serves its one parent, so one scope holds every connection.
 */
function serveEngine(engine: ProtocolEngine, pool: ChainPool): void {
  // The frame serves its engine and its pause as long as its page, so the stops go unused.
  serveEngineScope(served, engine);
  servePoolControl({ serving: served, control: pool });
  disposeOnPageHide({ target: window, dispose: engine.dispose });
  boot.markReady();
}

async function initDirectMode(): Promise<void> {
  // Dynamic so the other modes pay for neither smoldot nor the chain pool.
  const [provider, resolve, lightClientService] = await Promise.all([
    loadProvider(),
    loadResolve(),
    loadLightClientService(),
  ]);
  const session = readSessionTuning(() => sessionStorage);
  const lightClient = provider.createLightClient(provider.createLightClientDeps(session, isLocalhost));
  const service = lightClientService.startLightClientService({
    lightClient,
    resolver: {
      createDotnsResolver: resolve.createDotnsResolver,
      enableSyncReporting: provider.chainSync.enableSyncReporting,
    },
    services: getActiveServicesConfig(),
  });
  // The service lives as long as the frame's page, so the stop goes unused.
  disposeOnPageHide({ target: window, dispose: service.dispose });

  lightClient.subscribe(change => {
    if (change.kind === 'fatal') {
      log.error(`${FRAME_LOG_TAG} Light client died, signaling fatal: ${change.message}`);
      boot.fail(new ProtocolFatalError(change.message));
    }
  });

  boot.serveTelemetry(
    createTelemetryHandler({
      onChainSync: provider.chainSync.onChainSync,
      // Telemetry only.
      onChainDetail: provider.chainSync.onChainDetail,
      ...toLightClientDb(lightClient),
      onNetBytes: shareNetBytes({ read: byteMeter.readBytesReceived }),
      // This frame's light client is its own, so each database read is this tab's.
      hasJoinedSynced: () => false,
    }),
  );

  const engine = createEngine({
    pool: service.pool,
    isChainSupported: lightClient.isChainSupported,
    onWarmup() {
      // Warmed in the background, so a later People read does not wait on a cold warp sync. The warmup call never
      // waits on it.
      service.warmPeople(FRAME_LOG_TAG);
      return Promise.resolve();
    },
    resolver: service.dotns,
    syncBudgetCapMs: readResolveBudgetCap(session),
  });

  serveEngine(engine, service.pool);
}

// Gateway mode serves chain connections only, so no resolver is wired here.
async function initRpcMode(): Promise<void> {
  const { openGatewayChains } = await loadGatewayChains();
  const chains = openGatewayChains();
  const engine = createEngine(chains);

  serveEngine(engine, chains.pool);
}

void init().catch((error: unknown) => {
  failInit(serializeError(error), { cause: error });
});
