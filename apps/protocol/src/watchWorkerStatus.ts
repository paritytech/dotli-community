// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The iframe's one `frame.status` subscription to the protocol SharedWorker, and what its end means for this tab.

import { reportListener } from '@dotli/metrics';
import {
  createEndListeners,
  getFailure,
  fromTransportError,
  protocolSchema,
  type FrameStatusEnd,
  type ProtocolTransport,
} from '@dotli/protocol';
import { createListenerSet } from '@dotli/shared';

import { PROTOCOL_APP_ERRORS } from './errors.js';

/**
 * How the worker's status ended for this tab: the worker's own end, as the worker sent it, or the link's transport
 * closing under it.
 */
export type WorkerEnd = { kind: 'interrupt'; outcome: FrameStatusEnd } | { kind: 'close'; error: Error };

/** The one `frame.status` subscription to the worker. */
export type WorkerStatus = ReturnType<typeof watchWorkerStatus>;

type Params = {
  /** The link's transport, on the worker's port. */
  transport: ProtocolTransport;
  /** Hears the worker say it is ready. */
  onReady: () => void;
};

/** Subscribes to the worker's status once, and tells each listener its end until it is disposed. */
export function watchWorkerStatus({ transport, onReady }: Params) {
  const ends = createListenerSet<WorkerEnd>({ onListenerError: reportListener('protocol', 'protocol.worker_status') });
  let ended: WorkerEnd | null = null;
  const unsubscribe = transport.subscribe({
    method: protocolSchema.sections.frame.status,
    start: undefined,
    listeners: {
      receive: onReady,
      // A failure of the transport's own ends the status as the worker's end.
      ...createEndListeners((outcome: FrameStatusEnd) => {
        finish({ kind: 'interrupt', outcome });
      }),
      close: error => {
        finish({ kind: 'close', error });
      },
    },
  });
  return {
    /**
     * Hears its one end, and returns the removal of `listener`. Called at once if it has ended, and then the removal
     * is a no-op, since nothing is left to hear. A listener that throws is reported, never thrown.
     */
    onEnd,
    /** Ends the subscription, safe to call twice and after the status ended. A listener still waiting hears no end. */
    dispose(): void {
      unsubscribe();
    },
  };

  // The transport ends a subscription once.
  function finish(end: WorkerEnd): void {
    ended = end;
    ends.emit(end);
  }

  function onEnd(listener: (end: WorkerEnd) => void): () => void {
    if (ended !== null) {
      ends.deliver(listener, ended);
      return () => undefined;
    }
    return ends.subscribe(listener);
  }
}

/**
 * What a worker's end means for this tab, as an error under the name the worker's failure has. A link that closed on
 * the transport's own error, such as a version mismatch, ends under the protocol's class.
 */
export function getWorkerEndError(end: WorkerEnd): Error {
  switch (end.kind) {
    case 'close':
      return fromTransportError(end.error);
    case 'interrupt':
      return end.outcome.success
        ? new Error(PROTOCOL_APP_ERRORS.WORKER_STATUS_ENDED)
        : getFailure(protocolSchema.sections.frame.status, end.outcome.value);
  }
}
