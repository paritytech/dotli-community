// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port. Each port has its
// own transport, so what a tab hears is encoded for that port alone, and its own engine scope, so its chain
// connections are its own.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { getActiveFixedServicesConfig } from '@dotli/config/fixed';
import { countMetric, defineCount, m, spans as S } from '@dotli/metrics';
import {
  createFrameStatus,
  createWireReport,
  ProtocolFatalError,
  ProtocolInitFailedError,
  protocolSchema,
} from '@dotli/protocol';
import { getErrorName, log, serializeError, type Timers } from '@dotli/shared';
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
  netBytes?: { read: () => number; startTicker?: Ticker | undefined } | undefined;
  /**
   * Sends buffered telemetry before the worker closes. May reject. A rejection is captured, logged and counted, and the
   * close goes on.
   */
  flush: () => Promise<void>;
  /** Runs the worker's zero-delay close. Defaults to the page's own timers. */
  timers?: Timers;
  /** The monotonic clock the pre-sync is timed on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
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
}: Params): {
  /**
   * Lets go of every tab's port, stops hearing the light client and tabs that connect, and releases the chains the
   * pre-sync took, and never closes the worker or disposes the light client. Safe to call more than once and after
   * the worker failed. Throws only what releasing a chain throws, after every tab's port is let go and with the
   * engine's dispose still run. A tab's status ends with the port closed, an end the port may drop as it
   * closes at once, nothing else open on the port hears from the worker, and a pre-sync still under way reports
   * nothing more.
   */
  dispose: () => void;
} {
  // What each port's transport cannot handle itself, counted as the worker's.
  const wire = createWireReport({ side: 'worker', count: countMetric });
  // Built by the pre-sync, unless the network is unknown.
  let service: LightClientService | null = null;
  let engine: ProtocolEngine | null = null;
  // Aborted by `dispose`, so a pre-sync still under way reports nothing more.
  const disposed = new AbortController();
  // What every port hears through its `frame.status` subscription, each on its own transport.
  const status = createFrameStatus();

  const networkInitFailure = !network.success ? network.value : null;
  const lifecycle = createWorkerLifecycle({
    scope,
    status,
    flush,
    startHeartbeat,
    timers,
    initialFailure: networkInitFailure === null ? null : new ProtocolInitFailedError(networkInitFailure),
    onEveryTabPausedChange: applyEveryTabPaused,
  });
  // Only this worker can meter the light client every tab shares, so every tab hears its total from one meter.
  const subscribeNetBytes =
    netBytes === undefined ? null : shareNetBytes({ read: netBytes.read, startTicker: netBytes.startTicker });
  const handleTelemetry = createTelemetryHandler({
    onChainSync: resolver.onChainSync,
    onChainDetail: resolver.onChainDetail,
    ...toLightClientDb(lightClient),
    onNetBytes: listener => (subscribeNetBytes === null ? (): void => undefined : subscribeNetBytes(listener)),
    // A tab that subscribes once the chains are synced paid no sync cost, so the reads before it are hits.
    hasJoinedSynced: () => lifecycle.getPhase().name === 'ready',
  });

  function applyEveryTabPaused(paused: boolean): void {
    if (service === null) {
      return;
    }
    if (paused) {
      service.pool.pause();
    } else {
      service.pool.resume();
    }
  }

  function requireEngine(): ProtocolEngine {
    if (engine === null) {
      throw new Error(networkInitFailure ?? PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
    }
    return engine;
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

  // No retries by design. A failed pre-sync tells every port and closes the worker, so a retry is a new worker.
  async function presync(signal: AbortSignal): Promise<void> {
    const startedAt = now();
    logWorkerEvent('Pre-sync started');

    try {
      const started = startLightClientService({ lightClient, resolver, services: getActiveFixedServicesConfig() });
      service = started;
      if (lifecycle.isEveryTabPaused()) {
        started.pool.pause();
      }
      const { dotns } = started;
      engine = createEngine({
        pool: started.pool,
        isChainSupported: lightClient.isChainSupported,
        resolver: dotns,
        log: logWorkerEvent,
      });

      await dotns.waitForAssetHubFinalized();
      if (signal.aborted) {
        return;
      }

      // The fatal already ended every port's status, so no port may hear ready.
      if (lifecycle.getPhase().name === 'failed') {
        return;
      }
      logWorkerEvent('Pre-sync complete', { ms: Math.round(now() - startedAt) });
      lifecycle.markReady();

      // Warmed in the background, so a later People read does not wait on a cold warp sync. Ready never waits on it.
      started.warmPeople(WORKER_LOG_TAG);
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      const message = serializeError(error);
      log.error(`${WORKER_LOG_TAG} Pre-sync failed: ${message}`, error);
      smoldotPresyncMetric.count({ outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
      // A light client that died during pre-sync is the real cause, and the fatal already closed the worker.
      lifecycle.fail(new ProtocolInitFailedError(message, { cause: error }));
    }
  }

  // A fatal ends every port's status at once, and a port that connects before the close lands still hears the cause.
  // No chain opens before pre-sync, so no change came earlier.
  const stopHearingLightClient = lightClient.subscribe(change => {
    if (change.kind !== 'fatal') {
      return;
    }
    const { message } = change;
    log.error(`${WORKER_LOG_TAG} Light client died, telling ${String(lifecycle.countPorts())} port(s): ${message}`);
    lifecycle.fail(new ProtocolFatalError(message));
  });

  scope.addEventListener('connect', handleConnectEvent);

  if (network.success) {
    logWorkerEvent('Worker started', { network: network.value });
    void presync(disposed.signal);
  } else {
    // Every tab hears this as the reason the worker never became ready.
    log.error(`${WORKER_LOG_TAG} ${network.value}`);
  }

  return {
    dispose,
  };

  function handleConnectEvent(event: ConnectEvent): void {
    const port = event.ports[0];
    if (port !== undefined) {
      handleConnect(port);
    }
  }

  function dispose(): void {
    disposed.abort();
    scope.removeEventListener('connect', handleConnectEvent);
    stopHearingLightClient();
    lifecycle.dispose();
    // The observed chains go before the pool they lease from, and a release that throws still lets the pool go.
    try {
      service?.dispose();
    } finally {
      engine?.dispose();
    }
  }
}
