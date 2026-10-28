// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Over the iframe's link to the protocol SharedWorker, the iframe forwards its chain and name calls to the worker as
// their message bytes, so the host hears the worker's answers, values and ends as the worker posted them. Nothing is
// added on the way: no deadline goes to the worker, and no chain or name payload is decoded in the iframe.

import {
  createEndListeners,
  fromTransportError,
  protocolSchema,
  type ProtocolHello,
  type ProtocolTransport,
  type SubscriptionEnd,
} from '@dotli/protocol';
import { err, hostFailure, type Subscription, type SubscriptionHandler } from '@dotli/transport';

import type { FrameBoot } from './createFrameBoot.js';
import { ENGINE_METHODS } from './serveEngineMethods.js';
import { getWorkerEndError, type WorkerStatus } from './watchWorkerStatus.js';

type Params = {
  /** The iframe's end of the host's link, whose chain and name calls go to the worker. */
  serving: ProtocolTransport;
  /** The iframe's link to the worker. */
  worker: ProtocolTransport;
  /** The link's one status subscription to the worker. */
  workerStatus: WorkerStatus;
  /** What the host hears of this frame's boot. */
  boot: Pick<FrameBoot, 'fail' | 'interrupt' | 'serveTelemetry'>;
};

/**
 * Forwards the chain and name calls of `serving` to `worker`, and feeds `boot` the worker's telemetry. When the worker
 * stops serving this tab, `boot` ends the status with the worker's own end, and the calls the worker still holds fail,
 * since it will answer nothing more.
 */
export function registerWorkerRelay({ serving, worker, workerStatus, boot }: Params): void {
  serving.forward(ENGINE_METHODS, worker);
  // Before the status can end, so no telemetry subscription waits for a source when it does.
  boot.serveTelemetry(relaySubscription(worker, protocolSchema.sections.frame.telemetry));
  workerStatus.onEnd(end => {
    // The status ends first, so the forwarded calls fail after it.
    switch (end.kind) {
      case 'interrupt':
        boot.interrupt(end.outcome);
        break;
      case 'close':
        boot.fail(end.error);
        break;
    }
    // A worker that stopped serving this tab answers nothing more, so a call it held would wait for good.
    worker.dispose(getWorkerEndError(end));
  });
}

/**
 * Sends each value of the worker's and ends with the worker's own end. A link that closed under the subscription ends
 * it with the closing error, under the protocol's class when it is the transport's own. The telemetry crosses this way,
 * decoded, since a subscription can arrive before its source has loaded, and a refusal would never be retried.
 */
function relaySubscription<Start, Value, Domain>(
  worker: ProtocolTransport,
  method: Subscription<Start, Value, SubscriptionEnd<Domain>>,
): SubscriptionHandler<Start, Value, SubscriptionEnd<Domain>, ProtocolHello> {
  return (start, _context, sink) =>
    worker.subscribe({
      method,
      start,
      listeners: {
        receive: value => {
          sink.send(value);
        },
        ...createEndListeners<Domain>(outcome => {
          sink.interrupt(outcome);
        }),
        close: error => {
          sink.interrupt(err(hostFailure(fromTransportError(error))));
        },
      },
    });
}
