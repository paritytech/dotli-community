// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol SharedWorker serves one tab's port: its own transport, the frame methods, and the engine methods on
// the tab's own engine scope.

import { countMetric, type m } from '@dotli/metrics';
import { createWireReport, protocolSchema, type FrameStatus } from '@dotli/protocol';
import { log } from '@dotli/shared';
import { createPortProvider, createTransport, ok } from '@dotli/transport';

import type { ProtocolEngine } from './createEngine.js';
import type { TelemetryHandler } from './createTelemetryHandler.js';
import type { PortSession, WorkerLifecycle, WorkerPort } from './createWorkerLifecycle.js';
import { serveEngineMethods } from './serveEngineMethods.js';
import { servePoolControl } from './servePoolControl.js';
import { withRefusalReports } from './withRefusalReports.js';
import { withRequestSpan, withSubscriptionSpan } from './withRequestSpan.js';
import { WORKER_LOG_TAG } from './workerLogTag.js';

/** A tab that connects to the worker, with its port first. */
export type ConnectEvent = { readonly ports: readonly WorkerPort[] };

type Params = {
  /** Admits each port, and owns its session from then on. */
  lifecycle: WorkerLifecycle;
  /** What every port hears through its `frame.status` subscription. */
  status: FrameStatus;
  /** Serves each port's `frame.telemetry`. */
  handleTelemetry: TelemetryHandler;
  /** Opens the span of one tab's request. */
  openSpan: typeof m.open;
  /** The worker's engine. Throws why there is none. */
  requireEngine: () => ProtocolEngine;
};

const { frame, resolve, chain } = protocolSchema.sections;

/** Serves the port of each tab that connects. The returned listener never throws. */
export function createPortServer({ lifecycle, status, handleTelemetry, openSpan, requireEngine }: Params) {
  // What each port's transport cannot handle itself, counted as the worker's.
  const wire = createWireReport({ side: 'worker', count: countMetric });

  return function handleConnect(event: ConnectEvent): void {
    const port = event.ports[0];
    if (port === undefined) {
      return;
    }
    const transport = createTransport({
      schema: protocolSchema,
      // The worker closes the port itself, after a release has had its chance to reach a frozen tab.
      provider: createPortProvider({ port, closeOnDispose: false }),
      handshake: 'respond',
      // A worker has no page load of its own.
      hello: { resolutionId: null },
      onIssue: wire.onIssue,
    });
    const session: PortSession = { port, transport };
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
    const getScope = () => lifecycle.getScope(session, () => requireEngine().openScope());
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
        handler: (start, context, sink) => getScope().connect(start, context, sink),
      }),
      send: withRequestSpan({
        openSpan,
        method: chain.send,
        handler: (payload, context) => getScope().send(payload, context),
      }),
    });
    lifecycle.admit(session);
  };
}
