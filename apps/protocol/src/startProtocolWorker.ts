// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port. Each port has its
// own transport, so what a tab hears is encoded for that port alone, and its own engine scope, so its chain
// connections are its own.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { getActiveFixedServicesConfig } from '@dotli/config/fixed';
import { countMetric, createReporter, defineCount, m, spans as S } from '@dotli/metrics';
import {
  createFrameStatus,
  createWireReport,
  ProtocolFatalError,
  ProtocolInitFailedError,
  protocolSchema,
} from '@dotli/protocol';
import {
  createStateMachine,
  getErrorName,
  log,
  serializeError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
} from '@dotli/shared';
import { createPortProvider, createTransport, ok } from '@dotli/transport';

import { createEngine, type EngineScope, type ProtocolEngine } from './createEngine.js';
import type { Ticker } from './createIntervalTicker.js';
import { createTelemetryHandler } from './createTelemetryHandler.js';
import { createWorkerLifecycle, type PortSession, type WorkerPort } from './createWorkerLifecycle.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { logWorkerEvent } from './logWorkerEvent.js';
import type { WorkerNetwork } from './parseWorkerNetwork.js';
import { serveEngineMethods } from './serveEngineMethods.js';
import { servePoolControl } from './servePoolControl.js';
import { shareNetBytes } from './shareNetBytes.js';
import { startLightClientService, type LightClientService } from './startLightClientService.js';
import { toLightClientDb } from './toLightClientDb.js';
import { withRefusalReports } from './withRefusalReports.js';
import { withRequestSpan, withSubscriptionSpan } from './withRequestSpan.js';
import { WORKER_LOG_TAG } from './workerLogTag.js';

/** Create, relay, asset hub and first finalized block together. */
const smoldotPresyncMetric = defineCount<'error'>(S.SMOLDOT_PRESYNC);
const workerTransitionMetric = defineCount<'error'>('protocol.worker.transition');

const report = createReporter({ flow: 'protocol' });

/** What the pre-sync builds on a known network. */
type Built = { service: LightClientService; engine: ProtocolEngine };

/**
 * `unbuilt` is a known network whose service threw on start. `serving` holds the engine once the pre-sync settled, or
 * once the light client died under it, so a late sync marks nothing ready.
 */
type WorkerState =
  | { kind: 'starting' }
  | { kind: 'unknownNetwork'; message: string }
  | { kind: 'unbuilt' }
  | ({ kind: 'syncing'; startedAt: number } & Built)
  | ({ kind: 'serving' } & Built)
  | { kind: 'disposed' };

type WorkerEvent =
  | { kind: 'started' }
  | { kind: 'assetHubSynced' }
  | { kind: 'presyncFailed'; error: unknown }
  | { kind: 'everyTabPausedChanged'; paused: boolean }
  | { kind: 'lightClientDied'; message: string }
  | { kind: 'disposed' };

type WorkerEffect =
  | { kind: 'networkUnknown'; message: string }
  | { kind: 'presyncStarted'; network: string }
  | { kind: 'presyncComplete'; ms: number }
  | { kind: 'presyncFailed'; error: unknown }
  | { kind: 'lightClientDied'; message: string }
  | { kind: 'lifecycleFailed'; error: Error };

type WorkerMachine = MachineTypes<WorkerState, WorkerEvent, WorkerEffect>;

type LiveKind = Exclude<WorkerState, { kind: 'disposed' }>['kind'];

/** A tab that connects to the worker, with its port first. */
type ConnectEvent = { readonly ports: readonly WorkerPort[] };

/** The worker global, narrowed to what the worker uses. */
export type WorkerScope = {
  /** Hears each tab that connects, with its port first. Never throws. */
  addEventListener: (type: 'connect', listener: (event: ConnectEvent) => void) => void;
  /** Stops hearing tabs that connect through `listener`. Never throws. */
  removeEventListener: (type: 'connect', listener: (event: ConnectEvent) => void) => void;
  /** Closes the worker, which then serves no tab. Never throws. */
  close: () => void;
};

/** The resolver and the sync reporting, passed as functions so a test can drive fakes. */
export type WorkerResolver = Pick<typeof Resolver, 'createDotnsResolver'> &
  Pick<typeof Chains.chainSync, 'enableSyncReporting' | 'onChainDetail' | 'onChainSync'>;

type Params = {
  /** The worker global, which hands the worker each tab's port and closes it. */
  scope: WorkerScope;
  /** The network parsed from the worker's name, which must already be this context's active network. */
  network: WorkerNetwork;
  /** The one light client every tab shares. */
  lightClient: Chains.LightClient;
  /** The name resolver and sync reporting the worker starts on the light client. */
  resolver: WorkerResolver;
  /** Opens the span of one tab's request. */
  openSpan?: typeof m.open;
  /** Beats each port. */
  startHeartbeat?: Ticker;
  /** The light client's inbound byte total, which every tab hears. Unset, nothing is reported. */
  netBytes?: Pick<Parameters<typeof shareNetBytes>[0], 'read' | 'startTicker'> | undefined;
  /**
   * Sends buffered telemetry before the worker closes. May reject. A rejection is captured, logged and counted, and the
   * close goes on.
   */
  flush: () => Promise<void>;
  /** Runs the worker's zero-delay close. Defaults to the page's own timers. */
  timers?: Timers;
  /** The monotonic clock the pre-sync is timed on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
  /** Starts the light client's chains and name resolver. Defaults to the real one. */
  startService?: typeof startLightClientService;
};

const { frame, resolve, chain } = protocolSchema.sections;

/**
 * Serves every tab that connects to `scope`, and pre-syncs the light client unless the network is unknown. Returns an
 * object with the worker's `dispose`.
 */
export function startProtocolWorker({
  scope,
  network,
  lightClient,
  resolver,
  openSpan = m.open,
  startHeartbeat,
  netBytes,
  flush,
  timers,
  now = () => performance.now(),
  startService = startLightClientService,
}: Params): {
  /**
   * Lets go of every tab's port, stops hearing the light client and tabs that connect, and releases the chains the
   * pre-sync took, and never closes the worker or disposes the light client. Safe to call more than once and after
   * the worker failed. A chain release that throws is reported, after every tab's port is let go and with the engine's
   * dispose still run. A tab's status ends with the port closed, an end the port may drop as it closes at once,
   * nothing else open on the port hears from the worker, and a pre-sync still under way reports nothing more.
   */
  dispose: () => void;
} {
  // What each port's transport cannot handle itself, counted as the worker's.
  const wire = createWireReport({ side: 'worker', count: countMetric });
  // What every port hears through its `frame.status` subscription, each on its own transport.
  const status = createFrameStatus();

  const lifecycle = createWorkerLifecycle({
    scope,
    status,
    flush,
    startHeartbeat,
    timers,
    initialFailure: network.success ? null : new ProtocolInitFailedError(network.value),
    onEveryTabPausedChange: paused => {
      machine.update({ kind: 'everyTabPausedChanged', paused });
    },
  });
  // Only this worker can meter the light client every tab shares, so every tab hears its total from one meter.
  const subscribeNetBytes = netBytes === undefined ? null : shareNetBytes(netBytes);
  const handleTelemetry = createTelemetryHandler({
    onChainSync: resolver.onChainSync,
    onChainDetail: resolver.onChainDetail,
    ...toLightClientDb(lightClient),
    onNetBytes: listener => (subscribeNetBytes === null ? (): void => undefined : subscribeNetBytes(listener)),
    // A tab that subscribes once the chains are synced paid no sync cost, so the reads before it are hits.
    hasJoinedSynced: lifecycle.isReady,
  });

  /** A pre-sync that fails tells every port and closes the worker, so a retry is a new worker. */
  const failPresync: HandlerOf<WorkerMachine, 'syncing' | 'serving', 'presyncFailed'> = (
    { service, engine },
    { error },
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'serving', service, engine });
    emitSideEffect({ kind: 'presyncFailed', error });
    // A light client that died during pre-sync is the real cause, and the fatal already closed the worker.
    emitSideEffect({
      kind: 'lifecycleFailed',
      error: new ProtocolInitFailedError(serializeError(error), { cause: error }),
    });
  };
  /** A fatal ends every port's status at once, and a port that connects before the close lands still hears the cause. */
  const failLightClient: HandlerOf<WorkerMachine, LiveKind, 'lightClientDied'> = (
    state,
    { message },
    { emitState, emitSideEffect },
  ) => {
    switch (state.kind) {
      case 'syncing':
        // The fatal ended every port's status, so a late sync must not mark the worker ready.
        emitState({ kind: 'serving', service: state.service, engine: state.engine });
        break;
      case 'starting':
      case 'unknownNetwork':
      case 'unbuilt':
      case 'serving':
        break;
    }
    emitSideEffect({ kind: 'lightClientDied', message });
    emitSideEffect({ kind: 'lifecycleFailed', error: new ProtocolFatalError(message) });
  };
  /** The worker pauses only while every tab it serves asks. */
  const applyEveryTabPaused: HandlerOf<WorkerMachine, 'syncing' | 'serving', 'everyTabPausedChanged'> = (
    { service },
    { paused },
  ) => {
    if (paused) {
      service.pool.pause();
    } else {
      service.pool.resume();
    }
  };
  const disposeWorker: HandlerOf<WorkerMachine, LiveKind, 'disposed'> = (state, _event, { emitState }) => {
    emitState({ kind: 'disposed' });
    scope.removeEventListener('connect', handleConnectEvent);
    stopHearingLightClient();
    lifecycle.dispose();
    switch (state.kind) {
      case 'syncing':
      case 'serving':
        // The observed chains go before the pool they lease from, and a release that throws still lets the pool go.
        try {
          state.service.dispose();
        } finally {
          state.engine.dispose();
        }
        break;
      case 'starting':
      case 'unknownNetwork':
      case 'unbuilt':
        break;
    }
  };
  const machine = createStateMachine<WorkerMachine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, _event, { emitState, emitSideEffect, update }) {
          if (!network.success) {
            // Every tab hears this as the reason the worker never became ready.
            emitState({ kind: 'unknownNetwork', message: network.value });
            emitSideEffect({ kind: 'networkUnknown', message: network.value });
            return;
          }
          const startedAt = now();
          emitSideEffect({ kind: 'presyncStarted', network: network.value });
          let service: LightClientService;
          try {
            service = startService({ lightClient, resolver, services: getActiveFixedServicesConfig() });
          } catch (error) {
            emitState({ kind: 'unbuilt' });
            emitSideEffect({ kind: 'presyncFailed', error });
            emitSideEffect({
              kind: 'lifecycleFailed',
              error: new ProtocolInitFailedError(serializeError(error), { cause: error }),
            });
            return;
          }
          const engine = createEngine({
            pool: service.pool,
            isChainSupported: lightClient.isChainSupported,
            resolver: service.dotns,
            log: logWorkerEvent,
          });
          emitState({ kind: 'syncing', startedAt, service, engine });
          if (lifecycle.isEveryTabPaused()) {
            service.pool.pause();
          }
          update(
            service.dotns.waitForAssetHubFinalized().then(
              (): WorkerEvent => ({ kind: 'assetHubSynced' }),
              (error: unknown): WorkerEvent => ({ kind: 'presyncFailed', error }),
            ),
          );
        },
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      unknownNetwork: {
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      unbuilt: {
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      syncing: {
        assetHubSynced({ startedAt, service, engine }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'serving', service, engine });
          emitSideEffect({ kind: 'presyncComplete', ms: Math.round(now() - startedAt) });
          lifecycle.markReady();
          // Warmed in the background, so a later People read does not wait on a cold warp sync. Ready never waits on it.
          service.warmPeople(WORKER_LOG_TAG);
        },
        presyncFailed: failPresync,
        everyTabPausedChanged: applyEveryTabPaused,
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      serving: {
        presyncFailed: failPresync,
        everyTabPausedChanged: applyEveryTabPaused,
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      disposed: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'networkUnknown':
          log.error(`${WORKER_LOG_TAG} ${effect.message}`);
          break;
        case 'presyncStarted':
          logWorkerEvent('Worker started', { network: effect.network });
          logWorkerEvent('Pre-sync started');
          break;
        case 'presyncComplete':
          logWorkerEvent('Pre-sync complete', { ms: effect.ms });
          break;
        case 'presyncFailed':
          log.error(`${WORKER_LOG_TAG} Pre-sync failed: ${serializeError(effect.error)}`, effect.error);
          smoldotPresyncMetric.count({ outcome: 'error', reason: getErrorName(effect.error) ?? 'unknown' });
          break;
        case 'lightClientDied':
          log.error(
            `${WORKER_LOG_TAG} Light client died, telling ${String(lifecycle.countPorts())} port(s): ${effect.message}`,
          );
          break;
        case 'lifecycleFailed':
          lifecycle.fail(effect.error);
          break;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: workerTransitionMetric,
        message: `${WORKER_LOG_TAG} A transition of the protocol worker failed:`,
      });
    },
  });

  function requireEngine(): ProtocolEngine {
    const state = machine.state.get();
    switch (state.kind) {
      case 'syncing':
      case 'serving':
        return state.engine;
      case 'unknownNetwork':
        throw new Error(state.message);
      case 'starting':
      case 'unbuilt':
      case 'disposed':
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
    }
  }

  function getSessionScope(session: PortSession): EngineScope {
    return lifecycle.getScope(session, () => requireEngine().openScope());
  }

  function serve(session: PortSession): void {
    const { transport } = session;
    transport.handleSubscription(frame.status, (start, context, sink) => {
      const removeSink = lifecycle.addStatusSink(session, sink);
      // Ended at once if the worker already failed, and told of a later failure the moment it happens.
      const stop = status.handler(start, context, sink);
      lifecycle.hear(session);
      return stopStatus;

      function stopStatus(): void {
        removeSink();
        stop();
      }
    });
    transport.handleSubscription(frame.telemetry, handleTelemetry);
    transport.handleSubscription(frame.beat, (_start, _context, sink) => lifecycle.addBeatSink(session, sink));
    // Any message keeps the port, so the heartbeat that answers a beat needs no answer beyond its arrival.
    transport.handleRequest(frame.heartbeat, () => ok());
    // The worker pauses only while every tab it serves asks.
    servePoolControl({
      serving: transport,
      control: {
        pause: () => {
          lifecycle.markPaused(session, true);
        },
        resume: () => {
          lifecycle.markPaused(session, false);
        },
      },
    });
    // The engine and the tab's scope are made on first use, so each method asks for them when called. A failure is
    // logged under its call name, and reaches the tab as the call's answer.
    const reporting = withRefusalReports(transport, ({ method, error }) => {
      log.warn(`${WORKER_LOG_TAG} ${method} failed`, error);
    });
    // The stop is dropped, since the port's transport takes its handlers with it when it is disposed.
    serveEngineMethods(reporting, {
      warmup: withRequestSpan({
        openSpan,
        method: frame.warmup,
        handler: (payload, context) => requireEngine().warmup(payload, context),
      }),
      resolveDotName: withSubscriptionSpan({
        openSpan,
        method: resolve.dotName,
        isAnswer: value => value.tag === 'resolved',
        handler: (start, context, sink) => requireEngine().resolveDotName(start, context, sink),
      }),
      resolveOwner: withRequestSpan({
        openSpan,
        method: resolve.owner,
        handler: (payload, context) => requireEngine().resolveOwner(payload, context),
      }),
      resolveExecutableManifest: withRequestSpan({
        openSpan,
        method: resolve.executableManifest,
        handler: (payload, context) => requireEngine().resolveExecutableManifest(payload, context),
      }),
      resolveRootManifest: withRequestSpan({
        openSpan,
        method: resolve.rootManifest,
        handler: (payload, context) => requireEngine().resolveRootManifest(payload, context),
      }),
      connect: withSubscriptionSpan({
        openSpan,
        method: chain.connect,
        isAnswer: value => value.tag === 'connected',
        handler: (start, context, sink) => getSessionScope(session).connect(start, context, sink),
      }),
      send: withRequestSpan({
        openSpan,
        method: chain.send,
        handler: (payload, context) => getSessionScope(session).send(payload, context),
      }),
    });
  }

  function handleConnect(port: WorkerPort): void {
    // The worker closes the port itself, after a release has had its chance to reach a frozen tab.
    const provider = createPortProvider({ port, closeOnDispose: false });
    // A worker has no page load of its own.
    const transport = createTransport({
      schema: protocolSchema,
      provider,
      handshake: 'respond',
      hello: { resolutionId: null },
      onIssue: wire.onIssue,
    });
    port.addEventListener('close', handleClose);
    const session = lifecycle.admit({ port, transport, unwatch, serve });
    // Any message shows the tab is alive, not only its heartbeat. The provider drops this listener when the transport
    // is disposed, so its stop is not kept.
    provider.subscribe(() => {
      lifecycle.markAlive(session);
    });

    function unwatch(): void {
      port.removeEventListener('close', handleClose);
    }

    // The tab's end of the port closed, as when its page left for good, crashed or was evicted, which no message tells.
    // Engines that never fire the event fall back to the heartbeat release. The event fires in a later task, once
    // `session` is set.
    function handleClose(): void {
      lifecycle.closePort(session);
    }
  }

  // No chain opens before pre-sync, so no change came earlier.
  const stopHearingLightClient = lightClient.subscribe(change => {
    if (change.kind === 'fatal') {
      machine.update({ kind: 'lightClientDied', message: change.message });
    }
  });
  scope.addEventListener('connect', handleConnectEvent);
  machine.update({ kind: 'started' });

  return {
    dispose(): void {
      machine.update({ kind: 'disposed' });
    },
  };

  function handleConnectEvent(event: ConnectEvent): void {
    const port = event.ports[0];
    if (port !== undefined) {
      handleConnect(port);
    }
  }
}
