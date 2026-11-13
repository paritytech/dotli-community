// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol SharedWorker. Every tab's protocol iframe shares its one light client over a port. Each port has its
// own transport, so what a tab hears is encoded for that port alone, and its own engine scope, so its chain
// connections are its own.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import { getActiveFixedServicesConfig } from '@dotli/config/fixed';
import { createReporter, defineCount, m, spans as S } from '@dotli/metrics';
import { createFrameStatus, ProtocolFatalError, ProtocolInitFailedError } from '@dotli/protocol';
import {
  createStateMachine,
  getErrorName,
  log,
  serializeError,
  type HandlerOf,
  type MachineTypes,
  type Timers,
} from '@dotli/shared';

import { createEngine, type ProtocolEngine } from './createEngine.js';
import type { Ticker } from './createIntervalTicker.js';
import { createPortServer, type ConnectEvent } from './createPortServer.js';
import { createTelemetryHandler } from './createTelemetryHandler.js';
import { createWorkerLifecycle } from './createWorkerLifecycle.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import type { WorkerNetwork } from './parseWorkerNetwork.js';
import { shareNetBytes } from './shareNetBytes.js';
import { startLightClientService, type LightClientService } from './startLightClientService.js';
import { toLightClientDb } from './toLightClientDb.js';
import { WORKER_LOG_TAG } from './workerLogTag.js';

/** Create, relay, asset hub and first finalized block together. */
const smoldotPresyncMetric = defineCount<'error'>(S.SMOLDOT_PRESYNC);
const workerTransitionMetric = defineCount<'error'>('protocol.worker.transition');

const report = createReporter({ flow: 'protocol' });

/** What the pre-sync builds on a known network. */
type Built = { service: LightClientService; engine: ProtocolEngine };

/**
 * `unserved` is an unknown network, or a known one whose service threw on start, with what every call is refused with.
 * `failed` keeps the engine of a pre-sync that failed or a
 * light client that died, so a late sync marks nothing ready.
 */
type WorkerState =
  | { kind: 'starting' }
  | { kind: 'unserved'; reason: string }
  | ({ kind: 'syncing'; startedAt: number } & Built)
  | ({ kind: 'serving' } & Built)
  | ({ kind: 'failed' } & Built)
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
  | { kind: 'presyncComplete'; ms: number; service: LightClientService }
  | { kind: 'presyncFailed'; error: unknown }
  | { kind: 'lightClientDied'; message: string }
  | { kind: 'pauseApplied'; service: LightClientService; paused: boolean }
  | { kind: 'released' }
  | { kind: 'serviceDisposed'; service: LightClientService }
  | { kind: 'engineDisposed'; engine: ProtocolEngine };

type WorkerMachine = MachineTypes<WorkerState, WorkerEvent, WorkerEffect>;

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
  netBytes?: Parameters<typeof shareNetBytes>[0] | undefined;
  /**
   * Sends buffered telemetry before the worker closes. May reject. A rejection is captured, logged and counted, and the
   * close goes on.
   */
  flush: () => Promise<void>;
  /** Runs the worker's zero-delay close. Defaults to the page's own timers. */
  timers?: Timers;
  /** Starts the light client's chains and name resolver. Defaults to the real one. */
  startService?: typeof startLightClientService;
};

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
  const handleConnect = createPortServer({
    lifecycle,
    status,
    handleTelemetry: createTelemetryHandler({
      onChainSync: resolver.onChainSync,
      onChainDetail: resolver.onChainDetail,
      ...toLightClientDb(lightClient),
      // Only this worker can meter the light client every tab shares, so every tab hears its total from one meter.
      onNetBytes: netBytes === undefined ? () => (): void => undefined : shareNetBytes(netBytes),
      // A tab that subscribes once the chains are synced paid no sync cost, so the reads before it are hits.
      hasJoinedSynced: lifecycle.isReady,
    }),
    openSpan,
    requireEngine,
  });

  /** A fatal ends every port's status at once, and a port that connects before the close lands still hears the cause. */
  const failLightClient: HandlerOf<WorkerMachine, 'syncing' | 'serving', 'lightClientDied'> = (
    { service, engine },
    { message },
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'failed', service, engine });
    emitSideEffect({ kind: 'lightClientDied', message });
  };
  /** A worker that already serves nothing still tells every port the fatal. */
  const reportFatal: HandlerOf<WorkerMachine, 'unserved' | 'failed', 'lightClientDied'> = (
    _state,
    { message },
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'lightClientDied', message });
  };
  /** The worker pauses only while every tab it serves asks. */
  const applyEveryTabPaused: HandlerOf<WorkerMachine, 'syncing' | 'serving' | 'failed', 'everyTabPausedChanged'> = (
    { service },
    { paused },
    { emitSideEffect },
  ) => {
    emitSideEffect({ kind: 'pauseApplied', service, paused });
  };
  /** The chains go in effects of their own, so a release that throws still lets the engine go. */
  const disposeWorker: HandlerOf<WorkerMachine, 'syncing' | 'serving' | 'failed', 'disposed'> = (
    { service, engine },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'disposed' });
    emitSideEffect({ kind: 'released' });
    // The observed chains go before the pool they lease from.
    emitSideEffect({ kind: 'serviceDisposed', service });
    emitSideEffect({ kind: 'engineDisposed', engine });
  };
  const machine = createStateMachine<WorkerMachine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, _event, { emitState, emitSideEffect, update }) {
          if (!network.success) {
            // Every tab hears this as the reason the worker never became ready.
            emitState({ kind: 'unserved', reason: network.value });
            emitSideEffect({ kind: 'networkUnknown', message: network.value });
            return;
          }
          const startedAt = performance.now();
          emitSideEffect({ kind: 'presyncStarted', network: network.value });
          let service: LightClientService;
          try {
            service = startService({ lightClient, resolver, services: getActiveFixedServicesConfig() });
          } catch (error) {
            emitState({ kind: 'unserved', reason: PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED });
            emitSideEffect({ kind: 'presyncFailed', error });
            return;
          }
          const engine = createEngine({
            pool: service.pool,
            isChainSupported: lightClient.isChainSupported,
            resolver: service.dotns,
            log: report.log.event,
          });
          // No tab has connected yet, so none has asked for a pause.
          emitState({ kind: 'syncing', startedAt, service, engine });
          update(
            service.dotns.waitForAssetHubFinalized().then(
              (): WorkerEvent => ({ kind: 'assetHubSynced' }),
              (error: unknown): WorkerEvent => ({ kind: 'presyncFailed', error }),
            ),
          );
        },
      },
      unserved: {
        lightClientDied: reportFatal,
        disposed(_state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'disposed' });
          emitSideEffect({ kind: 'released' });
        },
      },
      syncing: {
        assetHubSynced({ startedAt, service, engine }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'serving', service, engine });
          emitSideEffect({ kind: 'presyncComplete', ms: Math.round(performance.now() - startedAt), service });
        },
        // A pre-sync that fails tells every port and closes the worker, so a retry is a new worker.
        presyncFailed({ service, engine }, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'failed', service, engine });
          emitSideEffect({ kind: 'presyncFailed', error });
        },
        everyTabPausedChanged: applyEveryTabPaused,
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      serving: {
        everyTabPausedChanged: applyEveryTabPaused,
        lightClientDied: failLightClient,
        disposed: disposeWorker,
      },
      // A pre-sync that fails after the light client died still reports, though the fatal is the cause the tabs hear.
      failed: {
        presyncFailed(_state, { error }, { emitSideEffect }) {
          emitSideEffect({ kind: 'presyncFailed', error });
        },
        everyTabPausedChanged: applyEveryTabPaused,
        lightClientDied: reportFatal,
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
          report.log.event('Worker started', { network: effect.network });
          report.log.event('Pre-sync started');
          break;
        case 'presyncComplete':
          report.log.event('Pre-sync complete', { ms: effect.ms });
          lifecycle.markReady();
          // Warmed in the background, so a later People read does not wait on a cold warp sync. Ready never waits on it.
          effect.service.warmPeople(WORKER_LOG_TAG);
          break;
        case 'presyncFailed':
          log.error(`${WORKER_LOG_TAG} Pre-sync failed: ${serializeError(effect.error)}`, effect.error);
          smoldotPresyncMetric.count({ outcome: 'error', reason: getErrorName(effect.error) ?? 'unknown' });
          // A light client that died first already failed the lifecycle with its fatal, which this does not replace.
          lifecycle.fail(new ProtocolInitFailedError(serializeError(effect.error), { cause: effect.error }));
          break;
        case 'lightClientDied':
          log.error(
            `${WORKER_LOG_TAG} Light client died, telling ${String(lifecycle.countPorts())} port(s): ${effect.message}`,
          );
          lifecycle.fail(new ProtocolFatalError(effect.message));
          break;
        case 'pauseApplied':
          if (effect.paused) {
            effect.service.pool.pause();
          } else {
            effect.service.pool.resume();
          }
          break;
        case 'released':
          scope.removeEventListener('connect', handleConnect);
          stopHearingLightClient();
          lifecycle.dispose();
          break;
        case 'serviceDisposed':
          effect.service.dispose();
          break;
        case 'engineDisposed':
          effect.engine.dispose();
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

  // No chain opens before pre-sync, so no change came earlier.
  const stopHearingLightClient = lightClient.subscribe(change => {
    if (change.kind === 'fatal') {
      machine.update({ kind: 'lightClientDied', message: change.message });
    }
  });
  scope.addEventListener('connect', handleConnect);
  machine.update({ kind: 'started' });

  return {
    dispose(): void {
      machine.update({ kind: 'disposed' });
    },
  };

  function requireEngine(): ProtocolEngine {
    const state = machine.state.get();
    switch (state.kind) {
      case 'syncing':
      case 'serving':
      case 'failed':
        return state.engine;
      case 'unserved':
        throw new Error(state.reason);
      case 'starting':
      case 'disposed':
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
    }
  }
}
