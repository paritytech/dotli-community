// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createFrameStatus, protocolSchema, type ProtocolTransport } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';

/** Serves a worker's own status on `worker`, noting when a subscription reaches it. Throws when `worker` already serves a status. */
export function serveWorkerStatus(worker: ProtocolTransport) {
  const workerStatus = createFrameStatus();
  const subscribed = createDeferred<undefined>();
  worker.handleSubscription(protocolSchema.sections.frame.status, (start, context, sink) => {
    const stop = workerStatus.handler(start, context, sink);
    subscribed.resolve(undefined);
    return stop;
  });
  return {
    /** The worker's own status, which a case ends. */
    workerStatus,
    /** Settles once a subscription to the status reached the worker. Never rejects. */
    subscribed: subscribed.promise,
  };
}
