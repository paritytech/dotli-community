// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port. Each port has its
// own transport, so what a tab hears is encoded for that port alone, and its own engine scope, so its chain
// connections are its own.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { getActiveFixedServicesConfig } from '@dotli/config/fixed';
import { m, spans as S } from '@dotli/metrics';
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
import { shareNetBytes } from './shareNetBytes.js';
import { startLightClientService } from './startLightClientService.js';
import { toLightClientDb } from './toLightClientDb.js';
import { withRefusalReports } from './withRefusalReports.js';
import { withRequestSpan, withSubscriptionSpan } from './withRequestSpan.js';
import { WORKER_LOG_TAG } from './workerLogTag.js';

/** The worker global, narrowed to what the worker uses. */
export type WorkerScope = {
  /** Hears each tab that connects, with its port first. Never throws. */
  addEventListener: (type: 'connect', listener: (event: { readonly ports: readonly WorkerPort[] }) => void) => void;
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

/** Serves every tab that connects to `scope`, and pre-syncs the light client unless the network is unknown. */
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
}: Params): void {
  // What each port's transport cannot handle itself, counted as the worker's.
  const wire = createWireReport({ side: 'worker', count: m.count });
  let engine: ProtocolEngine | null = null;
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
    // The engine and the tab's scope are made on first use, so each method asks for them when called. A failure is
    // logged under its call name, and reaches the tab as the call's answer.
    const reporting = withRefusalReports(transport, ({ method, error }) => {
      log.warn(`${WORKER_LOG_TAG} ${method} failed`, error);
    });
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
    // Any message shows the tab is alive, not only its heartbeat.
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
  async function presync(): Promise<void> {
    const startedAt = now();
    logWorkerEvent('Pre-sync started');

    try {
      // Nothing calls `dispose`, since the observed chains live as long as the worker, which closes as a whole.
      const service = startLightClientService({ lightClient, resolver, services: getActiveFixedServicesConfig() });
      const { dotns } = service;
      engine = createEngine({
        pool: service.pool,
        isChainSupported: lightClient.isChainSupported,
        resolver: dotns,
        log: logWorkerEvent,
      });

      await dotns.waitForAssetHubFinalized();

      // The fatal already ended every port's status, so no port may hear ready.
      if (lifecycle.getPhase().name === 'failed') {
        return;
      }
      logWorkerEvent('Pre-sync complete', { ms: Math.round(now() - startedAt) });
      lifecycle.markReady();

      // Warmed in the background, so a later People read does not wait on a cold warp sync. Ready never waits on it.
      service.warmPeople(WORKER_LOG_TAG);
    } catch (error: unknown) {
      const message = serializeError(error);
      log.error(`${WORKER_LOG_TAG} Pre-sync failed: ${message}`, error);
      m.count(S.SMOLDOT_PRESYNC, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
      // A light client that died during pre-sync is the real cause, and the fatal already closed the worker.
      lifecycle.fail(new ProtocolInitFailedError(message, { cause: error }));
    }
  }

  // A fatal ends every port's status at once, and a port that connects before the close lands still hears the cause.
  // No chain opens before pre-sync, so no change came earlier.
  lightClient.subscribe(change => {
    if (change.kind !== 'fatal') {
      return;
    }
    const { message } = change;
    log.error(`${WORKER_LOG_TAG} Light client died, telling ${String(lifecycle.countPorts())} port(s): ${message}`);
    lifecycle.fail(new ProtocolFatalError(message));
  });

  scope.addEventListener('connect', event => {
    const port = event.ports[0];
    if (port !== undefined) {
      handleConnect(port);
    }
  });

  if (!network.success) {
    // Every tab hears this as the reason the worker never became ready.
    log.error(`${WORKER_LOG_TAG} ${network.value}`);
    return;
  }
  logWorkerEvent('Worker started', { network: network.value });
  void presync();
}
