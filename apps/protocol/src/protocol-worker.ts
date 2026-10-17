// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port. Each port has its
// own serving transport, so what a tab hears is encoded for that port alone, and its own engine scope, so its chain
// connections are its own.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { isValidNetwork, getActiveFixedServicesConfig, type Network } from '@dotli/config/fixed';
import { m, captureException, spans as S, type SpanHandle } from '@dotli/metrics';
import {
  createPortProvider,
  createServingTransport,
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  type RequestHandler,
  type RequestMethod,
  type ServingTransport,
  type SubscriptionEvent,
  type SubscriptionHandler,
  type SubscriptionSink,
} from '@dotli/protocol';
import { errorName, log, serializeError } from '@dotli/shared';

import { createEngine, type EngineScope, type ProtocolEngine } from './engine.js';
import { createFrameStatus } from './frame-status.js';
import { startLightClientService } from './light-client-service.js';
import { intervalTicker, NET_BYTES_INTERVAL_MS, shareNetBytes, type Ticker } from './net-bytes.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { createTelemetryHandler } from './telemetry-handler.js';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_MISSED_BEATS } from './worker-port.js';

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
  /** The light client's inbound byte total, which every tab hears for its speed readout. Unset, nothing is reported. */
  netBytes?: { read: () => number; ticker?: Ticker };
  /** Sends buffered telemetry before the worker closes. Never rejects. */
  flush: () => Promise<void>;
}

interface PortSession {
  port: MessagePort;
  transport: ServingTransport;
  /** Opened by the tab's first chain call. */
  scope: EngineScope | null;
  /** Beats since the port last sent anything. */
  missed: number;
  /** The tab's open `beat` subscriptions, which each beat reaches. */
  beats: Set<SubscriptionSink<'beat'>>;
  /** Stops hearing the port close. */
  unwatch: () => void;
}

/** The requests a span follows. A chain message would swamp them, and a heartbeat says nothing of a load. */
type TracedRequest = Exclude<RequestMethod, 'chainSend' | 'heartbeat'>;

const TAG = '[dot.li SW]';
const NETWORK_NAME_PREFIX = 'dotli-protocol-';
// Bounds what a tab can write into this worker's span attributes. The host mints a UUID.
const RESOLUTION_ID_PATTERN = /^[\w-]{1,64}$/;

function swEvent(message: string, data?: Record<string, unknown>): void {
  log.event(message, { flow: 'protocol', ...data });
}

/** The iframe names the worker for its network, since a worker's URL cannot carry it. */
export function workerNetwork(name: string): WorkerNetwork {
  const requested = name.startsWith(NETWORK_NAME_PREFIX) ? name.slice(NETWORK_NAME_PREFIX.length) : null;
  if (requested === null) {
    return {
      ok: false,
      message: `Unexpected SharedWorker name "${name}". The iframe did not encode the active network.`,
    };
  }
  if (!isValidNetwork(requested)) {
    return { ok: false, message: `Unknown protocol network: "${requested}"` };
  }
  return { ok: true, network: requested };
}

export function startProtocolWorker(deps: ProtocolWorkerDeps): void {
  const { scope, lightClient, resolver } = deps;
  const openSpan = deps.openSpan ?? m.open;
  const sessions = new Set<PortSession>();
  // A frozen page's port queues what it is sent until the page thaws, and a port closed right after a post may drop
  // it. So a released port stays open until the beat after its tab speaks again, or until the worker closes. Each maps
  // to its close.
  const released = new Map<MessagePort, () => void>();
  // Released ports whose tab spoke since the last beat, which the next beat closes.
  const spoke = new Set<MessagePort>();
  let engine: ProtocolEngine | null = null;
  // The tab that starts the worker connects in a later task, so a failure before then waits for it to close.
  let reached = false;
  // Owned by `closeDeadWorker` and `closeOnceHeard` alone, so however many failures ask for it the worker closes once.
  let closing: 'none' | 'on_connect' | 'scheduled' | 'flushed' | 'closed' = 'none';
  // Ports that connected and have not yet subscribed to their status.
  const unheard = new Set<PortSession>();
  // The first failure is the cause, and every later tab hears it on subscribe.
  let phase: { name: 'syncing' | 'ready' } | { name: 'failed'; error: Error } = { name: 'syncing' };
  // What every port hears through its `frameStatus` subscription, each on its own transport.
  const status = createFrameStatus();

  const networkInitFailure = deps.network.ok ? null : deps.network.message;
  if (networkInitFailure !== null) {
    phase = { name: 'failed', error: new ProtocolInitFailedError(networkInitFailure) };
    status.fail(phase.error);
  }
  const stopHeartbeat = (deps.heartbeat ?? intervalClock(HEARTBEAT_INTERVAL_MS)).start(beat);
  // Only this worker can meter the light client every tab shares, so every tab hears its total from one meter.
  const netBytes =
    deps.netBytes === undefined
      ? null
      : shareNetBytes(deps.netBytes.read, deps.netBytes.ticker ?? intervalTicker(NET_BYTES_INTERVAL_MS));
  const telemetry = createTelemetryHandler({
    onChainSync: resolver.onChainSync,
    onChainDetail: resolver.onChainDetail,
    dbOutcomes: () => lightClient.status().db,
    onDbOutcome: listener =>
      lightClient.subscribe(change => {
        if (change.kind === 'db') {
          listener(change.chain, change.outcome);
        }
      }),
    netBytes: listener => (netBytes === null ? (): void => undefined : netBytes(listener)),
    // A tab that subscribes once the chains are synced paid no sync cost, so the reads before it are hits.
    joinedSynced: () => phase.name === 'ready',
  });

  /** Stops serving the port, once. Its transport goes first, so each open chain hears the release and not a halt. */
  function release(session: PortSession, reason: Error): void {
    if (!sessions.delete(session)) {
      return;
    }
    session.transport.dispose(reason);
    session.scope?.close();
    holdReleased(session);
    heard(session);
  }

  /**
   * Keeps a released port open until the beat after its tab sends anything, which it is no longer served for. A tab
   * that speaks may have done so before the release reached it, so the ends posted at the release get a beat to arrive.
   */
  function holdReleased({ port, unwatch }: PortSession): void {
    const onMessage = (): void => {
      spoke.add(port);
    };
    released.set(port, () => {
      port.removeEventListener('message', onMessage);
      unwatch();
      released.delete(port);
      spoke.delete(port);
      port.close();
      swEvent('Released port closed', { released: released.size });
    });
    port.addEventListener('message', onMessage);
  }

  /**
   * Lets go of a port whose tab disposed its transport, so nothing it was sent is still waited for. Its port closes at
   * once instead of being held for a release.
   */
  function forget(session: PortSession): void {
    if (!sessions.delete(session)) {
      return;
    }
    session.unwatch();
    session.transport.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
    session.scope?.close();
    session.port.close();
    heard(session);
    swEvent('Port closed', { ports: sessions.size });
  }

  /** The port subscribed to its status, or is gone, so a close can no longer leave it waiting for why. */
  function heard(session: PortSession): void {
    if (unheard.delete(session)) {
      closeOnceHeard();
    }
  }

  /**
   * Ends a worker whose light client is dead, after every port heard why. A closing SharedWorker is never matched by
   * name, so the host's next connect starts a fresh light client instead of hearing this failure again.
   */
  function closeDeadWorker(): void {
    if (closing !== 'none' && closing !== 'on_connect') {
      return;
    }
    // Closed now, the first tab's queued connect would never be served and the tab would wait out its ready timeout.
    if (!reached) {
      closing = 'on_connect';
      return;
    }
    closing = 'scheduled';
    const flushed = (): void => {
      closing = 'flushed';
      closeOnceHeard();
    };
    // A worker cannot see the connects queued for it, and a close drops them unserved. Closing in a later task lets
    // each queued connect run first. A worker has no page-hide flush, so the telemetry of the failure goes out before
    // the close drops it.
    setTimeout(() => {
      // A flush that fails still closes, after it is reported.
      void deps.flush().then(flushed, (err: unknown) => {
        captureException(err, { flow: 'protocol', step: 'worker_flush' });
        log.error(`${TAG} Telemetry flush failed`, err);
        flushed();
      });
    }, 0);
  }

  /**
   * Closes a flushed dead worker once no port waits to subscribe to its status. A tab hears why only on subscribe, a
   * round trip after it connects, and a closed worker answers nothing.
   */
  function closeOnceHeard(): void {
    if (closing !== 'flushed' || unheard.size > 0 || phase.name !== 'failed') {
      return;
    }
    closing = 'closed';
    swEvent('Worker closing', { ports: sessions.size });
    stopHeartbeat();
    // Each tab hears why everything still open on its port ended.
    for (const session of [...sessions]) {
      release(session, phase.error);
    }
    for (const close of [...released.values()]) {
      close();
    }
    scope.close();
  }

  /** Latches the first failure, tells every port and closes the worker. A later failure is only its symptom. */
  function fail(error: Error): void {
    if (phase.name === 'failed') {
      return;
    }
    phase = { name: 'failed', error };
    status.fail(error);
    closeDeadWorker();
  }

  function requireEngine(): ProtocolEngine {
    if (engine === null) {
      throw new Error(networkInitFailure ?? PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
    }
    return engine;
  }

  function scopeOf(session: PortSession): EngineScope {
    session.scope ??= requireEngine().openScope();
    return session.scope;
  }

  /** The resolution id goes on this span alone, since scope or metric defaults would label other tabs' work too. */
  function openRequestSpan(method: TracedRequest | 'chainConnect' | 'resolveDotName', resolutionId: string | null) {
    return openSpan(S.PROTOCOL_WORKER_REQUEST, {
      root: true,
      attributes: {
        method,
        ...(resolutionId !== null && RESOLUTION_ID_PATTERN.test(resolutionId) ? { resolution_id: resolutionId } : {}),
      },
    });
  }

  function endSpan(span: SpanHandle, error: unknown): void {
    span.setAttributes(
      error === undefined ? { outcome: 'ok' } : { outcome: 'error', error_name: errorName(error) ?? 'NonError' },
    );
    span.end();
  }

  function traced<M extends TracedRequest>(method: M, handler: RequestHandler<M>): RequestHandler<M> {
    return async (payload, context) => {
      const span = openRequestSpan(method, context.resolutionId);
      try {
        const answer = await handler(payload, context);
        endSpan(span, undefined);
        return answer;
      } catch (error) {
        endSpan(span, error);
        // The host rebuilds this failure from the answer and reports it.
        log.warn(`${TAG} ${method} failed`, error);
        throw error;
      }
    };
  }

  /** A chain message gets no span, which would swamp the request spans, but its failure is logged as theirs are. */
  function loggedChainSend(handler: RequestHandler<'chainSend'>): RequestHandler<'chainSend'> {
    return async (payload, context) => {
      try {
        await handler(payload, context);
      } catch (error) {
        log.warn(`${TAG} chainSend failed`, error);
        throw error;
      }
    };
  }

  /** Spans a subscription until the event that answers it, or its end, or the tab stopping it first. */
  function tracedSubscription<M extends 'chainConnect' | 'resolveDotName'>(
    method: M,
    answers: (event: SubscriptionEvent<M>) => boolean,
    handler: SubscriptionHandler<M>,
  ): SubscriptionHandler<M> {
    return (payload, context, sink) => {
      const span = openRequestSpan(method, context.resolutionId);
      let open = true;
      const settle = (error: unknown): void => {
        if (!open) {
          return;
        }
        open = false;
        endSpan(span, error);
        if (error !== undefined) {
          log.warn(`${TAG} ${method} failed`, error);
        }
      };
      const spanned: SubscriptionSink<M> = {
        send: event => {
          sink.send(event);
          if (answers(event)) {
            settle(undefined);
          }
        },
        end: error => {
          settle(error);
          sink.end(error);
        },
      };
      let stop: () => void;
      try {
        stop = handler(payload, context, spanned);
      } catch (error) {
        settle(error);
        throw error;
      }
      return () => {
        if (open) {
          open = false;
          span.setAttributes({ outcome: 'cancelled' });
          span.end();
        }
        stop();
      };
    };
  }

  function serve(session: PortSession): void {
    const { transport } = session;
    transport.handleSubscription('frameStatus', (payload, context, sink) => {
      // Ended at once if the worker already failed, and told of a later failure the moment it happens.
      const stop = status.handler(payload, context, sink);
      heard(session);
      return stop;
    });
    transport.handleSubscription('telemetry', telemetry);
    transport.handleSubscription('beat', (_payload, _context, sink) => {
      session.beats.add(sink);
      return () => {
        session.beats.delete(sink);
      };
    });
    // Any message keeps the port, so the heartbeat that answers a beat needs no answer beyond its arrival.
    transport.handleRequest('heartbeat', () => undefined);
    transport.handleRequest(
      'warmup',
      traced('warmup', (payload, context) => requireEngine().warmup(payload, context)),
    );
    transport.handleRequest(
      'resolveOwner',
      traced('resolveOwner', (payload, context) => requireEngine().resolveOwner(payload, context)),
    );
    transport.handleRequest(
      'resolveExecutableManifest',
      traced('resolveExecutableManifest', (payload, context) =>
        requireEngine().resolveExecutableManifest(payload, context),
      ),
    );
    transport.handleRequest(
      'resolveRootManifest',
      traced('resolveRootManifest', (payload, context) => requireEngine().resolveRootManifest(payload, context)),
    );
    transport.handleSubscription(
      'resolveDotName',
      tracedSubscription(
        'resolveDotName',
        event => event.tag === 'resolved',
        (payload, context, sink) => requireEngine().resolveDotName(payload, context, sink),
      ),
    );
    transport.handleSubscription(
      'chainConnect',
      tracedSubscription(
        'chainConnect',
        event => event.tag === 'connected',
        (payload, context, sink) => scopeOf(session).connect(payload, context, sink),
      ),
    );
    transport.handleRequest(
      'chainSend',
      loggedChainSend((payload, context) => scopeOf(session).send(payload, context)),
    );
  }

  /** Beats each port from this worker's clock, and lets go of one that sent nothing for too many beats. */
  function beat(): void {
    for (const port of [...spoke]) {
      released.get(port)?.();
    }
    for (const session of [...sessions]) {
      session.missed += 1;
      if (session.missed > HEARTBEAT_MISSED_BEATS) {
        release(session, new ProtocolPortReleasedError(PROTOCOL_APP_ERRORS.PORT_RELEASED));
        swEvent('Port released', { ports: sessions.size });
        continue;
      }
      for (const sink of [...session.beats]) {
        sink.send(undefined);
      }
    }
  }

  function onConnect(port: MessagePort): void {
    reached = true;
    // The worker closes the port itself, after a release has had its chance to reach a frozen tab.
    const provider = createPortProvider(port, { closeOnDispose: false });
    const transport = createServingTransport(provider, {
      side: 'worker',
      // A live tab always holds a subscription, so a tab that left none disposed its transport, as a page that left for
      // good does, and would never speak to end a release.
      onPeerIdle: () => {
        forget(session);
      },
    });
    // The tab's end of the port closed, as when its page crashed or was evicted, which no unsubscribe or message tells.
    // Engines that never fire the event fall back to the heartbeat release.
    const onClosed = (): void => {
      if (sessions.has(session)) {
        forget(session);
      } else {
        released.get(port)?.();
      }
    };
    port.addEventListener('close', onClosed);
    const session: PortSession = {
      port,
      transport,
      scope: null,
      missed: 0,
      beats: new Set(),
      unwatch: () => {
        port.removeEventListener('close', onClosed);
      },
    };
    // Any message shows the tab is alive, not only its heartbeat.
    provider.subscribe(() => {
      session.missed = 0;
    });
    sessions.add(session);
    unheard.add(session);
    serve(session);
    swEvent('Port connected', { ports: sessions.size, engine: phase.name });
    if (closing === 'on_connect') {
      closeDeadWorker();
    }
  }

  // No retries by design. A failed pre-sync tells every port and closes the worker, so whether to try again stays
  // with the host.
  async function presync(): Promise<void> {
    const t0 = performance.now();
    swEvent('Pre-sync started');

    try {
      // Nothing calls `stop`, since the observed chains live as long as the worker, which closes as a whole.
      const service = startLightClientService({ lightClient, resolver, services: getActiveFixedServicesConfig() });
      const { dotns } = service;
      engine = createEngine({
        pool: service.pool,
        isChainSupported: lightClient.isChainSupported,
        resolver: dotns,
        log: swEvent,
      });

      // The resolver records the `smoldot.presync` timing for this wait.
      await dotns.waitForAssetHubFinalized();

      // The fatal already ended every port's status, so no port may hear ready.
      if (phase.name === 'failed') {
        return;
      }
      swEvent('Pre-sync complete', { ms: Math.round(performance.now() - t0) });
      phase = { name: 'ready' };
      status.ready();

      // Legacy-account auth reads People, which otherwise races its warp sync on a cold start. Resolution does not
      // need People, so this must not gate ready.
      void dotns.waitForPeopleFinalized().catch((err: unknown) => {
        log.warn(`${TAG} People chain warm failed (retried on demand)`, err);
      });
    } catch (err: unknown) {
      const msg = serializeError(err);
      log.error(`${TAG} Pre-sync failed: ${msg}`, err);
      m.count(S.SMOLDOT_PRESYNC, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
      // A light client that died during pre-sync is the real cause, and the fatal already closed the worker.
      // The message already carries the cause, which the error logged above keeps in full.
      fail(new ProtocolInitFailedError(msg));
    }
  }

  // A fatal lets every tab end what it has open at once instead of timing out, and a port that connects before the
  // close lands still hears the cause, as after a failed pre-sync. No chain opens before pre-sync, so no change came
  // earlier.
  lightClient.subscribe(change => {
    if (change.kind !== 'fatal') {
      return;
    }
    const { message } = change;
    log.error(`${TAG} Light client died, telling ${String(sessions.size)} port(s): ${message}`);
    fail(new ProtocolFatalError(message));
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
