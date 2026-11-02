// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFrameStatus, protocolSchema, type FrameStatus, type ProtocolTransport } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';

/** A worker status served on a transport, with the signal that a subscription reached it. */
type ServedWorkerStatus = {
  /** The worker's own status, which a case ends. */
  workerStatus: FrameStatus;
  /** Settles once a subscription to the status reached the worker. Never rejects. */
  subscribed: Promise<void>;
};

/** Serves a worker's own status on `worker`, noting when a subscription reaches it. Throws when `worker` already serves a status. */
export function serveWorkerStatus(worker: ProtocolTransport): ServedWorkerStatus {
  const workerStatus = createFrameStatus();
  const subscribed = createDeferred<undefined>();
  worker.handleSubscription(protocolSchema.sections.frame.status, (start, context, sink) => {
    const stop = workerStatus.handler(start, context, sink);
    subscribed.resolve(undefined);
    return stop;
  });
  return {
    workerStatus,
    subscribed: subscribed.promise.then(() => undefined),
  };
}
