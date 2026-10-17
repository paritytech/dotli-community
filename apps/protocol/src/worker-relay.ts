// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// In shared-worker mode the iframe serves its chain and name methods by making the same call on the SharedWorker, so
// the host hears the worker's answers, events and ends as the worker gave them.

import type {
  CallContext,
  ConsumerTransport,
  RequestHandler,
  RequestMethod,
  ServingTransport,
  SubscriptionHandler,
  SubscriptionMethod,
} from '@dotli/protocol';

import { PROTOCOL_APP_ERRORS } from './errors.js';
import type { FrameStatus } from './frame-status.js';

function callOptions(context: CallContext): { deadlineMs?: number } {
  return context.deadlineMs === null ? {} : { deadlineMs: context.deadlineMs };
}

/** The host reports where the worker threw a failure, not where this frame passed it on. */
function asThrownByWorker<E>(error: E): E {
  if (error instanceof Error && 'remoteStack' in error && typeof error.remoteStack === 'string') {
    error.stack = error.remoteStack;
  }
  return error;
}

function relayRequest<M extends RequestMethod>(worker: ConsumerTransport, method: M): RequestHandler<M> {
  return (payload, context) =>
    worker.request(method, payload, callOptions(context)).catch((error: unknown) => {
      throw asThrownByWorker(error);
    });
}

function relaySubscription<M extends SubscriptionMethod>(worker: ConsumerTransport, method: M): SubscriptionHandler<M> {
  return (payload, context, sink) => {
    const subscription = worker.subscribe(
      method,
      payload,
      event => {
        sink.send(event);
      },
      callOptions(context),
    );
    subscription.onEnd(error => {
      sink.end(error === null ? undefined : asThrownByWorker(error));
    });
    return () => {
      subscription.unsubscribe();
    };
  };
}

/** The worker's telemetry, for the frame to serve once it has a worker to hear. */
export function relayTelemetry(worker: ConsumerTransport): SubscriptionHandler<'telemetry'> {
  return relaySubscription(worker, 'telemetry');
}

/**
 * Serves the chain and name methods on `serving` through `worker`. When the worker stops serving this tab, `status`
 * fails with the worker's error, so the host's frame status ends with it and the host rebuilds the frame.
 */
export function registerWorkerRelay(
  serving: ServingTransport,
  worker: ConsumerTransport,
  status: Pick<FrameStatus, 'fail'>,
): void {
  serving.handleRequest('warmup', relayRequest(worker, 'warmup'));
  serving.handleRequest('resolveOwner', relayRequest(worker, 'resolveOwner'));
  serving.handleRequest('resolveExecutableManifest', relayRequest(worker, 'resolveExecutableManifest'));
  serving.handleRequest('resolveRootManifest', relayRequest(worker, 'resolveRootManifest'));
  serving.handleRequest('chainSend', relayRequest(worker, 'chainSend'));
  serving.handleSubscription('chainConnect', relaySubscription(worker, 'chainConnect'));
  serving.handleSubscription('resolveDotName', relaySubscription(worker, 'resolveDotName'));
  worker
    .subscribe('frameStatus', undefined, () => undefined)
    .onEnd(error => {
      status.fail(error === null ? new Error(PROTOCOL_APP_ERRORS.WORKER_STATUS_ENDED) : asThrownByWorker(error));
    });
}
