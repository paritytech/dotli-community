// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol SharedWorker.
//
// Runs @parity/truapi-provider's embedded smoldot light client in-thread, via
// `@dotli/resolver/provider`. No sub-Worker is spawned, because the `Worker`
// constructor is not available in SharedWorkerGlobalScope. All protocol iframes
// across every tab connect over MessagePort and share the one light client,
// which persists as long as at least one tab is open.

/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope;

import type { SmoldotDbChain, SmoldotDbOutcome } from '@dotli/protocol';

import { isValidNetwork, setNetworkOverride, getActiveServicesConfig } from '@dotli/config';

import {
  createChainProvider,
  enableSyncReporting,
  isChainSupported,
  onChainDetail,
  onChainSync,
  onProviderFatal,
  onSmoldotDbOutcome,
  resolveDotName,
  resolveExecutableManifest,
  resolveOwner,
  resolveRootManifest,
  resolveSeitySlot,
  setResolverAssetHubProvider,
  setResolverPeopleProvider,
  waitForAssetHubFinalized,
  waitForPeopleFinalized,
} from '@dotli/resolver';

import {
  m,
  captureException,
  initSentry,
  installGlobalErrorHandlers,
  spans as S,
  type SpanHandle,
} from '@dotli/metrics';

import {
  createChainPool,
  requireBrokerLocalProvider,
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
  getRequestSyncTimeoutMs,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolEnvelope,
} from '@dotli/protocol';
import { errorName, isExecutableKind, log, serializeError } from '@dotli/shared';

import { errorResponse } from './error-response.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { createWorkerChainSessions, type WorkerChainSessions } from './worker-chains.js';

initSentry('worker');
installGlobalErrorHandlers('worker');
// Only ever runs in shared-worker mode. Tag every metric emitted from this
// context so broker/smoldot counters aggregate cleanly with the iframe's.
m.setDefaults({ protocol_mode: 'shared-worker' });

export interface SWRelayRequest {
  type: 'relay-request';
  envelope: ProtocolRequestEnvelope;
  origin: string;
  /**
   * The page load of the tab that sent the request. Carried per request
   * because this worker serves every tab at once: it can only ever label the
   * work done for one request, never its own context.
   */
  resolutionId?: string;
}

export interface SWRelayResponse {
  type: 'relay-response';
  envelope: ProtocolEnvelope;
}

export interface SWReady {
  type: 'ready';
}

export interface SWError {
  type: 'error';
  message: string;
}

export type SWOutbound = SWRelayResponse | SWReady | SWError;

const TAG = '[dot.li SW]';

function swEvent(message: string, data?: Record<string, unknown>): void {
  log.event(message, { flow: 'protocol', ...data });
}

const ports = new Set<MessagePort>();
const pendingPorts: MessagePort[] = [];
// Each port's way out of the chain sync streams, released with the port.
const syncForwarders = new Map<MessagePort, () => void>();
let engineReady = false;
// Why the engine is dead for good: pre-sync failed, or the light client could
// not connect a chain. Every port that connects later is told, never `ready`.
let presyncFailureMessage: string | null = null;
let workerStopped = false;

// An uncaught worker error is terminal, not a socket reconnect. Tell every
// attached frame before retiring this worker, so the host's existing frame
// halt/backoff path can take a fresh lease without replacing its native Core.
self.addEventListener('error', event => {
  if (workerStopped) {
    return;
  }
  workerStopped = true;
  engineReady = false;
  const message = event.message || 'Protocol SharedWorker crashed';
  presyncFailureMessage = message;
  broadcastToPorts({ namespace: 'dotli:protocol', kind: 'fatal', message });
  pendingPorts.length = 0;
  self.close();
});

const NETWORK_NAME_PREFIX = 'dotli-protocol-';
let networkInitFailure: string | null = null;
const requestedNetwork = self.name.startsWith(NETWORK_NAME_PREFIX) ? self.name.slice(NETWORK_NAME_PREFIX.length) : null;
if (requestedNetwork === null) {
  networkInitFailure = `Unexpected SharedWorker name "${self.name}" — iframe did not encode the active network.`;
} else if (!isValidNetwork(requestedNetwork)) {
  networkInitFailure = `Unknown protocol network: "${requestedNetwork}"`;
} else {
  setNetworkOverride(requestedNetwork);
  m.setDefaults({ network: requestedNetwork });
}

// This worker owns the light client in shared-worker mode, so it is the only
// place the chains' sync can be observed from. Enabled before pre-sync opens
// the first connection, which would otherwise carry no lifecycle watch. Same
// chains as direct mode.
enableSyncReporting(['relay', 'asset-hub', 'bulletin', 'people']);

// Light-client death broadcast. When the light client cannot connect a chain,
// relay a `fatal` envelope to every connected port so the host client rejects
// every in-flight request immediately instead of waiting for a per-request
// timeout. `onProviderFatal` is idempotent and replays to late subscribers,
// so firing this once at module load covers the SharedWorker's lifetime.
//
// The light client stays dead for every tab: the engine is marked failed, so
// a port that connects later (another tab, or this one after its retry) gets
// the cause through the same path as a failed pre-sync, never `ready`.
onProviderFatal(message => {
  if (workerStopped) {
    return;
  }
  log.error(`${TAG} Light client died, broadcasting fatal to ${String(ports.size)} port(s): ${message}`);
  engineReady = false;
  presyncFailureMessage = message;
  broadcastToPorts({ namespace: 'dotli:protocol', kind: 'fatal', message });
});

// Tell every connected tab which chains began from pre-existing state. The
// provider replay only covers this in-worker subscriber, never MessagePorts,
// so the record-time broadcast reaches only ports connected at that instant.
// `latchedSmoldotDb` covers the rest: the connect handler below replays it to
// every port that arrives later.
const latchedSmoldotDb = new Map<SmoldotDbChain, SmoldotDbOutcome>();
onSmoldotDbOutcome((chain, outcome) => {
  latchedSmoldotDb.set(chain, outcome);
  broadcastToPorts({
    namespace: 'dotli:protocol',
    kind: 'smoldot-db',
    chain,
    outcome,
  });
});

// Created by pre-sync.
let chainSessions: WorkerChainSessions | null = null;

function requireChainSessions(): WorkerChainSessions {
  if (chainSessions === null) {
    throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
  }
  return chainSessions;
}

// NO retries. NO cleanup-and-retry. NO backoff. The user picked
// smoldot-shared-worker. If presync fails the actual cause is surfaced to
// every waiting port and the engine stays dead until the user reloads.

async function presync(): Promise<void> {
  const t0 = performance.now();
  swEvent('Pre-sync started');

  try {
    // Create the broker FIRST and route the resolver's Asset Hub reads
    // through it as a local session, so there is one shared Asset Hub follow
    // (never removed mid-read) instead of a separate resolver chain the first
    // dApp connection would release — the `ChainHead disjointed` load failure.
    const pool = createChainPool({
      createTransport: createChainProvider,
      destroyDelay: Infinity,
    });
    chainSessions = createWorkerChainSessions(pool, isChainSupported, sendToPort, swEvent);
    setResolverAssetHubProvider(() =>
      requireBrokerLocalProvider(pool, getActiveServicesConfig().assethub.genesis, 'Asset Hub'),
    );
    // The People warm-keep must share this same broker follow. A separate
    // getSmProvider on the People chain would race the broker's follow (one
    // shared smoldot JSON-RPC queue) and have its events misrouted, so the
    // broker drops People follow events as "unknown token" and reads hang.
    setResolverPeopleProvider(() =>
      requireBrokerLocalProvider(pool, getActiveServicesConfig().people.genesis, 'People'),
    );

    // Wait for Asset Hub to sync to a finalized block via the
    // explicit presync primitive (no more overloading `resolveDotName`
    // with a sentinel label). This now syncs the broker's shared chain.
    // The resolver records the `smoldot.presync` timing for this wait.
    await waitForAssetHubFinalized();

    // A light client that failed while Asset Hub synced stays dead: the
    // waiting ports were told by the fatal broadcast, and must not hear ready.
    if (presyncFailureMessage !== null) {
      return;
    }

    swEvent('Pre-sync complete', { ms: Math.round(performance.now() - t0) });
    engineReady = true;

    // Signal ready to any ports that connected during pre-sync
    for (const port of pendingPorts) {
      const readyMsg: SWReady = { type: 'ready' };
      port.postMessage(readyMsg);
    }
    pendingPorts.length = 0;

    // Warm the People chain in the background. Legacy-account auth reads the
    // username -> account map on People, and on a cold start that read races
    // the parachain warp sync (the source of the intermittent failures). Start
    // syncing it now so it is ready by the time auth runs. People is not needed
    // for resolution, so this must not gate the ready signal above.
    void waitForPeopleFinalized().catch((err: unknown) => {
      log.warn(`${TAG} People chain warm failed (retried on demand)`, err);
    });
  } catch (err: unknown) {
    const msg = serializeError(err);
    log.error(`${TAG} Pre-sync failed: ${msg}`, err);
    m.count(S.SMOLDOT_PRESYNC, {
      outcome: 'error',
      reason: err instanceof Error ? err.name : 'unknown',
    });

    // Surface the actual cause to every waiting port. Engine remains
    // permanently dead. The user must reload to retry. A light client that
    // died during pre-sync is that cause, and this failure only its symptom:
    // the fatal broadcast already told the waiting ports, and later ones hear
    // the fatal's message.
    if (presyncFailureMessage === null) {
      presyncFailureMessage = msg;
      for (const port of pendingPorts) {
        const errorMsg: SWError = { type: 'error', message: msg };
        port.postMessage(errorMsg);
      }
    }
    pendingPorts.length = 0;
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

function broadcastToPorts(envelope: ProtocolEnvelope): void {
  for (const port of ports) {
    sendToPort(port, envelope);
  }
}

function sendToPort(port: MessagePort, envelope: ProtocolEnvelope): void {
  // Promise continuations and queued chain events belong to the retired
  // worker generation. Only its terminal notification may still leave it.
  if (workerStopped && envelope.kind !== 'fatal') {
    return;
  }
  try {
    const msg: SWRelayResponse = { type: 'relay-response', envelope };
    port.postMessage(msg);
  } catch (err: unknown) {
    // Distinguish "port closed" (expected on tab navigation) from any
    // other postMessage failure. Closed ports throw `InvalidStateError`
    // or `DataCloneError` with `name === "InvalidStateError"`. Any other
    // cause (a structured-clone failure on an un-transferable payload,
    // for example) is a real bug and we want it visible instead of
    // silently removing an otherwise-healthy port.
    if (errorName(err) === 'InvalidStateError') {
      removePort(port, 'closed');
      return;
    }
    // What failed to arrive is lost for good: a response leaves the tab
    // waiting out its timeout with no cause, and a broadcast never arrives.
    // Nothing reaches the host to report, so this is the only report.
    captureException(err, {
      flow: 'protocol',
      step: 'worker_port_send',
      tags: { envelope_kind: envelope.kind },
    });
    // Remove the port regardless, since we can't deliver to it.
    removePort(port, 'send_failed');
  }
}

type PortRemoval = 'closed' | 'disconnect' | 'stale' | 'send_failed';

function removePort(port: MessagePort, reason: PortRemoval): void {
  ports.delete(port);
  syncForwarders.get(port)?.();
  syncForwarders.delete(port);
  const cleaned = chainSessions?.removePort(port) ?? 0;
  swEvent('Port removed', { reason, connections: cleaned, ports: ports.size });
}

/**
 * Forward what the chains report about their sync to one tab.
 *
 * The chains are shared, so every tab hears every chain's events. Each
 * subscription first replays where each chain stands, which is what a tab
 * joining a running worker needs to hear.
 */
function forwardChainSync(port: MessagePort, joinedSynced: boolean): void {
  let replaying = true;
  const stopSync = onChainSync(event => {
    const { chain, kind, ...rest } = event;
    sendToPort(port, { namespace: 'dotli:protocol', kind: 'chain-sync', chain, syncKind: kind, ...rest });
  });
  const stopDetail = onChainDetail(detail => {
    // A tab joining a synced worker paid no sync cost, whatever the worker's
    // own first start found on disk: the rule `smoldot-db` follows below.
    const reported =
      replaying && joinedSynced && detail.dbCache !== undefined ? { ...detail, dbCache: 'hit' as const } : detail;
    sendToPort(port, { namespace: 'dotli:protocol', kind: 'chain-detail', ...reported });
  });
  replaying = false;
  const stop = (): void => {
    stopSync();
    stopDetail();
  };
  // A failed send during the replay has already removed the port.
  if (!ports.has(port)) {
    stop();
    return;
  }
  syncForwarders.set(port, stop);
}

async function handleRequest(port: MessagePort, request: ProtocolRequestEnvelope, origin: string): Promise<void> {
  if (isSharedAuthRequestMethod(request.method)) {
    throw new Error(`Shared auth requests must be handled on host.dot.li, not the SharedWorker: ${request.method}`);
  }
  if (isSharedModeRequestMethod(request.method)) {
    throw new Error(
      `Shared mode-storage requests must be handled on host.dot.li, not the SharedWorker: ${request.method}`,
    );
  }

  const syncTimeoutMs = getRequestSyncTimeoutMs(request);
  const syncOptions = syncTimeoutMs !== undefined ? { syncTimeoutMs } : {};

  switch (request.method) {
    case 'warmup': {
      // Pre-sync already started smoldot, the relay chain, and periodic
      // saves. Just confirm it's done.
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'resolveDotName': {
      const payload = request.payload as ProtocolRequestMap['resolveDotName'];
      assertString(payload.label, 'label');
      const result = await resolveDotName(payload.label, {
        onStatus: message => {
          sendToPort(port, {
            namespace: 'dotli:protocol',
            kind: 'progress',
            id: request.id,
            message,
          });
        },
        ...syncOptions,
      });
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case 'resolveSeitySlot': {
      const payload = request.payload as ProtocolRequestMap['resolveSeitySlot'];
      assertString(payload.lookupKey, 'lookupKey');
      const slot = await resolveSeitySlot(payload.lookupKey as `0x${string}`, syncOptions);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: slot === null ? null : { ...slot, version: slot.version.toString() },
      });
      return;
    }

    case 'resolveOwner': {
      const payload = request.payload as ProtocolRequestMap['resolveOwner'];
      assertString(payload.label, 'label');
      const result = await resolveOwner(payload.label, syncOptions);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case 'resolveExecutableManifest': {
      const payload = request.payload as ProtocolRequestMap['resolveExecutableManifest'];
      assertString(payload.label, 'label');
      // postMessage payloads are untrusted strings even though TS narrows
      // `payload.kind` to the union. Widening through a string local keeps the
      // runtime check intact under strict TS rules.
      const kind: string = payload.kind;
      if (!isExecutableKind(kind)) {
        throw new Error(`Unsupported executable kind: ${kind}`);
      }
      const result = await resolveExecutableManifest(payload.label, payload.kind, syncOptions);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case 'resolveRootManifest': {
      const payload = request.payload as ProtocolRequestMap['resolveRootManifest'];
      assertString(payload.label, 'label');
      const result = await resolveRootManifest(payload.label, syncOptions);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result,
      });
      return;
    }

    case 'chainConnect': {
      const payload = request.payload as ProtocolRequestMap['chainConnect'];
      assertString(payload.genesisHash, 'genesisHash');
      assertString(payload.connectionId, 'connectionId');
      requireChainSessions().connect(port, origin, payload.genesisHash, payload.connectionId);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'chainSend': {
      const payload = request.payload as ProtocolRequestMap['chainSend'];
      assertString(payload.connectionId, 'connectionId');
      assertString(payload.message, 'message');
      requireChainSessions().send(origin, payload.connectionId, payload.message);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'chainDisconnect': {
      const payload = request.payload as ProtocolRequestMap['chainDisconnect'];
      assertString(payload.connectionId, 'connectionId');
      requireChainSessions().disconnect(origin, payload.connectionId);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    case 'walletStorage':
    case 'coreCustody':
    case 'walletOwner':
      throw new Error('Wallet storage is only available through the trusted protocol iframe');

    default: {
      const _method: never = request.method;
      throw new Error(`Unknown protocol method: ${_method as string}`);
    }
  }
}

// Bounds what a tab can write into this worker's span attributes. The host
// mints a UUID.
const RESOLUTION_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * A span for the work one tab's request costs this worker, labelled with the
 * page load of that tab.
 *
 * The label goes on this span alone. The worker serves every tab at once, so a
 * resolution id set on its scope or its metric defaults would label the work
 * of other tabs too.
 */
function openRequestSpan(envelope: ProtocolRequestEnvelope, resolutionId: unknown): SpanHandle | null {
  // One per product JSON-RPC message: as on the host, it would swamp the
  // resolution requests.
  if (envelope.method === 'chainSend') {
    return null;
  }
  return m.open(S.PROTOCOL_WORKER_REQUEST, {
    root: true,
    attributes: {
      method: envelope.method,
      ...(typeof resolutionId === 'string' && RESOLUTION_ID_PATTERN.test(resolutionId)
        ? { resolution_id: resolutionId }
        : {}),
    },
  });
}

// Proactively clean up stale ports by sending a ping.
// Posting to a closed port throws, and we catch that to detect dead ports.
function cleanStalePorts(): void {
  for (const p of [...ports]) {
    try {
      p.postMessage({ type: 'ping' });
    } catch {
      removePort(p, 'stale');
    }
  }
}

self.addEventListener('connect', event => {
  if (workerStopped) {
    return;
  }
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }

  // Clean up any stale ports from previous iframe reloads
  cleanStalePorts();

  ports.add(port);
  swEvent('Port connected', {
    ports: ports.size,
    engine: presyncFailureMessage !== null ? 'failed' : engineReady ? 'ready' : 'syncing',
  });

  port.addEventListener('message', (msgEvent: MessageEvent) => {
    if (workerStopped) {
      return;
    }
    const data = msgEvent.data as { type?: string } | null;

    // Handle disconnect signal from iframe beforeunload
    if (data?.type === 'disconnect') {
      removePort(port, 'disconnect');
      return;
    }

    if (data?.type !== 'relay-request') {
      return;
    }

    const relayData = data as SWRelayRequest;
    const { envelope, origin } = relayData;
    const span = openRequestSpan(envelope, relayData.resolutionId);
    void handleRequest(port, envelope, origin)
      .then(
        () => {
          span?.setAttributes({ outcome: 'ok' });
        },
        (error: unknown) => {
          span?.setAttributes({ outcome: 'error', error_name: errorName(error) ?? 'NonError' });
          // The host rebuilds this failure from the response and reports it.
          log.warn(`${TAG} ${envelope.method} failed`, error);
          sendToPort(port, errorResponse(envelope.id, error));
        },
      )
      .finally(() => {
        span?.end();
      });
  });

  port.start();

  // Before the ready signal, so a tab hears where the chains stand before it
  // starts its resolution against them.
  if (presyncFailureMessage === null) {
    forwardChainSync(port, engineReady);
  }

  if (presyncFailureMessage !== null) {
    // The engine is dead: pre-sync failed, or the light client could not
    // connect a chain. Surface the original cause immediately instead of
    // queuing this port forever or telling it the engine is ready.
    const errorMsg: SWError = {
      type: 'error',
      message: presyncFailureMessage,
    };
    port.postMessage(errorMsg);
  } else if (engineReady) {
    // Engine already synced, signal ready immediately.
    const readyMsg: SWReady = { type: 'ready' };
    port.postMessage(readyMsg);
    // This tab joins a worker whose recorded chains are already live, so it
    // pays no sync cost regardless of what the worker's own first load did.
    // Report the state this tab got rather than the worker's disk outcomes.
    for (const chain of latchedSmoldotDb.keys()) {
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'smoldot-db',
        chain,
        outcome: 'hit',
      });
    }
  } else {
    // Engine still syncing. Queue the port and signal when pre-sync completes.
    // A port arriving after a store read missed that record-time broadcast
    // and would otherwise never learn the outcome. It waits on the same sync
    // the worker is running, so the worker's outcomes are its own.
    for (const [chain, outcome] of latchedSmoldotDb) {
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'smoldot-db',
        chain,
        outcome,
      });
    }
    pendingPorts.push(port);
  }
});

if (networkInitFailure !== null) {
  // Every tab hears this as the reason the worker never became ready, and the
  // host reports it from there.
  log.error(`${TAG} ${networkInitFailure}`);
  presyncFailureMessage = networkInitFailure;
} else {
  swEvent('Worker started', { network: requestedNetwork });
  void presync();
}
