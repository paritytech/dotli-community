// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs smoldot in-thread because SharedWorkerGlobalScope has no `Worker` constructor. Every tab's protocol iframe
// shares this one light client over a MessagePort.

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
// Tagged so broker and smoldot counters aggregate with the iframe's.
m.setDefaults({ protocol_mode: 'shared-worker' });

export interface SWRelayRequest {
  type: 'relay-request';
  envelope: ProtocolRequestEnvelope;
  origin: string;
  /** The sending tab's page load. Per request, because this worker serves every tab at once. */
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
const syncForwarders = new Map<MessagePort, () => void>();
let engineReady = false;
// Set once the engine is dead for good. Every later port is told this, never `ready`.
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

// Before pre-sync opens the first connection, which would otherwise carry no lifecycle watch.
enableSyncReporting(['relay', 'asset-hub', 'bulletin', 'people']);

// `fatal` lets every tab reject in-flight requests at once instead of timing out. The engine stays dead, so later
// ports get the cause like a failed pre-sync.
onProviderFatal(message => {
  if (workerStopped) {
    return;
  }
  log.error(`${TAG} Light client died, broadcasting fatal to ${String(ports.size)} port(s): ${message}`);
  engineReady = false;
  presyncFailureMessage = message;
  broadcastToPorts({ namespace: 'dotli:protocol', kind: 'fatal', message });
});

// The provider replays only to this in-worker subscriber, so the connect handler replays the latch to later ports.
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

let chainSessions: WorkerChainSessions | null = null;

function requireChainSessions(): WorkerChainSessions {
  if (chainSessions === null) {
    throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
  }
  return chainSessions;
}

// No retries by design. A failed pre-sync leaves the engine dead until reload, with the cause sent to every port.
async function presync(): Promise<void> {
  const t0 = performance.now();
  swEvent('Pre-sync started');

  try {
    // The broker comes first so the resolver shares its one Asset Hub follow. A separate resolver chain would be
    // released by the first dApp connection mid-read (`ChainHead disjointed`).
    const pool = createChainPool({
      createTransport: createChainProvider,
      destroyDelay: Infinity,
    });
    chainSessions = createWorkerChainSessions(pool, isChainSupported, sendToPort, swEvent);
    setResolverAssetHubProvider(() =>
      requireBrokerLocalProvider(pool, getActiveServicesConfig().assethub.genesis, 'Asset Hub'),
    );
    // A separate People provider would race the broker on smoldot's one JSON-RPC queue, its events dropped as
    // "unknown token" and reads hanging.
    setResolverPeopleProvider(() =>
      requireBrokerLocalProvider(pool, getActiveServicesConfig().people.genesis, 'People'),
    );

    // The resolver records the `smoldot.presync` timing for this wait.
    await waitForAssetHubFinalized();

    // The fatal broadcast already told the waiting ports, they must not hear ready.
    if (presyncFailureMessage !== null) {
      return;
    }

    swEvent('Pre-sync complete', { ms: Math.round(performance.now() - t0) });
    engineReady = true;

    for (const port of pendingPorts) {
      const readyMsg: SWReady = { type: 'ready' };
      port.postMessage(readyMsg);
    }
    pendingPorts.length = 0;

    // Legacy-account auth reads People, which otherwise races its warp sync on a cold start. Resolution does not
    // need People, so this must not gate ready.
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

    // A light client that died during pre-sync is the real cause, and the fatal broadcast already reported it.
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
    // A closed port (tab navigation) is expected. Any other failure, such as a clone error, is a real bug.
    if (errorName(err) === 'InvalidStateError') {
      removePort(port, 'closed');
      return;
    }
    // The host never hears of this failure, so this is the only report.
    captureException(err, {
      flow: 'protocol',
      step: 'worker_port_send',
      tags: { envelope_kind: envelope.kind },
    });
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

/** Forwards every chain's sync events to one tab, starting with a replay of where each chain stands. */
function forwardChainSync(port: MessagePort, joinedSynced: boolean): void {
  let replaying = true;
  const stopSync = onChainSync(event => {
    const { chain, kind, ...rest } = event;
    sendToPort(port, { namespace: 'dotli:protocol', kind: 'chain-sync', chain, syncKind: kind, ...rest });
  });
  const stopDetail = onChainDetail(detail => {
    // A tab joining a synced worker paid no sync cost, the same rule `smoldot-db` follows below.
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
      // Widened to string so strict TS keeps the runtime check on this untrusted payload.
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
    case 'walletOwner':
      throw new Error('Wallet storage is only available through the trusted protocol iframe');

    default: {
      const _method: never = request.method;
      throw new Error(`Unknown protocol method: ${_method as string}`);
    }
  }
}

// Bounds what a tab can write into this worker's span attributes. The host mints a UUID.
const RESOLUTION_ID_PATTERN = /^[\w-]{1,64}$/;

/** The resolution id goes on this span alone, since scope or metric defaults would label other tabs' work too. */
function openRequestSpan(envelope: ProtocolRequestEnvelope, resolutionId: unknown): SpanHandle | null {
  // One per product JSON-RPC message would swamp the resolution requests.
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

// Posting to a closed port throws, which is how dead ports are found.
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

    // Sent from the iframe's beforeunload.
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

  // Before the ready signal, so the tab hears where the chains stand before resolving.
  if (presyncFailureMessage === null) {
    forwardChainSync(port, engineReady);
  }

  if (presyncFailureMessage !== null) {
    const errorMsg: SWError = {
      type: 'error',
      message: presyncFailureMessage,
    };
    port.postMessage(errorMsg);
  } else if (engineReady) {
    const readyMsg: SWReady = { type: 'ready' };
    port.postMessage(readyMsg);
    // The chains are already live, so this tab paid no sync cost whatever the worker's first load found on disk.
    for (const chain of latchedSmoldotDb.keys()) {
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'smoldot-db',
        chain,
        outcome: 'hit',
      });
    }
  } else {
    // This port missed the record-time broadcast. It waits on the same sync, so the worker's outcomes are its own.
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
  // Every tab hears this as the reason the worker never became ready, and the host reports it.
  log.error(`${TAG} ${networkInitFailure}`);
  presyncFailureMessage = networkInitFailure;
} else {
  swEvent('Worker started', { network: requestedNetwork });
  void presync();
}
