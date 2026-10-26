// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription to the frame as the host's layers hold it. Whether the frame ended it or the transport closed under
// it, its one end is heard in one place, as the error host code sees, unless the subscriber tells the two apart.

import { err, type SubscribeOptions, type Subscription as Method, type SubscriptionListeners } from '@dotli/transport';
import { callName } from './method-policy.js';
import { callFailure, fromTransportError } from './errors.js';
import type { DomainFailure, ProtocolTransport, SubscriptionEnd } from './schema.js';

/** What a subscriber hears: each value, then one end, unless it stops first. */
export type FrameSubscriber<V> = {
  receive(value: V): void;
  /** Null when the frame ended it cleanly, else why it ended, as the error host code sees. */
  end(error: Error | null): void;
  /** Hears the transport closing under it in place of `end`, for a subscriber that the frame's loss ends for good. */
  close?(): void;
};

/**
 * The `interrupt` and `fail` listeners of a protocol subscription as one end. A failure of the library's ends it as
 * `err(failure)`, the `CallError` a protocol interrupt carries.
 */
export function endListeners<E>(
  end: (outcome: SubscriptionEnd<E>) => void,
): Pick<SubscriptionListeners<never, SubscriptionEnd<E>>, 'interrupt' | 'fail'> {
  return {
    interrupt: end,
    fail: failure => {
      end(err(failure));
    },
  };
}

/** Subscribes `method` on `transport`, and returns its `unsubscribe`. Throws when `start` is refused. */
export function subscribe<S, V, I extends SubscriptionEnd<DomainFailure>>(
  transport: ProtocolTransport,
  method: Method<S, V, I>,
  start: NoInfer<S>,
  listeners: FrameSubscriber<NoInfer<V>>,
  options: SubscribeOptions = {},
): () => void {
  const name = callName(method);
  return transport.subscribe(
    method,
    start,
    {
      receive: value => {
        listeners.receive(value);
      },
      ...endListeners<DomainFailure>(outcome => {
        listeners.end(outcome.success ? null : callFailure(outcome.value, name, options.signal));
      }),
      close: error => {
        if (listeners.close === undefined) {
          listeners.end(fromTransportError(error));
        } else {
          listeners.close();
        }
      },
    },
    options,
  );
}
