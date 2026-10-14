// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port, and each port gets
// its own engine scope.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { isValidNetwork, getActiveFixedServicesConfig, type Network } from '@dotli/config/fixed';
import { m, captureException, spans as S, type SpanHandle } from '@dotli/metrics';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '@dotli/protocol';
import { errorName, log, serializeError } from '@dotli/shared';

import { createEngine, type EngineScope, type ProtocolEngine } from './engine.js';
import { startLightClientService } from './light-client-service.js';
import { errorResponse } from './error-response.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import type {
  SWDisconnect,
  SWError,
  SWInbound,
  SWOutbound,
  SWPing,
  SWReady,
  SWRelayRequest,
} from './worker-messages.js';

/** The worker global, narrowed to what the worker uses. */
export interface WorkerScope {
  addEventListener: (type: 'connect', listener: (event: MessageEvent) => void) => void;
  close: () => void;
}

/** The resolver and the sync reporting, passed as functions so a test can drive fakes. */
export type WorkerResolver = Pick<typeof Resolver, 'createDotnsResolver'> &
  Pick<typeof Chains, 'enableSyncReporting' | 'onChainDetail' | 'onChainSync'>;

/** Calls `beat` once per heartbeat interval. Returns a stop. */
export interface HeartbeatClock {
  start: (beat: () => void) => () => void;
}

/**
 * A closed tab's port neither throws nor tells the worker, so the worker pings each port and lets go of one that
 * answered nothing for this many beats. Three beats of 20 s release a dead tab's connections within about a minute,
 * and leave an iframe stuck in a long task two beats of slack. Pongs are answered from a message event, which
 * background timer throttling does not delay.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_MISSED_BEATS = 3;

function intervalClock(intervalMs: number): HeartbeatClock {
  return {
    start: beat => {
      const timer = setInterval(beat, intervalMs);
      return () => {
        clearInterval(timer);
      };
    },
  };
}

/** The network a worker serves, or why it cannot serve one. */
export type WorkerNetwork = { ok: true; network: Network } | { ok: false; message: string };

export interface ProtocolWorkerDeps {
  scope: WorkerScope;
  /** Set as this context's network by the entry, before anything reads it. */
  network: WorkerNetwork;
  /** The one light client every tab shares. */
  lightClient: Chains.LightClient;
  resolver: WorkerResolver;
  /** Opens the span of one tab's request. */
  openSpan?: typeof m.open;
  /** Defaults to a `HEARTBEAT_INTERVAL_MS` interval. */
  heartbeat?: HeartbeatClock;
}

/**
 * The light client as every port sees it. `told` marks a failure the fatal broadcast already reported to the ports
 * that were connected, so they are not told twice.
 */
type LightClientStatus =
  { phase: 'syncing' } | { phase: 'ready' } | { phase: 'failed'; message: string; told: boolean };

type SettledStatus = Exclude<LightClientStatus, { phase: 'syncing' }>;

interface PortSession {
  scope: EngineScope | null;
  stopSync: (() => void) | null;
  stopWaiting: (() => void) | null;
  /** Heartbeats since the port last sent anything. */
  missed: number;
  /** Carried across a rejoin, so a tab let go before it heard `ready` still hears it once. */
  heardReady: boolean;
  /** The chains whose stored database this tab heard, carried across a rejoin as `heardReady` is. */
  heardDb: Set<Chains.SmoldotDbChain>;
  /**
   * Whether the tab first joined live chains and so paid no sync cost, carried across a rejoin. A tab that joined
   * during the sync waited on it, so the database outcomes are its own.
   */
  joinedSynced: boolean;
  /** Why the worker let go of the port, once it has. */
  removedBy: PortRemoval | null;
}

type PortRemoval = 'closed' | 'disconnect' | 'stale' | 'send_failed';

// A silent tab may only be frozen and a failed send may be one bad message, so these ports are served when they talk
// again. A tab that said it was leaving, or whose port closed, is gone.
const REJOINABLE: ReadonlySet<PortRemoval> = new Set(['stale', 'send_failed']);

const TAG = '[dot.li SW]';
const NETWORK_NAME_PREFIX = 'dotli-protocol-';
// Bounds what a tab can write into this worker's span attributes. The host mints a UUID.
const RESOLUTION_ID_PATTERN = /^[\w-]{1,64}$/;

function swEvent(message: string, data?: Record<string, unknown>): void {
  log.event(message, { flow: 'protocol', ...data });
}

/** The one status every port reads. A port that connects while syncing waits to be told once. */
function createLightClientStatus(initial: LightClientStatus): {
  readonly current: LightClientStatus;
  whenSettled: (tell: (status: SettledStatus) => void) => () => void;
  settle: (next: SettledStatus) => boolean;
} {
  let current = initial;
  const waiting = new Set<(status: SettledStatus) => void>();
  return {
    get current() {
      return current;
    },
    whenSettled(tell) {
      waiting.add(tell);
      return () => {
        waiting.delete(tell);
      };
    },
    // A failure is final, and a ready light client can still die.
    settle(next) {
      if (current.phase === 'failed' || (current.phase === 'ready' && next.phase === 'ready')) {
        return false;
      }
      current = next;
      const told = [...waiting];
      waiting.clear();
      for (const tell of told) {
        tell(next);
      }
      return true;
    },
  };
}

/** The iframe names the worker for its network, since a worker's URL cannot carry it. */
export function workerNetwork(name: string): WorkerNetwork {
  const requested = name.startsWith(NETWORK_NAME_PREFIX) ? name.slice(NETWORK_NAME_PREFIX.length) : null;
  if (requested === null) {
    return { ok: false, message: `Unexpected SharedWorker name "${name}" — iframe did not encode the active network.` };
  }
  if (!isValidNetwork(requested)) {
    return { ok: false, message: `Unknown protocol network: "${requested}"` };
  }
  return { ok: true, network: requested };
}

export function startProtocolWorker(deps: ProtocolWorkerDeps): void {
  const { scope, lightClient, resolver } = deps;
  const openSpan = deps.openSpan ?? m.open;
  const sessions = new Map<MessagePort, PortSession>();
  // A frozen page's port queues what it is sent until the page thaws, so a tab let go for a rejoinable reason still
  // hears why the worker closes, and its host rebuilds the frame instead of talking to a closed worker.
  const letGoPorts = new Set<MessagePort>();
  let engine: ProtocolEngine | null = null;
  // What a tab that connects after the light client died hears, as the tabs connected then did.
  let fatal: ProtocolEnvelope | null = null;
  // The tab that starts the worker connects in a later task, so a failure before then waits for it to close.
  let reached = false;
  // Owned by `closeDeadWorker` alone, so however many failures ask for it the worker closes once.
  let closing: 'none' | 'on_connect' | 'scheduled' = 'none';

  const networkInitFailure = deps.network.ok ? null : deps.network.message;
  const status = createLightClientStatus(
    networkInitFailure === null ? { phase: 'syncing' } : { phase: 'failed', message: networkInitFailure, told: false },
  );
  const stopHeartbeat = (deps.heartbeat ?? intervalClock(HEARTBEAT_INTERVAL_MS)).start(beat);

  /** Lets go of a port its message cannot reach, so one bad port never stops the worker telling the others. */
  function deliver(port: MessagePort, message: SWOutbound, tags: Record<string, string>): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch (err: unknown) {
      letGoPorts.delete(port);
      // A closed port (tab navigation) is expected. Any other failure, such as a clone error, is a real bug.
      if (errorName(err) === 'InvalidStateError') {
        removePort(port, 'closed');
        return false;
      }
      // The host never hears of this failure, so this is the only report.
      captureException(err, { flow: 'protocol', step: 'worker_port_send', tags });
      removePort(port, 'send_failed');
      return false;
    }
  }

  function sendToPort(port: MessagePort, envelope: ProtocolEnvelope): void {
    deliver(port, { type: 'relay-response', envelope }, { envelope_kind: envelope.kind });
  }

  function broadcastToPorts(envelope: ProtocolEnvelope): void {
    for (const port of [...sessions.keys()]) {
      sendToPort(port, envelope);
    }
  }

  /** `ports` defaults to those let go now. A caller that broadcast first passes the ones let go before it. */
  function tellLetGoPorts(message: SWOutbound, tags: Record<string, string>, ports = [...letGoPorts]): void {
    for (const port of ports) {
      deliver(port, message, tags);
    }
  }

  function tellDb(
    port: MessagePort,
    session: PortSession,
    chain: Chains.SmoldotDbChain,
    outcome: Chains.SmoldotDbOutcome,
  ): void {
    const envelope: ProtocolEnvelope = { namespace: 'dotli:protocol', kind: 'smoldot-db', chain, outcome };
    if (deliver(port, { type: 'relay-response', envelope }, { envelope_kind: envelope.kind })) {
      session.heardDb.add(chain);
    }
  }

  function removePort(port: MessagePort, reason: PortRemoval): void {
    const session = sessions.get(port);
    if (session === undefined) {
      return;
    }
    sessions.delete(port);
    session.removedBy = reason;
    if (REJOINABLE.has(reason)) {
      letGoPorts.add(port);
    }
    session.stopSync?.();
    session.stopWaiting?.();
    // A port served again must not keep connections the worker forgot, so it hears each one halted and reconnects.
    const cleaned = session.scope?.close({ halt: REJOINABLE.has(reason) }) ?? 0;
    swEvent('Port removed', { reason, connections: cleaned, ports: sessions.size });
  }

  /**
   * Ends a worker whose light client is dead, after every port heard why. A closing SharedWorker is never matched by
   * name, so the host's next connect starts a fresh light client instead of hearing this failure again.
   */
  function closeDeadWorker(): void {
    if (closing === 'scheduled') {
      return;
    }
    // Closed now, the first tab's queued connect would never be served and the tab would wait out its ready timeout.
    if (!reached) {
      closing = 'on_connect';
      return;
    }
    closing = 'scheduled';
    // A worker cannot see the connects queued for it, and a close drops them unserved. Closing in a later task lets
    // each queued connect run first and hear the latched failure.
    setTimeout(() => {
      swEvent('Worker closing', { ports: sessions.size });
      stopHeartbeat();
      scope.close();
    }, 0);
  }

  /** Forwards every chain's sync events to one tab, starting with a replay of where each chain stands. */
  function forwardChainSync(port: MessagePort, session: PortSession): void {
    let replaying = true;
    const stopSync = resolver.onChainSync(event => {
      const { chain, kind, ...rest } = event;
      sendToPort(port, { namespace: 'dotli:protocol', kind: 'chain-sync', chain, syncKind: kind, ...rest });
    });
    const stopDetail = resolver.onChainDetail(detail => {
      const reported =
        replaying && session.joinedSynced && detail.dbCache !== undefined
          ? { ...detail, dbCache: 'hit' as const }
          : detail;
      sendToPort(port, { namespace: 'dotli:protocol', kind: 'chain-detail', ...reported });
    });
    replaying = false;
    const stop = (): void => {
      stopSync();
      stopDetail();
    };
    // A failed send during the replay has already removed the port.
    if (sessions.get(port) !== session) {
      stop();
      return;
    }
    session.stopSync = stop;
  }

  /** The resolution id goes on this span alone, since scope or metric defaults would label other tabs' work too. */
  function openRequestSpan(envelope: ProtocolRequestEnvelope, resolutionId: unknown): SpanHandle | null {
    // One per product JSON-RPC message would swamp the resolution requests.
    if (envelope.method === 'chainSend') {
      return null;
    }
    return openSpan(S.PROTOCOL_WORKER_REQUEST, {
      root: true,
      attributes: {
        method: envelope.method,
        ...(typeof resolutionId === 'string' && RESOLUTION_ID_PATTERN.test(resolutionId)
          ? { resolution_id: resolutionId }
          : {}),
      },
    });
  }

  function serve(port: MessagePort, session: PortSession, data: SWRelayRequest | SWDisconnect): void {
    if (data.type === 'disconnect') {
      removePort(port, 'disconnect');
      return;
    }
    const { envelope, origin } = data;
    // A removed port's scope is closed, and a request served on it would hold connections nothing ever releases. A
    // closing tab's late request is expected, so it is no failure.
    if (sessions.get(port) !== session) {
      swEvent('Request refused', { method: envelope.method, reason: session.removedBy });
      sendToPort(port, errorResponse(envelope.id, new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED)));
      return;
    }
    const span = openRequestSpan(envelope, data.resolutionId);
    const handled =
      session.scope === null
        ? Promise.reject(new Error(networkInitFailure ?? PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED))
        : session.scope.handleRequest(envelope, origin, response => {
            sendToPort(port, response);
          });
    void handled
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
  }

  function beat(): void {
    for (const [port, session] of [...sessions]) {
      if (session.missed >= HEARTBEAT_MISSED_BEATS) {
        removePort(port, 'stale');
        continue;
      }
      session.missed += 1;
      const ping: SWPing = { type: 'ping' };
      deliver(port, ping, { message_type: 'ping' });
    }
  }

  function tellSettled(port: MessagePort, session: PortSession, settled: SettledStatus): void {
    if (settled.phase === 'ready') {
      const readyMsg: SWReady = { type: 'ready' };
      session.heardReady = deliver(port, readyMsg, { message_type: 'ready' });
      return;
    }
    // The fatal broadcast already told this port.
    if (!settled.told) {
      const errorMsg: SWError = { type: 'error', message: settled.message };
      deliver(port, errorMsg, { message_type: 'error' });
    }
  }

  /** A rejoining port is told only what it has not heard. */
  function admit(port: MessagePort, previous: PortSession | null): PortSession {
    const session: PortSession = {
      scope: engine?.openScope() ?? null,
      stopSync: null,
      stopWaiting: null,
      missed: 0,
      heardReady: previous?.heardReady ?? false,
      heardDb: previous?.heardDb ?? new Set(),
      joinedSynced: previous?.joinedSynced ?? status.current.phase === 'ready',
      removedBy: null,
    };
    sessions.set(port, session);
    letGoPorts.delete(port);
    const joined = status.current;
    swEvent(previous === null ? 'Port connected' : 'Port rejoined', { ports: sessions.size, engine: joined.phase });
    // A failed send lets go of the port, and nothing more is told to a port the worker let go.
    const tracked = (): boolean => sessions.get(port) === session;
    const replayDb = (): void => {
      for (const [chain, read] of lightClient.status().db) {
        if (tracked() && !session.heardDb.has(chain)) {
          tellDb(port, session, chain, session.joinedSynced ? 'hit' : read);
        }
      }
    };

    if (joined.phase === 'failed') {
      if (fatal !== null) {
        sendToPort(port, fatal);
        return session;
      }
      const errorMsg: SWError = { type: 'error', message: joined.message };
      deliver(port, errorMsg, { message_type: 'error' });
      return session;
    }

    // Before the ready signal, so the tab hears where the chains stand before resolving.
    forwardChainSync(port, session);

    if (joined.phase === 'ready') {
      if (!session.heardReady && tracked()) {
        tellSettled(port, session, joined);
      }
      replayDb();
      return session;
    }

    // This port missed the record-time broadcast.
    replayDb();
    if (tracked()) {
      session.stopWaiting = status.whenSettled(settled => {
        session.stopWaiting = null;
        tellSettled(port, session, settled);
      });
    }
    return session;
  }

  function onConnect(port: MessagePort): void {
    reached = true;
    let session = admit(port, null);
    port.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as SWInbound | null;
      if (data?.type !== 'disconnect' && data?.type !== 'relay-request' && data?.type !== 'pong') {
        return;
      }
      const letGo = sessions.get(port) !== session;
      if (letGo && data.type === 'disconnect') {
        // A tab that is leaving is never served again, nor told why the worker closes.
        letGoPorts.delete(port);
        session.removedBy = 'disconnect';
        return;
      }
      if (letGo && session.removedBy !== null && REJOINABLE.has(session.removedBy)) {
        // The tab was frozen or missed one message, and it is talking again.
        session = admit(port, session);
      }
      session.missed = 0;
      if (data.type !== 'pong') {
        serve(port, session, data);
      }
    });
    port.start();
    if (closing === 'on_connect') {
      closeDeadWorker();
    }
  }

  // No retries by design. A failed pre-sync sends the cause to every port and closes the worker, so whether to try
  // again stays with the host.
  async function presync(): Promise<void> {
    const t0 = performance.now();
    swEvent('Pre-sync started');

    try {
      // Nothing calls `stop`, since the observed chains live as long as the worker, which closes as a whole.
      const service = startLightClientService({ lightClient, resolver, services: getActiveFixedServicesConfig() });
      const { dotns } = service;
      engine = createEngine({
        broker: service.broker,
        isChainSupported: lightClient.isChainSupported,
        resolver: dotns,
        log: swEvent,
      });

      // The resolver records the `smoldot.presync` timing for this wait.
      await dotns.waitForAssetHubFinalized();

      // The fatal broadcast already told the waiting ports, they must not hear ready.
      if (status.current.phase === 'failed') {
        return;
      }
      swEvent('Pre-sync complete', { ms: Math.round(performance.now() - t0) });
      status.settle({ phase: 'ready' });

      // Legacy-account auth reads People, which otherwise races its warp sync on a cold start. Resolution does not
      // need People, so this must not gate ready.
      void dotns.waitForPeopleFinalized().catch((err: unknown) => {
        log.warn(`${TAG} People chain warm failed (retried on demand)`, err);
      });
    } catch (err: unknown) {
      const msg = serializeError(err);
      log.error(`${TAG} Pre-sync failed: ${msg}`, err);
      m.count(S.SMOLDOT_PRESYNC, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
      // Taken first, since a waiting port the settle fails to reach joins the let-go ports and must not be tried again.
      const letGoBefore = [...letGoPorts];
      // A light client that died during pre-sync is the real cause, and the fatal handler already reported it and
      // closed the worker.
      if (status.settle({ phase: 'failed', message: msg, told: false })) {
        const errorMsg: SWError = { type: 'error', message: msg };
        tellLetGoPorts(errorMsg, { message_type: 'error' }, letGoBefore);
        closeDeadWorker();
      }
    }
  }

  // A fatal lets every tab reject in-flight requests at once instead of timing out, and a port that connects before the
  // close lands still gets the cause like a failed pre-sync. No chain opens before pre-sync, so no change came earlier.
  lightClient.subscribe(change => {
    if (change.kind === 'db') {
      for (const [port, session] of [...sessions]) {
        tellDb(port, session, change.chain, change.outcome);
      }
      return;
    }
    const { message } = change;
    log.error(`${TAG} Light client died, broadcasting fatal to ${String(sessions.size)} port(s): ${message}`);
    fatal = { namespace: 'dotli:protocol', kind: 'fatal', message };
    // Taken first, since a port the broadcast fails to reach joins the let-go ports and must not be tried again.
    const letGoBefore = [...letGoPorts];
    broadcastToPorts(fatal);
    tellLetGoPorts({ type: 'relay-response', envelope: fatal }, { envelope_kind: 'fatal' }, letGoBefore);
    status.settle({ phase: 'failed', message, told: true });
    closeDeadWorker();
  });

  scope.addEventListener('connect', event => {
    const port = event.ports[0];
    if (port !== undefined) {
      onConnect(port);
    }
  });

  const { network } = deps;
  if (!network.ok) {
    // Every tab hears this as the reason the worker never became ready, and the host reports it.
    log.error(`${TAG} ${network.message}`);
    return;
  }
  swEvent('Worker started', { network: network.network });
  void presync();
}
