// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port. Each port has its
// own transport, so what a tab hears is encoded for that port alone, and its own engine scope, so its chain
// connections are its own.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { isValidNetwork, getActiveFixedServicesConfig, type Network } from '@dotli/config/fixed';
import { m, captureException, spans as S, type SpanHandle } from '@dotli/metrics';
import {
  callName,
  failureOf,
  protocolSchema,
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  type ProtocolSchema,
  type ProtocolTransport,
} from '@dotli/protocol';
import { errorName, log, serializeError } from '@dotli/shared';
import {
  createPortProvider,
  createTransport,
  ok,
  type CallError,
  type DomainError,
  type MethodName,
  type MethodTypes,
  type RequestHandler,
  type RequestMethodName,
  type Result,
  type Sink,
  type SubscriptionHandler,
  type SubscriptionMethodName,
  type TraitName,
} from '@dotli/transport';

import { createEngine, type EngineScope, type ProtocolEngine } from './engine.js';
import { createFrameStatus, frameStatusEnd, type FrameStatusSink } from './frame-status.js';
import { startLightClientService } from './light-client-service.js';
import { intervalTicker, NET_BYTES_INTERVAL_MS, shareNetBytes, type Ticker } from './net-bytes.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { createWireReport } from './refusal-report.js';
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
  transport: ProtocolTransport;
  /** Opened by the tab's first chain call. */
  scope: EngineScope | null;
  /** Beats since the port last sent anything. */
  missed: number;
  /** The tab's open `frame.beat` subscriptions, which each beat reaches. */
  beats: Set<Sink<void, never>>;
  /** The tab's open `frame.status` subscriptions, which a release ends before the transport goes. */
  statuses: Set<FrameStatusSink>;
  /** Stops hearing the port close. */
  unwatch: () => void;
}

/** A traced call's failure: no domain error but the one name resolution and chain connections declare. */
type TracedFailure = CallError<DomainError<ProtocolSchema, 'resolve', 'owner'>>;

type ValueOf<T extends TraitName<ProtocolSchema>, M extends SubscriptionMethodName<ProtocolSchema, T>> =
  MethodTypes<ProtocolSchema, T, M> extends { receive: infer V } ? V : never;

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
  // What each port's transport cannot handle itself, counted as the worker's.
  const wire = createWireReport('worker', { warn: log.warn, count: m.count });
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
  // What every port hears through its `frame.status` subscription, each on its own transport.
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

  /**
   * Stops serving the port, once. Its status ends first with why, typed, so the tab tells a release from a crash. Its
   * transport goes next, so each open chain hears the release and not a halt.
   */
  function release(session: PortSession, reason: Error): void {
    if (!sessions.delete(session)) {
      return;
    }
    const end = frameStatusEnd(reason);
    for (const sink of [...session.statuses]) {
      sink.interrupt(end);
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
  function openRequestSpan(method: string, resolutionId: string | null) {
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

  /** Why an answer failed, as an error under its name, or undefined for one that succeeded. */
  function failureOfAnswer<T extends TraitName<ProtocolSchema>>(
    trait: T,
    method: MethodName<ProtocolSchema, T>,
    answer: unknown,
  ): Error | undefined {
    // Every answer is a `Result`, which the method's deferred answer type does not show where the method is generic.
    const outcome = answer as Result<unknown, TracedFailure>;
    return outcome.ok ? undefined : failureOf(trait, method, outcome.error);
  }

  /** Spans a request, and logs one that fails, by the name dashboards know it by. */
  function traced<T extends 'frame' | 'resolve', M extends RequestMethodName<ProtocolSchema, T>>(
    trait: T,
    method: M,
    handler: RequestHandler<ProtocolSchema, T, M>,
  ): RequestHandler<ProtocolSchema, T, M> {
    const name = callName(trait, method);
    return async (payload, context) => {
      const span = openRequestSpan(name, context.hello.resolutionId);
      try {
        const answer = await handler(payload, context);
        const failure = failureOfAnswer(trait, method, answer);
        endSpan(span, failure);
        if (failure !== undefined) {
          // The host rebuilds this failure from the answer and reports it.
          log.warn(`${TAG} ${name} failed`, failure);
        }
        return answer;
      } catch (error) {
        endSpan(span, error);
        log.warn(`${TAG} ${name} failed`, error);
        throw error;
      }
    };
  }

  /** A chain message gets no span, which would swamp the request spans, but its failure is logged as theirs are. */
  function loggedChainSend(
    handler: RequestHandler<ProtocolSchema, 'chain', 'send'>,
  ): RequestHandler<ProtocolSchema, 'chain', 'send'> {
    return async (payload, context) => {
      try {
        const answer = await handler(payload, context);
        if (!answer.ok) {
          log.warn(`${TAG} chainSend failed`, failureOf('chain', 'send', answer.error));
        }
        return answer;
      } catch (error) {
        log.warn(`${TAG} chainSend failed`, error);
        throw error;
      }
    };
  }

  /** Spans a subscription until the value that answers it, or its end, or the tab stopping it first. */
  function tracedSubscription<T extends 'chain' | 'resolve', M extends SubscriptionMethodName<ProtocolSchema, T>>(
    trait: T,
    method: M,
    answers: (value: ValueOf<T, M>) => boolean,
    handler: SubscriptionHandler<ProtocolSchema, T, M>,
  ): SubscriptionHandler<ProtocolSchema, T, M> {
    const name = callName(trait, method);
    return (start, context, sink) => {
      const span = openRequestSpan(name, context.hello.resolutionId);
      let open = true;
      const settle = (error: unknown): void => {
        if (!open) {
          return;
        }
        open = false;
        endSpan(span, error);
        if (error !== undefined) {
          log.warn(`${TAG} ${name} failed`, error);
        }
      };
      const spanned: typeof sink = {
        receive: value => {
          sink.receive(value);
          if (answers(value)) {
            settle(undefined);
          }
        },
        interrupt: error => {
          settle(error === undefined ? undefined : failureOfAnswer(trait, method, { ok: false, error }));
          sink.interrupt(error);
        },
      };
      let stop: () => void;
      try {
        stop = handler(start, context, spanned);
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
    transport.handleSubscription('frame', 'status', (start, context, sink) => {
      session.statuses.add(sink);
      // Ended at once if the worker already failed, and told of a later failure the moment it happens.
      const stop = status.handler(start, context, sink);
      heard(session);
      return () => {
        session.statuses.delete(sink);
        stop();
      };
    });
    transport.handleSubscription('frame', 'telemetry', telemetry);
    transport.handleSubscription('frame', 'beat', (_start, _context, sink) => {
      session.beats.add(sink);
      return () => {
        session.beats.delete(sink);
      };
    });
    // Any message keeps the port, so the heartbeat that answers a beat needs no answer beyond its arrival.
    transport.handleRequest('frame', 'heartbeat', () => ok());
    transport.handleRequest(
      'frame',
      'warmup',
      traced('frame', 'warmup', (payload, context) => requireEngine().warmup(payload, context)),
    );
    transport.handleRequest(
      'resolve',
      'owner',
      traced('resolve', 'owner', (payload, context) => requireEngine().resolveOwner(payload, context)),
    );
    transport.handleRequest(
      'resolve',
      'executableManifest',
      traced('resolve', 'executableManifest', (payload, context) =>
        requireEngine().resolveExecutableManifest(payload, context),
      ),
    );
    transport.handleRequest(
      'resolve',
      'rootManifest',
      traced('resolve', 'rootManifest', (payload, context) => requireEngine().resolveRootManifest(payload, context)),
    );
    transport.handleSubscription(
      'resolve',
      'dotName',
      tracedSubscription(
        'resolve',
        'dotName',
        value => value.tag === 'resolved',
        (start, context, sink) => requireEngine().resolveDotName(start, context, sink),
      ),
    );
    transport.handleSubscription(
      'chain',
      'connect',
      tracedSubscription(
        'chain',
        'connect',
        value => value.tag === 'connected',
        (start, context, sink) => scopeOf(session).connect(start, context, sink),
      ),
    );
    transport.handleRequest(
      'chain',
      'send',
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
        sink.receive(undefined);
      }
    }
  }

  function onConnect(port: MessagePort): void {
    reached = true;
    // The worker closes the port itself, after a release has had its chance to reach a frozen tab.
    const provider = createPortProvider(port, { closeOnDispose: false });
    // A tab's hello names its page load, which each request span carries. The worker's own names none.
    const transport = createTransport(protocolSchema, provider, {
      handshake: 'accept',
      hello: { resolutionId: null },
      onIssue: wire.onIssue,
      // A live tab always holds a subscription, so a tab that left none disposed its transport, as a page that left for
      // good does, and would never speak to end a release.
      onPeerIdle: () => {
        forget(session);
      },
    });
    // The tab's end of the port closed, as when its page crashed or was evicted, which no stop or message tells.
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
      statuses: new Set(),
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
