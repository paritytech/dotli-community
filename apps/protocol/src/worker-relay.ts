// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// In shared-worker mode the iframe serves its chain and name methods by making the same call on the SharedWorker, so
// the host hears the worker's answers, values and ends as the worker gave them. Nothing is added on the way: no
// deadline goes to the worker, and each answer and end comes back unchanged.

import { fromTransportError, type ProtocolSchema, type ProtocolTransport } from '@dotli/protocol';
import {
  hostFailure,
  type RequestHandler,
  type RequestMethodName,
  type SubscriptionHandler,
  type SubscriptionMethodName,
  type TraitName,
} from '@dotli/transport';

import type { FrameBoot } from './frame-boot.js';
import { workerEndError, type WorkerStatus } from './shared-worker-link.js';

type S = ProtocolSchema;

/**
 * Answers with the worker's own answer. A link that closed under the call fails it with the closing error, under the
 * protocol's class when it is the transport's own.
 */
function relayRequest<T extends TraitName<S>, M extends RequestMethodName<S, T>>(
  worker: ProtocolTransport,
  trait: T,
  method: M,
): RequestHandler<S, T, M> {
  return async payload => {
    try {
      return await worker.request(trait, method, payload);
    } catch (error) {
      throw error instanceof Error ? fromTransportError(error) : error;
    }
  };
}

/**
 * Sends each value of the worker's and ends with the worker's own end. A link that closed under the subscription ends
 * it with the closing error, under the protocol's class when it is the transport's own.
 */
function relaySubscription<T extends TraitName<S>, M extends SubscriptionMethodName<S, T>>(
  worker: ProtocolTransport,
  trait: T,
  method: M,
): SubscriptionHandler<S, T, M> {
  return (start, _context, sink) => {
    const subscription = worker.subscribe(trait, method, start, {
      receive: value => {
        sink.receive(value);
      },
      interrupt: outcome => {
        sink.interrupt(outcome.ok ? undefined : outcome.error);
      },
    });
    subscription.onClose(error => {
      sink.interrupt(hostFailure(fromTransportError(error)));
    });
    return () => {
      subscription.stop();
    };
  };
}

/** The worker's telemetry, for the frame to serve once it has a worker to hear. */
export function relayTelemetry(worker: ProtocolTransport): SubscriptionHandler<S, 'frame', 'telemetry'> {
  return relaySubscription(worker, 'frame', 'telemetry');
}

/**
 * Serves the chain and name methods on `serving` through `worker`. When the worker stops serving this tab, `status`
 * ends with the worker's own end, so the host's frame status ends with it and the host rebuilds the frame, and the
 * calls the worker still holds fail, since it will answer nothing more.
 */
export function registerWorkerRelay(
  serving: ProtocolTransport,
  worker: ProtocolTransport,
  workerStatus: WorkerStatus,
  status: Pick<FrameBoot, 'fail' | 'interrupt'>,
): void {
  serving.handleRequest('frame', 'warmup', relayRequest(worker, 'frame', 'warmup'));
  serving.handleRequest('resolve', 'owner', relayRequest(worker, 'resolve', 'owner'));
  serving.handleRequest('resolve', 'executableManifest', relayRequest(worker, 'resolve', 'executableManifest'));
  serving.handleRequest('resolve', 'rootManifest', relayRequest(worker, 'resolve', 'rootManifest'));
  serving.handleRequest('chain', 'send', relayRequest(worker, 'chain', 'send'));
  serving.handleSubscription('chain', 'connect', relaySubscription(worker, 'chain', 'connect'));
  serving.handleSubscription('resolve', 'dotName', relaySubscription(worker, 'resolve', 'dotName'));
  workerStatus.onEnd(end => {
    // A worker that stopped serving this tab answers nothing more, so a call it held would wait for good.
    worker.dispose(workerEndError(end));
    if (end.kind === 'interrupt') {
      status.interrupt(end.outcome.ok ? undefined : end.outcome.error);
    } else {
      status.fail(end.error);
    }
  });
}
