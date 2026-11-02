// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription to the frame as the host's layers hold it. Whether the frame ended it or the transport closed under
// it, its one end is heard in one place, as the error host code sees, unless the subscriber tells the two apart.

import type { Subscription as Method } from '@dotli/transport';
import { createEndListeners } from './createEndListeners.js';
import { callFailure, fromTransportError } from './errors.js';
import { getCallName } from './methodPolicy.js';
import type { DomainFailure, ProtocolTransport, SubscriptionEnd } from './schema.js';

/** What a subscriber hears: each value, then one end, unless it stops first. */
export type FrameSubscriber<V> = {
  /** Hears each value. */
  receive(value: V): void;
  /** Null when the frame ended it cleanly, else why it ended, as the error host code sees. */
  end(error: Error | null): void;
  /** Hears the transport closing under it in place of `end`, for a subscriber that the frame's loss ends for good. */
  close?(): void;
};

type Params<Start, Value, Interrupt extends SubscriptionEnd<DomainFailure>> = {
  transport: ProtocolTransport;
  method: Method<Start, Value, Interrupt>;
  start: NoInfer<Start>;
  listeners: FrameSubscriber<NoInfer<Value>>;
  /** Stops the subscription once it aborts. */
  signal?: AbortSignal | undefined;
};

/** Subscribes `method` on `transport`, and returns its `unsubscribe`. Throws when `start` is refused. */
export function subscribe<Start, Value, Interrupt extends SubscriptionEnd<DomainFailure>>({
  transport,
  method,
  start,
  listeners,
  signal,
}: Params<Start, Value, Interrupt>): () => void {
  const name = getCallName(method);
  return transport.subscribe({
    method,
    start,
    listeners: {
      receive: value => {
        listeners.receive(value);
      },
      ...createEndListeners<DomainFailure>(outcome => {
        listeners.end(outcome.success ? null : callFailure(outcome.value, name, signal));
      }),
      close: error => {
        if (listeners.close === undefined) {
          listeners.end(fromTransportError(error));
        } else {
          listeners.close();
        }
      },
    },
    signal,
  });
}
