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
  isChainSupported,
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

import { m, initSentry, installGlobalErrorHandlers, spans as S } from '@dotli/metrics';

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
import { errorName, serializeError, isExecutableKind } from '@dotli/shared';

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

export type SWInbound = SWRelayRequest;
export type SWOutbound = SWRelayResponse | SWReady | SWError;

const TAG = '[dot.li SW]';

function swLog(...args: unknown[]): void {
  console.warn(TAG, ...args);
}

function swError(...args: unknown[]): void {
  console.error(TAG, ...args);
}

const ports = new Set<MessagePort>();
const pendingPorts: MessagePort[] = [];
let engineReady = false;
// Why the engine is dead for good: pre-sync failed, or the light client could
// not connect a chain. Every port that connects later is told, never `ready`.
let presyncFailureMessage: string | null = null;

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
  swLog(`Active network pinned to ${requestedNetwork}`);
}

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
  swError(`Chain death detected, broadcasting fatal to ${String(ports.size)} port(s)`);
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
  m.breadcrumb('presync starting');

  try {
    // Create the broker FIRST and route the resolver's Asset Hub reads
    // through it as a local session, so there is one shared Asset Hub follow
    // (never removed mid-read) instead of a separate resolver chain the first
    // dApp connection would release — the `ChainHead disjointed` load failure.
    const pool = createChainPool({
      createTransport: createChainProvider,
      destroyDelay: Infinity,
    });
    chainSessions = createWorkerChainSessions(pool, isChainSupported, sendToPort, swLog);
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
    swLog('Waiting for Asset Hub to reach finalized block...');
    await waitForAssetHubFinalized(msg => {
      swLog(`Pre-sync status: ${msg}`);
    });
    const totalMs = performance.now() - t0;
    m.measure(S.SMOLDOT_PRESYNC, totalMs);
    m.distribution(S.SMOLDOT_PRESYNC, totalMs);
    swLog(`Asset Hub synced (${String(Math.round(totalMs))}ms total)`);

    // A light client that failed while Asset Hub synced stays dead: the
    // waiting ports were told by the fatal broadcast, and must not hear ready.
    if (presyncFailureMessage !== null) {
      return;
    }

    // Success: mark ready.
    swLog('Pre-sync complete, engine ready');
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
    swLog('Warming People chain in background...');
    void waitForPeopleFinalized(msg => {
      swLog(`People warm status: ${msg}`);
    })
      .then(() => {
        swLog('People chain warmed');
      })
      .catch((err: unknown) => {
        swLog(`People chain warm failed (retried on demand): ${serializeError(err)}`);
      });
  } catch (err: unknown) {
    const msg = serializeError(err);
    swError(`Pre-sync failed: ${msg}`);
    m.count(S.SMOLDOT_PRESYNC, {
      outcome: 'error',
      reason: err instanceof Error ? err.name : 'unknown',
    });
    m.breadcrumb('smoldot presync failed', { reason: msg });

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
    const name = errorName(err) ?? '';
    if (name === 'InvalidStateError') {
      swLog('Port closed, cleaning up');
      removePort(port);
      return;
    }
    swError(`sendToPort unexpected failure (name=${name || '<unknown>'}):`, err);
    // Remove the port regardless, since we can't deliver to it. The
    // error log above preserves the real cause for triage.
    removePort(port);
  }
}

function removePort(port: MessagePort): void {
  ports.delete(port);
  const cleaned = chainSessions?.removePort(port) ?? 0;
  swLog(`Port removed (cleaned ${String(cleaned)} connections, ${String(ports.size)} ports remaining)`);
}

async function handleRequest(port: MessagePort, request: ProtocolRequestEnvelope, origin: string): Promise<void> {
  const t = performance.now();
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
      swLog(`Warmup acknowledged (engine already pre-synced) (${String(Math.round(performance.now() - t))}ms)`);
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
      swLog(`Resolved "${payload.label}" → ${result ?? 'null'} (${String(Math.round(performance.now() - t))}ms)`);
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
      swLog(`Owner "${payload.label}" → ${result ?? 'null'} (${String(Math.round(performance.now() - t))}ms)`);
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

// Proactively clean up stale ports by sending a ping.
// Posting to a closed port throws, and we catch that to detect dead ports.
function cleanStalePorts(): void {
  for (const p of [...ports]) {
    try {
      p.postMessage({ type: 'ping' });
    } catch {
      swLog('Detected stale port during cleanup');
      removePort(p);
    }
  }
}

self.addEventListener('connect', event => {
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }

  // Clean up any stale ports from previous iframe reloads
  cleanStalePorts();

  ports.add(port);
  swLog(`Port connected (${String(ports.size)} total, engine ${engineReady ? 'ready' : 'syncing'})`);

  port.addEventListener('message', (msgEvent: MessageEvent) => {
    const data = msgEvent.data as { type?: string } | null;

    // Handle disconnect signal from iframe beforeunload
    if (data?.type === 'disconnect') {
      swLog('Port sent disconnect signal, cleaning up');
      removePort(port);
      return;
    }

    if (data?.type !== 'relay-request') {
      return;
    }

    const relayData = data as SWRelayRequest;
    const { envelope, origin } = relayData;
    void handleRequest(port, envelope, origin).catch((error: unknown) => {
      const msg = serializeError(error);
      const name = errorName(error);
      swError(`Request ${envelope.method} failed:`, msg);
      sendToPort(port, {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: envelope.id,
        ok: false,
        error: msg,
        ...(name !== undefined ? { errorName: name } : {}),
      });
    });
  });

  port.start();

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
    swLog('Engine not ready yet, queuing port for ready signal');
    pendingPorts.push(port);
  }
});

if (networkInitFailure !== null) {
  swError(networkInitFailure);
  presyncFailureMessage = networkInitFailure;
} else {
  swLog('SharedWorker initialized, starting pre-sync...');
  void presync();
}
