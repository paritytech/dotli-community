// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// In shared-worker mode the iframe serves its chain and name methods by making the same call on the SharedWorker, so
// the host hears the worker's answers, values and ends as the worker gave them. Nothing is added on the way: no
// deadline goes to the worker, and each answer and end comes back unchanged.

import {
  fromTransportError,
  type ProtocolHello,
  protocolSchema,
  type ProtocolServing,
  type ProtocolTransport,
} from '@dotli/protocol';
import { toError } from '@dotli/shared';
import {
  err,
  hostFailure,
  type Request,
  type RequestHandler,
  type Subscription,
  type SubscriptionHandler,
} from '@dotli/transport';

import { serveEngineMethods } from './engine.js';
import type { FrameBoot } from './frame-boot.js';
import { workerEndError, type WorkerStatus } from './shared-worker-link.js';

const { frame, resolve, chain } = protocolSchema.traits;

/**
 * Answers with the worker's own answer. A link that closed under the call fails it with the closing error, under the
 * protocol's class when it is the transport's own.
 */
function relayRequest<P, R, E>(
  worker: ProtocolTransport,
  method: Request<P, R, E>,
): RequestHandler<P, R, E, ProtocolHello> {
  return async payload => {
    try {
      return await worker.request(method, payload);
    } catch (error) {
      throw fromTransportError(toError(error));
    }
  };
}

/**
 * Sends each value of the worker's and ends with the worker's own end. A link that closed under the subscription ends
 * it with the closing error, under the protocol's class when it is the transport's own.
 */
function relaySubscription<S, V, I>(
  worker: ProtocolTransport,
  method: Subscription<S, V, I>,
): SubscriptionHandler<S, V, I, ProtocolHello> {
  return (start, _context, sink) =>
    worker.subscribe(method, start, {
      receive: value => {
        sink.receive(value);
      },
      interrupt: outcome => {
        sink.interrupt(outcome);
      },
      close: error => {
        sink.interrupt(err(hostFailure(fromTransportError(error))));
      },
    });
}

/**
 * Serves the chain and name methods on `serving` through `worker`, and feeds `boot` the worker's telemetry. When the
 * worker stops serving this tab, `boot` ends the status with the worker's own end, so the host's frame status ends with
 * it and the host rebuilds the frame, and the calls the worker still holds fail, since it will answer nothing more.
 */
export function registerWorkerRelay(
  serving: ProtocolServing,
  worker: ProtocolTransport,
  workerStatus: WorkerStatus,
  boot: Pick<FrameBoot, 'fail' | 'interrupt' | 'serveTelemetry'>,
): void {
  serveEngineMethods(serving, {
    warmup: relayRequest(worker, frame.warmup),
    resolveDotName: relaySubscription(worker, resolve.dotName),
    resolveOwner: relayRequest(worker, resolve.owner),
    resolveExecutableManifest: relayRequest(worker, resolve.executableManifest),
    resolveRootManifest: relayRequest(worker, resolve.rootManifest),
    connect: relaySubscription(worker, chain.connect),
    send: relayRequest(worker, chain.send),
  });
  // Before the status can end, so no telemetry subscription waits for a source when it does.
  boot.serveTelemetry(relaySubscription(worker, frame.telemetry));
  workerStatus.onEnd(end => {
    // The status goes first, so the host drops this frame before it hears the relayed calls fail, and counts them in
    // the frame's loss.
    if (end.kind === 'interrupt') {
      boot.interrupt(end.outcome);
    } else {
      boot.fail(end.error);
    }
    // A worker that stopped serving this tab answers nothing more, so a call it held would wait for good.
    worker.dispose(workerEndError(end));
  });
}
